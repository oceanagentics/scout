export const KINDS = { event: 'Event', announcement: 'Announcement', treaty_status: 'Treaty change' };
const dayValid = value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const instantValid = value => typeof value === 'string' && dayValid(value.slice(0, 10)) && /T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));

export function sourceLink(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function stamp(value) {
  return instantValid(value) ? `${new Date(value).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'Unknown';
}

function zoned(value, zone) {
  if (!instantValid(value) || !zone) return null;
  const offset = zone.match(/^([+-])(\d{2}):(\d{2})$/);
  if (offset) {
    if (+offset[2] > 14 || +offset[3] > 59 || (+offset[2] === 14 && +offset[3] !== 0)) return null;
    const local = new Date(Date.parse(value) + (offset[1] === '+' ? 1 : -1) * (+offset[2] * 60 + +offset[3]) * 60000).toISOString();
    return { day: local.slice(0, 10), time: local.slice(11, 16), zone: `UTC${zone}` };
  }
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
    return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, zone };
  } catch { return null; }
}

export function recordDates(record) {
  if (record.kind !== 'event') {
    const date = record.kind === 'treaty_status' ? record.recorded_on ?? record.published_on : record.published_on;
    return dayValid(date) ? [date, date] : [null, null];
  }
  if (dayValid(record.start_on)) return [record.start_on, dayValid(record.end_on) ? record.end_on : record.start_on];
  const start = zoned(record.starts_at, record.time_zone), end = zoned(record.ends_at, record.time_zone);
  return start ? [start.day, end?.day ?? start.day] : [null, null];
}

export function eventLabel(record) {
  if (dayValid(record.start_on)) return `${record.start_on}${dayValid(record.end_on) && record.end_on !== record.start_on ? ` – ${record.end_on}` : ''} · Date only`;
  const start = zoned(record.starts_at, record.time_zone), end = zoned(record.ends_at, record.time_zone);
  if (!start) return 'Event date / time not yet known';
  const zone = record.date_evidence?.time_zone?.value;
  return `${start.day} · ${start.time}${end ? ` – ${end.day === start.day ? '' : `${end.day} `}${end.time}` : ''} ${zone ? `${zone} (${start.zone})` : start.zone}`;
}

export function eventTiming(record, now = new Date()) {
  if (record.kind !== 'event') return '';
  if (record.status === 'cancelled') return 'Cancelled';
  const [start, end] = recordDates(record);
  if (!start) return 'Date unknown';
  if (record.start_on) {
    const today = now.toISOString().slice(0, 10);
    return end < today ? 'Past' : start > today ? 'Upcoming' : 'Today / ongoing';
  }
  if (Date.parse(record.starts_at) > now.getTime()) return 'Upcoming';
  return instantValid(record.ends_at) && Date.parse(record.ends_at) > now.getTime() ? 'In progress' : 'Past / started';
}

export function filterRecords(records, filters = {}, now = new Date()) {
  const query = (filters.search ?? '').normalize('NFKC').toLowerCase().trim();
  return records.filter(record => {
    if (filters.kind && record.kind !== filters.kind) return false;
    if (filters.organization && (record.organization || 'Unknown organization') !== filters.organization) return false;
    if (query && ![record.title, record.organization, record.summary, record.description, record.country, record.treaty_action].filter(Boolean).join(' ').normalize('NFKC').toLowerCase().includes(query)) return false;
    const [start, end] = recordDates(record);
    if ((filters.from || filters.to) && (!start || (filters.from && end < filters.from) || (filters.to && start > filters.to))) return false;
    if (filters.timing && eventTiming(record, now) !== filters.timing) return false;
    return true;
  });
}

export function trackerState(tracker, now = new Date()) {
  const hsa = tracker.url === 'https://bsky.app/profile/highseasalliance.bsky.social' && tracker.method === 'Bluesky API: getAuthorFeed';
  const availability = !tracker.url ? 'Unconfigured · Paused' : !tracker.enabled ? 'Paused' : hsa ? 'Manual collection only' : 'Collector not implemented';
  const outcomes = { success: 'Success', no_change: 'No change', partial: 'Partial', failed: 'Failed', quota: 'Quota reached', unsupported: 'Unsupported' };
  const overdue = Boolean(tracker.enabled && instantValid(tracker.next_run_at) && Date.parse(tracker.next_run_at) <= now.getTime());
  return { availability, outcome: outcomes[tracker.last_outcome] ?? (tracker.last_attempt_at ? 'No completed result' : 'Never collected'),
    success: tracker.last_success_at ? stamp(tracker.last_success_at) : 'Never', overdue,
    schedule: !tracker.enabled ? 'Paused' : !tracker.next_run_at ? 'Not scheduled' : `${overdue ? 'Overdue · ' : 'Due · '}${stamp(tracker.next_run_at)}` };
}

// RFC 5545: UTC instants, floating DATE values, escaped text, UTF-8 line folding.
export function calendarFile(record, now = new Date()) {
  if (record.kind !== 'event' || !record.id || !recordDates(record)[0]) return null;
  const utc = value => new Date(value).toISOString().replaceAll(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const escape = value => String(value ?? '').replaceAll('\\', '\\\\').replace(/\r\n|\r|\n/g, '\\n').replaceAll(',', '\\,').replaceAll(';', '\\;');
  const urls = [...new Set([record.event_url, record.registration_url, ...(record.sources ?? []).map(source => source.url)].map(sourceLink).filter(Boolean))];
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ocean Agentics//BBNJ Scout//EN', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    `UID:${encodeURIComponent(record.id)}@bbnj-scout.web.app`, `DTSTAMP:${utc(now)}`, `SUMMARY:${escape(record.title)}`];
  if (dayValid(record.start_on)) {
    const end = new Date(`${dayValid(record.end_on) ? record.end_on : record.start_on}T00:00:00Z`);
    if (end.getTime() < Date.parse(`${record.start_on}T00:00:00Z`)) return null;
    end.setUTCDate(end.getUTCDate() + 1);
    lines.push(`DTSTART;VALUE=DATE:${record.start_on.replaceAll('-', '')}`, `DTEND;VALUE=DATE:${end.toISOString().slice(0, 10).replaceAll('-', '')}`);
  } else {
    lines.push(`DTSTART:${utc(record.starts_at)}`);
    if (instantValid(record.ends_at) && Date.parse(record.ends_at) >= Date.parse(record.starts_at)) lines.push(`DTEND:${utc(record.ends_at)}`);
  }
  if (instantValid(record.updated_at)) lines.push(`LAST-MODIFIED:${utc(record.updated_at)}`);
  if (record.status === 'cancelled') lines.push('STATUS:CANCELLED');
  if (record.location) lines.push(`LOCATION:${escape(record.location)}`);
  if (urls.length) lines.push(`URL:${urls[0]}`);
  lines.push(`DESCRIPTION:${escape([record.summary || record.description, `Source schedule: ${eventLabel(record)}`, record.status && `Status: ${record.status}`, ...urls].filter(Boolean).join('\n\n'))}`, 'END:VEVENT', 'END:VCALENDAR');
  const encoder = new TextEncoder();
  return lines.map(line => {
    let folded = '', bytes = 0;
    for (const char of line) {
      const size = encoder.encode(char).length;
      if (bytes + size > 75) { folded += '\r\n '; bytes = 1; }
      folded += char; bytes += size;
    }
    return folded;
  }).join('\r\n') + '\r\n';
}
