import {findingInterval,recordDate} from './finding-dates.js';

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
    (recordDates(a)[0]?Date.parse(recordDates(a)[0]):Infinity)-(recordDates(b)[0]?Date.parse(recordDates(b)[0]):Infinity)||a.id.localeCompare(b.id));
}
export function sourceLink(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export const recordDates=record=>findingInterval(record);

export function eventTiming(record, now = new Date()) {
  if (record.type !== 'event') return '';
  const start=recordDate(record),[from,to]=findingInterval(record),today=now.toISOString().slice(0,10);
  if(!from)return 'Date unknown';
  if(start.utc)return Date.parse(start.utc)>+now?'Upcoming':'Past / started';
  return from>today?'Upcoming':to>=today?'Date known · time unknown':'Past / started';
}
