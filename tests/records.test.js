import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventLabel, eventTiming, filterRecords, recordDates, sourceLink, trackerState } from '../src/records.js';
import { loadScout } from '../src/dashboard.js';

const now = new Date('2026-10-01T12:00:00Z');
const hsa = { id: 'hsa-webinar', kind: 'event', title: 'Unpacking Part II of BBNJ: Marine Genetic Resources and Digital Sequence Information', organization: 'High Seas Alliance',
  starts_at: '2026-09-29T11:30:00Z', time_zone: '-04:00', updated_at: '2026-10-01T05:23:54Z', date_evidence: { time_zone: { value: 'EDT' } },
  sources: [{ url: 'https://us06web.zoom.us/webinar/register/WN_cueG31LFSVOVPdkUxm5SHQ' }] };

test('source dates, timezone boundaries, filters and past/cancelled/unknown states', () => {
  assert.match(eventLabel(hsa), /2026-09-29 · 11:30 UTC/);
  assert.equal(eventTiming(hsa, now), 'Past / started');
  const boundary = { ...hsa, id: 'boundary', starts_at: '2026-10-02T00:30:00Z', time_zone: '-04:00', date_evidence: null };
  assert.deepEqual(recordDates(boundary), ['2026-10-02', '2026-10-02']);
  assert.match(eventLabel(boundary), /2026-10-02 · 00:30 UTC/);
  const workshop = { id: 'workshop', kind: 'event', title: 'BBNJ workshop', starts_at: '2026-10-03T12:00:00Z', ends_at: '2026-10-05T12:00:00Z', time_zone: 'UTC' };
  assert.equal(filterRecords([workshop], { from: '2026-10-04', to: '2026-10-04' }, now).length, 1);
  const unknown = { id: 'unknown', kind: 'event', title: 'BBNJ date to follow' };
  assert.equal(eventTiming(unknown, now), 'Date unknown');
  assert.equal(eventTiming({ ...boundary, status: 'cancelled' }, now), 'Cancelled');
  assert.equal(filterRecords([hsa, boundary, unknown], { timing: 'Upcoming' }, now).length, 1);
  const treaty = { id: 'treaty', kind: 'treaty_status', title: 'Treaty update', description: 'Example country reported a treaty update' };
  assert.equal(filterRecords([hsa, treaty], { search: 'EXAMPLE', kind: 'treaty_status' }, now)[0].id, 'treaty');
  assert.equal(filterRecords([hsa, unknown], { organization: 'High Seas Alliance', search: 'genetic' }, now)[0].id, hsa.id);
  assert.equal(filterRecords([unknown], { from: '2026-01-01' }, now).length, 0);
});

test('source links reject unsafe and credential-bearing URLs', () => {
  assert.equal(sourceLink('javascript:alert(1)'), null);
  assert.equal(sourceLink('https://user:secret@example.org'), null);
});

test('tracker freshness uses run-derived status without a stored schedule', () => {
  const tracker = { enabled: true, url: 'https://bsky.app/profile/highseasalliance.bsky.social', collector: 'bluesky_feed', last_success_at: null };
  assert.equal(trackerState(tracker, now).success, 'Never');
  const success = { ...tracker, last_success_at: '2026-10-01T11:00:00Z', last_outcome: 'success' };
  const unchanged = { ...success, last_success_at: '2026-10-01T11:30:00Z', last_outcome: 'no_change' };
  assert.notEqual(trackerState(success, now).success, trackerState(unchanged, now).success);
  for (const outcome of ['partial', 'failed', 'quota']) assert.equal(trackerState({ ...unchanged, last_outcome: outcome }, now).success, trackerState(unchanged, now).success);
  assert.equal(trackerState({ ...tracker, url: null, enabled: false }, now).availability, 'Unconfigured');
  assert.equal(trackerState({ ...tracker, url: 'https://example.org', enabled: false }, now).availability, 'Collector not yet proven');
  for (const actor of ['highseasalliance.bsky.social','deepstewardship.bsky.social','globalfishingwatch.org','iddri.bsky.social'])
    assert.equal(trackerState({...tracker,url:`https://bsky.app/profile/${actor}`}).availability,'Manual collection only');
  const hub={...tracker,collector:'web',url:'https://www.hubocean.earth/events-calendar'};
  assert.equal(trackerState(hub).availability,'Manual collection only');
  assert.equal(trackerState({...hub,enabled:false}).availability,'Collector not yet proven');
  assert.equal(trackerState({...hub,url:'https://octogroup.org/webinars/',enabled:false}).availability,'Collector not yet proven');
});

test('member data reads load every page and surface errors instead of silently truncating', async () => {
  const inventory = { records: Array.from({ length: 501 }, (_, id) => ({ id })), tracker_status: Array.from({ length: 22 }, (_, id) => ({ id })), source_details: [{ record_id: 500, url: 'https://example.org' }] };
  let fail = false;
  const client = { from(table) { return { select(columns) {
    assert.ok(!columns.includes('excerpt') && !columns.includes('content_hash'));
    if (table === 'records') {
      const fields = columns.split(',sources(')[0].split(',');
      for (const removed of ['summary', 'start_on', 'end_on', 'published_on', 'country', 'treaty_action', 'recorded_on', 'collected_at']) assert.ok(!fields.includes(removed));
      assert.ok(fields.includes('starts_at') && fields.includes('ends_at'));
    }
    return { order() { return this; }, async range(from, through) { return fail ? { error: new Error('Unavailable') } : { data: inventory[table].slice(from, through + 1) }; } };
  } }; } };
  const data = await loadScout(client);
  assert.equal(data.records.length, 501);
  assert.equal(data.trackers.length, 22);
  assert.equal(data.records[500].sources[0].url, 'https://example.org');
  fail = true;
  await assert.rejects(loadScout(client), /Unavailable/);
});
