import { test, mock } from 'node:test';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { collectHSA, HSA, sourceURL, readPublic } from '../collector/hsa.js';
import { baseline, prepareFindings } from '../notifications/slack.js';

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

test('HTTP transport rejects private and mixed DNS answers before opening a source socket', async () => {
  for (const addresses of [[{ address: '127.0.0.1', family: 4 }], [{ address: 'fd00::1', family: 6 }],
    [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }]]) {
    const resolver = mock.method(dns, 'lookup', (_host, _options, callback) => callback(null, addresses));
    syncBuiltinESMExports();
    try {
      await assert.rejects(readPublic('https://example.test/source', { requests: 0, deadline: Date.now() + 1000 }), /Non-public source address/);
    } finally { resolver.mock.restore(); syncBuiltinESMExports(); }
  }
});

async function database() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users (id uuid primary key, raw_app_meta_data jsonb default '{}');
    create table auth.identities (user_id uuid, provider text, identity_data jsonb);
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
    assert.equal(Object.hasOwn(initial, 'time_zone'), false);
    assert.equal(initial.status, 'scheduled');
    assert.equal(initial.evidence_rank, 2);
    assert.equal((await db.query('select * from scout.current_evidence')).rows.length, 2);
    const captured = (await db.query('select * from scout.evidence where id=$1', [initial.date_evidence.schedule_source])).rows[0];
    assert.equal(captured.record_id, initial.id);
    assert.equal(captured.content, page);
    await baseline(db);
    const success = (await db.query('select last_success_at from scout.tracker_status where id=(select tracker_id from scout.collection_runs limit 1)')).rows[0].last_success_at;
    const versionCount = (await db.query('select count(*)::int n from scout.evidence')).rows[0].n;
    const repeat = await collectHSA(db, { since, read, now });
    assert.equal(repeat.outcome, 'no_change');
    assert.equal((await db.query('select * from scout.records')).rows[0].updated_at.getTime(), initial.updated_at.getTime());
    assert.equal((await db.query('select count(*)::int n from scout.evidence')).rows[0].n, versionCount);
    assert.deepEqual(await prepareFindings(db), []);
    assert.ok((await db.query('select last_success_at from scout.tracker_status where id=(select tracker_id from scout.collection_runs limit 1)')).rows[0].last_success_at > success);
    // Later captures may lack a schedule; the establishing capture still proves it.
    page = '<html>No structured schedule currently available</html>';
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal((await collectHSA(db, { since, read, now })).outcome, 'partial');
      assert.deepEqual((await db.query('select starts_at from scout.records')).rows[0].starts_at, initial.starts_at);
      assert.deepEqual((await db.query('select updated_at from scout.records')).rows[0].updated_at, initial.updated_at);
    }
    page = html('2026-10-15T14:00:00Z', 'EventRescheduled');
    assert.equal((await collectHSA(db, { since, read, now })).changed, 1);
    const rescheduled = (await db.query('select * from scout.records')).rows[0];
    assert.equal(rescheduled.starts_at.toISOString(), '2026-10-15T14:00:00.000Z');
    assert.equal(rescheduled.status, 'rescheduled');
    assert.notEqual(rescheduled.date_evidence.schedule_source, initial.date_evidence.schedule_source);
    assert.equal((await db.query('select content from scout.evidence where id=$1', [rescheduled.date_evidence.schedule_source])).rows[0].content, page);
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
    assert.equal((await db.query('select * from scout.current_evidence')).rows.length, 3);
    assert.ok((await db.query('select * from scout.evidence')).rows.length >= 6);
    const [notification] = await prepareFindings(db);
    assert.equal(notification.kind, 'change');
    assert.match(notification.payload.blocks[1].text.text, /2026-10-08.*→.*2026-10-15/);
    assert.match(notification.payload.blocks[1].text.text, /status: scheduled → cancelled/);
    // The organizer may deliberately return to a previously seen date/version.
    page = html('2026-10-08T14:00:00Z');
    assert.equal((await collectHSA(db, { since, read, now })).changed, 1);
    assert.equal((await db.query('select * from scout.records')).rows[0].starts_at.toISOString(), '2026-10-08T14:00:00.000Z');
    await db.exec('set role authenticated');
    await assert.rejects(db.query('select * from scout.evidence'), { code: '42501' });
  } finally { await db.close(); }
});

