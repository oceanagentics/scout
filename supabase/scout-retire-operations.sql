-- One-time legacy cleanup before the findings cutover. Run as one transaction.
-- Keep final facts/URLs for the deployed reader; prohibit all old producer writes.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
set local idle_in_transaction_session_timeout='30s';
do $$
declare records_before bytea[]; kept jsonb;
begin
 if to_regclass('scout.source_state') is not null then raise exception 'Findings cutover already applied';end if;
 lock table scout.records in share mode nowait;
 lock table scout.evidence,scout.collection_runs in access exclusive mode nowait;
 if to_regclass('cron.job') is not null and exists(select 1 from cron.job where active and
   (jobname like 'scout-%' or command ilike '%scout%')) then raise exception 'Pause Scout jobs first';end if;
 if exists(select 1 from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
   and (xact_start is not null or state is null and (backend_type='client backend' or backend_type is null)))
   then raise exception 'Other active or unobservable transactions require review';end if;
 if exists(select 1 from scout.collection_runs r cross join lateral jsonb_array_elements(coalesce(stats->'model_attempts','[]')) a
   where coalesce((a->>'at')::timestamptz,r.started_at)>=least(clock_timestamp()-interval '120 seconds',
     date_trunc('day',clock_timestamp() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles'))
   or exists(select 1 from scout.collection_runs where (stats->>'model_retry_at')::timestamptz>clock_timestamp())
   then raise exception 'Active quota accounting must survive; wait for its window to close';end if;
 if exists(select 1 from scout.collection_runs where stats#>>'{delivery,status}' in ('unknown','dispatching'))
   or exists(select 1 from scout.collection_runs r cross join lateral jsonb_array_elements(coalesce(stats#>'{delivery,records}','[]')) d
     left join scout.records f on f.id=(d->>'id')::uuid where r.stats#>>'{delivery,status}'='sent'
     and (f.id is null or f.last_communicated_at is null or f.last_communicated_at<(d->>'updated_at')::timestamptz))
   then raise exception 'Unresolved notification accounting requires preservation';end if;
 if exists(select 1 from pg_trigger where not tgisinternal and tgrelid in ('scout.evidence'::regclass,'scout.collection_runs'::regclass))
   or exists(select 1 from pg_constraint where contype='f' and confrelid in ('scout.evidence'::regclass,'scout.collection_runs'::regclass))
   then raise exception 'Unexpected legacy table dependency';end if;
 if (select count(*) from scout.records)>1000 or (select count(*) from scout.evidence)>10000
   or (select count(*) from scout.collection_runs)>10000 then raise exception 'Cleanup exceeds reviewed size';end if;
 select array_agg(record_send(r) order by id) into records_before from scout.records r;
 -- Values, acceptance time and source URLs are useful facts. Quotes, ranking,
 -- superseded values, captured documents and processing/review histories are not.
 select coalesce(jsonb_agg(to_jsonb(row(e.id,e.tracker_id,e.url,e.content_hash,''::text,e.published_at,e.collected_at,
   jsonb_build_object('accepted_fields',coalesce((select jsonb_object_agg(k,jsonb_strip_nulls(jsonb_build_object(
     'value',v->'value','accepted_at',v->'accepted_at','sources',coalesce((select jsonb_agg(jsonb_build_object('url',url))
       from (select distinct s->>'url' url from jsonb_array_elements(coalesce(v->'sources','[]')) s where s->>'url' is not null) urls),'[]'::jsonb))))
     from jsonb_each(coalesce(e.parsed->'accepted_fields','{}')) f(k,v)),'{}'::jsonb),
     'assessment',coalesce((select jsonb_object_agg(k,v) from jsonb_each(coalesce(e.parsed->'assessment','{}')) a(k,v)
       where k in ('priority','priority_accepted','reason','accepted_at')),'{}'::jsonb)),
   e.published_on,e.record_id,e.last_seen_at,e.authoritative,e.evidence_at)::scout.evidence) order by e.id),'[]'::jsonb)
   into kept from scout.evidence e where record_id is not null;
 if pg_column_size(kept)>2097152 then raise exception 'Retained facts exceed 2 MiB review bound';end if;
 truncate scout.evidence,scout.collection_runs;
 insert into scout.evidence select * from jsonb_populate_recordset(null::scout.evidence,kept);
 if kept is distinct from (select coalesce(jsonb_agg(to_jsonb(e) order by id),'[]'::jsonb) from scout.evidence e)
   or records_before is distinct from (select array_agg(record_send(r) order by id) from scout.records r)
   then raise exception 'Useful data preservation failed';end if;
end $$;
-- NOT VALID preserves the retained reader rows but rejects every future INSERT
-- and UPDATE, including an obsolete collector connected as the table owner.
alter table scout.evidence add constraint legacy_operations_retired check(false) not valid;
alter table scout.collection_runs add constraint legacy_operations_retired check(false) not valid;
revoke insert,update,delete,truncate on scout.evidence,scout.collection_runs from authenticated,service_role;
drop function if exists scout.loop_tick(text);
drop function if exists scout.loop_health();
drop function if exists scout.loop_retention();
create or replace view scout.tracker_status with(security_invoker=true) as
select t.*,null::timestamptz last_attempt_at,null::timestamptz last_success_at,
 null::text last_outcome,null::text last_error,0::int awaiting_initial,null::timestamptz oldest_awaiting_at,
 0::int parked,0::int source_problems,null::text processing_problems,'Paused'::text loop_state from scout.trackers t;
drop function scout.source_backlog(uuid);
drop view scout.source_queue;
-- Extension tables are shared. Truncate only when every row is disposable;
-- otherwise delete just Scout's completed history / responses past pg_net's TTL.
do $$ begin
 if to_regclass('cron.job_run_details') is not null then
  lock table cron.job_run_details in access exclusive mode nowait;
  if (select count(*) from cron.job_run_details)>10000 then raise exception 'Cron history exceeds review bound';end if;
  if exists(select 1 from cron.job_run_details d where d.end_time is null or not exists(
    select 1 from cron.job j where j.jobid=d.jobid and j.jobname in ('scout-collection','scout-findings','scout-health','scout-retention'))) then
   delete from cron.job_run_details d using cron.job j where d.jobid=j.jobid and d.end_time is not null
    and j.jobname in ('scout-collection','scout-findings','scout-health','scout-retention');
  else truncate cron.job_run_details;end if;
 end if;
 if to_regclass('net._http_response') is not null then
  lock table net._http_response in access exclusive mode nowait;
  if (select count(*) from net._http_response)>1000 then raise exception 'HTTP response history exceeds review bound';end if;
  if current_setting('pg_net.ttl',true) is null then raise exception 'Verify pg_net response TTL before cleanup';end if;
  if exists(select 1 from net._http_response where created is null or created>=clock_timestamp()-current_setting('pg_net.ttl')::interval) then
   delete from net._http_response where created<clock_timestamp()-current_setting('pg_net.ttl')::interval;
  else truncate net._http_response;end if;
 end if;
end $$;
commit;
