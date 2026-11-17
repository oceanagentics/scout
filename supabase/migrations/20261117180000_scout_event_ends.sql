begin;
set local lock_timeout='5s';
set local statement_timeout='10s';

-- The final published day is inclusive; endtime uses the record's timezone.
alter table scout.records
 add column enddate text check(enddate is null or scout.date_span(enddate) is not null),
 add column endtime text check(endtime~'^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$');

notify pgrst,'reload schema';
commit;
