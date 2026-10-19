begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_advisory_xact_lock(hashtextextended('scout:findings',0));
lock table scout.records in access exclusive mode;
lock table scout.source_state,scout.quota_policy,scout.delivery_state in share mode;
do $$ begin
 if (select enabled from scout.quota_policy) or exists(select 1 from scout.source_state where state='running' or lease_until>clock_timestamp())
 or exists(select 1 from scout.delivery_state where status='sending')
 then raise exception 'Pause Scout work before removing finding titles';end if;
 if to_regclass('cron.job') is not null then
  if exists(select 1 from cron.job where active and (jobname like 'scout-%' or command ilike '%scout%'))
  then raise exception 'Pause Scout jobs before removing finding titles';end if;
 end if;
 if (select count(*) from scout.records)>1000 then raise exception 'Review migration budget above 1000 findings';end if;
 if exists(select 1 from scout.records where overrides ? 'title')
 then raise exception 'Review human title corrections before migration';end if;
end $$;

drop function scout.findings(text,text,date,date,text,text,text,jsonb,integer,text,uuid);
drop view scout.finding_reader;
drop index scout.records_text;
drop index scout.records_title;
-- Preserve useful legacy text only where no description exists; never truncate it.
alter table scout.records drop constraint compact_records_description_check;
update scout.records set description=title where nullif(trim(description),'') is null;
update scout.records set provenance=provenance-'title',
 completeness=jsonb_set(completeness,'{unknowns}',coalesce(completeness->'unknowns','{}')-'title')
 where provenance ? 'title' or completeness->'unknowns' ? 'title';
alter table scout.records alter column description set not null;
alter table scout.records add constraint records_description_check check(length(trim(description))>0);
alter table scout.records drop column title;
create index records_text on scout.records using gin(to_tsvector('simple',coalesce(description,'')||' '||organizations::text));
create index records_description on scout.records(lower(description));

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
