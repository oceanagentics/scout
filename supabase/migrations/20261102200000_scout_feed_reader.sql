begin;
set local lock_timeout='5s';
set local statement_timeout='5s';
lock table scout.trackers in access exclusive mode;
do $$ begin
 if exists(select 1 from scout.trackers where lease_until>clock_timestamp())
 then raise exception 'Wait for active tracker checks before feed cutover';end if;
 if to_regclass('cron.job') is not null then
  if exists(select 1 from cron.job where active and (jobname like 'scout-%' or command ilike '%scout%'))
  then raise exception 'Pause Scout jobs before feed cutover';end if;
 end if;
end $$;

-- Start existing and newly configured sources three weeks back, then consume forward.
alter table scout.trackers
 drop column next_check_at,
 add column last_successful_check timestamptz default date_trunc('milliseconds',now()-interval '21 days');
create index trackers_due on scout.trackers(last_checked_at) where enabled and failure_count<3;
create or replace function scout.reset_tracker() returns trigger language plpgsql set search_path='' as $$
begin
 new.enabled=false;
 new.last_checked_at=null;new.last_successful_check=date_trunc('milliseconds',clock_timestamp()-interval '21 days');
 new.last_error=null;new.failure_count=0;new.lease_id=null;new.lease_until=null;
 return new;
end $$;
grant select(last_successful_check) on scout.trackers to authenticated;
notify pgrst,'reload schema';
commit;
