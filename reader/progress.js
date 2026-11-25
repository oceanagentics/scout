const fail=reason=>Object.assign(new Error(reason),{reason});
export async function verifyLease(tx,tracker){
 if(!(await tx.query(`select id from scout.trackers where id=$1 and lease_id=$2 and url=$3 and lease_until>clock_timestamp() for update`,[tracker.id,tracker.lease_id,tracker.url])).rows.length)throw fail('stale_lease');
}
export async function pendingItems(db,tracker){
 return (await db.query('select * from scout.source_items where tracker_id=$1 and pending order by item_key',[tracker.id])).rows;
}
export async function registerItems(db,tracker,discovery,deadline){
 await db.transaction(async tx=>{
  await verifyLease(tx,tracker);
  if(discovery.items.length)await tx.query(`insert into scout.source_items(tracker_id,item_key,url,observed_version)
   select $1,x.key,x.url,x.version from jsonb_to_recordset($2::jsonb) as x(key text,url text,version text)
   on conflict(tracker_id,item_key) do update set url=excluded.url,observed_version=excluded.observed_version,
   last_error=case when scout.source_items.url is distinct from excluded.url or scout.source_items.observed_version is distinct from excluded.observed_version then null else scout.source_items.last_error end,
   pending=scout.source_items.pending or excluded.observed_version is null or scout.source_items.consumed_version is distinct from excluded.observed_version
   where not scout.source_items.ignored and (scout.source_items.url is distinct from excluded.url or excluded.observed_version is null
     or scout.source_items.observed_version is distinct from excluded.observed_version)`,
   [tracker.id,JSON.stringify(discovery.items.map(i=>({key:i.key,url:i.url,version:i.version??null})))]);
  if(!discovery.retainMissing&&!discovery.unchanged&&!discovery.excluded)await tx.query('delete from scout.source_items where tracker_id=$1 and not pending and not ignored and not(item_key=any($2::text[]))',[tracker.id,discovery.items.map(i=>i.key)]);
  if(!discovery.excluded)await tx.query('update scout.trackers set discovery_request_url=$2,discovery_checked_at=$3,discovery_fingerprint=$4 where id=$1',
   [tracker.id,discovery.source.request_url,discovery.source.checked_at,discovery.source.fingerprint??null]);
 },{deadline});
}
export async function consumeItem(tx,tracker,row,resource,lastError=null){
 const result=await tx.query(`update scout.source_items set pending=false,consumed_version=observed_version,consumed_at=clock_timestamp(),
  request_url=coalesce($4,request_url),request_checked_at=coalesce($5::timestamptz,request_checked_at),
  request_fingerprint=case when $4::text is null then request_fingerprint else $6 end,last_error=$7
  where tracker_id=$1 and item_key=$2 and observed_version is not distinct from $3 and pending returning item_key`,
  [tracker.id,row.item_key,row.observed_version,resource?.request_url??null,resource?.checked_at??null,resource?.fingerprint??null,lastError]);
 if(!result.rows.length)throw fail('stale_record');
 await tx.query('update scout.trackers set failure_count=0,last_error=null where id=$1',[tracker.id]);
}
export async function completeSource(db,tracker,through,deadline){
 await db.transaction(async tx=>{
  await verifyLease(tx,tracker);
  await tx.query('update scout.trackers set last_successful_check=$2,last_error=null,failure_count=0,lease_id=null,lease_until=null where id=$1',[tracker.id,through]);
 },{deadline});
}