test('shared pages get independent record evidence without duplicate captures on repeat collection', async () => {
  const db = await database();
  const sharedURL = 'https://highseasalliance.org/supporting-page';
  const feed = ['first','second'].map(key => {
    const post = fixturePost(key, `Register for our BBNJ ${key} webinar.`, undefined, HSA, `https://highseasalliance.org/events/${key}`);
    post.post.record.facets.push({ features: [{ $type: 'app.bsky.richtext.facet#link', uri: sharedURL }] });
    return post;
  });
  const read = async (url, budget) => {
    budget.requests++;
    return { url, headers: { 'content-type': 'text/html' }, body: url.includes('/xrpc/') ? JSON.stringify({ feed }) :
      url === sharedURL ? '<html>Supporting BBNJ information</html>' : html('2026-10-08T14:00:00Z').replaceAll(eventURL, url) };
  };
  try {
    const first = await collectHSA(db, { since, read });
    assert.equal(first.created, 2);
    const records = (await db.query('select * from scout.records order by id')).rows;
    const copies = (await db.query('select * from scout.evidence where url=$1 order by record_id', [sharedURL])).rows;
    assert.deepEqual(copies.map(row => row.record_id), records.map(row => row.id));
    assert.notEqual(copies[0].id, copies[1].id);
    assert.equal(copies[0].content, copies[1].content);
    assert.equal((await db.query('select * from scout.evidence')).rows.length, 6);
    assert.equal((await db.query('select * from scout.current_evidence')).rows.length, 6);
    assert.equal((await collectHSA(db, { since, read })).changed, 0);
    assert.equal((await db.query('select * from scout.evidence')).rows.length, 6);
    assert.deepEqual((await db.query('select * from scout.records order by id')).rows, records);
  } finally { await db.close(); }
});

test('missing/ambiguous dates and irrelevant posts stay honest; fetch failures preserve records and success', async () => {
  const db = await database();
  let response = { feed: [fixturePost('unknown', 'Join our BBNJ webinar. Date to follow.', undefined, HSA, null), fixturePost('irrelevant', 'Lunch with friends.', undefined, HSA, null)] };
  const read = async (url, budget) => { budget.requests++; return { url, headers: {}, body: JSON.stringify(response) }; };
  try {
    assert.equal((await collectHSA(db, { since, read })).outcome, 'success');
    const record = (await db.query('select * from scout.records')).rows[0];
    assert.equal(Object.hasOwn(record, 'start_on'), false);
    assert.equal(record.starts_at, null);
    assert.equal(Object.hasOwn(record, 'time_zone'), false);
    assert.equal((await db.query('select * from scout.records')).rows.length, 1);
    assert.equal((await db.query('select * from scout.evidence where record_id is null')).rows.length, 1);
    assert.equal((await db.query('select * from scout.current_evidence')).rows.length, 1);
    const previousSuccess = (await db.query("select last_success_at from scout.tracker_status where seed_key like '%:17'")).rows[0].last_success_at;
    const failed = await collectHSA(db, { since, read: async () => { throw new Error('Fixture unavailable'); } });
    assert.equal(failed.outcome, 'failed');
    assert.equal((await db.query('select * from scout.records')).rows.length, 1);
    const expired = await collectHSA(db, { since, read, deadline: 0 });
    assert.equal(expired.outcome, 'failed');
    assert.deepEqual(expired.warnings, ['Collection time limit reached']);
    response = { feed: [fixturePost('unknown', 'Join our BBNJ webinar. Date to follow.', undefined, HSA, null)], cursor: 'more' };
    assert.equal((await collectHSA(db, { since, read })).outcome, 'partial');
    const quota = await collectHSA(db, { since, read: async () => { throw Object.assign(new Error('HTTP 429'), { quota: true }); } });
    assert.equal(quota.outcome, 'quota');
    assert.equal((await db.query("select last_success_at from scout.tracker_status where seed_key like '%:17'")).rows[0].last_success_at.getTime(), previousSuccess.getTime());
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
    assert.equal(Object.hasOwn(row, 'start_on'), false);
    assert.equal((await db.query('select parsed from scout.evidence where url=$1', [eventURL])).rows[0].parsed.start_on, '2026-10-20');
    assert.equal(row.starts_at, null);
    assert.equal(Object.hasOwn(row, 'time_zone'), false);
    page = null;
    assert.equal((await collectHSA(db, { since, read })).outcome, 'partial');
    assert.equal((await db.query('select * from scout.records')).rows[0].starts_at, null);
  } finally { await db.close(); }
});

test('source URLs reject local/IP/credential URLs before network access', () => {
  for (const url of ['http://example.org', 'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://user:password@example.org']) assert.throws(() => sourceURL(url));
  assert.equal(sourceURL('https://example.org/event?utm_source=bluesky&id=1#top'), 'https://example.org/event?id=1');
});

