begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_advisory_xact_lock(hashtextextended('scout:findings',0));
create function scout.migrate_sources(value text[]) returns jsonb language sql immutable set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('url',url,'role','unclassified')),'[]'::jsonb) from unnest(value) url
$$;
do $$ declare c record; begin
 for c in select conname from pg_constraint where conrelid='scout.records'::regclass and contype='c' and pg_get_constraintdef(oid) like '%sources%'
 loop execute format('alter table scout.records drop constraint %I',c.conname);end loop;
end $$;
drop index scout.records_sources;
alter table scout.records alter column sources drop default;
alter table scout.records alter column sources type jsonb using scout.migrate_sources(sources);
alter table scout.records alter column sources set default '[]'::jsonb;
alter table scout.records add constraint record_sources_array check(jsonb_typeof(sources)='array' and not jsonb_path_exists(sources,
 '$[*] ? (@.type() != "object" || !(exists(@.url)) || @.url.type() != "string" || !(exists(@.role)) || !(@.role == "finding" || @.role == "supporting" || @.role == "unclassified"))')),
 add column details text check(octet_length(details)<=4096);
drop function scout.migrate_sources(text[]);
create index records_sources on scout.records using gin(sources jsonb_path_ops);
alter table scout.trackers add column discovery_request_url text,add column discovery_checked_at timestamptz;
create table scout.source_items(
 tracker_id uuid not null references scout.trackers(id) on delete cascade,
 item_key text not null,url text not null,observed_version text,consumed_version text,
 pending boolean not null default true,consumed_at timestamptz,request_url text,request_checked_at timestamptz,
 primary key(tracker_id,item_key)
);
create index source_items_pending on scout.source_items(tracker_id) where pending;
alter table scout.source_items enable row level security;
revoke all on scout.source_items from public,anon,authenticated;
grant select,insert,update,delete on scout.source_items to service_role;
create or replace function scout.reset_tracker() returns trigger language plpgsql security definer set search_path='' as $$
begin
 new.enabled=false;new.last_checked_at=null;new.last_successful_check=null;
 new.last_error=null;new.failure_count=0;new.lease_id=null;new.lease_until=null;
 new.discovery_request_url=null;new.discovery_checked_at=null;
 delete from scout.source_items where tracker_id=new.id;
 return new;
end $$;
create or replace function scout.findings(p_type text default null,p_priority text default null,p_from date default null,p_to date default null,
 p_organization text default null,p_search text default null,p_meaning text default null,p_after jsonb default null,p_limit integer default 50,p_order text default 'priority',p_id uuid default null)
returns setof scout.records language plpgsql stable security definer set search_path='' as $$
begin
 if scout.access_role() is null and current_setting('role',true)<>'service_role' then return;end if;
 return query select r.* from scout.records r
 where (p_type is null or r.type=p_type) and (p_priority is null or coalesce(r.priority,'unassessed')=p_priority)
 and (p_organization is null or p_organization=any(r.organizations)) and (p_id is null or r.id=p_id)
 and (nullif(trim(p_search),'') is null or to_tsvector('simple',r.description||' '||array_to_string(r.organizations,' ')||' '||coalesce(r.details,'')) @@ plainto_tsquery('simple',p_search))
 and (p_from is null and p_to is null or scout.date_span(case when p_meaning='deadline' then r.deadline else r.date end) && daterange(p_from,p_to,'[]'))
 and (p_meaning is null or p_meaning in ('date','deadline'))
 and (p_after is null or (case when p_order='date' then 0 else case r.priority when 'high' then 0 when 'normal' then 1 when 'low' then 2 else 3 end end,coalesce(lower(scout.date_span(r.date)),'infinity'::date),r.id)>
  ((p_after->>'rank')::integer,coalesce((p_after->>'day')::date,'infinity'::date),(p_after->>'id')::uuid))
 order by case when p_order='date' then 0 else case r.priority when 'high' then 0 when 'normal' then 1 when 'low' then 2 else 3 end end,
 coalesce(lower(scout.date_span(r.date)),'infinity'::date),r.id
 limit greatest(1,least(coalesce(p_limit,50),100));
end $$;

notify pgrst,'reload schema';
commit;
