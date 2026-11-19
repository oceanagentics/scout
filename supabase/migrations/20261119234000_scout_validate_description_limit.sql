begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_advisory_xact_lock(hashtextextended('scout:findings',0));

update scout.records set description=left(description,280),
 modified=array_append(modified,greatest(date_trunc('milliseconds',clock_timestamp()),
   modified[cardinality(modified)]+interval '1 millisecond'))
 where char_length(description)>280;
alter table scout.records validate constraint records_description_length;

commit;
