begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_advisory_xact_lock(hashtextextended('scout:findings',0));

do $$begin
 if exists(select 1 from scout.trackers where lease_until>clock_timestamp()) then
  raise exception 'Wait for active Scout collection leases before changing the finding contract';
 end if;
end $$;

alter table scout.records add column score smallint check(score between 0 and 100);
update scout.records set score=case priority when 'low' then 25 when 'normal' then 60 when 'high' then 85 end;
alter table scout.records drop column priority;

-- Historical categories are actual feedback, not invented numeric votes.
alter table scout.finding_reviews
 alter column priority drop not null,
 add column model_score smallint check(model_score between 0 and 100),
 add column score smallint check(score between 0 and 100),
 add constraint review_ranking_present check((priority is null)<>(score is null)),
 add constraint review_model_ranking check(model_priority is null or model_score is null);

drop function scout.findings(text,text,date,date,text,text,jsonb,integer,text,uuid);
create function scout.findings(p_type text default null,p_min_score integer default null,p_unassessed boolean default false,
 p_from date default null,p_to date default null,p_organization text default null,p_search text default null,
 p_after jsonb default null,p_limit integer default 50,p_order text default 'score',p_id uuid default null)
returns setof scout.records language plpgsql stable security definer set search_path='' as $$
begin
 if scout.access_role() is null and current_setting('role',true)<>'service_role' then return;end if;
 if p_min_score not between 0 and 100 then raise exception 'Minimum score must be between 0 and 100' using errcode='22023';end if;
 return query select r.* from scout.records r
 where (p_type is null or r.type=p_type) and (p_min_score is null or r.score>=p_min_score)
 and (not coalesce(p_unassessed,false) or r.score is null)
 and (p_organization is null or p_organization=any(r.organizations)) and (p_id is null or r.id=p_id)
 and (nullif(trim(p_search),'') is null or to_tsvector('simple',r.description||' '||array_to_string(r.organizations,' ')||' '||coalesce(r.details,'')) @@ plainto_tsquery('simple',p_search))
 and (p_from is null and p_to is null or scout.date_span(r.date) && daterange(p_from,p_to,'[]'))
 and (p_after is null or (case when p_order='date' then 0 else coalesce(-r.score,1) end,coalesce(lower(scout.date_span(r.date)),'infinity'::date),r.id)>
  ((p_after->>'rank')::integer,coalesce((p_after->>'day')::date,'infinity'::date),(p_after->>'id')::uuid))
 order by case when p_order='date' then 0 else coalesce(-r.score,1) end,
 coalesce(lower(scout.date_span(r.date)),'infinity'::date),r.id
 limit greatest(1,least(coalesce(p_limit,50),100));
end $$;
revoke all on function scout.findings(text,integer,boolean,date,date,text,text,jsonb,integer,text,uuid) from public,anon;
grant execute on function scout.findings(text,integer,boolean,date,date,text,text,jsonb,integer,text,uuid) to authenticated,service_role;

create or replace function scout.review_queue() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if scout.access_role() is null then raise exception 'Scout sign-in required' using errcode='42501';end if;
 return jsonb_build_object(
  'reviewed_count',(select count(*) from scout.finding_reviews where reviewer_id=auth.uid()),
  'record',(select jsonb_build_object('id',r.id,'description',r.description,'type',r.type,
    'score',r.score,'sources',r.sources,'modified',r.modified[array_length(r.modified,1)])
   from scout.records r where not exists
    (select 1 from scout.finding_reviews v where v.reviewer_id=auth.uid() and v.record_id=r.id)
   order by r.modified[1] desc,r.id limit 1)
 );
end $$;

drop function scout.submit_review(uuid,timestamptz,text,text);
create function scout.submit_review(p_record_id uuid,p_modified timestamptz,p_score integer,p_notes text default '')
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare finding scout.records;
begin
 if scout.access_role() is null then raise exception 'Scout sign-in required' using errcode='42501';end if;
 if p_score is null or p_score not between 0 and 100 then
  raise exception 'Choose a score between 0 and 100' using errcode='22023';
 end if;
 if p_notes is null or p_notes !~ '[^[:space:]]' then
  raise exception 'Explain why you chose this ranking' using errcode='22023';
 end if;
 if exists(select 1 from scout.finding_reviews where reviewer_id=auth.uid() and record_id=p_record_id) then
  return scout.review_queue();
 end if;
 select * into finding from scout.records where id=p_record_id for share;
 if not found then raise exception 'This finding is no longer available. Reload to continue.' using errcode='P0002';end if;
 if finding.modified[array_length(finding.modified,1)] is distinct from p_modified then
  raise exception 'This finding changed. Reload it before reviewing.' using errcode='40001';
 end if;
 insert into scout.finding_reviews(reviewer_id,record_id,model_score,score,notes)
 values(auth.uid(),p_record_id,finding.score,p_score,p_notes)
 on conflict(reviewer_id,record_id) do nothing;
 return scout.review_queue();
end $$;
revoke all on function scout.submit_review(uuid,timestamptz,integer,text) from public,anon,authenticated,service_role;
grant execute on function scout.submit_review(uuid,timestamptz,integer,text) to authenticated;

notify pgrst,'reload schema';
commit;
