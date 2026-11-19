import {recordDate,recordEnd,dateLabel,scoutDay,SCOUT_TIMEZONE} from '../shared/finding-dates.js';
export const TYPES = { event: 'Event', announcement: 'Announcement' };
export const PRIORITIES = { high:'High', normal:'Normal', low:'Low' };
export function fieldLabel(record, field) {
  if (field==='priority') return PRIORITIES[record.priority]??'Not yet assessed';
  if(field==='organizations')return record.organizations.join('; ')||'Unknown';
  const value=record[field];
  return value==null?'Unknown':String(value);
}
const dayValid = value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const instantValid = value => typeof value === 'string' && dayValid(value.slice(0, 10)) && /T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
export function stamp(value) {
  if(!instantValid(value))return 'Unknown';
  const at=new Date(value);
  return scoutDay(at)+' '+new Intl.DateTimeFormat('en-US',{timeZone:SCOUT_TIMEZONE,hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZoneName:'short'}).format(at);
}

export function eventLabel(record) {
  const prefix={event:'Starts',announcement:'Published'}[record.type]??'Date';
  const end=recordEnd(record);
  return `${prefix} · ${dateLabel(recordDate(record))}`+(end?' → '+dateLabel(end):'');
}

export function trackerState(tracker) {
  const availability = !tracker.url?'Unconfigured':!tracker.enabled?'Disabled':tracker.failure_count>=3?'Needs attention':
    tracker.last_error?'Retry scheduled':tracker.last_checked_at?'Scheduled':'Not checked';
  return {availability};
}
