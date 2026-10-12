begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_advisory_xact_lock(hashtextextended('scout:findings',0));
lock table scout.records,scout.record_sources,scout.record_identities in access exclusive mode;
lock table scout.source_state,scout.quota_policy in share mode;
do $$ begin
 if (select enabled from scout.quota_policy) or exists(select 1 from scout.source_state where state='running' or lease_until>clock_timestamp())
 then raise exception 'Pause Scout writes before compact storage migration';end if;
 if to_regclass('cron.job') is not null then
  if exists(select 1 from cron.job where active and (jobname like 'scout-%' or command ilike '%scout%'))
  then raise exception 'Pause Scout jobs before compact storage migration';end if;
 end if;
 if (select count(*) from scout.records)>1000 then raise exception 'Review migration budget above 1000 findings';end if;
 -- Legacy values must already have a current home before their columns are removed.
 if exists(select 1 from scout.records r where
  (organization is not null and not exists(select 1 from jsonb_array_elements(organizations) o where o->>'name'=organization)) or
  (event_url is not null and event_url is distinct from canonical_url and not exists(select 1 from scout.record_sources s where s.record_id=r.id and s.url=event_url)) or
  (location is not null and details->>'location' is null) or (registration_url is not null and details->>'registration_url' is null) or
  (starts_at is not null and details->'start' is null) or (ends_at is not null and details->'end' is null) or (status is not null and details->>'status' is null) or
  (identity_key is not null and not exists(select 1 from scout.record_identities i where i.record_id=r.id and i.identity='legacy:'||r.identity_key)) or checked_at is not null)
 then raise exception 'Unmapped legacy finding data';end if;
end $$;

-- Rebuild the one finding table so removed columns and old row versions occupy no new heap space.
create table scout.compact_records(
 id uuid primary key default gen_random_uuid(),version integer not null default 1,accepted_version integer,
 discovered_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),last_communicated_at timestamptz,
 kind text not null check(kind in ('event','announcement','treaty_status')),
 priority text check(priority in ('high','normal','low')),title text not null check(length(trim(title))>0),
 description text check(length(description)<=280),canonical_url text,
 organizations jsonb not null default '[]',details jsonb not null default '{}',overrides jsonb not null default '{}',provenance jsonb not null default '{}',
 completeness jsonb not null default '{"state":"provisional","unknowns":{}}',relevance jsonb not null default '{"state":"pending"}',
 date_span daterange generated always as(scout.finding_span(kind,details)) stored,
 sources jsonb not null default '[]' check(jsonb_typeof(sources)='array'),identities text[] not null default '{}'
);
insert into scout.compact_records(id,version,accepted_version,discovered_at,updated_at,last_communicated_at,kind,priority,title,description,canonical_url,
 organizations,details,overrides,provenance,completeness,relevance,sources,identities)
select r.id,r.version,r.accepted_version,r.discovered_at,r.updated_at,r.last_communicated_at,r.kind,r.priority,r.title,r.description,r.canonical_url,
 r.organizations,r.details,r.overrides,
 -- Keep human and field-specific provenance; all-source lists are already represented by sources.
 coalesce((select jsonb_object_agg(p.key,p.value) from jsonb_each(r.provenance) p
  where r.overrides ? p.key or jsonb_typeof(p.value)<>'array' or not(p.value @> links.urls and p.value <@ links.urls)),'{}'),
 r.completeness,r.relevance,links.sources,array(select identity from scout.record_identities i where i.record_id=r.id order by identity)
from scout.records r cross join lateral (
 select coalesce(jsonb_agg(jsonb_build_object('url',s.url,'tracker_id',s.tracker_id,'relationship',s.relationship) order by s.url),'[]') sources,
 coalesce(jsonb_agg(s.url),'[]') urls from scout.record_sources s where s.record_id=r.id
) links;
do $$ begin
 if (select count(*) from scout.records)<>(select count(*) from scout.compact_records) or
 exists(select 1 from scout.records r join scout.compact_records n using(id) where
  to_jsonb(r)-array['organization','location','event_url','registration_url','starts_at','ends_at','status','identity_key','evidence_rank','evidence_at','checked_at','provenance']
  is distinct from to_jsonb(n)-array['sources','identities','provenance']) or
 exists(select 1 from scout.record_sources s where not exists(select 1 from scout.compact_records r cross join lateral jsonb_array_elements(r.sources) v
  where r.id=s.record_id and v=jsonb_build_object('url',s.url,'tracker_id',s.tracker_id,'relationship',s.relationship))) or
 exists(select 1 from scout.record_identities i where not exists(select 1 from scout.compact_records r where r.id=i.record_id and i.identity=any(r.identities)))
 then raise exception 'Incomplete finding, source or identity transfer';end if;
