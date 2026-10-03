import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { Agent, request } from 'undici';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { observe, assessmentInput, validateDecision, INSTRUCTION, SCHEMA, CONTENT_FIELDS, normalize, fingerprint, visibleText, dosiArticle, ASSESSMENT_VERSION } from './assessment.js';

export const HSA = 'highseasalliance.bsky.social';
export const USER_AGENT = 'BBNJ-Scout-Bot/1.0 (+https://bbnj-scout.web.app)';
export const LIMITS = { feedPages: 2, postsPerPage: 25, pages: 6, redirects: 3, requests: 24, bytes: 524288, seconds: 120 };
const hash = value => createHash('sha256').update(value).digest('hex');
const normalized = value => value.normalize('NFKC').replace(/\s+/g, ' ').trim();
const eventPost = text => /webinar|register|registration|rescheduled|cancelled|canceled/i.test(text) && !/expression.?s? of interest|call for (?:proposals|EOI)/i.test(text);

function publicAddress(address) {
  if (isIP(address) === 6) return !/^(?:fc|fd|fe[89ab]|::)/i.test(address);
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
}

export function sourceURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Unsupported source URL');
  if (isIP(url.hostname.replaceAll(/[\[\]]/g, '')) || !url.hostname.includes('.')) throw new Error('Source must use a public hostname');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.href;
}

// Validate DNS at connection time, including each redirect; never fetch local services.
export async function readPublic(url, budget, redirects = 0) {
  url = sourceURL(url);
  if (++budget.requests > LIMITS.requests || Date.now() > budget.deadline) throw new Error('Request/time limit reached');
  const agent = new Agent({ connect: {
      lookup(host, options, callback) {
        lookup(host, { all: true }, (error, addresses) => {
          if (error) return callback(error);
          if (!addresses.length || addresses.some(item => !publicAddress(item.address))) return callback(new Error('Non-public source address'));
          callback(null, options.all ? addresses : addresses[0].address, options.all ? undefined : addresses[0].family);
        });
      },
    }, maxResponseSize: LIMITS.bytes, connections: 1, pipelining: 0 });
  let result;
  try {
    const response = await request(url, {
      dispatcher: agent, method: 'GET', maxRedirections: 0,
      signal: AbortSignal.timeout(Math.max(1, Math.min(12000, budget.deadline - Date.now()))),
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/html;q=0.9', 'Accept-Encoding': 'identity' },
    });
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > LIMITS.bytes) throw new Error('Source exceeds byte limit');
      chunks.push(chunk);
    }
    result = { status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8'), url };
  } finally { await agent.destroy(); }
  if (result.status >= 300 && result.status < 400 && result.headers.location) {
    if (redirects >= LIMITS.redirects) throw new Error('Redirect limit reached');
    return readPublic(new URL(result.headers.location, url).href, budget, redirects + 1);
  }
  if (result.status !== 200) {
    const error = new Error(`Source returned HTTP ${result.status}`);
    error.quota = result.status === 429;
    throw error;
  }
  return result;
}

function dates(start, end) {
  const result = { start_on: null, end_on: null, starts_at: null, ends_at: null, time_zone: null };
  const day = value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  const instant = value => /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value ?? '') && day(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
  if (day(start)) {
    result.start_on = start;
    if (day(end) && end >= start) result.end_on = end;
  } else if (instant(start)) {
    result.starts_at = new Date(start).toISOString();
    result.time_zone = start.endsWith('Z') ? 'UTC' : start.slice(-6);
    if (instant(end) && Date.parse(end) >= Date.parse(start)) result.ends_at = new Date(end).toISOString();
  }
  return result;
}

function postDates(text) {
  if (/deadline|register by|registration closes|submission/i.test(text)) return dates();
  const iso = text.match(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2}))?\b/g) ?? [];
  // Several dates may be old/new dates or deadlines: do not choose one by guessing.
  if (iso.length === 1) return dates(iso[0]);
  return dates();
}

function links(post) {
  const values = (post.record.facets ?? []).flatMap(facet => facet.features ?? []).filter(feature => feature.$type === 'app.bsky.richtext.facet#link').map(feature => feature.uri);
  if (post.embed?.external?.uri) values.push(post.embed.external.uri);
  return [...new Set(values.map(value => { try { return sourceURL(value); } catch { return null; } }).filter(Boolean))].sort();
}

function postRecord(post, urls) {
  const text = post.record.text;
  const kind = eventPost(text) ? 'event' : 'announcement';
  const eventURL = urls.find(url => /webinar\/register|\/events?\/|\/webinars?\/|registration/i.test(new URL(url).pathname));
  const registration = urls.find(url => /register|registration/i.test(new URL(url).pathname));
  // Narrow observed HSA format: the year must come from the same event's page.
  const times = [...text.matchAll(/\b(\d{1,2}) Sept?, (\d{1,2}):([0-5]\d) (AM|PM) EDT\b/g)];
  const time = post.author.handle === HSA && times.length === 1 ? times[0] : null;
  return {
    kind, title: text.split('\n').find(line => line.trim())?.trim() || text,
    organization: post.author.handle === HSA ? 'High Seas Alliance' : post.author.displayName || post.author.handle,
    description: text,
    ...dates(), ...(kind === 'event' ? postDates(text) : {}),
    location: null, event_url: kind === 'event' ? eventURL ?? null : null,
    registration_url: kind === 'event' ? registration ?? null : null,
    date_parts: time && +time[2] >= 1 && +time[2] <= 12 ? { month: 9, day: +time[1],
      hour: +time[2] % 12 + (time[4] === 'PM' ? 12 : 0), minute: +time[3], zone: 'EDT', offset: '-04:00' } : null,
    status: kind === 'event' && /\bcancell?ed\b/i.test(text) ? 'cancelled' : kind === 'event' && /\brescheduled\b/i.test(text) ? 'rescheduled' : null,
  };
}

