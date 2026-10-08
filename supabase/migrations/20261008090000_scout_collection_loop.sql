begin;

create index on scout.collection_runs(finished_at);
create index on scout.evidence(tracker_id,(parsed#>>'{document,identity}'),last_seen_at desc)
  where record_id is null and parsed#>>'{document,identity}' is not null;

-- Current capture only. Repairs/uncertainty are durable backlog, never work for
-- the initial-review queue. Historical processing versions remain untouched.
create view scout.source_queue as
select e.*,p.state as progress,case
  when e.parsed#>>'{document,conflicted}'='true' then 'held'
  when e.parsed#>>'{document,preparation,state}' is distinct from 'complete' then 'preparation_failed'
  when e.parsed#>>'{document,feed_only}'='true' then 'feed_only'
  when e.parsed#>>'{document,processing,version}' is not null and
    not starts_with(e.parsed#>>'{document,processing,version}','announcement-events-6/resolve-4/rubric-1/') then 'version_held'
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
revoke all on scout.source_queue from public,anon,authenticated;
grant select on scout.source_queue to service_role;

create function scout.source_backlog(p_tracker_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('awaiting_initial',count(*) filter(where queue_state in ('awaiting_initial','deferred')),
    'oldest_awaiting_at',min(collected_at) filter(where queue_state in ('awaiting_initial','deferred')),
    'parked',count(*) filter(where queue_state in ('needs_repair','uncertain','held','version_held')),
    'source_problems',count(*) filter(where queue_state in ('feed_only','preparation_failed')),
    'reasons',coalesce(jsonb_agg(distinct coalesce(progress->>'error',queue_state)) filter(
      where queue_state not in ('complete','awaiting_initial')),'[]'::jsonb))
  from scout.source_queue where tracker_id=p_tracker_id and (select scout.access_role()) is not null
$$;
revoke all on function scout.source_backlog(uuid) from public,anon;
grant execute on function scout.source_backlog(uuid) to authenticated,service_role;

create or replace view scout.tracker_status with (security_invoker=true) as
select t.*,activity.last_attempt_at,activity.last_success_at,latest.outcome as last_outcome,
  (select string_agg(value,'; ') from jsonb_array_elements_text(latest.stats->'warnings')) as last_error,
  (backlog.value->>'awaiting_initial')::int as awaiting_initial,
  (backlog.value->>'oldest_awaiting_at')::timestamptz as oldest_awaiting_at,
  (backlog.value->>'parked')::int as parked,
  (backlog.value->>'source_problems')::int as source_problems,
  backlog.value->>'reasons' as processing_problems,
  case when not t.enabled then 'Disabled'
    when control.stats->'supported' is null then 'Not scheduled'
    when not exists(select 1 from jsonb_array_elements(control.stats->'supported') s
      where s->>'collector'=t.collector and s->>'url'=t.url) then 'Unsupported'
    when control.stats->>'enabled'='true' then 'Background collection' else 'Paused' end as loop_state
from scout.trackers t
left join lateral (
  select max(started_at) as last_attempt_at,
    max(finished_at) filter(where outcome in ('success','no_change')) as last_success_at
  from scout.collection_runs where tracker_id=t.id and coalesce(stats->>'purpose','collection')='collection'
    and coalesce(stats->>'stage','fetch')='fetch'
) activity on true
left join lateral (
  select outcome,stats from scout.collection_runs where tracker_id=t.id and finished_at is not null
    and coalesce(stats->>'purpose','collection')='collection' and coalesce(stats->>'stage','fetch')='fetch'
  order by finished_at desc,started_at desc,id limit 1
) latest on true
left join lateral (select scout.source_backlog(t.id) value) backlog on true
left join lateral (select stats from scout.collection_runs where stats->>'purpose'='scheduler' order by started_at desc limit 1) control on true;

commit;
