begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create function scout.cron()
 returns table(job_id bigint,name text,schedule text,enabled boolean,status text,
  started_at timestamptz,finished_at timestamptz,message text)
 language plpgsql stable security definer set search_path='' as $$
begin
 if scout.access_role() is null then
  raise exception 'Scout sign-in required' using errcode='42501';
 end if;
 return query
 select j.jobid,j.jobname,j.schedule,j.active,d.status,d.start_time,d.end_time,d.return_message
 from cron.job j
 left join lateral (
  select r.status,r.start_time,r.end_time,r.return_message
  from cron.job_run_details r where r.jobid=j.jobid
  order by r.start_time desc nulls last,r.runid desc limit 1
 ) d on true
 order by j.jobname,j.jobid;
end $$;
revoke all on function scout.cron() from public,anon,authenticated,service_role;
grant execute on function scout.cron() to authenticated;

notify pgrst,'reload schema';
commit;