test('new HSA corrections survive unavailable and unchanged pages; genuine later organizer facts win', async () => {
  const db = await database();
  let feed = [fixturePost('original', 'Register for our BBNJ webinar on 2026-10-08.')];
  let page = html('2026-10-08T14:00:00Z');
  let clock = Date.parse('2026-09-20T12:00:00Z');
  const now = () => new Date(clock += 1000).toISOString();
  const read = async (url, budget) => {
    budget.requests++;
    if (url.includes('/xrpc/')) return { url, headers: {}, body: JSON.stringify({ feed }) };
    if (!page) throw new Error('Organizer unavailable');
    return { url, headers: { 'content-type': 'text/html' }, body: page };
  };
  try {
    await collectHSA(db, { since, read, now });
    assert.equal((await db.query('select status from scout.records')).rows[0].status, 'scheduled');
    assert.equal((await db.query('select evidence_at from scout.current_evidence where url=$1', [eventURL])).rows[0].evidence_at, null);
    feed = [fixturePost('cancellation', 'Our BBNJ webinar is cancelled. Registration update to follow.', '2026-09-21T10:00:00Z')];
    clock = Date.parse('2026-09-22T12:00:00Z');
    page = null;
    assert.equal((await collectHSA(db, { since, read, now })).outcome, 'partial');
    const cancelled = (await db.query('select * from scout.records')).rows[0];
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.evidence_at.toISOString(), '2026-09-21T10:00:00.000Z');
    page = html('2026-10-08T14:00:00Z', 'EventScheduled', 'Cosmetically updated page text.');
    for (let repeat = 0; repeat < 2; repeat++) {
      assert.equal((await collectHSA(db, { since, read, now })).changed, 0);
      const row = (await db.query('select * from scout.records')).rows[0];
      assert.equal(row.status, 'cancelled');
      assert.equal(row.updated_at.getTime(), cancelled.updated_at.getTime());
      assert.equal(row.evidence_at.getTime(), cancelled.evidence_at.getTime());
    }
    feed = [fixturePost('old-repost', 'Register for the BBNJ webinar on 2026-10-08.', '2026-09-10T10:00:00Z', 'other.bsky.social')];
    assert.equal((await collectHSA(db, { since, read, now })).changed, 0);
    assert.equal((await db.query('select status from scout.records')).rows[0].status, 'cancelled');
    clock = Date.parse('2026-09-24T12:00:00Z');
    page = html('2026-10-15T14:00:00Z', 'EventRescheduled');
    assert.equal((await collectHSA(db, { since, read, now })).changed, 1);
    assert.equal((await db.query('select status from scout.records')).rows[0].status, 'rescheduled');
    feed = [fixturePost('new-cancellation', 'Our BBNJ webinar is cancelled.', '2026-09-25T10:00:00Z')];
    clock = Date.parse('2026-09-26T12:00:00Z');
    assert.equal((await collectHSA(db, { since, read, now })).changed, 1);
    assert.equal((await db.query('select status from scout.records')).rows[0].status, 'cancelled');
    assert.equal((await collectHSA(db, { since, read, now })).changed, 0);
  } finally { await db.close(); }
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
    assert.equal(Object.hasOwn(row, 'start_on'), false);
    assert.equal(row.starts_at, null);
    assert.equal(Object.hasOwn(row, 'time_zone'), false);
    assert.match(row.title, /Marine Genetic Resources/);
    const source = (await db.query("select parsed from scout.evidence where published_at is null")).rows[0].parsed;
    assert.equal(source.start_on, '2026-09-29');
    assert.match(source.title, /Marine Genetic Resources and Digital Sequence Information/);
    assert.deepEqual(source.local_schedule, { date: '2026-09-29', month: 9, day: 29, hour: 7, minute: 30 });
    assert.equal(Array.from(row.description).length, 280);
    const count = (await db.query('select count(*)::int n from scout.evidence')).rows[0].n;
    page += '<script nonce="different-every-request">/* irrelevant page script */</script>';
    const again = await collectHSA(db, { since, read });
    assert.equal(again.created, 0);
    assert.equal(again.changed, 0);
    assert.equal((await db.query('select count(*)::int n from scout.evidence')).rows[0].n, count);
  } finally { await db.close(); }
});