function structuredEvents(html, pageURL) {
  const events = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(visit);
    if ([value['@type']].flat().includes('Event') && typeof value.name === 'string') events.push(value);
    if (value['@graph']) visit(value['@graph']);
  }
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(match[1])); } catch { /* A malformed block supplies no facts. */ }
  }
  // A listing page cannot identify which of several events the post referred to.
  if (!events.length && /(^|\.)zoom\.us$/.test(new URL(pageURL).hostname) && new URL(pageURL).pathname.startsWith('/webinar/register/')) {
    // Read Zoom's public registration metadata as data; never evaluate its scripts.
    const schedule = html.match(/\bscheduleTime:\s*(\[[^\]\n]*\])/);
    const topic = html.match(/\btopic:\s*'((?:\\.|[^'\\])*)'/);
    const description = html.match(/\bdesc:\s*'((?:\\.|[^'\\])*)'/);
    const decode = value => value.replace(/\\(['\\nrt])/g, (_, char) => ({ n: '\n', r: '\r', t: '\t' })[char] ?? char);
    if (schedule && topic) {
      let times;
      try { times = JSON.parse(schedule[1]); } catch { return null; }
      if (times.length !== 1) return null;
      const date = times[0].match(/^([A-Z][a-z]{2}) (\d{1,2}), (\d{4}) (0[1-9]|1[0-2]):([0-5]\d) (AM|PM)$/);
      const month = date && ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(date[1]) + 1;
      if (!month) return null;
      const parsedDate = dates(`${date[3]}-${String(month).padStart(2, '0')}-${date[2].padStart(2, '0')}`);
      if (!parsedDate.start_on) return null;
      const detail = description ? decode(description[1]) : '';
      return { kind: 'event', title: decode(topic[1]), organization: null,
        description: detail || null, ...parsedDate, location: null,
        local_schedule: { date: parsedDate.start_on, month, day: +date[2],
          hour: +date[4] % 12 + (date[6] === 'PM' ? 12 : 0), minute: +date[5] },
        event_url: pageURL, registration_url: pageURL, status: null,
        limitation: 'Registration page supplies a local time without a time zone; only its calendar date is stored',
      };
    }
  }
  if (events.length !== 1) return null;
  const event = events[0];
  const safe = value => { try { return sourceURL(value); } catch { return null; } };
  const organizer = typeof event.organizer?.name === 'string' ? event.organizer.name : null;
  const location = typeof event.location === 'string' ? event.location : event.location?.name ?? null;
  const parsedDate = dates(event.startDate, event.endDate);
  return {
    kind: 'event', title: event.name, organization: organizer,
    description: typeof event.description === 'string' ? event.description.replace(/<[^>]*>/g, ' ').trim() : null,
    ...parsedDate, location: typeof location === 'string' ? location : null,
    event_url: safe(event.url) ?? pageURL,
    registration_url: safe(event.offers?.url),
    status: ({ EventCancelled: 'cancelled', EventRescheduled: 'rescheduled', EventScheduled: 'scheduled' })[event.eventStatus?.split('/').pop()] ?? null,
    limitation: event.startDate && !parsedDate.start_on && !parsedDate.starts_at ? 'Structured event date is unsupported or lacks a time zone' : null,
  };
}

const fields = [...CONTENT_FIELDS, 'date_evidence', 'priority'];
// Observed DOSI Mailchimp caption/button layout. The observed button URL keys
// an item within its issue; it does not automatically identify an event page.
function dosiNewsletter(html, url) {
  if (!/^https:\/\/mailchi\.mp\/soton\.ac\.uk\/dosi-deep-sea-roundup-\d{2}-\d{2}-\d{4}$/.test(url)) throw new Error('Unsupported DOSI newsletter URL');
  const blocks=[...html.matchAll(/<table\b[^>]*class="mcnCaptionBlock"[^>]*>/gi)].map(m=>m.index);
  const items=[],seen=new Set();let unsupported=0;
  for (let i=0;i<blocks.length;i++) {
    const block=html.slice(blocks[i],blocks[i+1]??html.length);
    const cell=block.match(/<td\b[^>]*class="mcnTextContent"[^>]*>([\s\S]*?)<\/td>/i);
    const title=cell?.[1].match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i);
    const button=block.match(/<a\b[^>]*class="mcnButton\s*"[^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a>/i);
    if (!title || !button) continue;
    let link;try{link=sourceURL(button[1].replaceAll('&amp;','&'));}catch{unsupported++;continue;}
    if (seen.has(link)) throw new Error('Ambiguous DOSI newsletter item link; coverage incomplete');
    seen.add(link);
    const heading=visibleText(cell[1].match(/<h4\b[^>]*>([\s\S]*?)<\/h4>/i)?.[1]??'');
    const date=heading.match(/^(\d{1,2}) (January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})$/);
    const event=Boolean(heading && /\b(?:event|webinar|symposium|conference|session|seminar)\b/i.test(visibleText(cell[1])) && !/deadline/i.test(heading));
    const day=date && `${date[3]}-${String(['January','February','March','April','May','June','July','August','September','October','November','December'].indexOf(date[2])+1).padStart(2,'0')}-${date[1].padStart(2,'0')}`;
    const eventLink=event && /\/webinar\/register|\/events?\/|\/webinars?\//i.test(new URL(link).pathname);
    items.push({url,link,content:cell[0]+button[0],parsed:{kind:event?'event':'announcement',title:visibleText(title[1]),
      description:visibleText(cell[1].replace(/<h[34]\b[^>]*>[\s\S]*?<\/h[34]>/gi,' ')),organization:null,location:null,
      ...dates(event?day:null),event_url:eventLink?link:null,registration_url:eventLink&&/register/i.test(new URL(link).pathname)?link:null,status:null}});
  }
  if (!items.length) throw new Error('DOSI newsletter item layout unavailable; coverage incomplete');
  return {items,unsupported};
}

