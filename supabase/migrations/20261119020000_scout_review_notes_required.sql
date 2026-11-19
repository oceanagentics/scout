begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create or replace function scout.submit_review(p_record_id uuid,p_modified timestamptz,p_priority text,p_notes text default '')
 returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare finding scout.records;
begin
 if scout.access_role() is null then raise exception 'Scout sign-in required' using errcode='42501';end if;
 if p_priority is null or p_priority not in ('high','normal','low') then
  raise exception 'Choose High, Normal or Low' using errcode='22023';
 end if;
 if p_notes is null or p_notes !~ '[^[:space:]]' then
  raise exception 'Explain why you chose this ranking' using errcode='22023';
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
 values(auth.uid(),p_record_id,finding.priority,p_priority,p_notes)
 on conflict(reviewer_id,record_id) do nothing;
 return scout.review_queue();
end $$;

notify pgrst,'reload schema';
commit;