test('descriptions are bounded while full evidence and stable record versions survive', async () => {
  const db = await database();
  const text = 'BBNJ update: ' + '🌊'.repeat(300);
  const read = async (url, budget) => {
    budget.requests++;
    return { url, headers: {}, body: JSON.stringify({ feed: [fixturePost('long', text, undefined, HSA, null)] }) };
  };
  try {
    assert.equal((await collectHSA(db, { since, read })).outcome, 'success');
    const record = (await db.query('select * from scout.records')).rows[0];
    assert.equal(Array.from(record.description).length, 280);
    assert.ok(record.description.endsWith('…'));
    for (const field of ['summary', 'start_on', 'end_on', 'published_on', 'country', 'treaty_action', 'recorded_on', 'collected_at']) assert.equal(Object.hasOwn(record, field), false);
    const source = (await db.query('select * from scout.evidence')).rows[0];
    assert.equal(source.parsed.description, text);
    assert.equal(JSON.parse(source.content).text, text);
    assert.equal(Object.hasOwn(record, 'material_hash'), false);
    await db.query("update scout.evidence set content_hash=replace(content_hash,'hsa-v3:','hsa-v2:'),parsed=parsed || $1 where id=$2",
      [{ summary: text, published_on: '2026-09-30' }, source.id]);
    const migrated = (await db.query('select * from scout.records')).rows[0];
    assert.equal((await collectHSA(db, { since, read })).outcome, 'no_change');
    assert.equal((await db.query('select updated_at from scout.records')).rows[0].updated_at.getTime(), migrated.updated_at.getTime());
    assert.equal((await db.query('select content from scout.evidence where id=$1', [source.id])).rows[0].content, source.content);
  } finally { await db.close(); }
});

test('matching real HSA and Zoom components supply a proven time zone; conflicts stay explicit', async () => {
  const db = await database();
  const newer = JSON.parse(await readFile(new URL('./fixtures/hsa-webinar.json', import.meta.url), 'utf8'));
  const earlier = JSON.parse(await readFile(new URL('./fixtures/hsa-webinar-time.json', import.meta.url), 'utf8'));
  let feed = [newer, earlier];
  let page = await readFile(new URL('./fixtures/hsa-zoom.html', import.meta.url), 'utf8');
  const read = async (url, budget) => {
    budget.requests++;
    return { url, headers: { 'content-type': 'text/html' }, body: url.includes('/xrpc/') ? JSON.stringify({ feed }) : page };
  };
  try {
    assert.equal((await collectHSA(db, { since, read })).outcome, 'success');
    const row = (await db.query('select * from scout.records')).rows[0];
    assert.equal(row.starts_at.toISOString(), '2026-09-29T11:30:00.000Z');
    assert.equal(Object.hasOwn(row, 'time_zone'), false);
    assert.equal(Object.hasOwn(row, 'start_on'), false);
    const versions = (await db.query('select id,parsed,url from scout.evidence')).rows;
    const zone = versions.find(item => item.id === row.date_evidence.zone_source);
    assert.equal(zone.parsed.date_parts.zone, 'EDT');
    assert.match(zone.url, /3mvkyjyep6m24$/);
    assert.equal(versions.find(item => item.id === row.date_evidence.schedule_source).parsed.local_schedule.date, '2026-09-29');
    for (let repeat = 0; repeat < 2; repeat++) {
      assert.equal((await collectHSA(db, { since, read })).outcome, 'no_change');
      assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n, 1);
      assert.equal((await db.query('select updated_at from scout.records')).rows[0].updated_at.getTime(), row.updated_at.getTime());
    }
    // The time-zone evidence survives a later run containing only the newer post.
    feed = [newer];
    page += '<script nonce="changed">/* unrelated */</script>';
    assert.equal((await collectHSA(db, { since, read })).outcome, 'no_change');
    assert.equal((await db.query('select starts_at from scout.records')).rows[0].starts_at.toISOString(), '2026-09-29T11:30:00.000Z');
    page = page.replace('07:30 AM', '08:30 AM');
    const conflict = await collectHSA(db, { since, read });
    assert.equal(conflict.outcome, 'partial');
    assert.match(conflict.warnings.join(' '), /registration 2026-09-29 08:30; HSA post 9\/29 07:30 EDT/);
    const unresolved = (await db.query('select * from scout.records')).rows[0];
    assert.equal(Object.hasOwn(unresolved, 'start_on'), false);
    assert.equal(unresolved.starts_at, null);
    assert.equal(Object.hasOwn(unresolved, 'time_zone'), false);
    assert.equal((await collectHSA(db, { since, read })).changed, 0);
  } finally { await db.close(); }
});
