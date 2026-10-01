import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { baseline, getDelivery, prepareDigest, prepareFindings, prepareVerification, recordReceipt, reprepareStale, sendDelivery, webhookTransport } from '../notifications/slack.js';

const now = new Date('2026-10-01T12:00:00Z');
const options = { now: () => now, wait: async () => {} };
async function database() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create table auth.identities (user_id uuid, provider text, identity_data jsonb);
    create function auth.uid() returns uuid language sql as $$select null::uuid$$;`);
  for (const name of (await readdir(new URL('../supabase/migrations/', import.meta.url))).sort()) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
  }
  return db;
}
async function insert(db, title = 'Public BBNJ announcement', extra = {}) {
  const row = { kind: 'announcement', title, summary: 'Source-backed description.', ...extra };
  const record = (await db.query(`insert into scout.records(${Object.keys(row).join(',')}) values(${Object.keys(row).map((_, i) => `$${i + 1}`).join(',')}) returning *`, Object.values(row))).rows[0];
  await db.query("insert into scout.sources(record_id,url) values($1,'https://example.org/bbnj')", [record.id]);
  return record;
}

test('explicit baseline does not flood history or swallow later new/material records', async () => {
  const db = await database();
  try {
    await assert.rejects(prepareFindings(db, now), /baseline first/);
    const historical = [];
    for (let i = 0; i < 12; i++) historical.push(await insert(db, `Historical ${i}`));
    const first = await baseline(db);
    assert.equal(first.snapshot.count, 12);
    assert.deepEqual(await prepareFindings(db, now), []);
    const added = await insert(db, '<!channel> Newly collected', { published_on: '2026-09-30' });
    assert.equal((await baseline(db)).id, first.id);
    await db.query('update scout.records set collected_at=now(),evidence_rank=2 where id=$1', [historical[0].id]);
    let prepared = await prepareFindings(db, now);
    assert.equal(prepared.length, 1);
    assert.equal(prepared[0].record_id, added.id);
    assert.equal(prepared[0].kind, 'finding');
    const containing = prepared[0].payload.blocks.find(block => block.text.text.includes('<!channel>'));
    assert.equal(containing.text.type, 'plain_text');
    assert.match(containing.text.text, /Published: 2026-09-30 · Collected:/);
    const payload = prepared[0].payload;
    let calls = 0;
    const post = async body => { calls++; assert.deepEqual(body, payload); return { status: 200, body: 'ok' }; };
    assert.equal((await sendDelivery(db, prepared[0].id, post, options)).status, 'sent');
    assert.equal((await sendDelivery(db, prepared[0].id, post, options)).attempts, 1);
    assert.equal(calls, 1);
    await db.query("update scout.records set title='Organizer correction' where id=$1", [historical[0].id]);
    prepared = await prepareFindings(db, now);
    assert.equal(prepared.length, 1);
    assert.equal(prepared[0].kind, 'change');
    assert.match(JSON.stringify(prepared[0].payload), /Historical 0 → Organizer correction/);
    assert.deepEqual(await prepareFindings(db, now), []);
    await db.exec('set role authenticated');
    await assert.rejects(db.query('select payload,snapshot from scout.deliveries'), /permission denied/);
    await db.exec('reset role');
  } finally { await db.close(); }
});

test('digest respects source-local windows, cancellation, past/ongoing and unknown dates', async () => {
  const db = await database();
  try {
    const events = [
      ['Past HSA event', { starts_at: '2026-09-29T11:30:00Z', time_zone: '-04:00' }],
      ['Cancelled', { start_on: '2026-10-03', status: 'cancelled' }],
      ['Local boundary', { starts_at: '2026-10-02T00:30:00Z', time_zone: '-04:00' }],
      ['Date only', { start_on: '2026-10-01' }],
      ['Ongoing', { starts_at: '2026-10-01T10:00:00Z', ends_at: '2026-10-01T14:00:00Z', time_zone: 'UTC' }],
      ['Unknown date', {}], ['Later', { start_on: '2026-10-09' }],
    ];
    for (const [title, fields] of events) await insert(db, title, { kind: 'event', ...fields });
    await baseline(db);
    const digest = await prepareDigest(db, '2026-10-01', '2026-10-01', now);
    assert.equal(digest.snapshot.records.length, 4);
    const text = JSON.stringify(digest.payload);
    assert.match(text, /3 qualifying events/);
    assert.match(text, /Date unknown: 1/);
    assert.match(text, /2026-10-01 · 20:30 UTC-04:00/);
    assert.doesNotMatch(text, /Past HSA event|Cancelled|Later/);
    assert.match(text, /Calendar download is unavailable/);
    assert.equal((await prepareDigest(db, '2026-10-01', '2026-10-01', new Date('2026-10-01T13:00:00Z'))).id, digest.id);
    await assert.rejects(prepareDigest(db, '2026-02-30', '2026-03-01', now), /window/);
    let calls = 0;
    const result = await sendDelivery(db, digest.id, async () => { calls++; }, { ...options, now: () => new Date('2026-10-03T00:00:00Z') });
    assert.equal(result.status, 'failed');
    assert.equal(calls, 0);
    const empty = await prepareDigest(db, '2026-10-04', '2026-10-07', now);
    assert.match(JSON.stringify(empty.payload), /No qualifying upcoming events/);
  } finally { await db.close(); }
});

test('rate limiting retries the exact payload once; permanent and prolonged rejection stay failed', async () => {
  const db = await database();
  try {
    await baseline(db);
    for (let i = 0; i < 4; i++) await insert(db, `Transient ${i}`);
    const rows = await prepareFindings(db, now);
    let calls = 0;
    const waits = [], bodies = [];
    const result = await sendDelivery(db, rows[0].id, async body => { bodies.push(body); return ++calls === 1 ? { status: 429, body: 'rate_limited', retryAfter: '2' } : { status: 200, body: 'ok' }; }, { ...options, wait: async ms => waits.push(ms) });
    assert.equal(result.status, 'sent');
    assert.equal(result.attempts, 2);
    assert.deepEqual(bodies[0], bodies[1]);
    assert.ok(waits.includes(2000));
    calls = 0;
    for (const [row, response, attempts] of [[rows[1], { status: 429, retryAfter: '0' }, 2], [rows[2], { status: 429, retryAfter: '31' }, 1], [rows[3], { status: 400 }, 1]]) {
      const post = async () => { calls++; return response; };
      const rejected = await sendDelivery(db, row.id, post, options);
      assert.equal(rejected.status, 'failed');
      assert.equal(rejected.attempts, attempts);
      assert.equal(rejected.sent_at, null);
      assert.equal((await sendDelivery(db, row.id, post, options)).attempts, attempts);
    }
    assert.equal(calls, 4);
  } finally { await db.close(); }
});

test('ambiguous outcomes and interrupted sends require evidence-based reconciliation, never resend', async () => {
  const db = await database();
  try {
    await baseline(db);
    for (let i = 0; i < 4; i++) await insert(db, `Ambiguous ${i}`);
    const rows = await prepareFindings(db, now);
    for (const [row, post] of [[rows[0], async () => { throw new Error('timeout secret URL must not be stored'); }], [rows[1], async () => ({ status: 503, body: 'error' })], [rows[2], async () => ({ status: 200, body: 'unexpected' })]]) {
      assert.equal((await sendDelivery(db, row.id, post, options)).status, 'unknown');
      await sendDelivery(db, row.id, async () => assert.fail('No repost'), options);
      assert.doesNotMatch((await getDelivery(db, row.id)).error, /secret URL/);
    }
    await db.query("update scout.deliveries set status='sending',attempts=1 where id=$1", [rows[3].id]);
    assert.equal((await sendDelivery(db, rows[3].id, async () => assert.fail('No interrupted resend'), options)).status, 'unknown');
    await db.query("update scout.records set title='New evidence while delivery unknown' where id=$1", [rows[0].record_id]);
    assert.deepEqual(await prepareFindings(db, now), []);
    await assert.rejects(recordReceipt(db, rows[0].id, 'bad', ''), /Receipt requires/);
    const receipt = await recordReceipt(db, rows[0].id, '1790856000.123456', 'Read matching delivery UUID in #scout.');
    assert.equal(receipt.status, 'sent');
    assert.equal(receipt.slack_ts, '1790856000.123456');
    assert.equal((await prepareFindings(db, now))[0].kind, 'change');
  } finally { await db.close(); }
});

test('verification freezes one historical payload; changed evidence blocks stale sends and webhook binding is fixed', async () => {
  const db = await database();
  try {
    const record = await insert(db, 'Historical source');
    await baseline(db);
    const row = await prepareVerification(db, record.id, now);
    assert.match(JSON.stringify(row.payload), /verification · historical source example/);
    assert.equal((await prepareVerification(db, record.id, now)).id, row.id);
    await db.query("update scout.records set title='Correction' where id=$1", [record.id]);
    const result = await sendDelivery(db, row.id, async () => assert.fail('No stale send'), options);
    assert.equal(result.status, 'failed');
    assert.equal(result.attempts, 0);
    assert.match(JSON.stringify(result.payload), /Historical source/);
    for (const url of ['https://example.org', 'https://hooks.slack.com/services/OTHER/B0C5TEK4R38/secret', 'https://hooks.slack.com/services/TFZ8FRLBV/B0C5TEK4R38/secret?redirect=x']) assert.throws(() => webhookTransport(url));
    assert.equal(typeof webhookTransport('https://hooks.slack.com/services/TFZ8FRLBV/B0C5TEK4R38/placeholder'), 'function');
  } finally { await db.close(); }
});

test('explicit recovery preserves a stale empty digest and delivers the updated window once', async () => {
  const db = await database();
  try {
    await baseline(db);
    const original = await prepareDigest(db, '2026-10-01', '2026-10-07', now);
    const event = await insert(db, 'Newly collected October event', { kind: 'event', start_on: '2026-10-03' });
    let calls = 0;
    const post = async () => { calls++; return { status: 200, body: 'ok' }; };
    const stale = await sendDelivery(db, original.id, post, options);
    assert.equal(stale.status, 'failed');
    assert.equal(stale.attempts, 0);
    assert.equal(calls, 0);
    assert.equal((await prepareDigest(db, '2026-10-01', '2026-10-07', now)).id, original.id);
    const replacement = await reprepareStale(db, original.id, now);
    assert.notEqual(replacement.id, original.id);
    assert.equal(replacement.status, 'pending');
    assert.equal(replacement.snapshot.replaces, original.id);
    assert.equal(replacement.snapshot.records[0].id, event.id);
    assert.match(JSON.stringify(replacement.payload), /Newly collected October event/);
    assert.deepEqual(await getDelivery(db, original.id), stale);
    assert.equal((await reprepareStale(db, original.id, now)).id, replacement.id);
    assert.equal((await prepareDigest(db, '2026-10-01', '2026-10-07', now)).id, replacement.id);
    assert.equal((await sendDelivery(db, replacement.id, post, options)).status, 'sent');
    await assert.rejects(reprepareStale(db, replacement.id, now), /Only stale/);
    const repeated = await prepareDigest(db, '2026-10-01', '2026-10-07', now);
    await sendDelivery(db, repeated.id, post, options);
    assert.equal((await reprepareStale(db, original.id, now)).id, repeated.id);
    assert.equal(calls, 1);
    assert.deepEqual(await getDelivery(db, original.id), stale);
  } finally { await db.close(); }
});

test('timing-only and changed-version findings recover without losing evidence or creating duplicates', async () => {
  const db = await database();
  try {
    await baseline(db);
    const event = await insert(db, 'Source-backed timed event', { kind: 'event', starts_at: '2026-10-01T13:00:00Z', ends_at: '2026-10-01T15:00:00Z', time_zone: 'UTC' });
    const [original] = await prepareFindings(db, now);
    let later = new Date('2026-10-01T14:00:00Z');
    const laterOptions = { ...options, now: () => later };
    let calls = 0;
    const post = async () => { calls++; return { status: 200, body: 'ok' }; };
    const stale = await sendDelivery(db, original.id, post, laterOptions);
    assert.equal(stale.attempts, 0);
    const inProgress = await reprepareStale(db, original.id, later);
    assert.match(JSON.stringify(inProgress.payload), /In progress/);
    later = new Date('2026-10-01T16:00:00Z');
    const staleAgain = await sendDelivery(db, inProgress.id, post, laterOptions);
    assert.equal(staleAgain.attempts, 0);
    const replacement = await reprepareStale(db, inProgress.id, later);
    assert.equal((await reprepareStale(db, original.id, later)).id, replacement.id);
    assert.deepEqual(await getDelivery(db, inProgress.id), staleAgain);
    assert.equal(replacement.snapshot.records[0].version, original.snapshot.records[0].version);
    assert.match(JSON.stringify(replacement.payload), /Past \/ started/);
    assert.match(JSON.stringify(original.payload), /Upcoming/);
    assert.deepEqual(await getDelivery(db, original.id), stale);
    await sendDelivery(db, replacement.id, post, laterOptions);
    await sendDelivery(db, replacement.id, post, laterOptions);
    assert.deepEqual(await prepareFindings(db, later), []);
    assert.equal(calls, 1);
    await db.query("update scout.records set title='Organizer correction' where id=$1", [event.id]);
    const [change] = await prepareFindings(db, later);
    await db.query("update scout.records set title='Later organizer correction' where id=$1", [event.id]);
    assert.equal((await sendDelivery(db, change.id, post, laterOptions)).status, 'failed');
    const corrected = await reprepareStale(db, change.id, later);
    assert.equal(corrected.kind, 'change');
    assert.match(JSON.stringify(corrected.payload), /Later organizer correction/);
    assert.deepEqual(await prepareFindings(db, later), []);
    await sendDelivery(db, corrected.id, post, laterOptions);
    assert.deepEqual(await prepareFindings(db, later), []);
    assert.equal(calls, 2);
  } finally { await db.close(); }
});

test('recovery cannot replace baseline, pending, sending, unknown, sent or attempted failures', async () => {
  const db = await database();
  try {
    const history = await baseline(db);
    await assert.rejects(reprepareStale(db, history.id, now), /Only stale/);
    const original = await prepareDigest(db, '2026-10-01', '2026-10-07', now);
    await assert.rejects(reprepareStale(db, original.id, now), /Only stale/);
    await insert(db, 'New date', { kind: 'event', start_on: '2026-10-03' });
    await sendDelivery(db, original.id, async () => assert.fail('Stale sends never call transport'), options);
    const replacement = await reprepareStale(db, original.id, now);
    await sendDelivery(db, replacement.id, async () => { throw new Error('Timeout'); }, options);
    await assert.rejects(reprepareStale(db, replacement.id, now), /Only stale/);
    assert.equal((await reprepareStale(db, original.id, now)).status, 'unknown');
    assert.equal((await prepareDigest(db, '2026-10-01', '2026-10-07', now)).id, replacement.id);
    const attempted = await prepareDigest(db, '2026-10-08', '2026-10-14', now);
    await sendDelivery(db, attempted.id, async () => ({ status: 400 }), options);
    await assert.rejects(reprepareStale(db, attempted.id, now), /Only stale/);
    const interrupted = await prepareDigest(db, '2026-10-15', '2026-10-21', now);
    await db.query("update scout.deliveries set status='sending',attempts=1 where id=$1", [interrupted.id]);
    await assert.rejects(reprepareStale(db, interrupted.id, now), /Only stale/);
    assert.equal((await db.query('select count(*)::int n from scout.deliveries')).rows[0].n, 5);
  } finally { await db.close(); }
});
