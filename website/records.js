import {recordDate,dateLabel} from '../shared/finding-dates.js';
export const TYPES = { event: 'Event', announcement: 'Announcement', treaty_status: 'Treaty change' };
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
  return instantValid(value) ? `${new Date(value).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'Unknown';
}

export function eventLabel(record) {
  const prefix={event:'Starts',announcement:'Published',treaty_status:'Action date'}[record.type]??'Date';
  return `${prefix} · ${dateLabel(recordDate(record))}`;
}

export function trackerState(tracker) {
  const availability = !tracker.url?'Unconfigured':!tracker.enabled?'Disabled':tracker.failure_count>=3?'Needs attention':
    tracker.last_error?'Retry scheduled':tracker.last_checked_at?'Scheduled':'Not checked';
  return {availability};
}
