begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_advisory_xact_lock(hashtextextended('scout:findings',0));

-- The existing details byte constraint aborts the transaction if a fact cannot fit.
update scout.records set
 type=case when type='treaty_status' then 'announcement' else type end,
 details=case when deadline is null then details
   else concat_ws(' ',nullif(details,''),'Submission deadline: '||deadline||'.') end,
 modified=array_append(modified,greatest(date_trunc('milliseconds',clock_timestamp()),
   modified[cardinality(modified)]+interval '1 millisecond'))
 where type='treaty_status' or deadline is not null;

alter table scout.records drop constraint flat_records_type_check,
 add constraint records_type_check check(type in ('event','announcement')),
 drop column deadline;

drop function scout.findings(text,text,date,date,text,text,text,jsonb,integer,text,uuid);
create function scout.findings(p_type text default null,p_priority text default null,p_from date default null,p_to date default null,
 p_organization text default null,p_search text default null,p_after jsonb default null,p_limit integer default 50,p_order text default 'priority',p_id uuid default null)
returns setof scout.records language plpgsql stable security definer set search_path='' as $$
begin
 if scout.access_role() is null and current_setting('role',true)<>'service_role' then return;end if;
 return query select r.* from scout.records r
 where (p_type is null or r.type=p_type) and (p_priority is null or coalesce(r.priority,'unassessed')=p_priority)
 and (p_organization is null or p_organization=any(r.organizations)) and (p_id is null or r.id=p_id)
 and (nullif(trim(p_search),'') is null or to_tsvector('simple',r.description||' '||array_to_string(r.organizations,' ')||' '||coalesce(r.details,'')) @@ plainto_tsquery('simple',p_search))
 and (p_from is null and p_to is null or scout.date_span(r.date) && daterange(p_from,p_to,'[]'))
 and (p_after is null or (case when p_order='date' then 0 else case r.priority when 'high' then 0 when 'normal' then 1 when 'low' then 2 else 3 end end,coalesce(lower(scout.date_span(r.date)),'infinity'::date),r.id)>
  ((p_after->>'rank')::integer,coalesce((p_after->>'day')::date,'infinity'::date),(p_after->>'id')::uuid))
 order by case when p_order='date' then 0 else case r.priority when 'high' then 0 when 'normal' then 1 when 'low' then 2 else 3 end end,
 coalesce(lower(scout.date_span(r.date)),'infinity'::date),r.id
 limit greatest(1,least(coalesce(p_limit,50),100));
end $$;
revoke all on function scout.findings(text,text,date,date,text,text,jsonb,integer,text,uuid) from public,anon;
grant execute on function scout.findings(text,text,date,date,text,text,jsonb,integer,text,uuid) to authenticated,service_role;

notify pgrst,'reload schema';
commit;
