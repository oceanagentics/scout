import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { collectHSA, HSA, sourceURL } from '../collector/hsa.js';

const since = '2026-09-01T00:00:00Z';
const eventURL = 'https://highseasalliance.org/events/bbnj-webinar/';
const fixturePost = (key, text, createdAt = '2026-09-20T10:00:00Z', author = HSA, url = eventURL) => ({
  post: { uri: `at://did:plc:fixture/app.bsky.feed.post/${key}`, author: { handle: author }, indexedAt: '2026-09-30T10:00:00Z',
    record: { text, createdAt, facets: url ? [{ features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }] }] : [] } },
});
const html = (startDate, eventStatus = 'EventScheduled', description = 'BBNJ implementation webinar.') => `<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'Event', name: 'BBNJ implementation webinar', startDate,
  eventStatus: `https://schema.org/${eventStatus}`, organizer: { name: 'High Seas Alliance' }, description, url: eventURL,
})}</script>`;

async function database() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql as $$select null::uuid$$;`);
  for (const name of (await readdir(new URL('../supabase/migrations/', import.meta.url))).sort()) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
  }
  await db.exec(await readFile(new URL('../supabase/seeds/trackers.sql', import.meta.url), 'utf8'));
  return db;
}

test('initial, unchanged, rescheduled, cosmetic, cancelled, and older repost keep source evidence', async () => {
  const db = await database();
  let feed = [fixturePost('new', 'Register for our BBNJ webinar on 2026-10-08.')];
  let page = html('2026-10-08T14:00:00Z');
  let clock = Date.now();
  const now = () => new Date(clock += 1000).toISOString();
  const read = async (url, budget) => {
    budget.requests++;
    return { url, headers: { 'content-type': url.includes('/xrpc/') ? 'application/json' : 'text/html' }, body: url.includes('/xrpc/') ? JSON.stringify({ feed }) : page };
  };
  try {
    const first = await collectHSA(db, { since, read, now });
    assert.equal(first.outcome, 'success');
    const initial = (await db.query('select * from scout.records')).rows[0];
    assert.equal(initial.starts_at.toISOString(), '2026-10-08T14:00:00.000Z');
    assert.equal(initial.time_zone, 'UTC');
    assert.equal(initial.status, 'scheduled');
    assert.equal(initial.evidence_rank, 2);
    assert.equal((await db.query('select * from scout.sources')).rows.length, 2);
    const success = (await db.query('select last_success_at from scout.trackers where id=(select tracker_id from scout.collection_runs limit 1)')).rows[0].last_success_at;
    const versionCount = (await db.query('select count(*)::int n from scout.source_versions')).rows[0].n;
    const repeat = await collectHSA(db, { since, read, now });
    assert.equal(repeat.outcome, 'no_change');
    assert.equal((await db.query('select * from scout.records')).rows[0].updated_at.getTime(), initial.updated_at.getTime());
    assert.equal((await db.query('select count(*)::int n from scout.source_versions')).rows[0].n, versionCount);
    assert.ok((await db.query('select last_success_at from scout.trackers where id=(select tracker_id from scout.collection_runs limit 1)')).rows[0].last_success_at > success);
    page = html('2026-10-15T14:00:00Z', 'EventRescheduled');
    assert.equal((await collectHSA(db, { since, read, now })).changed, 1);
    const rescheduled = (await db.query('select * from scout.records')).rows[0];
    assert.equal(rescheduled.starts_at.toISOString(), '2026-10-15T14:00:00.000Z');
    assert.equal(rescheduled.status, 'rescheduled');
    page = html('2026-10-15T14:00:00Z', 'EventRescheduled', 'BBNJ   implementation webinar.');
    assert.equal((await collectHSA(db, { since, read, now })).outcome, 'no_change');
    page = html('2026-10-15T14:00:00Z', 'EventCancelled');
    await collectHSA(db, { since, read, now });
    feed = [fixturePost('older', 'BBNJ webinar on 2026-10-08. Register now!', '2026-09-10T10:00:00Z', 'other.bsky.social')];
    const older = await collectHSA(db, { since, read, now });
    assert.equal(older.outcome, 'no_change');
    const final = (await db.query('select * from scout.records')).rows;
    assert.equal(final.length, 1);
    assert.equal(final[0].status, 'cancelled');
    assert.equal(final[0].starts_at.toISOString(), '2026-10-15T14:00:00.000Z');
    assert.equal((await db.query('select * from scout.sources')).rows.length, 3);
    assert.equal((await db.query('select * from scout.record_changes')).rows.length, 4);
    assert.ok((await db.query('select * from scout.source_versions')).rows.length >= 6);
    // The organizer may deliberately return to a previously seen date/version.
    page = html('2026-10-08T14:00:00Z');
    assert.equal((await collectHSA(db, { since, read, now })).changed, 1);
    assert.equal((await db.query('select * from scout.records')).rows[0].starts_at.toISOString(), '2026-10-08T14:00:00.000Z');
    await db.exec('set role authenticated');
    await assert.rejects(db.query('select * from scout.source_versions'), { code: '42501' });
  } finally { await db.close(); }
});

