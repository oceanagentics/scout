import {randomUUID} from 'node:crypto';

export async function claimSource(db,source){
  return (await db.query(`insert into scout.source_state(tracker_id,identity,url,state,attempts,lease_id,lease_until,native_id,native_ref)
    select $1,$2,$3,'running',1,$4,clock_timestamp()+interval '120 seconds',$5,$6
    where exists(select 1 from scout.source_state where tracker_id=$1 and identity=$2)
      or (select count(*) from scout.source_state where tracker_id=$1)<201
    on conflict(tracker_id,identity) do update set state=case when scout.source_state.state in ('complete','parked') then scout.source_state.state when scout.source_state.attempts>=3 then 'parked' else 'running' end,
      attempts=case when scout.source_state.state='parked' then scout.source_state.attempts else least(3,scout.source_state.attempts+1) end,
      reason=case when scout.source_state.state<>'parked' and scout.source_state.attempts>=3 then 'attempt_bound' else scout.source_state.reason end,
      lease_id=excluded.lease_id,lease_until=excluded.lease_until
    where scout.source_state.due_at<=clock_timestamp() and
      (scout.source_state.lease_until is null or scout.source_state.lease_until<clock_timestamp())
    returning *`,[source.tracker_id,source.identity??source.url,source.url,randomUUID(),source.native_id??null,source.native_ref??{}])).rows[0];
}
export async function finishSource(db,source,{observed,processed,state='complete',reason=null,retryAt,attempts=0,cursor=null,research=null}={}){
  return (await db.query(`update scout.source_state set observed_hash=coalesce($3,observed_hash),processed_hash=case when $11 then $4 else processed_hash end,
    state=$5,reason=$6,attempts=$7,due_at=greatest(clock_timestamp()+interval '1 minute',$8::timestamptz),
    checked_at=clock_timestamp(),lease_id=null,lease_until=null,cursor=$9,research=coalesce($10,research)
    where id=$1 and lease_id=$2 and lease_until>clock_timestamp() returning id`,
    [source.id,source.lease_id,observed??null,processed??null,state,reason,attempts,retryAt??new Date(Date.now()+6*3600000).toISOString(),cursor,research,processed!==undefined])).rows.length>0;
}
