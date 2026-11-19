begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create table scout.finding_reviews (
 reviewer_id uuid not null references auth.users(id) on delete cascade,
 record_id uuid not null references scout.records(id) on delete cascade,
 model_priority text check(model_priority in ('high','normal','low')),
 priority text not null check(priority in ('high','normal','low')),
 notes text not null default '',
 reviewed_at timestamptz not null default now(),
 primary key(reviewer_id,record_id)
);
alter table scout.finding_reviews enable row level security;
revoke all on scout.finding_reviews from public,anon,authenticated;
grant select on scout.finding_reviews to authenticated;
grant select,insert,update,delete on scout.finding_reviews to service_role;
create policy review_read on scout.finding_reviews for select to authenticated
 using ((select scout.access_role()) is not null and
   (reviewer_id=(select auth.uid()) or (select scout.access_role())='admin'));

create function scout.review_queue() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if scout.access_role() is null then raise exception 'Scout sign-in required' using errcode='42501';end if;
 return jsonb_build_object(
  'reviewed_count',(select count(*) from scout.finding_reviews where reviewer_id=auth.uid()),
  'record',(select jsonb_build_object('id',r.id,'description',r.description,'type',r.type,
    'priority',r.priority,'sources',r.sources,'modified',r.modified[array_length(r.modified,1)])
   from scout.records r where not exists
    (select 1 from scout.finding_reviews v where v.reviewer_id=auth.uid() and v.record_id=r.id)
   order by r.modified[1] desc,r.id limit 1)
 );
end $$;

create function scout.submit_review(p_record_id uuid,p_modified timestamptz,p_priority text,p_notes text default '')
 returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare finding scout.records;
begin
 if scout.access_role() is null then raise exception 'Scout sign-in required' using errcode='42501';end if;
 if p_priority is null or p_priority not in ('high','normal','low') then
  raise exception 'Choose High, Normal or Low' using errcode='22023';
 end if;
 -- A retry after a lost response returns committed progress without adding a review.
 if exists(select 1 from scout.finding_reviews where reviewer_id=auth.uid() and record_id=p_record_id) then
  return scout.review_queue();
 end if;
 select * into finding from scout.records where id=p_record_id for share;
 if not found then raise exception 'This finding is no longer available. Reload to continue.' using errcode='P0002';end if;
 if finding.modified[array_length(finding.modified,1)] is distinct from p_modified then
  raise exception 'This finding changed. Reload it before reviewing.' using errcode='40001';
 end if;
 insert into scout.finding_reviews(reviewer_id,record_id,model_priority,priority,notes)
 values(auth.uid(),p_record_id,finding.priority,p_priority,coalesce(p_notes,''))
 on conflict(reviewer_id,record_id) do nothing;
 return scout.review_queue();
end $$;
revoke all on function scout.review_queue(),scout.submit_review(uuid,timestamptz,text,text) from public,anon,authenticated,service_role;
grant execute on function scout.review_queue(),scout.submit_review(uuid,timestamptz,text,text) to authenticated;

notify pgrst,'reload schema';
commit;
