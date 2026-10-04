begin;

-- No historical backfill: NULL means no instrumented report was captured.
alter table scout.collection_runs add column report jsonb;
revoke select on scout.collection_runs from authenticated;
grant select (id,tracker_id,started_at,finished_at,outcome,coverage_since,stats)
  on scout.collection_runs to authenticated;

create function scout.run_history(p_tracker_id uuid, p_before_at timestamptz default null, p_before_id uuid default null)
returns table(id uuid,tracker_id uuid,started_at timestamptz,finished_at timestamptz,outcome text,report_available boolean)
language sql stable security definer set search_path='' as $$
  select r.id,r.tracker_id,r.started_at,r.finished_at,r.outcome,r.report is not null
  from scout.collection_runs r
  where (select scout.access_role()) is not null and r.tracker_id=p_tracker_id
    and coalesce(r.stats->>'purpose','collection')='collection'
    and (p_before_at is null and p_before_id is null or (r.started_at,r.id)<(p_before_at,p_before_id))
  order by r.started_at desc,r.id desc limit 20
$$;

create function scout.run_detail(p_run_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',r.id,'tracker_id',r.tracker_id,'started_at',r.started_at,
    'finished_at',r.finished_at,'outcome',r.outcome,'coverage_since',r.coverage_since,
    'counts',jsonb_build_object('requests',r.stats->'requests','posts',r.stats->'posts',
      'pages',r.stats->'pages','candidates',r.stats->'candidates','skipped',r.stats->'skipped',
      'assessed',r.stats->'assessed','created',r.stats->'created','changed',r.stats->'changed','pending',r.stats->'pending',
      'documents',r.stats->'documents','prepared',r.stats->'prepared','reused',r.stats->'reused',
      'feed_only',r.stats->'feed_only','failed',r.stats->'failed','unfetched',r.stats->'unfetched'),
    'warnings',r.stats->'warnings',
    'report',case when r.report is null then null else r.report-'artifacts' || jsonb_build_object('artifacts',
      coalesce((select jsonb_object_agg(a.key,a.value-'data') from jsonb_each(r.report->'artifacts') a),'{}'::jsonb)) end)
  from scout.collection_runs r where r.id=p_run_id and (select scout.access_role()) is not null
    and coalesce(r.stats->>'purpose','collection')='collection'
$$;

-- The run's backend-written references authorize individual Scout captures.
-- No arbitrary evidence lookup and no grant on raw evidence or the report column.
create function scout.run_artifact(p_run_id uuid, p_artifact_id text) returns jsonb
language sql stable security definer set search_path='' as $$
  select case when a->>'kind'='capture' or a->>'kind'='preparation' and a ? 'source_id' then (
    select case when e.content ~* '"(headers|authorization|cookie|set-cookie|access_token|refresh_token|api_key|apikey|env)"[[:space:]]*:'
      then jsonb_build_object('unavailable','Capture contains transport/credential metadata; raw payload remains backend-only.')
      when a->>'kind'='preparation' then e.parsed#>'{document,prepared}'
      else jsonb_build_object('url',e.url,'content_hash',e.content_hash,'content',e.content,
        'collected_at',e.collected_at,'published_at',e.published_at) end
    from scout.evidence e where e.id::text=a->>'source_id' and e.tracker_id=r.tracker_id
      and e.content_hash=a->>'content_hash'
  ) else a->'data' end
  from scout.collection_runs r
  cross join lateral (select r.report->'artifacts'->p_artifact_id as a) artifact
  where r.id=p_run_id and r.report->>'version'='1' and p_artifact_id ~ '^a[0-9]+$'
    and coalesce(r.stats->>'purpose','collection')='collection'
    and (select scout.access_role()) is not null
$$;

revoke all on function scout.run_history(uuid,timestamptz,uuid),scout.run_detail(uuid),scout.run_artifact(uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function scout.run_history(uuid,timestamptz,uuid),scout.run_detail(uuid),scout.run_artifact(uuid,text)
  to authenticated;

commit;
