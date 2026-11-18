import {randomUUID} from 'node:crypto';
import {readUrl} from './url.js';
import {ingestSource} from './ingestion.js';
// Claim one tracker; commit each source-date group before moving to newer posts.
export async function intake(db,{trackerId=null,modelFor,sourceFetch=fetch,notify,publishCalendar}){
  const tracker=(await db.query(`update scout.trackers set lease_id=$2,lease_until=clock_timestamp()+interval '120 seconds',
    last_checked_at=date_trunc('milliseconds',clock_timestamp()),
    failure_count=case when $1::uuid is not null and failure_count>=3 then 1 else failure_count+1 end
    where id=(select id from scout.trackers where url is not null
      and (retire_on is null or retire_on>(clock_timestamp() at time zone 'America/New_York')::date)
      and (lease_until is null or lease_until<=clock_timestamp())
      and (case when $1::uuid is not null then id=$1 else enabled and failure_count<3
        and (exists(select 1 from scout.source_items si where si.tracker_id=scout.trackers.id and si.pending) or last_checked_at is null or last_successful_check is distinct from last_checked_at
          or date_trunc('day',last_successful_check at time zone 'America/New_York')+cadence
            <=date_trunc('day',clock_timestamp() at time zone 'America/New_York')) end)
      order by last_checked_at nulls first,id for update skip locked limit 1)
    returning *,
      ((last_checked_at at time zone 'America/New_York')::date
        - interval '1 month')::date::text as oldest_date`,[trackerId,randomUUID()])).rows[0];
  if(!tracker)return {state:'idle',created:0,changed:0};
  const through=new Date(tracker.last_checked_at).toISOString(),deadline=Date.parse(through)+100000;
  const cache=new Map(),metrics={requests:0,bytes:0};
  const read=(url,options={})=>{
   const remaining=deadline-Date.now();if(remaining<=0)throw Object.assign(new Error('runtime_bound'),{reason:'runtime_bound'});
   return readUrl(url,{fetch:sourceFetch,signal:AbortSignal.timeout(remaining),cache,metrics,...options});
  };
  const result=await ingestSource(db,tracker,{modelFor,readUrl:read,sourceFetch,through,deadline});
  if(result.state==='deferred'){
   const updated=await db.query(`update scout.trackers set last_error=$4,failure_count=$5,lease_id=null,lease_until=null
    where id=$1 and lease_id=$2 and url=$3 and lease_until>clock_timestamp() returning id`,
    [tracker.id,tracker.lease_id,tracker.url,/^[a-z_]{1,48}$/.test(result.reason)?result.reason:'reader_failed',result.processed?1:tracker.failure_count]);
   result.state=!updated.rows.length?'stale':(!result.processed&&tracker.failure_count>=3?'needs_attention':'deferred');
  }
  const notifications=[],calendar=[];const callbackDeadline=Date.parse(through)+115000;
  if(notify&&result.createdIds.length&&Date.now()<callbackDeadline){try{notifications.push(await notify(result.createdIds,{deadline:callbackDeadline}));}catch{notifications.push({status:'unknown',communicated:0});}}
  if(publishCalendar&&result.calendarIds.length&&Date.now()<callbackDeadline){try{calendar.push(await publishCalendar([...new Set(result.calendarIds)],{deadline:callbackDeadline}));}catch{calendar.push({status:'failed'});}}
  const {createdIds,calendarIds,...output}=result;
  return {...output,tracker_id:tracker.id,source:metrics,notifications,calendar};
}
