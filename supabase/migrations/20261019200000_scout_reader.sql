begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_advisory_xact_lock(hashtextextended('scout:findings',0));
lock table scout.records,scout.trackers,scout.source_state in access exclusive mode;
lock table scout.quota_policy,scout.delivery_state in share mode;
do $$ begin
 if (select enabled from scout.quota_policy) or exists(select 1 from scout.source_state where state='running' or lease_until>clock_timestamp())
 or exists(select 1 from scout.delivery_state where status='sending')
 then raise exception 'Pause Scout work before reader cutover';end if;
 if to_regclass('cron.job') is not null then
  if exists(select 1 from cron.job where active and (jobname like 'scout-%' or command ilike '%scout%'))
  then raise exception 'Pause Scout jobs before reader cutover';end if;
 end if;
 if (select count(*) from scout.records)>1000 or (select count(*) from scout.trackers)>500
 then raise exception 'Review migration budget above 1000 findings or 500 trackers';end if;
end $$;

drop function scout.finding_jobs(uuid);
drop view scout.tracker_status;
-- Reinstall the paused scheduler from scout-loop.sql after deploying scout-reader.
drop function if exists scout.loop_tick(text);
alter table scout.trackers
 drop constraint trackers_url_check,
 add column next_check_at timestamptz default now(),
 add column last_checked_at timestamptz,
 add column last_error text,
 add column failure_count integer not null default 0 check(failure_count between 0 and 3),
 add column lease_id uuid,
 add column lease_until timestamptz,
 add constraint tracker_lease_pair check((lease_id is null)=(lease_until is null));
create index trackers_due on scout.trackers(next_check_at) where enabled and failure_count<3;
-- No article inventory, completion flag, hashes, cursor or research metadata is migrated.
drop table scout.source_state;

drop trigger invalidate_collector_proof on scout.trackers;
drop function scout.invalidate_collector_proof();
create function scout.reset_tracker() returns trigger language plpgsql set search_path='' as $$
begin
 new.enabled=false;
 new.next_check_at=clock_timestamp();new.last_checked_at=null;new.last_error=null;
 new.failure_count=0;new.lease_id=null;new.lease_until=null;
 return new;
end $$;
revoke all on function scout.reset_tracker() from public,anon,authenticated,service_role;
create trigger reset_tracker before update of url on scout.trackers
 for each row when(old.url is distinct from new.url) execute function scout.reset_tracker();
revoke select on scout.trackers from authenticated;
grant select(id,name,url,coverage,collector,cadence,enabled,seed_key,next_check_at,last_checked_at,last_error,failure_count)
 on scout.trackers to authenticated;

drop function scout.findings(text,text,date,date,text,text,text,jsonb,integer,text,uuid);
drop view scout.finding_reader;
alter table scout.records drop column overrides,drop column provenance;
-- Remove correction-specific labels without copying their metadata elsewhere.
update scout.records r set sources=(select jsonb_agg(case when s->>'relationship'='human_review' then s-'relationship' else s end order by n)
 from jsonb_array_elements(r.sources) with ordinality as items(s,n))
 where r.sources @> '[{"relationship":"human_review"}]';

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
    and (nullif(trim(p_search),'') is null or to_tsvector('simple',coalesce(r.description,'')||' '||r.organizations::text) @@ plainto_tsquery('simple',p_search))
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
