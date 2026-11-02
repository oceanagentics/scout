begin;
set local lock_timeout='5s';
set local statement_timeout='5s';
do $$ begin
 if to_regclass('cron.job') is not null then
  if exists(select 1 from cron.job where active and (jobname like 'scout-%' or command ilike '%scout%'))
  then raise exception 'Pause Scout jobs before removing delivery state';end if;
 end if;
end $$;
-- Deploy scout-notify without delivery-state reads/writes before dropping the table.
drop table scout.delivery_state;
notify pgrst,'reload schema';
commit;
