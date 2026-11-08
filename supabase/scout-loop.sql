-- Install paused; enable the three jobs after deployed collection and Slack are verified.
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.alter_job(jobid,active:=false) from cron.job
 where jobname in ('scout-collection','scout-findings','scout-health','scout-retention','scout-morning','scout-weekly');
select cron.unschedule(jobid) from cron.job where jobname in ('scout-findings','scout-health','scout-retention');
drop function if exists scout.loop_health();
drop function if exists scout.loop_retention();
create or replace function scout.loop_tick(mode text default 'next') returns void
language plpgsql security definer set search_path='' as $$
declare key text;endpoint text;local_now timestamp:=clock_timestamp() at time zone 'America/New_York';
begin
 if mode not in ('next','morning','weekly') then return;end if;
 -- pg_cron writes a row per wake even when no tracker is due. Retain one day,
 -- prune this job's completed rows in batches; never another service's.
 delete from cron.job_run_details where runid in (
  select d.runid from cron.job_run_details d join cron.job j using(jobid)
  where j.jobname in ('scout-collection','scout-morning','scout-weekly') and d.end_time<clock_timestamp()-interval '1 day'
  order by d.end_time limit 48);
 if mode='next' then
 if not exists(select 1 from scout.trackers t
  where t.enabled and t.failure_count<3
    and (t.last_checked_at is null or t.last_successful_check is distinct from t.last_checked_at
      or date_trunc('day',t.last_successful_check at time zone 'America/New_York')+t.cadence
        <=date_trunc('day',local_now))
    and (t.retire_on is null or t.retire_on>local_now::date)
    and (t.lease_until is null or t.lease_until<=clock_timestamp())) then return;end if;
 endpoint:='scout-reader';
 else
 -- Supabase cron runs in GMT. Only one candidate hour matches New York time.
 if mode='morning' and extract(hour from local_now)<>8 then return;end if;
 if mode='weekly' and (extract(hour from local_now)<>9 or extract(isodow from local_now)<>1) then return;end if;
 endpoint:='scout-notify?kind='||mode;
 end if;
 select decrypted_secret into key from vault.decrypted_secrets where name='scout_loop_backend_key';
 if key is null then return;end if;
 perform net.http_post(url:='https://vhlfumeyhkeospnemukq.supabase.co/functions/v1/'||endpoint,
  headers:=jsonb_build_object('apikey',key),body:=null,timeout_milliseconds:=120000);
end $$;
revoke all on function scout.loop_tick(text) from public,anon,authenticated,service_role;
select cron.schedule('scout-collection','*/6 * * * *',$$select scout.loop_tick('next')$$);
select cron.schedule('scout-morning','0 12,13 * * *',$$select scout.loop_tick('morning')$$);
select cron.schedule('scout-weekly','0 13,14 * * 1',$$select scout.loop_tick('weekly')$$);
select cron.alter_job(jobid,active:=false) from cron.job
 where jobname in ('scout-collection','scout-morning','scout-weekly');
