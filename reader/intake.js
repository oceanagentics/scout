import {randomUUID} from 'node:crypto';
import {INTAKE_INSTRUCTION,RESPONSE_SCHEMA} from './instructions.js';
import {normalizeFinding,saveFindings} from './findings.js';

const fail=reason=>Object.assign(new Error(reason),{reason});

// One invocation checks one tracker. Claim before HTTP; save and finish together.
export async function intake(db,{trackerId=null,modelFor}){
  const tracker=(await db.query(`update scout.trackers set lease_id=$2,lease_until=clock_timestamp()+interval '120 seconds',
    failure_count=case when $1::uuid is not null and failure_count>=3 then 1 else failure_count+1 end
    where id=(select id from scout.trackers where url is not null
      and (lease_until is null or lease_until<=clock_timestamp())
      and (case when $1::uuid is not null then id=$1 else enabled and failure_count<3 and next_check_at<=clock_timestamp() end)
      order by next_check_at nulls first,id for update skip locked limit 1)
    returning *`,[trackerId,randomUUID()])).rows[0];
  if(!tracker)return {state:'idle',created:0,changed:0};
  let usage={generations:0,input_tokens:0,output_tokens:0},diagnostics;
  try{
    const model=modelFor(tracker);
    const answer=await model(INTAKE_INSTRUCTION,{url:tracker.url,current_date:new Date().toISOString().slice(0,10)},RESPONSE_SCHEMA);
    usage=answer._usage??{...usage,generations:1};diagnostics=answer._diagnostics;
    if(!['found','none','unreadable'].includes(answer.status)||!Array.isArray(answer.records))throw fail('invalid_output');
    if(answer.status==='unreadable')throw fail('model_unreadable');
    const findings=answer.records.slice(0,8).map(r=>normalizeFinding(r,answer._source_url??tracker.url)).filter(Boolean);
    if(answer.status==='found'&&!findings.length)throw fail('empty_findings');
    const counts=await db.transaction(async tx=>{
      if(!(await tx.query(`select id from scout.trackers where id=$1 and lease_id=$2 and url=$3
        and lease_until>clock_timestamp() for update`,[tracker.id,tracker.lease_id,tracker.url])).rows.length)throw fail('stale_lease');
      const saved=await saveFindings(tx,{...tracker,url:answer._source_url??tracker.url},findings);
      if(answer._progress&&saved.ambiguous)throw fail('ambiguous_findings');
      await tx.query(`update scout.trackers set last_checked_at=clock_timestamp(),next_check_at=clock_timestamp()+cadence,
        last_error=null,failure_count=0,lease_id=null,lease_until=null,reader_progress=coalesce($2,reader_progress) where id=$1`,[tracker.id,answer._progress??null]);
      return saved;
    });
    return {state:counts.saved?'saved':counts.ambiguous?'ambiguous':'no_findings',tracker_id:tracker.id,...counts,usage,diagnostics};
  }catch(error){
    const reason=/^[a-z_]{1,48}$/.test(error.reason??error.message??'')?error.reason??error.message:'reader_failed';
    usage=error.usage??usage;diagnostics=error.diagnostics??diagnostics;
    const failures=tracker.failure_count;
    const retryAt=failures>=3?null:new Date(Math.max(Date.parse(error.deferred?.retry_at)||0,Date.now()+3600000)).toISOString();
    const updated=await db.query(`update scout.trackers set last_checked_at=clock_timestamp(),last_error=$4,failure_count=$5,
      next_check_at=$6,lease_id=null,lease_until=null where id=$1 and lease_id=$2 and url=$3 and lease_until>clock_timestamp() returning id`,
      [tracker.id,tracker.lease_id,tracker.url,reason,failures,retryAt]);
    return {state:!updated.rows.length?'stale':failures>=3?'needs_attention':'deferred',tracker_id:tracker.id,reason,created:0,changed:0,usage,diagnostics};
  }
}
