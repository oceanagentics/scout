begin;
set local lock_timeout='5s';
set local statement_timeout='5s';
lock table scout.trackers in access exclusive mode;
do $$ begin
 if exists(select 1 from scout.trackers where lease_until>clock_timestamp())
 then raise exception 'Wait for active tracker checks before retirement cutover';end if;
 if to_regclass('cron.job') is not null then
  if exists(select 1 from cron.job where active and (jobname like 'scout-%' or command ilike '%scout%'))
  then raise exception 'Pause Scout jobs before retirement cutover';end if;
 end if;
end $$;

alter table scout.trackers add column retire_on date;
grant select(retire_on),insert(retire_on),update(retire_on) on scout.trackers to authenticated;

-- COP17 closed on 31 October; keep its dedicated sources for four more weeks.
-- The general CBD side-event registry remains an ongoing source.
update scout.trackers set retire_on='2026-11-28' where id in (
 'ef167795-73bb-4caa-9ec5-deb70cc91412','b1e1ff02-6c67-4b4d-8a0a-e3a92ade64f6',
 'f35c130a-3762-46d1-a518-77d6154fc0b1','9f88efb7-e4b9-4ebb-bc29-3f79d1c1272b',
 '5b856f85-23d9-4b6e-8c4f-cde168c98bc8','f709274a-9535-4c9a-a59d-0e044c92e719',
 '1172642b-c3bc-4e25-bb66-61f6841a0286','4d34c0c0-33ef-4918-a0bd-dffaa8f747e2',
 '346333d7-66b9-4f15-8edf-ac6092e8e558','8f994fe1-4076-46d2-bacf-3c59ea09f1d8',
 'a8bebde1-b2d3-4aba-9e9c-39a4dc1bf318'
);

-- Deploy scout-reader and the website, then reinstall the paused scout-loop.sql.
notify pgrst,'reload schema';
commit;
