export const KINDS = { event: 'Event', announcement: 'Announcement', treaty_status: 'Treaty change' };
export const PRIORITIES = { high:'High', normal:'Normal', low:'Low' };
export function fieldLabel(record, field) {
  if (field==='priority') return PRIORITIES[record.priority]??'Not yet assessed';
  if(field==='organization')return (record.organizations??[]).map(o=>o.name).join('; ')||'Unknown';
  if(['starts_at','ends_at'].includes(field))return dateLabel(record.details?.[field==='starts_at'?DATE_FIELDS[record.kind]?.[0]:record.kind==='event'?'end':'effective']);
  if(field==='completeness')return record.completeness?.state??'Unknown';
  if(field==='details')return JSON.stringify(record.details);
  const value=record[field];
  if (value===null||value===undefined||value==='') return 'Unknown';
  return field.endsWith('_at')?stamp(value):field==='kind'?KINDS[value]??value:typeof value==='object'?JSON.stringify(value):String(value);
}
export function orderRecords(records, order='priority') {
  const rank = value => ({high:0,normal:1,low:2})[value]??3;
  if (typeof order==='object') return [...records].sort((a,b)=>{
    const [left,right]=[a,b].map(record=>{
      const value=order.field==='starts_at'&&record.details?findingInterval(record)[0]:record[order.field];
      return value==null||value===''?null:order.field==='priority'?rank(value):order.field.endsWith('_at')?Date.parse(value)
        :order.field==='sources'?value.length:typeof value==='object'?JSON.stringify(value):value;
    });
    if (left===null||right===null) return left===right?0:left===null?1:-1;
    const compared=typeof left==='string'?left.localeCompare(String(right),undefined,{numeric:true,sensitivity:'base'}):left-right;
    return order.direction==='descending'?-compared:compared;
  });
  return [...records].sort((a,b)=>(order==='priority'?rank(a.priority)-rank(b.priority):0)||
    (recordDates(a)[0]?Date.parse(recordDates(a)[0]):Infinity)-(recordDates(b)[0]?Date.parse(recordDates(b)[0]):Infinity)||a.id.localeCompare(b.id));
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

export const recordDates=record=>findingInterval(record);

export function eventLabel(record) {
  const field=DATE_FIELDS[record.kind]?.[0],prefix={event:'Starts',announcement:'Published',treaty_status:'Action date'}[record.kind];
  return `${prefix} · ${dateLabel(record.details?.[field])}${record.kind==='event'&&record.details?.end?' – '+dateLabel(record.details?.end):''}`;
}

export function eventTiming(record, now = new Date()) {
  if (record.kind !== 'event') return '';
  if(record.details?.status==='cancelled')return 'Cancelled';
  const start=record.details?.start,end=record.details?.end,[from,to]=findingInterval(record),today=now.toISOString().slice(0,10);
  if(!from)return 'Date unknown';
  if(start.utc&&Date.parse(start.utc)>+now)return 'Upcoming';
  if(start.utc&&end?.utc&&Date.parse(end.utc)>+now)return 'In progress';
  return from>today?'Upcoming':to>=today&&!start.utc?'Date known · time unknown':'Past / started';
}

export function trackerState(tracker) {
  const availability = !tracker.url ? 'Unconfigured' : tracker.loop_state ?? (tracker.enabled ? 'Manual collection only' : 'Collector not yet proven');
  const outcomes = { success: 'Success', no_change: 'No change', partial: 'Partial', failed: 'Failed', quota: 'Quota reached', unsupported: 'Unsupported' };
  return { availability, outcome: outcomes[tracker.last_outcome] ?? (tracker.last_attempt_at ? 'No completed result' : 'Never collected'),
    success: tracker.last_success_at ? stamp(tracker.last_success_at) : 'Never' };
}
import {DATE_FIELDS,dateLabel,findingInterval} from './finding.js';
