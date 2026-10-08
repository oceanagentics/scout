begin;

-- Preserve citation prefixes during completion; retain earlier contract states.
create or replace view scout.source_queue as
select e.*,p.state as progress,case
  when e.parsed#>>'{document,preparation,state}' is distinct from 'complete' then 'preparation_failed'
  when e.parsed#>>'{document,feed_only}'='true' then 'feed_only'
  when e.parsed#>>'{document,conflicted}'='true' and (
    coalesce(starts_with(e.parsed#>>'{document,processing,version}','scout-findings-1/resolve-22/rubric-2/'),false)=false or
    exists(select 1 from scout.evidence v where v.record_id is null and v.tracker_id=e.tracker_id
      and v.parsed#>>'{document,identity}'=e.parsed#>>'{document,identity}' and v.id<>e.id
      and not coalesce(p.state->'variant_captures','[]'::jsonb) ? v.id::text)) then 'awaiting_initial'
  when e.parsed#>>'{document,processing,version}' is not null and
    not starts_with(e.parsed#>>'{document,processing,version}','scout-findings-1/resolve-22/rubric-2/') and
    (e.parsed#>>'{document,processing,version}' !~ '^scout-findings-1/resolve-([56789]|1[0123456789]|2[01])/rubric-2/' or
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

commit;
