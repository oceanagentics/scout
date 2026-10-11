-- Install only after schema/backend review. All recurring work remains disabled.
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.alter_job(jobid,active:=false) from cron.job
 where jobname in ('scout-collection','scout-findings','scout-health','scout-retention');
drop function if exists scout.loop_health();
drop function if exists scout.loop_retention();
create or replace function scout.loop_tick(mode text default 'next') returns void
language plpgsql security definer set search_path='' as $$
declare key text;
begin
 if mode<>'next' then return;end if;
 -- pg_cron writes a row per wake even when no source is due. Retain one day,
 -- delete at most two days of this job's completed rows; never another service's.
 delete from cron.job_run_details where runid in (
  select d.runid from cron.job_run_details d join cron.job j using(jobid)
  where j.jobname='scout-collection' and d.end_time<clock_timestamp()-interval '1 day'
  order by d.end_time limit 48);
 if not exists(select 1 from scout.quota_policy where id and enabled and verified_until>clock_timestamp()
  and verified_rpm>0 and verified_rpd>0 and verified_tpm>0
  and database_verified_until>clock_timestamp() and database_bytes between 0 and 399999999) then return;end if;
 if not exists(select 1 from scout.source_state s join scout.trackers t on t.id=s.tracker_id
  where t.enabled and s.due_at<=clock_timestamp() and (s.lease_until is null or s.lease_until<clock_timestamp())) then return;end if;
 select decrypted_secret into key from vault.decrypted_secrets where name='scout_loop_backend_key';
 if key is null then return;end if;
 perform net.http_post(url:='https://vhlfumeyhkeospnemukq.supabase.co/functions/v1/scout-collect-hsa?next=true',
  headers:=jsonb_build_object('apikey',key),body:=null,timeout_milliseconds:=120000);
end $$;
revoke all on function scout.loop_tick(text) from public,anon,authenticated,service_role;
select cron.schedule('scout-collection','0 * * * *',$$select scout.loop_tick('next')$$);
select cron.alter_job(jobid,active:=false) from cron.job
 where jobname in ('scout-collection','scout-findings','scout-health','scout-retention');
