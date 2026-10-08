begin;

-- Admit the omission-review contract while retaining completed prior work.
create or replace view scout.source_queue as
select e.*,p.state as progress,case
  when e.parsed#>>'{document,conflicted}'='true' then 'held'
  when e.parsed#>>'{document,preparation,state}' is distinct from 'complete' then 'preparation_failed'
  when e.parsed#>>'{document,feed_only}'='true' then 'feed_only'
  when e.parsed#>>'{document,processing,version}' is not null and
    not starts_with(e.parsed#>>'{document,processing,version}','scout-findings-1/resolve-6/rubric-2/') and
    (not starts_with(e.parsed#>>'{document,processing,version}','scout-findings-1/resolve-5/rubric-2/') or
      coalesce(p.state->>'state','') not in ('complete','uncertain','needs_repair')) then 'version_held'
  when p.state->>'state' in ('complete','uncertain') then p.state->>'state'
  when p.state->>'exhausted'='true' or p.state->>'state'='needs_repair' then 'needs_repair'
  when coalesce(p.state->>'policy','')<>'initial-only' and
    (p.state->>'state'='failed' and coalesce(p.state->>'error','') not in ('Model quota reached','Observation-only run: assessments deferred (max_attempts=0)') or (p.state#>>'{pending,round}')::int>0 or
      exists(select 1 from jsonb_array_elements(p.state->'findings') f where (f#>>'{pending,round}')::int>0)) then 'needs_repair'
  when p.state->>'state'='deferred' then 'deferred'
  else 'awaiting_initial' end as queue_state
from (select distinct on(tracker_id,parsed#>>'{document,identity}') * from scout.evidence
  where record_id is null and parsed#>>'{document,identity}' is not null
  order by tracker_id,parsed#>>'{document,identity}',last_seen_at desc,collected_at desc,id) e
left join lateral (select e.parsed#>array['document','processing_versions',e.parsed#>>'{document,processing,version}'] state) p on true;

create or replace view scout.source_details with (security_barrier=true) as
select current.record_id,current.url,current.last_seen_at,current.authoritative,current.tracker_id,
  current.published_at,current.published_on,current.collected_at,
  accepted.assessment->>'reason' as priority_reason,accepted.assessment->>'accepted_at' as assessed_at,
  jsonb_strip_nulls(jsonb_build_object(
    'starts_on',case when current.parsed#>>'{resolution,facts,starts_on}'='supported' then current.parsed#>'{finding,dates,starts_on}' end,
    'ends_on',case when current.parsed#>>'{resolution,facts,ends_on}'='supported' then current.parsed#>'{finding,dates,ends_on}' end)) as calendar_dates
from scout.current_evidence current
left join lateral (
  select e.parsed->'assessment' as assessment from scout.evidence e join scout.records r on r.id=e.record_id
  where e.record_id=current.record_id and e.parsed#>>'{assessment,priority_accepted}'='true'
    and e.parsed#>>'{assessment,priority}'=r.priority
  order by e.parsed#>>'{assessment,accepted_at}' desc limit 1
) accepted on true
where (select scout.access_role()) is not null;


commit;