end $$;

drop function scout.findings(text,text,date,date,text,text,text,jsonb,integer,text,uuid);
drop view scout.finding_reader;
drop table scout.record_sources,scout.record_identities;
alter table scout.delivery_state drop constraint delivery_state_record_id_fkey;
drop table scout.records;
alter table scout.compact_records rename to records;
alter index scout.compact_records_pkey rename to records_pkey;
alter table scout.delivery_state add constraint delivery_state_record_id_fkey foreign key(record_id) references scout.records(id);
alter table scout.records enable row level security;
create policy scout_read on scout.records for select to authenticated using((select scout.access_role()) is not null);
revoke all on scout.records from public,anon,authenticated,service_role;
grant select on scout.records to authenticated;
grant select,insert,update,delete on scout.records to service_role;
create index records_dates on scout.records using gist(date_span);
create index records_effective_dates on scout.records using gist(scout.date_span(details->'effective'));
create index records_organizations on scout.records using gin(organizations jsonb_path_ops);
create index records_text on scout.records using gin(to_tsvector('simple',title||' '||coalesce(description,'')||' '||organizations::text));
create index records_kind_priority on scout.records(kind,priority,id);
create index records_priority_page on scout.records((case priority when 'high' then 0 when 'normal' then 1 when 'low' then 2 else 3 end),(coalesce(lower(date_span),'infinity'::date)),id);
create index records_date_page on scout.records((coalesce(lower(date_span),'infinity'::date)),id);
create index records_title on scout.records(lower(title));
create index records_canonical on scout.records(canonical_url);
create index records_identities on scout.records using gin(identities);
create index records_sources on scout.records using gin(sources jsonb_path_ops);

create view scout.finding_reader with(security_barrier=true) as
select r.*,r.relevance->>'reason' as priority_reason from scout.records r
where (select scout.access_role()) is not null or current_setting('role',true)='service_role';
revoke all on scout.finding_reader from public,anon,authenticated,service_role;
grant select on scout.finding_reader to authenticated,service_role;
create function scout.findings(p_kind text default null,p_priority text default null,p_from date default null,p_to date default null,
  p_organization text default null,p_search text default null,p_meaning text default null,p_after jsonb default null,p_limit integer default 50,p_order text default 'priority',p_id uuid default null)
returns setof scout.finding_reader language plpgsql stable security definer set search_path='' as $$
begin
  if scout.access_role() is null and current_setting('role',true)<>'service_role' then return; end if;
  return query select projection.* from (select r.* from scout.records r
  where (p_kind is null or r.kind=p_kind) and (p_priority is null or coalesce(r.priority,'unassessed')=p_priority)
    and (p_organization is null or r.organizations @> jsonb_build_array(jsonb_build_object('name',p_organization)))
    and (p_id is null or r.id=p_id)
    and (nullif(trim(p_search),'') is null or to_tsvector('simple',r.title||' '||coalesce(r.description,'')||' '||r.organizations::text) @@ plainto_tsquery('simple',p_search))
    and (p_from is null and p_to is null or
      (case when p_meaning='effective' then scout.date_span(r.details->'effective') else r.date_span end) && daterange(p_from,p_to,'[]'))
    and (p_meaning is null or p_meaning in ('primary','effective'))
    and (p_after is null or (case when p_order='date' then 0 else case r.priority when 'high' then 0 when 'normal' then 1 when 'low' then 2 else 3 end end,coalesce(lower(r.date_span),'infinity'::date),r.id)>
      ((p_after->>'rank')::integer,coalesce((p_after->>'day')::date,'infinity'::date),(p_after->>'id')::uuid))
  order by case when p_order='date' then 0 else case r.priority when 'high' then 0 when 'normal' then 1 when 'low' then 2 else 3 end end,coalesce(lower(r.date_span),'infinity'::date),r.id
  limit greatest(1,least(coalesce(p_limit,50),100))) selected
  join scout.finding_reader projection on projection.id=selected.id
  order by case when p_order='date' then 0 else case selected.priority when 'high' then 0 when 'normal' then 1 when 'low' then 2 else 3 end end,
    coalesce(lower(selected.date_span),'infinity'::date),selected.id;
end
$$;
revoke all on function scout.findings(text,text,date,date,text,text,text,jsonb,integer,text,uuid) from public,anon;
grant execute on function scout.findings(text,text,date,date,text,text,text,jsonb,integer,text,uuid) to authenticated,service_role;


analyze scout.records;
notify pgrst,'reload schema';
commit;