function material(record) {
  const names = [...CONTENT_FIELDS, 'priority', 'start_on', 'end_on', 'time_zone'];
  const values = names.map(name => typeof record[name] === 'string' ? normalized(record[name]).toLowerCase() : record[name] ?? null);
  if (record.local_schedule) values.push(record.local_schedule);
  return hash(JSON.stringify(values));
}

async function save(db, identity, source, rank, observedAt, stats) {
  let record = source.parsed;
  let existing = (await db.query('select * from scout.records where identity_key=$1', [identity])).rows[0];
  if (existing) {
    for (const field of ['starts_at', 'ends_at']) if (existing[field] instanceof Date) existing[field] = existing[field].toISOString();
    const prior=source.parsed.source?.previous_id && (await db.query('select parsed from scout.evidence where id=$1',[source.parsed.source.previous_id])).rows[0]?.parsed;
    if (prior) {
      // A description edit cannot repeat an unchanged old schedule over a correction.
      record={...record};
      for (const field of [...CONTENT_FIELDS.filter(f=>f!=='kind'),'start_on','end_on','time_zone']) {
        if (['start_on','starts_at','ends_at','time_zone'].includes(field) && !isDeepStrictEqual(prior.local_schedule,record.local_schedule)) continue;
        if (isDeepStrictEqual(normalize(prior[field]),normalize(record[field]))) record[field]=null;
      }
    }
  }
  if (!record && !existing) return;
  // A shared capture belongs to each record independently. Reload ownership
  // because a cached page may already have been attached earlier in this run.
  source = (await db.query(`select * from scout.evidence where id=$1 or
    (record_id=$2 and tracker_id=$3 and url=$4 and content_hash=$5)
    order by (record_id=$2) desc nulls last limit 1`,
  [source.id, existing?.id ?? null, source.tracker_id, source.url, source.content_hash])).rows[0];
  if (source.record_id && source.record_id !== existing?.id) {
    source = (await db.query(`insert into scout.evidence (record_id,tracker_id,url,content_hash,content,published_at,collected_at,parsed,published_on)
      select $2,tracker_id,url,content_hash,content,published_at,collected_at,parsed,published_on from scout.evidence where id=$1
      on conflict (record_id,tracker_id,url,content_hash) do update set content_hash=excluded.content_hash returning *`,
    [source.id, existing?.id ?? null])).rows[0];
  }
  const references = existing ? (await db.query('select * from scout.current_evidence where record_id=$1', [existing.id])).rows : [];
  const previous = references.find(item => item.url === source.url);
  // Date-only values stay in captured sources, used here only to combine evidence.
  const established = existing?.date_evidence.schedule_source ? (await db.query('select url,parsed from scout.evidence where id=$1 and record_id=$2',
    [existing.date_evidence.schedule_source, existing.id])).rows[0] : null;
  const schedule = established?.parsed ??
    references.find(item => item.authoritative && (identity === `event:${item.url}` || existing?.event_url === item.url || existing?.registration_url === item.url))?.parsed ??
    references.find(item => item.parsed?.starts_at && item.parsed.starts_at === existing?.starts_at)?.parsed;
  let calendarDay = existing?.status !== 'rescheduled' || existing?.starts_at ? schedule?.start_on : null;
  // First page snapshots have unknown chronology. Only a change in their facts
  // starts a new evidence time, including a return to an older source version.
  const priorFacts = previous?.parsed ?? (established?.url === source.url ? established.parsed : null);
  const evidenceAt = source.parsed.source?.previous_id ? observedAt : source.published_at ?? (record && priorFacts && /^hsa-v[234]:/.test(previous?.content_hash) && material(priorFacts) !== material(record)
    ? observedAt : previous?.evidence_at ?? null);
  const baseline = !source.published_at && !evidenceAt;
  const accepted = record && (!existing || rank > existing.evidence_rank || (rank === existing.evidence_rank && (baseline || !existing.evidence_at || Date.parse(evidenceAt) >= Date.parse(existing.evidence_at))));
  const merged = Object.fromEntries(fields.map(field => [field, accepted ? record[field] ?? existing?.[field] ?? null : existing?.[field] ?? null]));
  merged.date_evidence ??= {};
  if (merged.description && Array.from(merged.description).length > 280) merged.description = Array.from(merged.description).slice(0, 279).join('').trimEnd() + '…';
  if (accepted) {
    for (const field of record.assessment?.clear_fields ?? []) merged[field] = null;
    if (baseline && existing?.evidence_rank === 2) merged.status = existing.status ?? record.status;
    // A newly evidenced date replaces the prior representation, including date-only/timed changes.
    const offset = schedule?.time_zone?.match(/^([+-])(\d{2}):(\d{2})$/);
    const localDay = existing?.starts_at && (offset || schedule?.time_zone === 'UTC') && new Date(Date.parse(existing.starts_at) +
      (offset ? (offset[1] === '+' ? 1 : -1) * (+offset[2] * 60 + +offset[3]) * 60000 : 0)).toISOString().slice(0, 10);
    const compatibleDay = record.start_on && existing?.starts_at && (schedule?.start_on ?? localDay) === record.start_on &&
      (!record.local_schedule || isDeepStrictEqual(schedule?.local_schedule, record.local_schedule));
    const protectsCorrection = baseline && existing?.evidence_rank === 2 && ['cancelled', 'rescheduled'].includes(existing.status);
    if ((record.start_on || record.starts_at) && !compatibleDay && !protectsCorrection) {
      calendarDay = record.start_on;
      for (const field of ['starts_at', 'ends_at']) merged[field] = record[field];
      merged.date_evidence = record.starts_at ? { schedule_source: source.id } : {};
    } else if (compatibleDay || protectsCorrection) {
      for (const field of ['starts_at', 'ends_at']) merged[field] = existing[field];
    }
    if (existing?.kind === 'event') {
      const before = existing.starts_at && new Date(existing.starts_at).toISOString();
      const after = record.start_on || record.starts_at;
      const comparable = existing.starts_at && record.starts_at;
      if (comparable && before !== after && merged.status !== 'cancelled') merged.status = 'rescheduled';
      if (existing.status === 'rescheduled' && merged.status === 'scheduled') merged.status = 'rescheduled';
      if (record.status === 'rescheduled' && !after) {
        calendarDay = null;
        for (const field of ['starts_at', 'ends_at']) merged[field] = null;
        merged.date_evidence = {};
      }
    }
  }
  // Combine only the observed Zoom schedule and matching HSA-authored components.
  const evidence = [...references.filter(item => item.url !== source.url), { ...source, authoritative: rank === 2 }];
  const page = evidence.find(item => item.parsed?.local_schedule && (identity === `event:${item.url}` || merged.event_url === item.url || merged.registration_url === item.url));
  let timing=[];
  if (page) {
    // A retained HSA post can supply compatible clock/zone facts without a
    // second relevance call. Only the latest capture of each source may do so.
    timing=(await db.query(`select * from (select distinct on(url) * from scout.evidence where tracker_id=$1
      order by url,coalesce((parsed#>>'{source,observed_at}')::timestamptz,collected_at) desc,last_seen_at desc nulls last,id) latest
      where parsed->>'event_url'=$2 and parsed#>>'{source,rank}'='2' and parsed->'date_parts' <> 'null'::jsonb
        and (record_id is null or record_id=$3)`,[source.tracker_id,page.url,existing?.id??null])).rows;
  }
  const post = timing.filter(item => item.published_at && item.parsed?.date_parts)
    .filter(item => new Date(item.published_at).getUTCFullYear() === Number(page.parsed.local_schedule.date.slice(0,4)))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
  let dateWarning = page ? page.parsed.limitation : null;
  if (page && post) {
    const schedule = page.parsed.local_schedule, parts = post.parsed.date_parts;
    const wall = value => `${String(value.hour).padStart(2, '0')}:${String(value.minute).padStart(2, '0')}`;
    if (['month', 'day', 'hour', 'minute'].every(key => schedule[key] === parts[key])) {
      if (calendarDay === schedule.date) {
        const timed = dates(`${schedule.date}T${wall(schedule)}:00${parts.offset}`);
        for (const field of ['starts_at', 'ends_at']) merged[field] = timed[field];
        merged.date_evidence = { schedule_source: page.id, zone_source: post.id };
        dateWarning = null;
      }
    } else dateWarning = `Conflicting event schedule: registration ${schedule.date} ${wall(schedule)}; HSA post ${parts.month}/${parts.day} ${wall(parts)} ${parts.zone}`;
  }
  if (accepted || (existing && material(merged) !== material(existing))) {
    const digest = material(merged);
    const recordEvidenceAt = accepted && !baseline ? evidenceAt : existing?.evidence_at ?? evidenceAt;
    const recordRank = accepted ? rank : existing.evidence_rank;
    if (!existing || digest !== material(existing)) {
      if (existing) {
        const changed = fields.filter(field => !isDeepStrictEqual(merged[field], existing[field]));
        const updates = [...changed, 'evidence_rank', 'evidence_at'];
        existing = (await db.query(`update scout.records set ${updates.map((field, index) => `${field}=$${index + 1}`).join(',')} where id=$${updates.length+1} returning *`, [...changed.map(field => merged[field]), recordRank, recordEvidenceAt, existing.id])).rows[0];
        stats.changed++;
      } else {
        existing = (await db.query(`insert into scout.records (${fields.join(',')},identity_key,evidence_rank,evidence_at) values (${Array.from({ length: fields.length+3 }, (_, i) => `$${i + 1}`).join(',')}) returning *`, [...fields.map(field => merged[field]), identity, recordRank, recordEvidenceAt])).rows[0];
        stats.created++;
      }
    } else {
      await db.query('update scout.records set evidence_rank=$1,evidence_at=$2 where id=$3', [recordRank, recordEvidenceAt, existing.id]);
    }
  }
  await db.query('update scout.evidence set record_id=$2,last_seen_at=clock_timestamp(),authoritative=$3,evidence_at=$4 where id=$1',
    [source.id, existing.id, rank === 2, evidenceAt]);
  if (post && merged.date_evidence.zone_source === post.id && !post.record_id) {
    await db.query('update scout.evidence set record_id=$2,authoritative=true where id=$1 and record_id is null',[post.id,existing.id]);
  }
  return {warning:dateWarning,recordId:existing.id,sourceId:source.id};
}

