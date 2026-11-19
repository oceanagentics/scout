begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_advisory_xact_lock(hashtextextended('scout:findings',0));

-- Preserve existing descriptions; enforce the ceiling on every inserted/updated row.
alter table scout.records
 add constraint records_description_length check(char_length(description)<=280) not valid,
 drop constraint records_details_check,
 add constraint records_details_length check(char_length(details)<=4096);

notify pgrst,'reload schema';
commit;
