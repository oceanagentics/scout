import {findingInterval,recordDate,scoutDay} from './finding-dates.js';

export const PUBLICATION_SCORE=75;

export function orderRecords(records, order='score') {
  if (typeof order==='object') return [...records].sort((a,b)=>{
    const [left,right]=[a,b].map(record=>{
      const value=record[order.field];
      return value==null||value===''?null:order.field.endsWith('_at')?Date.parse(value)
        :order.field==='sources'?value.length:typeof value==='object'?JSON.stringify(value):value;
    });
    if (left===null||right===null) return left===right?0:left===null?1:-1;
    const compared=typeof left==='string'?left.localeCompare(String(right),undefined,{numeric:true,sensitivity:'base'}):left-right;
    return order.direction==='descending'?-compared:compared;
  });
  return [...records].sort((a,b)=>(order==='score'?(b.score??-1)-(a.score??-1):0)||
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
  const start=recordDate(record),[from,to]=findingInterval(record),today=scoutDay(now);
  if(!from)return 'Date unknown';
  if(start.utc)return Date.parse(start.utc)>+now?'Upcoming':'Past / started';
  return from>today?'Upcoming':to>=today?'Date known · time unknown':'Past / started';
}
