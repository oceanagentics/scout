begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
lock table scout.finding_reviews in access exclusive mode;

-- No numeric human feedback existed at this cutover; never discard a vote.
do $$begin
 if exists(select 1 from scout.finding_reviews where score is not null) then
  raise exception 'Preserve existing numeric human reviews before removing their score column';
 end if;
end $$;

alter table scout.finding_reviews
 drop constraint review_ranking_present,
 drop column score,
 alter column priority set not null;

drop function scout.submit_review(uuid,timestamptz,integer,text);
create function scout.submit_review(p_record_id uuid,p_modified timestamptz,p_priority text,p_notes text default '')
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare finding scout.records;
begin
 if scout.access_role() is null then raise exception 'Scout sign-in required' using errcode='42501';end if;
 if p_priority is null or p_priority not in ('low','normal','high') then
  raise exception 'Choose Low, Normal or High' using errcode='22023';
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
 insert into scout.finding_reviews(reviewer_id,record_id,model_score,priority,notes)
 values(auth.uid(),p_record_id,finding.score,p_priority,p_notes)
 on conflict(reviewer_id,record_id) do nothing;
 return scout.review_queue();
end $$;
revoke all on function scout.submit_review(uuid,timestamptz,text,text) from public,anon,authenticated,service_role;
grant execute on function scout.submit_review(uuid,timestamptz,text,text) to authenticated;

notify pgrst,'reload schema';
commit;
