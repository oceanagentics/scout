import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarFile, eventLabel, eventTiming, filterRecords, recordDates, sourceLink, trackerState } from '../src/records.js';
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
  const allDay = { id: 'day', kind: 'event', title: 'BBNJ workshop', start_on: '2026-10-03', end_on: '2026-10-05' };
  assert.equal(filterRecords([allDay], { from: '2026-10-04', to: '2026-10-04' }, now).length, 1);
  const unknown = { id: 'unknown', kind: 'event', title: 'BBNJ date to follow' };
  assert.equal(eventTiming(unknown, now), 'Date unknown');
  assert.equal(eventTiming({ ...boundary, status: 'cancelled' }, now), 'Cancelled');
  assert.equal(filterRecords([hsa, boundary, unknown], { timing: 'Upcoming' }, now).length, 1);
  const treaty = { id: 'treaty', kind: 'treaty_status', title: 'Treaty update', country: 'Example country', recorded_on: '2026-09-28', published_on: '2026-10-01' };
  assert.equal(filterRecords([hsa, treaty], { from: '2026-09-28', to: '2026-09-28', search: 'EXAMPLE', kind: 'treaty_status' }, now)[0].id, 'treaty');
  assert.equal(filterRecords([hsa, unknown], { organization: 'High Seas Alliance', search: 'genetic' }, now)[0].id, hsa.id);
  assert.equal(filterRecords([unknown], { from: '2026-01-01' }, now).length, 0);
});

test('calendar files retain the real instant, date-only boundaries, status, source links and safe text', () => {
  const real = calendarFile(hsa, now).replace(/\r\n /g, '');
  assert.match(real, /DTSTART:20260929T113000Z/);
  assert.doesNotMatch(real, /DTEND:/); // No invented end time.
  assert.match(real, /07:30 EDT/);
  assert.match(real, /WN_cueG31LFSVOVPdkUxm5SHQ/);
  const day = { id: 'all-day', kind: 'event', title: 'Date-only workshop', start_on: '2026-12-31', end_on: '2027-01-02' };
  const allDay = calendarFile(day, now);
  assert.match(allDay, /DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270103/);
  assert.doesNotMatch(allDay, /DTSTART:|TZID/);
  assert.equal(calendarFile({ ...hsa, starts_at: null, start_on: '2026-02-30' }, now), null);
  assert.equal(calendarFile({ ...hsa, time_zone: null }, now), null);
  const cancelled = calendarFile({ ...hsa, status: 'cancelled' }, now);
  assert.match(cancelled, /UID:hsa-webinar@bbnj-scout.web.app/);
  assert.match(cancelled, /STATUS:CANCELLED/);
  const shifted = calendarFile({ ...hsa, starts_at: '2026-10-02T00:30:00Z', status: 'rescheduled' }, now);
  assert.match(shifted, /DTSTART:20261002T003000Z/);
  assert.match(shifted, /UID:hsa-webinar@bbnj-scout.web.app/);
  const safe = calendarFile({ ...hsa, title: '🌊'.repeat(60) + '\r\nATTENDEE:bad;value,\\end', event_url: 'javascript:alert(1)' }, now);
  assert.ok(safe.split('\r\n').every(line => Buffer.byteLength(line) <= 75));
  assert.doesNotMatch(safe, /\r\nATTENDEE:|javascript:/);
  assert.match(safe.replace(/\r\n /g, ''), /\\nATTENDEE:bad\\;value\\,\\\\end/);
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
    return { order() { return this; }, async range(from, through) { return fail ? { error: new Error('Unavailable') } : { data: inventory[table].slice(from, through + 1) }; } };
  } }; } };
  const data = await loadScout(client);
  assert.equal(data.records.length, 501);
  assert.equal(data.trackers.length, 22);
  fail = true;
  await assert.rejects(loadScout(client), /Unavailable/);
});
