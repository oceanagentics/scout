export const KINDS = { event: 'Event', announcement: 'Announcement', treaty_status: 'Treaty change' };
export const PRIORITIES = { high:'High', normal:'Normal', low:'Low' };
export function fieldLabel(record, field) {
  if (field==='priority') return PRIORITIES[record.priority]??'Not yet assessed';
  if (record.kind!=='event'&&['location','status','starts_at','ends_at','event_url','registration_url'].includes(field)) return 'Not applicable';
  const value=record[field];
  if (value===null||value===undefined||value==='') return 'Unknown';
  return field.endsWith('_at')?stamp(value):field==='kind'?KINDS[value]??value:typeof value==='object'?JSON.stringify(value):String(value);
}
export function orderRecords(records, order='priority') {
  const rank = value => ({high:0,normal:1,low:2})[value]??3;
  if (typeof order==='object') return [...records].sort((a,b)=>{
    const [left,right]=[a,b].map(record=>{
      const value=record[order.field];
      return value==null||value===''?null:order.field==='priority'?rank(value):order.field.endsWith('_at')?Date.parse(value)
        :order.field==='sources'?value.length:typeof value==='object'?JSON.stringify(value):value;
    });
    if (left===null||right===null) return left===right?0:left===null?1:-1;
    const compared=typeof left==='string'?left.localeCompare(String(right),undefined,{numeric:true,sensitivity:'base'}):left-right;
    return order.direction==='descending'?-compared:compared;
  });
  return [...records].sort((a,b)=>(order==='priority'?rank(a.priority)-rank(b.priority):0)||
    (a.starts_at?Date.parse(a.starts_at):Infinity)-(b.starts_at?Date.parse(b.starts_at):Infinity)||a.id.localeCompare(b.id));
}
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

export function recordDates(record) {
  if (record.kind !== 'event') return [null, null];
  const start = instantValid(record.starts_at) ? new Date(record.starts_at).toISOString().slice(0, 10) : null;
  const end = instantValid(record.ends_at) ? new Date(record.ends_at).toISOString().slice(0, 10) : start;
  return [start, end];
}

export function eventLabel(record) {
  if (record.kind!=='event') return 'Not applicable';
  if (!instantValid(record.starts_at)) return 'Unknown';
  const start = new Date(record.starts_at).toISOString(), end = instantValid(record.ends_at) && new Date(record.ends_at).toISOString();
  return `${start.slice(0, 10)} · ${start.slice(11, 16)}${end ? ` – ${end.slice(0, 10) === start.slice(0, 10) ? '' : `${end.slice(0, 10)} `}${end.slice(11, 16)}` : ''} UTC`;
}

export function eventTiming(record, now = new Date()) {
  if (record.kind !== 'event') return '';
  if (record.status === 'cancelled') return 'Cancelled';
  const [start] = recordDates(record);
  if (!start) return 'Date unknown';
  if (Date.parse(record.starts_at) > now.getTime()) return 'Upcoming';
  return instantValid(record.ends_at) && Date.parse(record.ends_at) > now.getTime() ? 'In progress' : 'Past / started';
}

export function filterRecords(records, filters = {}, now = new Date()) {
  const query = (filters.search ?? '').normalize('NFKC').toLowerCase().trim();
  return records.filter(record => {
    if (filters.kind && record.kind !== filters.kind) return false;
    if (filters.priority && (record.priority??'unassessed')!==filters.priority) return false;
    if (filters.record && record.id!==filters.record) return false;
    if (filters.organization && (record.organization || 'Unknown organization') !== filters.organization) return false;
    if (query && ![record.title, record.organization, record.description].filter(Boolean).join(' ').normalize('NFKC').toLowerCase().includes(query)) return false;
    const [start, end] = recordDates(record);
    if ((filters.from || filters.to) && (!start || (filters.from && end < filters.from) || (filters.to && start > filters.to))) return false;
    if (filters.timing && eventTiming(record, now) !== filters.timing) return false;
    return true;
  });
}

export function trackerState(tracker) {
  const availability = !tracker.url ? 'Unconfigured' : tracker.enabled ? 'Manual collection only' : 'Collector not yet proven';
  const outcomes = { success: 'Success', no_change: 'No change', partial: 'Partial', failed: 'Failed', quota: 'Quota reached', unsupported: 'Unsupported' };
  return { availability, outcome: outcomes[tracker.last_outcome] ?? (tracker.last_attempt_at ? 'No completed result' : 'Never collected'),
    success: tracker.last_success_at ? stamp(tracker.last_success_at) : 'Never' };
}
