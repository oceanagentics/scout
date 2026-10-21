begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_advisory_xact_lock(hashtextextended('scout:findings',0));
lock table scout.records,scout.trackers,scout.delivery_state in access exclusive mode;
do $$ begin
 if exists(select 1 from scout.trackers where lease_until>clock_timestamp())
 or exists(select 1 from scout.delivery_state where status='sending')
 then raise exception 'Pause Scout work before flattening records';end if;
 if to_regclass('cron.job') is not null then
  if exists(select 1 from cron.job where active and (jobname like 'scout-%' or command ilike '%scout%'))
  then raise exception 'Pause Scout jobs before flattening records';end if;
 end if;
end $$;

create function scout.date_span(value text) returns daterange language plpgsql immutable set search_path='' as $$
declare first_day date;last_day date;
begin
 if value is null then return null;end if;
 if value~'^\d{4}$' then first_day:=(value||'-01-01')::date;last_day:=(value||'-12-31')::date;
 elsif value~'^\d{4}-\d{2}$' then first_day:=(value||'-01')::date;last_day:=(first_day+interval '1 month'-interval '1 day')::date;
 elsif value~'^\d{4}-\d{2}-\d{2}$' then first_day:=value::date;last_day:=first_day;
 else raise exception 'Invalid date';end if;
 return daterange(first_day,last_day,'[]');
end $$;
revoke all on function scout.date_span(text) from public,anon;
grant execute on function scout.date_span(text) to authenticated,service_role;

create table scout.flat_records(
 id uuid primary key default gen_random_uuid(),
 description text not null check(length(trim(description))>0),
 type text check(type in ('event','announcement','treaty_status')),
 priority text check(priority in ('high','normal','low')),
 organizations text[] not null default '{}',
 deadline text check(deadline is null or scout.date_span(deadline) is not null),
 date text check(date is null or scout.date_span(date) is not null),
 starttime text check(starttime~'^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$'),
 timezone text,
 sources text[] not null default '{}',
 modified timestamptz[] not null default array[date_trunc('milliseconds',clock_timestamp())] check(cardinality(modified)>0),
 check(array_position(organizations,null) is null and array_position(sources,null) is null and array_position(modified,null) is null)
);
insert into scout.flat_records
select r.id,r.description,r.kind,r.priority,
 array(select o->>'name' from jsonb_array_elements(r.organizations) with ordinality as names(o,n) where nullif(o->>'name','') is not null group by o->>'name' order by min(n)),
 r.details#>>'{response_due,value}',primary_date->>'value',primary_date->>'time',primary_date->>'zone',
 array(select distinct url from (
  select s->>'url' url from jsonb_array_elements(r.sources) s
  union all select r.canonical_url union all select r.details->>'registration_url'
 ) links where nullif(url,'') is not null order by url),
 array(select distinct at from unnest(array[r.discovered_at,r.updated_at]) at where at is not null order by at)
from scout.records r cross join lateral (select r.details->case r.kind when 'event' then 'start' when 'announcement' then 'published' else 'action_date' end primary_date) d;

-- Keep the existing delivery row and outcome; use the saved modification instead of a record version.
alter table scout.delivery_state add column modified_at timestamptz;
update scout.delivery_state d set modified_at=case when d.version=r.version then r.updated_at else '-infinity'::timestamptz end
 from scout.records r where r.id=d.record_id;
alter table scout.delivery_state alter column modified_at set not null,drop column version;

do $$ begin
 if (select count(*) from scout.records)<>(select count(*) from scout.flat_records)
 or exists(select 1 from scout.records r left join scout.flat_records f using(id) where f.id is null or f.description<>r.description)
 then raise exception 'Incomplete record conversion';end if;
end $$;
drop function scout.findings(text,text,date,date,text,text,text,jsonb,integer,text,uuid);
drop view scout.finding_reader;
alter table scout.delivery_state drop constraint delivery_state_record_id_fkey;
drop table scout.records;
alter table scout.flat_records rename to records;
alter index scout.flat_records_pkey rename to records_pkey;
alter table scout.delivery_state add constraint delivery_state_record_id_fkey foreign key(record_id) references scout.records(id);
drop function scout.finding_span(text,jsonb);
drop function scout.date_span(jsonb);
alter table scout.records enable row level security;
create policy scout_read on scout.records for select to authenticated using((select scout.access_role()) is not null);
revoke all on scout.records from public,anon,authenticated,service_role;
grant select on scout.records to authenticated;
grant select,insert,update,delete on scout.records to service_role;
create index records_dates on scout.records using gist(scout.date_span(date));
create index records_deadlines on scout.records using gist(scout.date_span(deadline));
create index records_organizations on scout.records using gin(organizations);
create index records_sources on scout.records using gin(sources);
create index records_description on scout.records(lower(description));

create function scout.findings(p_type text default null,p_priority text default null,p_from date default null,p_to date default null,
 p_organization text default null,p_search text default null,p_meaning text default null,p_after jsonb default null,p_limit integer default 50,p_order text default 'priority',p_id uuid default null)
returns setof scout.records language plpgsql stable security definer set search_path='' as $$
begin
 if scout.access_role() is null and current_setting('role',true)<>'service_role' then return;end if;
 return query select r.* from scout.records r
 where (p_type is null or r.type=p_type) and (p_priority is null or coalesce(r.priority,'unassessed')=p_priority)
 and (p_organization is null or p_organization=any(r.organizations)) and (p_id is null or r.id=p_id)
 and (nullif(trim(p_search),'') is null or to_tsvector('simple',r.description||' '||array_to_string(r.organizations,' ')) @@ plainto_tsquery('simple',p_search))
 and (p_from is null and p_to is null or scout.date_span(case when p_meaning='deadline' then r.deadline else r.date end) && daterange(p_from,p_to,'[]'))
 and (p_meaning is null or p_meaning in ('date','deadline'))
 and (p_after is null or (case when p_order='date' then 0 else case r.priority when 'high' then 0 when 'normal' then 1 when 'low' then 2 else 3 end end,coalesce(lower(scout.date_span(r.date)),'infinity'::date),r.id)>
  ((p_after->>'rank')::integer,coalesce((p_after->>'day')::date,'infinity'::date),(p_after->>'id')::uuid))
 order by case when p_order='date' then 0 else case r.priority when 'high' then 0 when 'normal' then 1 when 'low' then 2 else 3 end end,
 coalesce(lower(scout.date_span(r.date)),'infinity'::date),r.id
 limit greatest(1,least(coalesce(p_limit,50),100));
end $$;
revoke all on function scout.findings(text,text,date,date,text,text,text,jsonb,integer,text,uuid) from public,anon;
grant execute on function scout.findings(text,text,date,date,text,text,text,jsonb,integer,text,uuid) to authenticated,service_role;
analyze scout.records;
notify pgrst,'reload schema';
commit;
