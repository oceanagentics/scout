import {randomUUID} from 'node:crypto';
import {INTAKE_INSTRUCTION,RESPONSE_SCHEMA} from './instructions.js';
import {normalizeFinding,saveFindings} from './findings.js';
import {readSource,readUrl} from './sources.js';
import {scoutDay,findingInterval} from '../shared/finding-dates.js';

const fail=reason=>Object.assign(new Error(reason),{reason});

// Claim one tracker; commit each source-date group before moving to newer posts.
export async function intake(db,{trackerId=null,modelFor,sourceFetch=fetch,notify,publishCalendar}){
  const tracker=(await db.query(`update scout.trackers set lease_id=$2,lease_until=clock_timestamp()+interval '120 seconds',
    last_checked_at=date_trunc('milliseconds',clock_timestamp()),
    failure_count=case when $1::uuid is not null and failure_count>=3 then 1 else failure_count+1 end
    where id=(select id from scout.trackers where url is not null
      and (retire_on is null or retire_on>(clock_timestamp() at time zone 'America/New_York')::date)
      and (lease_until is null or lease_until<=clock_timestamp())
      and (case when $1::uuid is not null then id=$1 else enabled and failure_count<3
        and (last_checked_at is null or last_successful_check is distinct from last_checked_at
          or date_trunc('day',last_successful_check at time zone 'America/New_York')+cadence
            <=date_trunc('day',clock_timestamp() at time zone 'America/New_York')) end)
      order by last_checked_at nulls first,id for update skip locked limit 1)
    returning *,
      ((last_checked_at at time zone 'America/New_York')::date
        - interval '1 month')::date::text as oldest_date`,[trackerId,randomUUID()])).rows[0];
  if(!tracker)return {state:'idle',created:0,changed:0};
  const counts={created:0,changed:0,saved:0,ambiguous:0},through=new Date(tracker.last_checked_at).toISOString();
  const deadline=Date.parse(through)+100000;
  let diagnostics,processed=0;const notifications=[],calendarResults=[],cache=new Map(),sourceMetrics={requests:0,bytes:0};
  const read=(url,{lastSuccessfulCheck=null}={})=>{
    const remaining=deadline-Date.now();if(remaining<=0)throw fail('runtime_bound');
    return readUrl(url,{fetch:sourceFetch,signal:AbortSignal.timeout(remaining),cache,metrics:sourceMetrics,lastSuccessfulCheck});
  };
  try{
    const items=await readSource(tracker,{through,fetch:sourceFetch,readUrl:read,signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))});
    // An empty feed or unchanged page commits the successful check without a model call.
    for(let start=0;start<items.length||start===0;){
      let end=start+1;
      while(end<items.length&&items[end].at===items[start].at)end++;
      const group=items.slice(start,end),prepared=[];
      for(const item of group){
        const model=modelFor({...tracker,...item},{deadline,readUrl:read});
        const answer=await model(INTAKE_INSTRUCTION,{url:item.url,source_kind:item.source_kind,current_date:scoutDay(new Date(through)),
          oldest_date:tracker.oldest_date,
          ...(item.content?{content:item.content}:{})},RESPONSE_SCHEMA);
        diagnostics={...answer._diagnostics,source:sourceMetrics};
        if(!['found','none','unreadable'].includes(answer.status)||!Array.isArray(answer.records))throw fail('invalid_output');
        if(answer.status==='unreadable')throw fail('model_unreadable');
        const invalidScheduling={},findings=answer.records.map(r=>normalizeFinding(r,item.url,invalidScheduling));
        if(Object.keys(invalidScheduling).length)diagnostics.invalid_scheduling=invalidScheduling;
        if(findings.some(f=>!f)||answer.status==='none'&&findings.length)throw fail('invalid_output');
        if(answer.status==='found'&&!findings.length)throw fail('empty_findings');
        prepared.push({url:item.url,findings:findings.filter(f=>{
          const [,latest]=findingInterval(f);
          return latest===null||latest>=tracker.oldest_date;
        })});
      }
      const finished=end>=items.length;
      const saved=await db.transaction(async tx=>{
        if(!(await tx.query(`select id from scout.trackers where id=$1 and lease_id=$2 and url=$3
          and lease_until>clock_timestamp() for update`,[tracker.id,tracker.lease_id,tracker.url])).rows.length)throw fail('stale_lease');
        const totals={created:0,changed:0,saved:0,ambiguous:0},createdIds=[],calendarIds=[];
        for(const item of prepared){
          if(!item.findings.length)continue;
          const result=await saveFindings(tx,item.url,item.findings);
          for(const key of Object.keys(totals))totals[key]+=result[key];
          createdIds.push(...result.createdIds);
          calendarIds.push(...result.calendarIds);
        }
        await tx.query(`update scout.trackers set last_successful_check=$2,last_error=null,
          failure_count=0,lease_id=case when $3 then null else lease_id end,
          lease_until=case when $3 then null else lease_until end where id=$1`,
          [tracker.id,finished?through:group.at(-1).at,finished]);
        return {...totals,createdIds,calendarIds:[...new Set(calendarIds)]};
      });
      for(const key of Object.keys(counts))counts[key]+=saved[key];
      processed+=group.length;
      // Slack follows the committed save. Delivery failure must not replay collection.
      if(notify&&saved.createdIds.length){
        try{notifications.push(await notify(saved.createdIds));}
        catch{notifications.push({status:'unknown',communicated:0});}
      }
      if(publishCalendar&&saved.calendarIds.length){
        try{calendarResults.push(await publishCalendar(saved.calendarIds,{deadline:Math.min(deadline+15000,Date.now()+10000)}));}
        catch{calendarResults.push({status:'failed'});}
      }
      if(finished)break;
      start=end;
    }
    return {state:counts.saved?'saved':'no_findings',tracker_id:tracker.id,...counts,processed,diagnostics,notifications,calendar:calendarResults};
  }catch(error){
    const reason=/^[a-z_]{1,48}$/.test(error.reason??error.message??'')?error.reason??error.message:'reader_failed';
    diagnostics=error.diagnostics??diagnostics;
    const failures=processed?1:tracker.failure_count;
    const updated=await db.query(`update scout.trackers set last_error=$4,failure_count=$5,
      lease_id=null,lease_until=null where id=$1 and lease_id=$2 and url=$3 and lease_until>clock_timestamp() returning id`,
      [tracker.id,tracker.lease_id,tracker.url,reason,failures]);
    return {state:!updated.rows.length?'stale':failures>=3?'needs_attention':'deferred',tracker_id:tracker.id,reason,...counts,processed,diagnostics,notifications,calendar:calendarResults};
  }
}