export async function collectHSA(db, { since = new Date(Date.now() - 30 * 86400000).toISOString(), read = readPublic, now = () => new Date().toISOString(), deadline = Date.now() + LIMITS.seconds * 1000, model, makeModel, sourceId = null, trackerId = null, validate = false } = {}) {
  if (!Number.isFinite(Date.parse(since))) throw new Error('A valid coverage start is required');
  if (validate !== false && (validate !== true || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(trackerId ?? ''))) {
    throw Object.assign(new Error('Validation requires an explicit tracker UUID'), { status: 400 });
  }
  const tracker = (await db.query("select * from scout.trackers where id=$1 or ($1::uuid is null and seed_key='bbnj-trackers-2026-10-01:17')",[trackerId])).rows[0];
  if (!tracker || (!validate && !tracker.enabled)) throw Object.assign(new Error('Tracker is missing or its collector is not yet proven'), { status: 400 });
  const actor=tracker.collector==='bluesky_feed' && tracker.url?.match(/^https:\/\/bsky\.app\/profile\/([a-z0-9.-]+)$/)?.[1];
  const hub=tracker.collector==='web' && tracker.url==='https://www.hubocean.earth/events-calendar';
  if (!actor && !hub) throw Object.assign(new Error('Unsupported tracker configuration; review before collecting'), { status: 400 });
  const publisherHost=({[HSA]:'highseasalliance.org','deepstewardship.bsky.social':'dosi-project.org','globalfishingwatch.org':'globalfishingwatch.org','iddri.bsky.social':'iddri.org'})[actor];
  const started = now();
  const run = (await db.query('insert into scout.collection_runs (tracker_id,coverage_since,started_at,stats) values ($1,$2,$3,$4) returning id', [tracker.id, since, started, validate ? { validation: true } : {}])).rows[0];
  const stats = { created: 0, changed: 0, posts: 0, pages: 0, candidates: 0, skipped: 0, assessed: 0, reused_uncertain: 0, warnings: [] };
  const budget = { requests: 0, deadline: Math.min(deadline, Date.now() + LIMITS.seconds * 1000) };
  model ??= makeModel?.(run.id,budget.deadline);
  const pages = new Map();
  const dateWarnings = new Map();
  let cursor, covered = false, quota = false, feedFailed = false;
  try {
    if (hub) {
      const feedURL=tracker.url+'?format=json';
      const response=await read(feedURL,budget);stats.pages++;
      const feed=JSON.parse(response.body);
      if (!Array.isArray(feed.upcoming)||!Array.isArray(feed.past)) throw new Error('Invalid HUB Ocean calendar response');
      if ([...feed.upcoming,...feed.past].some(event=>!event||!Number.isFinite(event.endDate))) throw new Error('Invalid calendar event date');
      const events=[...feed.upcoming,...feed.past].filter(event=>Number.isFinite(event.endDate)&&event.endDate>=Date.parse(since));
      covered=events.length<LIMITS.pages;
      if (!covered) stats.warnings.push('Calendar event limit reached');
      for (const event of events.slice(0,LIMITS.pages-1)) {
        try {
          const url=sourceURL(new URL(event.fullUrl,tracker.url).href);
          if (new URL(url).origin!==new URL(tracker.url).origin || typeof event.title!=='string' || typeof event.body!=='string') throw new Error('Invalid calendar event');
          const calendar=await read(url+'?format=ical',budget);stats.pages++;
          if (!calendar.body.includes(`UID:${event.id}@squarespace.com`)) throw new Error('Calendar event identity mismatch');
          const times=['DTSTART','DTEND'].map(name=>{
            const match=calendar.body.match(new RegExp(`^${name}:(\\d{4})(\\d{2})(\\d{2})T(\\d{2})(\\d{2})(\\d{2})Z\\r?$`,'m'));
            return match?`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`:null;
          });
          const schedule=dates(...times);
          if (!schedule.starts_at || !schedule.ends_at) throw new Error('Calendar lacks an unambiguous UTC schedule');
          const registration=[...event.body.matchAll(/href\s*=\s*"([^"]+)"/gi)].map(match=>{try{return sourceURL(match[1].replaceAll('&amp;','&'));}catch{return null;}})
            .find(link=>link && new URL(link).hostname==='events.teams.microsoft.com')??null;
          const scripted={kind:'event',title:event.title,organization:feed.website?.siteTitle?.includes('HUB Ocean')?'HUB Ocean':null,
            description:visibleText(event.excerpt||event.body),...schedule,location:event.location?.addressTitle??null,event_url:url,registration_url:registration,status:null};
          const meaningful={title:event.title,body:visibleText(event.body),...schedule,location:scripted.location,registration_url:registration};
          const source=await observe(db,tracker.id,url,JSON.stringify({...event,calendar:calendar.body}),Number.isFinite(event.publishOn)?new Date(event.publishOn).toISOString():null,
            scripted,meaningful,{rank:2,identity:`event:${url}`,feed_url:feedURL,links:[url+'?format=ical',registration].filter(Boolean)},now());
          stats[source.changed?'candidates':'skipped']++;
        } catch(error) { quota ||= Boolean(error.quota);stats.warnings.push(error.message); }
      }
    } else for (let page = 0; page < LIMITS.feedPages; page++) {
      const params = new URLSearchParams({ actor, limit: String(LIMITS.postsPerPage), filter: 'posts_no_replies', includePins: 'false' });
      if (cursor) params.set('cursor', cursor);
      const response = await read(`https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?${params}`, budget);
      const feed = JSON.parse(response.body);
      if (!Array.isArray(feed.feed)) throw new Error('Invalid feed response');
      let reachedBoundary = feed.feed.length > 0;
      for (const item of feed.feed) {
        if (Date.now() > budget.deadline) throw new Error('Collection time limit reached');
        const post = item.post;
        const indexed = item.reason?.indexedAt ?? post?.indexedAt;
        if (!post?.uri || typeof post.record?.text !== 'string' || !Number.isFinite(Date.parse(post.record.createdAt)) || !Number.isFinite(Date.parse(indexed))) {
          stats.warnings.push('Skipped malformed feed item'); continue;
        }
        if (Date.parse(indexed) < Date.parse(since)) continue;
        reachedBoundary = false;
        stats.posts++;
        const urls = links(post);
        const uri = post.uri.match(/^at:\/\/(did:[^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/);
        if (!uri) { stats.warnings.push('Skipped invalid post identity'); continue; }
        const postURL = `https://bsky.app/profile/${uri[1]}/post/${uri[2]}`;
        const content = JSON.stringify({ text: post.record.text, author: { handle: post.author.handle, displayName: post.author.displayName ?? null }, createdAt: post.record.createdAt, urls });
        const scripted = postRecord(post, urls);
        const doc = await observe(db, tracker.id, postURL, content, post.record.createdAt, scripted,
          { text:post.record.text.replace(/https:\/\/[^\s]+/g,value=>{try{return sourceURL(value);}catch{return value;}}), author:post.author.handle, organizer:post.author.displayName??null, urls, createdAt:post.record.createdAt },
          {rank:post.author.handle === actor ? 2 : 0, identity:`post:${post.uri}`}, now());
        stats[doc.changed ? 'candidates' : 'skipped']++;
        if (post.embed?.$type?.includes('record')) stats.warnings.push('Quoted post content is not expanded');
        // Supporting technical/official links are checked even on unchanged posts.
        if (urls.length > 2) stats.warnings.push('Post link limit reached');
        const follow = [...new Set([doc.parsed.registration_url, doc.parsed.event_url, ...urls].filter(Boolean))];
        for (const url of follow.slice(0, 2)) {
          if (!pages.has(url)) {
            if (pages.size >= LIMITS.pages) { stats.warnings.push('Page limit reached'); break; }
            try {
              const fetched = await read(url, budget);
              stats.pages++;
              if (!/text\/html/i.test(fetched.headers['content-type'] ?? '')) throw new Error('Unsupported page format');
              const parsed = structuredEvents(fetched.body, fetched.url);
              const authoritative = new URL(fetched.url).hostname.replace(/^www\./, '') === publisherHost || (post.author.handle === actor && url === scripted.registration_url);
              const article=dosiArticle(fetched.body,fetched.url);
              const text = visibleText(article);
              const pageLinks=[...new Set([...article.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)].map(match=>{
                try{return sourceURL(new URL(match[1].replaceAll('&amp;','&'),fetched.url).href);}catch{return null;}
              }).filter(Boolean))].sort();
              const meaningful = {text:normalized(text), structured:parsed, links:pageLinks};
              const source = await observe(db, tracker.id, fetched.url, fetched.body, null, parsed, meaningful,
                {rank:authoritative?2:0, identity:`page:${fetched.url}`,links:pageLinks.slice(0,10)}, now());
              stats[source.changed?'candidates':'skipped']++;
              pages.set(url, { source, authoritative, observedAt: now() });
              if (parsed?.limitation && !parsed.local_schedule) stats.warnings.push(parsed.limitation);
              if (actor==='deepstewardship.bsky.social' && article!==fetched.body) {
                const newsletters=pageLinks.filter(link=>/^https:\/\/mailchi\.mp\/soton\.ac\.uk\/dosi-deep-sea-roundup-\d{2}-\d{2}-\d{4}$/.test(link));
                if (newsletters.length>1) stats.warnings.push('DOSI newsletter link limit reached');
                for (const link of newsletters.slice(0,1)) {
                  if (pages.has(link)) continue;
                  if (pages.size>=LIMITS.pages) {stats.warnings.push('Page limit reached');break;}
                  pages.set(link,null);
                  try {
                    const newsletter=await read(link,budget);stats.pages++;
                    if (!/text\/html/i.test(newsletter.headers['content-type']??'')) throw new Error('Unsupported DOSI newsletter format');
                    const {items,unsupported}=dosiNewsletter(newsletter.body,newsletter.url);
                    if (unsupported) stats.warnings.push(`DOSI newsletter has ${unsupported} unsupported item links`);
                    if (items.length>8) stats.warnings.push(`DOSI newsletter item limit reached: ${items.length-8} linked items not captured`);
                    for (const item of items.slice(0,8)) {
                      const captured=await observe(db,tracker.id,item.url,item.content,null,item.parsed,
                        {text:visibleText(item.content),link:item.link,structured:item.parsed},
                        {rank:2,identity:`newsletter:${item.url}:${item.link}`,item_key:item.link,parent_url:fetched.url,links:[item.link]},now());
                      stats[captured.changed?'candidates':'skipped']++;
                    }
                  } catch(error) {quota ||= Boolean(error.quota);stats.warnings.push(error.message);}
                }
              }
            } catch (error) {
              quota ||= Boolean(error.quota);
              pages.set(url, null);
              stats.warnings.push(error.message);
            }
          }
        }
      }
      cursor = feed.cursor;
      if (!cursor || reachedBoundary) { covered = true; break; }
    }
  } catch (error) {
    quota ||= Boolean(error.quota);
    feedFailed = true;
    stats.warnings.push(error.message);
  }
  if (!covered && !feedFailed && !hub) stats.warnings.push('Feed page limit reached before coverage boundary');
  const pendingQuery=`select * from (select distinct on(url,parsed#>>'{source,item_key}') * from scout.evidence where tracker_id=$1
    order by url,parsed#>>'{source,item_key}',coalesce((parsed#>>'{source,observed_at}')::timestamptz,collected_at) desc,last_seen_at desc nulls last,id) latest
    where parsed#>>'{assessment,state}' in ('pending','uncertain')`;
  const queued = (await db.query(`${pendingQuery} and ($2::uuid is null or id=$2) order by (parsed#>>'{assessment,state}'='uncertain'),collected_at,id limit 20`,[tracker.id,sourceId])).rows;
  const pending=[];
  for (const source of queued) {
    if (source.parsed.assessment.state==='uncertain' && source.parsed.assessment.input_fingerprint) {
      const input=await assessmentInput(db,source,tracker);
      const context=fingerprint({source:source.content_hash,coverage:input.coverage,candidates:JSON.stringify(input.candidates)});
      if (source.parsed.assessment.input_fingerprint===context) { stats.reused_uncertain++; stats.warnings.push(source.parsed.assessment.reason); continue; }
    }
    pending.push(source);
  }
  for (let index=0; index<pending.length;) {
    // A post and its exact event page need the first accepted finding available
    // before the second assessment. Independent sources can share one request.
    const sameEvent=pending[index].parsed.event_url && pending[index].parsed.event_url===pending[index+1]?.parsed.event_url;
    const batch=pending.slice(index,index+(sameEvent?1:2));
    index+=batch.length;
    try {
      if (Date.now()>=budget.deadline) throw new Error('Assessment time limit reached');
      if (!model) throw new Error('Assessment pending: configure model and shared hosted quota accounting');
      const inputs=await Promise.all(batch.map(source=>assessmentInput(db,source,tracker)));
      if (batch.length===2 && Buffer.byteLength(JSON.stringify([INSTRUCTION,inputs,SCHEMA]))>7400) {batch.pop();inputs.pop();index--;}
      const decisions=await model(INSTRUCTION,inputs,SCHEMA);
      if (!Array.isArray(decisions)||decisions.length!==batch.length||new Set(decisions.map(d=>d.source_id)).size!==batch.length) throw new Error('Incomplete assessment batch');
      for (let i=0;i<batch.length;i++) {
        const source=batch[i], input=inputs[i];
        let decision=validateDecision(decisions.find(d=>d.source_id===source.id),input);
        // A parsed registration page supplies its own URL. An explicit link in
        // the retained post can resolve "new" only after the normal identity checks.
        const modelDecision=decision;
        if (source.parsed.local_schedule && decision.candidate?.kind==='event' && ['new','update'].includes(decision.action)) {
          const linked=input.candidates.filter(candidate=>candidate.registration_link);
          decision={...decision,candidate:{...decision.candidate,...Object.fromEntries(['event_url','registration_url']
            .filter(field=>!decision.candidate[field]&&!decision.clear_fields.includes(field)).map(field=>[field,input.scripted[field]??null]))}};
          if (decision.action==='new' && linked.length===1) decision={...decision,action:'update',record_id:linked[0].id};
          if (decision.action==='new' && linked.length>1) throw new Error('Ambiguous registration identity; assessment remains pending');
          validateDecision(decision,input);
        }
        const evaluatedUncertainty=decision.action==='uncertain';
        if (decision.action==='new' && decision.candidate && decision.priority!=='low') {
          const fresh=await assessmentInput(db,source,tracker);
          const matches=fresh.candidates.filter(candidate=>{
            const seen=input.candidates.some(item=>item.id===candidate.id);
            const exact=input.exact_ids.includes(candidate.id) || (decision.candidate.event_url &&
              decision.candidate.event_url===candidate.event_url && normalize(decision.candidate.title)===normalize(candidate.title));
            // Only unseen candidates invalidate a reviewed distinct-finding
            // decision; retain stable-source/exact-event identity protection.
            if (seen && !exact) return false;
            try { validateDecision({...decision,action:'update',record_id:candidate.id},fresh);return true; } catch {return false;}
          });
          if (matches.length) decision={...decision,action:'uncertain',reason:'Possible existing finding; reassess against the refreshed shortlist before creating a duplicate'};
        }
        const assessment={...decision,state:decision.action==='uncertain'?'uncertain':'complete',version:ASSESSMENT_VERSION,
          fingerprint:source.content_hash,accepted_at:now()};
        if (decision!==modelDecision) assessment.model_decision=modelDecision;
        if (evaluatedUncertainty) assessment.input_fingerprint=fingerprint({source:source.content_hash,coverage:input.coverage,candidates:JSON.stringify(input.candidates)});
        const parsed={...source.parsed,...(['supporting_evidence','no_substantive_change'].includes(decision.action)?{}:decision.candidate??{}),assessment};
        await db.transaction(async tx=>{
          const before={created:stats.created,changed:stats.changed};
          let target;
          await tx.query('update scout.evidence set parsed=$2 where id=$1',[source.id,JSON.stringify(parsed)]);
          if (decision.action==='uncertain') { stats.warnings.push(decision.reason); return; }
          if (['new','update'].includes(decision.action) && (decision.priority!=='low'||decision.record_id)) {
            const existing=input.candidates.find(row=>row.id===decision.record_id);
            let identity=existing?.identity_key ?? (parsed.kind==='event'&&parsed.event_url ? `event:${parsed.event_url}` : parsed.source.identity);
            if (!existing && (await tx.query('select id from scout.records where identity_key=$1',[identity])).rows.length) {
              // An event URL may be reused for a different edition or session.
              // The validated "new" decision must not silently become an update.
              identity=`${parsed.source.identity}:${hash(JSON.stringify([parsed.kind,parsed.title,parsed.starts_at,parsed.start_on]))}`;
            }
            target=await save(tx,identity,{...source,parsed:{...parsed,priority:decision.priority}},parsed.source.rank,parsed.source.observed_at,stats);
            dateWarnings.set(identity,target.warning);
          } else if (decision.record_id) {
            await tx.query('update scout.evidence set record_id=$2,last_seen_at=clock_timestamp(),authoritative=$3 where id=$1',[source.id,decision.record_id,parsed.source.rank===2]);
            target={recordId:decision.record_id,sourceId:source.id};
          }
          // Relevance uses combined evidence independently of which source wins
          // fact precedence. A weak source still cannot replace an official date.
          if (target && decision.candidate && decision.priority!==null) {
            const changed=await tx.query(`update scout.records set priority=$2
              where id=$1 and priority is distinct from $2 returning id`,[target.recordId,decision.priority]);
            if (changed.rows.length && stats.created===before.created && stats.changed===before.changed) stats.changed++;
            await tx.query("update scout.evidence set parsed=jsonb_set(parsed,'{assessment,priority_accepted}','true') where id=$1 and record_id is not null",[target.sourceId]);
          }
        });
        stats.assessed++;
      }
    } catch (error) { stats.warnings.push(error.message); quota ||= /quota|limit|429/.test(error.message); break; }
  }
  stats.pending=(await db.query(`select count(*)::int n from (${pendingQuery}) pending`,[tracker.id])).rows[0].n;
  if (stats.pending) stats.warnings.push(`${stats.pending} source assessments pending`);
  stats.warnings = [...new Set([...stats.warnings, ...dateWarnings.values()].filter(Boolean))];
  stats.requests = budget.requests;
  const outcome = quota ? 'quota' : feedFailed && stats.posts === 0 ? 'failed' : !covered || stats.warnings.length ? 'partial' : stats.created || stats.changed ? 'success' : 'no_change';
  const finished = now();
  await db.query('update scout.collection_runs set finished_at=$1,outcome=$2,stats=stats || $3::jsonb where id=$4', [finished, outcome, JSON.stringify(stats), run.id]);
  return { run_id: run.id, outcome, coverage_since: since, ...stats };
}
