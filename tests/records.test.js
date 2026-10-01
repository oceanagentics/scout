import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventLabel, eventTiming, filterRecords, recordDates, sourceLink, trackerState } from '../src/records.js';
import { loadScout } from '../src/dashboard.js';

const now = new Date('2026-10-01T12:00:00Z');
const hsa = { id: 'hsa-webinar', kind: 'event', title: 'Unpacking Part II of BBNJ: Marine Genetic Resources and Digital Sequence Information', organization: 'High Seas Alliance',
  starts_at: '2026-09-29T11:30:00Z', time_zone: '-04:00', updated_at: '2026-10-01T05:23:54Z', date_evidence: { time_zone: { value: 'EDT' } },
  sources: [{ url: 'https://us06web.zoom.us/webinar/register/WN_cueG31LFSVOVPdkUxm5SHQ' }] };

test('source dates, timezone boundaries, filters and past/cancelled/unknown states', () => {
  assert.match(eventLabel(hsa), /2026-09-29 · 07:30 EDT \(UTC-04:00\)/);
  assert.equal(eventTiming(hsa, now), 'Past / started');
  const boundary = { ...hsa, id: 'boundary', starts_at: '2026-10-02T00:30:00Z', time_zone: '-04:00', date_evidence: null };
  assert.deepEqual(recordDates(boundary), ['2026-10-01', '2026-10-01']);
  assert.match(eventLabel(boundary), /2026-10-01 · 20:30 UTC-04:00/);
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

test('tracker freshness follows stored success, with overdue derived from browser time alone', () => {
  const tracker = { enabled: true, url: 'https://bsky.app/profile/highseasalliance.bsky.social', method: 'Bluesky API: getAuthorFeed', last_success_at: null, next_run_at: null };
  assert.equal(trackerState(tracker, now).success, 'Never');
  assert.equal(trackerState(tracker, now).schedule, 'Not scheduled');
  const success = { ...tracker, last_success_at: '2026-10-01T11:00:00Z', last_outcome: 'success' };
  const unchanged = { ...success, last_success_at: '2026-10-01T11:30:00Z', last_outcome: 'no_change' };
  assert.notEqual(trackerState(success, now).success, trackerState(unchanged, now).success);
  for (const outcome of ['partial', 'failed', 'quota']) assert.equal(trackerState({ ...unchanged, last_outcome: outcome }, now).success, trackerState(unchanged, now).success);
  const scheduled = { ...unchanged, next_run_at: '2026-10-01T12:30:00Z' };
  assert.equal(trackerState(scheduled, now).overdue, false);
  assert.equal(trackerState(scheduled, new Date('2026-10-01T12:31:00Z')).overdue, true);
  assert.equal(trackerState({ ...scheduled, enabled: false }, new Date('2026-10-02T00:00:00Z')).overdue, false);
  assert.equal(trackerState({ ...tracker, url: null, enabled: false }, now).availability, 'Unconfigured · Paused');
  assert.equal(trackerState({ ...tracker, url: 'https://example.org' }, now).availability, 'Collector not implemented');
});

test('member data reads load every page and surface errors instead of silently truncating', async () => {
  const inventory = { records: Array.from({ length: 501 }, (_, id) => ({ id })), trackers: Array.from({ length: 22 }, (_, id) => ({ id })) };
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
  fail = true;
  await assert.rejects(loadScout(client), /Unavailable/);
});