test('missing/ambiguous dates and irrelevant posts stay honest; fetch failures preserve records and success', async () => {
  const db = await database();
  let response = { feed: [fixturePost('unknown', 'Join our BBNJ webinar. Date to follow.', undefined, HSA, null), fixturePost('irrelevant', 'Lunch with friends.', undefined, HSA, null)] };
  const read = async (url, budget) => { budget.requests++; return { url, headers: {}, body: JSON.stringify(response) }; };
  try {
    assert.equal((await collectHSA(db, { since, read })).outcome, 'success');
    const record = (await db.query('select * from scout.records')).rows[0];
    assert.equal(record.start_on, null);
    assert.equal(record.starts_at, null);
    assert.equal(record.time_zone, null);
    assert.equal((await db.query('select * from scout.records')).rows.length, 1);
    const previousSuccess = (await db.query("select last_success_at from scout.trackers where seed_key like '%:17'")).rows[0].last_success_at;
    const failed = await collectHSA(db, { since, read: async () => { throw new Error('Fixture unavailable'); } });
    assert.equal(failed.outcome, 'failed');
    assert.equal((await db.query('select * from scout.records')).rows.length, 1);
    response = { feed: [fixturePost('unknown', 'Join our BBNJ webinar. Date to follow.', undefined, HSA, null)], cursor: 'more' };
    assert.equal((await collectHSA(db, { since, read })).outcome, 'partial');
    const quota = await collectHSA(db, { since, read: async () => { throw Object.assign(new Error('HTTP 429'), { quota: true }); } });
    assert.equal(quota.outcome, 'quota');
    assert.equal((await db.query("select last_success_at from scout.trackers where seed_key like '%:17'")).rows[0].last_success_at.getTime(), previousSuccess.getTime());
    assert.equal((await db.query('select * from scout.records')).rows[0].updated_at.getTime(), record.updated_at.getTime());
  } finally { await db.close(); }
});

test('structured date-only events and page failures preserve facts and partial state', async () => {
  const db = await database();
  let page = html('2026-10-20');
  const read = async (url, budget) => {
    budget.requests++;
    if (url.includes('/xrpc/')) return { url, headers: {}, body: JSON.stringify({ feed: [fixturePost('day', 'BBNJ webinar. Register now!')] }) };
    if (!page) throw new Error('Organizer unavailable');
    return { url, headers: { 'content-type': 'text/html' }, body: page };
  };
  try {
    await collectHSA(db, { since, read });
    const row = (await db.query('select * from scout.records')).rows[0];
    assert.equal(row.start_on.toISOString().slice(0, 10), '2026-10-20');
    assert.equal(row.starts_at, null);
    assert.equal(row.time_zone, null);
    page = null;
    assert.equal((await collectHSA(db, { since, read })).outcome, 'partial');
    assert.equal((await db.query('select * from scout.records')).rows[0].start_on.toISOString().slice(0, 10), '2026-10-20');
  } finally { await db.close(); }
});

test('source URLs reject local/IP/credential URLs before network access', () => {
  for (const url of ['http://example.org', 'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://user:password@example.org']) assert.throws(() => sourceURL(url));
  assert.equal(sourceURL('https://example.org/event?utm_source=bluesky&id=1#top'), 'https://example.org/event?id=1');
});

test('recorded HSA/Zoom evidence stores the date but does not invent a time zone', async () => {
  const db = await database();
  const post = JSON.parse(await readFile(new URL('./fixtures/hsa-webinar.json', import.meta.url), 'utf8'));
  let page = await readFile(new URL('./fixtures/hsa-zoom.html', import.meta.url), 'utf8');
  const read = async (url, budget) => {
    budget.requests++;
    return { url, headers: { 'content-type': 'text/html' }, body: url.includes('/xrpc/') ? JSON.stringify({ feed: [post] }) : page };
  };
  try {
    const first = await collectHSA(db, { since, read });
    assert.equal(first.outcome, 'partial');
    assert.match(first.warnings.join(' '), /without a time zone/);
    const row = (await db.query('select * from scout.records')).rows[0];
    assert.equal(row.start_on.toISOString().slice(0, 10), '2026-09-29');
    assert.equal(row.starts_at, null);
    assert.equal(row.time_zone, null);
    assert.match(row.title, /Marine Genetic Resources and Digital Sequence Information/);
    assert.match(row.description, /07:30 AM/);
    const count = (await db.query('select count(*)::int n from scout.source_versions')).rows[0].n;
    page += '<script nonce="different-every-request">/* irrelevant page script */</script>';
    const again = await collectHSA(db, { since, read });
    assert.equal(again.created, 0);
    assert.equal(again.changed, 0);
    assert.equal((await db.query('select count(*)::int n from scout.source_versions')).rows[0].n, count);
  } finally { await db.close(); }
});
