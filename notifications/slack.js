import { randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';
import { KINDS, eventLabel, eventTiming, recordDates, sourceLink, stamp } from '../src/records.js';

export const CHANNEL = 'C0C5PE21KN1';
const baselineKey = `baseline:${CHANNEL}`;
const staleError = 'Prepared evidence changed or expired; no message sent.';
const canReprepare = row => row.status === 'failed' && row.attempts === 0 && !row.last_attempt_at && !row.sent_at && !row.slack_ts &&
  row.error === staleError && ['finding', 'change', 'digest'].includes(row.kind);
const clip = (value, limit) => Array.from(String(value ?? '')).slice(0, limit).join('');
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const section = text => ({ type: 'section', text: { type: 'plain_text', text: clip(text, 2900), emoji: false } });
const versionKey = record => `${CHANNEL}:${record.id}:${record.version}:${record.material_hash ?? ''}`;

export async function readRecords(db) {
  return (await db.query(`select to_jsonb(r) || jsonb_build_object(
    'version', to_char(r.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'sources', coalesce((select jsonb_agg(jsonb_build_object('url',s.url,'published_at',s.published_at,
      'published_on',s.published_on,'collected_at',s.collected_at,'authoritative',s.authoritative) order by s.authoritative desc,s.url)
      from scout.sources s where s.record_id=r.id), '[]'::jsonb)) as record
    from scout.records r order by r.updated_at,r.id`)).rows.map(row => row.record);
}

export async function getDelivery(db, id) {
  const row = (await db.query('select * from scout.deliveries where id=$1', [id])).rows[0];
  if (!row || row.channel_id !== CHANNEL) throw new Error('Unknown Scout delivery.');
  return row;
}

async function storeDelivery(db, key, kind, records, payload, snapshot = {}, status = 'pending', id = randomUUID()) {
  const record = ['finding', 'change'].includes(kind) ? records[0] : null;
  await db.query(`insert into scout.deliveries(id,record_id,record_updated_at,kind,channel_id,idempotency_key,status,payload,snapshot)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(idempotency_key) do nothing`,
  [id, record?.id ?? null, record?.version ?? null, kind, CHANNEL, key, status, payload, { format: 2, ...snapshot, records }]);
  return latestReplacement(db, (await db.query('select * from scout.deliveries where idempotency_key=$1', [key])).rows[0]);
}

async function latestReplacement(db, row) {
  for (;;) {
    const next = (await db.query('select * from scout.deliveries where idempotency_key=$1', [`replacement:${row.id}`])).rows[0];
    if (!next) return row;
    row = next;
  }
}

export async function baseline(db) {
  return db.transaction(async tx => {
    const existing = (await tx.query('select * from scout.deliveries where idempotency_key=$1', [baselineKey])).rows[0];
    if (existing) return existing;
    const records = await readRecords(tx);
    for (const record of records) await storeDelivery(tx, versionKey(record), 'finding', [record], null, {}, 'baseline');
    return storeDelivery(tx, baselineKey, 'baseline', records, null, { count: records.length }, 'baseline');
  });
}

async function requireBaseline(db) {
  if (!(await db.query('select id from scout.deliveries where idempotency_key=$1', [baselineKey])).rows.length) throw new Error('Run the explicit historical baseline first.');
}

function recordBlocks(record, now) {
  const dates = record.kind === 'event' ? `Event: ${eventLabel(record)} · ${eventTiming(record, now)}` : null;
  const sources = [...new Set([record.event_url, record.registration_url, ...record.sources.map(source => source.url)].map(sourceLink).filter(Boolean))].filter(url => url.length <= 1000).slice(0, 3);
  if (!sources.length) throw new Error('Delivery requires a usable source link.');
  const blocks = [section([`${KINDS[record.kind]} · ${clip(record.title, 200)}`, record.organization && clip(record.organization, 150),
    record.description || 'No source description available.', dates,
    ...record.sources.slice(0, 3).map(source => `Source published: ${source.published_at ? stamp(source.published_at) : source.published_on ?? 'Unknown'} · Collected: ${stamp(source.collected_at)}`),
    `Record updated: ${stamp(record.updated_at)}`].filter(Boolean).join('\n')),
  { type: 'section', text: { type: 'mrkdwn', text: sources.map((url, i) => `<${escape(url.replaceAll('|', '%7C'))}|Source ${i + 1}>`).join(' · '), verbatim: true } }];
  return blocks;
}

function payload(title, blocks, id) {
  return { text: `${escape(clip([title, ...blocks.map(block => block.text.text)].join('\n\n'), 3300))}\nDelivery ${id}`, unfurl_links: false, unfurl_media: false,
    blocks: [section(title), ...blocks, section(`Delivery ${id}\nHosted record links are unavailable while member access is pending.`)] };
}

export async function prepareFindings(db, now = new Date()) {
  await requireBaseline(db);
  const previous = (await db.query('select * from scout.deliveries where channel_id=$1', [CHANNEL])).rows;
  const prepared = [];
  for (const record of await readRecords(db)) {
    if (previous.some(row => row.record_id === record.id && (['sending', 'unknown'].includes(row.status) ||
        (row.snapshot?.records[0] && versionKey(row.snapshot.records[0]) === versionKey(record))))) continue;
    prepared.push(await prepareFinding(db, record, previous, now));
    if (prepared.length === 5) break;
  }
  return prepared;
}

async function prepareFinding(db, record, previous, now, verification = false, replaces = null) {
  const kind = !verification && previous.some(row => row.record_id === record.id && ['baseline', 'sent'].includes(row.status)) ? 'change' : 'finding';
  const id = randomUUID(), blocks = recordBlocks(record, now);
  if (kind === 'change') {
    const prior = previous.filter(row => row.record_id === record.id && ['baseline', 'sent'].includes(row.status)).sort((a, b) => b.created_at - a.created_at)[0].snapshot.records[0];
    const changes = ['title', 'description', 'location', 'status', 'registration_url']
      .filter(field => prior[field] !== record[field]).map(field => `${field.replaceAll('_', ' ')}: ${clip(prior[field] ?? 'Unknown', 150)} → ${clip(record[field] ?? 'Unknown', 150)}`);
    if (record.kind === 'event' && eventLabel(prior) !== eventLabel(record)) changes.unshift(`Event schedule: ${eventLabel(prior)} → ${eventLabel(record)}`);
    blocks.unshift(section(`Changes since the last notification/baseline:\n${changes.join('\n') || 'Source-backed record details updated.'}`));
  }
  const key = replaces ? `replacement:${replaces}` : verification ? `verification:${CHANNEL}:milestone-1` : versionKey(record);
  return storeDelivery(db, key, kind, [record], payload(verification ? 'Scout verification · historical source example' : `Scout · ${kind === 'change' ? 'Material change' : 'New finding'}`, blocks, id),
    { as_of: now.toISOString(), verification, replaces }, 'pending', id);
}

export async function prepareVerification(db, recordId, now = new Date()) {
  await requireBaseline(db);
  const record = (await readRecords(db)).find(row => row.id === recordId);
  if (!record) throw new Error('Verification requires an existing source-backed record.');
  return prepareFinding(db, record, [], now, true);
}

function digestRecords(records, from, through, now) {
  const dated = [], unknown = [];
  for (const record of records.filter(row => row.kind === 'event')) {
    const timing = eventTiming(record, now);
    if (timing === 'Date unknown') unknown.push(record);
    else if (['Upcoming', 'In progress'].includes(timing)) {
      const [start, end] = recordDates(record);
      if (start <= through && end >= from) dated.push(record);
    }
  }
  dated.sort((a, b) => recordDates(a)[0].localeCompare(recordDates(b)[0]) || a.id.localeCompare(b.id));
  return { dated, unknown };
}

export async function prepareDigest(db, from, through, now = new Date()) {
  return prepareDigestPayload(db, from, through, now);
}

async function prepareDigestPayload(db, from, through, now, replaces = null) {
  await requireBaseline(db);
  const valid = day => /^\d{4}-\d{2}-\d{2}$/.test(day ?? '') && !Number.isNaN(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
  if (!valid(from) || !valid(through) || through < from || Date.parse(through) - Date.parse(from) > 31 * 86400000) throw new Error('Provide an inclusive digest window of at most 32 calendar days.');
  const { dated, unknown } = digestRecords(await readRecords(db), from, through, now);
  const coverage = (await db.query('select count(*)::int total,count(last_success_at)::int collected,max(last_success_at) last_success from scout.trackers')).rows[0];
  const blocks = [section(`Window: ${from} through ${through} (inclusive source calendar dates).\nAs of: ${stamp(now.toISOString())}. Events must have a supported time and still be upcoming or in progress.\nCoverage: ${coverage.collected} of ${coverage.total} trackers has a successful collection. Latest success: ${stamp(coverage.last_success?.toISOString())}.`),
    section(dated.length ? `${dated.length} qualifying events; showing ${Math.min(5, dated.length)}.` : 'No qualifying upcoming events in the collected records for this window. Other trackers may contain uncollected events.')];
  for (const record of dated.slice(0, 5)) blocks.push(...recordBlocks(record, now));
  blocks.push(section(`Date unknown: ${unknown.length}. These cannot be assigned to this reporting window${unknown.length > 3 ? '; showing 3' : ''}.`));
  for (const record of unknown.slice(0, 3)) blocks.push(...recordBlocks(record, now));
  const id = randomUUID();
  return storeDelivery(db, replaces ? `replacement:${replaces}` : `digest:${CHANNEL}:${from}:${through}`, 'digest', [...dated, ...unknown],
    payload('Scout verification · manual upcoming-events digest', blocks, id), { as_of: now.toISOString(), from, through, coverage, replaces }, 'pending', id);
}

export async function reprepareStale(db, id, now = new Date()) {
  return db.transaction(async tx => {
    const row = await getDelivery(tx, id);
    if (!canReprepare(row)) throw new Error('Only stale deliveries rejected before any send attempt can be reprepared.');
    const latest = await latestReplacement(tx, row);
    if (latest.id !== row.id) return latest;
    if (row.kind === 'digest') return prepareDigestPayload(tx, row.snapshot.from, row.snapshot.through, now, id);
    const record = (await readRecords(tx)).find(record => record.id === row.record_id);
    if (!record) throw new Error('The source record no longer exists.');
    const previous = (await tx.query('select * from scout.deliveries where channel_id=$1', [CHANNEL])).rows;
    if (previous.some(other => other.id !== id && other.record_id === record.id && (['sending', 'unknown'].includes(other.status) ||
        (!row.snapshot.verification && !canReprepare(other) && other.snapshot?.records[0] && versionKey(other.snapshot.records[0]) === versionKey(record))))) {
      throw new Error('Another delivery exists for this record version or needs reconciliation; review it first.');
    }
    return prepareFinding(tx, record, previous, now, row.snapshot.verification, id);
  });
}

export function webhookTransport(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Missing or invalid Scout webhook.'); }
  if (url.protocol !== 'https:' || url.host !== 'hooks.slack.com' || url.username || url.password || url.search || url.hash ||
      !/^\/services\/TFZ8FRLBV\/B0C5TEK4R38\/[A-Za-z0-9]+$/.test(url.pathname)) throw new Error('Webhook does not match the confirmed Scout installation.');
  return body => new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let content = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { content += chunk; if (Buffer.byteLength(content) > 4096) req.destroy(new Error('Response limit')); });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: content, retryAfter: res.headers['retry-after'] }));
    });
    const timer = setTimeout(() => req.destroy(new Error('Delivery timeout')), 12000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

export async function sendDelivery(db, id, post, { now = () => new Date(), wait = sleep } = {}) {
  let row = await getDelivery(db, id);
  if (row.status === 'sending') {
    await db.query("update scout.deliveries set status='unknown',error='Interrupted send; inspect Slack before reconciliation.' where id=$1", [id]);
    return getDelivery(db, id);
  }
  if (row.status !== 'pending') return row;
  if (!row.payload || !row.snapshot?.records) throw new Error('Delivery has no reviewed payload evidence.');
  const records = await readRecords(db);
  let stale = row.snapshot.format !== 2 || row.snapshot.records.some(record => !records.some(current => versionKey(current) === versionKey(record)));
  stale ||= row.snapshot.records.some(record => record.kind === 'event' && eventTiming(record, new Date(row.snapshot.as_of)) !== eventTiming(record, now()));
  if (row.kind === 'digest') {
    const { dated, unknown } = digestRecords(records, row.snapshot.from, row.snapshot.through, now());
    stale ||= JSON.stringify([...dated, ...unknown].map(versionKey)) !== JSON.stringify(row.snapshot.records.map(versionKey));
  }
  if (stale) {
    await db.query("update scout.deliveries set status='failed',error=$2 where id=$1", [id, staleError]);
    return getDelivery(db, id);
  }
  if (row.record_id && (await db.query("select id from scout.deliveries where record_id=$1 and id<>$2 and status in ('sending','unknown')", [row.record_id, id])).rows.length) throw new Error('Reconcile the earlier uncertain delivery for this record first.');
  const last = (await db.query('select max(last_attempt_at) latest from scout.deliveries where channel_id=$1', [CHANNEL])).rows[0].latest;
  if (last) await wait(Math.max(0, 1000 - (now() - last)));
  while (row.attempts < 2) {
    // Commit before network I/O: a crash after acceptance must never cause a blind resend.
    const claimed = await db.query(`update scout.deliveries set status='sending',attempts=attempts+1,last_attempt_at=$2
      where id=$1 and status=$3 and attempts=$4 returning *`, [id, now().toISOString(), row.status, row.attempts]);
    if (!claimed.rows.length) return getDelivery(db, id);
    row = claimed.rows[0];
    let result;
    try { result = await post(row.payload); }
    catch {
      await db.query("update scout.deliveries set status='unknown',error='Network failure or timeout; delivery may have been accepted. Inspect Slack.' where id=$1", [id]);
      return getDelivery(db, id);
    }
    if (result.status === 200 && result.body.trim() === 'ok') {
      await db.query("update scout.deliveries set status='sent',sent_at=$2,error=null where id=$1", [id, now().toISOString()]);
      return getDelivery(db, id);
    }
    const retry = Number(result.retryAfter);
    if (result.status === 429 && /^\d+$/.test(String(result.retryAfter)) && retry <= 30 && row.attempts < 2) {
      await wait(Math.max(1000, retry * 1000));
      continue;
    }
    const rejected = result.status >= 400 && result.status < 500;
    await db.query('update scout.deliveries set status=$2,error=$3 where id=$1', [id, rejected ? 'failed' : 'unknown',
      `HTTP ${result.status}; ${rejected ? 'request rejected; automatic retries stopped.' : 'acceptance uncertain; inspect Slack.'}`]);
    return getDelivery(db, id);
  }
  throw new Error('Delivery attempt limit reached.');
}

export async function recordReceipt(db, id, ts, note) {
  const row = await getDelivery(db, id);
  if (!['sent', 'sending', 'unknown'].includes(row.status) || !/^\d{10,}\.\d{6}$/.test(ts ?? '') || !note?.trim()) throw new Error('Receipt requires an inspected Slack message timestamp, evidence note and a sent/uncertain delivery.');
  await db.query("update scout.deliveries set status='sent',slack_ts=$2::text,reconciliation_note=$3,sent_at=coalesce(sent_at,to_timestamp($2::text::double precision)),error=null where id=$1", [id, ts, note]);
  return getDelivery(db, id);
}
