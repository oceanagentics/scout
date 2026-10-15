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
const dayValid = value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const instantValid = value => typeof value === 'string' && dayValid(value.slice(0, 10)) && /T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
export function stamp(value) {
  return instantValid(value) ? `${new Date(value).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'Unknown';
}

export function eventLabel(record) {
  const field=DATE_FIELDS[record.kind]?.[0],prefix={event:'Starts',announcement:'Published',treaty_status:'Action date'}[record.kind];
  return `${prefix} · ${dateLabel(record.details?.[field])}${record.kind==='event'&&record.details?.end?' – '+dateLabel(record.details?.end):''}`;
}

export function trackerState(tracker) {
  const availability = !tracker.url ? 'Unconfigured' : tracker.loop_state ?? (tracker.enabled ? 'Manual collection only' : 'Collector not yet proven');
  const outcomes = { success: 'Success', no_change: 'No change', partial: 'Partial', failed: 'Failed', quota: 'Quota reached', unsupported: 'Unsupported' };
  return { availability, outcome: outcomes[tracker.last_outcome] ?? (tracker.last_attempt_at ? 'No completed result' : 'Never collected'),
    success: tracker.last_success_at ? stamp(tracker.last_success_at) : 'Never' };
}
import {DATE_FIELDS,dateLabel} from '../shared/finding-dates.js';
