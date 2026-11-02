begin;
set local lock_timeout='5s';
set local statement_timeout='5s';
do $$ begin
 if to_regclass('cron.job') is not null then
  if exists(select 1 from cron.job where active and (jobname like 'scout-%' or command ilike '%scout%'))
  then raise exception 'Pause Scout jobs before removing tracker seed keys';end if;
 end if;
end $$;
alter table scout.trackers drop column seed_key;
notify pgrst,'reload schema';
commit;
