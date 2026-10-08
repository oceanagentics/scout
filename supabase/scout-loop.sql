-- Operational install after the schema migration and verified function release.
-- Secrets are populated in Vault by the release, never in this file or run stats.
create extension if not exists pg_cron;
create extension if not exists pg_net;
-- Supabase owns pg_net grants. Keep net outside Data API exposed schemas;
-- queued credentials are visible to trusted direct database login roles.

create or replace function scout.loop_tick(mode text default 'next') returns void
language plpgsql security definer set search_path='' as $$
declare control scout.collection_runs; request_id bigint; key text;
begin
  if mode not in ('next','notify') then raise exception 'Invalid Scout loop mode'; end if;
  select * into control from scout.collection_runs where stats->>'purpose'='scheduler' order by started_at desc limit 1 for update;
  if control.stats->>'enabled' is distinct from 'true' then return; end if;
  select decrypted_secret into key from vault.decrypted_secrets where name='scout_loop_backend_key';
  if key is null then raise exception 'Scout scheduler credential unavailable'; end if;
  request_id:=net.http_post(url:='https://vhlfumeyhkeospnemukq.supabase.co/functions/v1/scout-collect-hsa?'||mode||'=true',
    headers:=jsonb_build_object('apikey',key),body:=null,timeout_milliseconds:=120000);
  update scout.collection_runs set stats=stats||jsonb_build_object('last_tick_at',clock_timestamp(),
    'dispatches',coalesce((select jsonb_agg(v order by n) from jsonb_array_elements(stats->'dispatches') with ordinality a(v,n)
      where n>jsonb_array_length(stats->'dispatches')-15),'[]'::jsonb)||
      jsonb_build_array(jsonb_build_object('id',request_id,'mode',mode,'at',clock_timestamp()))) where id=control.id;
end $$;

-- Independent of the collection endpoint: HTTP/auth failures and stopped worker
-- turns are checked from database/pg_net evidence, even when the endpoint fails.
create or replace function scout.loop_health() returns jsonb
language plpgsql security definer set search_path='' as $$
declare control scout.collection_runs; issues jsonb:='[]'; backlog jsonb; response record;
  latest_work timestamptz; urgent text; dm jsonb; token text; request_id bigint;
begin
  select * into control from scout.collection_runs where stats->>'purpose'='scheduler' order by started_at desc limit 1 for update;
  if control.id is null then return jsonb_build_object('state','not_installed'); end if;
  if control.stats->>'enabled'='true' then
    if not exists(select 1 from cron.job where jobname='scout-collection' and active) or
      coalesce((control.stats->>'last_tick_at')::timestamptz,control.started_at)<clock_timestamp()-interval '5 minutes' then
      issues:=issues||jsonb_build_array('Collection scheduler stopped');
    end if;
    select max(finished_at) into latest_work from scout.collection_runs where stats->>'rotation'='true' and stats->>'stage'='fetch';
    if coalesce(latest_work,control.started_at)<clock_timestamp()-interval '10 minutes' then
      issues:=issues||jsonb_build_array('No completed collection turn for ten minutes');
    end if;
    select r.status_code,r.timed_out,r.error_msg,d.value->>'mode' mode into response
      from jsonb_array_elements(control.stats->'dispatches') d
      join net._http_response r on r.id=(d.value->>'id')::bigint
      where (d.value->>'at')::timestamptz<clock_timestamp()-interval '2 minutes'
      order by (d.value->>'at')::timestamptz desc limit 1;
    if response.timed_out or response.error_msg is not null or response.status_code not in (200,409) then
      issues:=issues||jsonb_build_array('Worker HTTP failure: '||coalesce(response.status_code::text,'timeout/transport'));
    end if;
    if exists(select 1 from scout.collection_runs where outcome='running' and stats->>'rotation'='true'
      and (stats->>'turn_expires_at')::timestamptz<clock_timestamp()) then
      issues:=issues||jsonb_build_array('Expired collection claim awaiting recovery');
    end if;
    if issues ? 'Collection scheduler stopped' or
      coalesce(latest_work,control.started_at)<clock_timestamp()-interval '10 minutes'
      and response.mode='next' and (response.timed_out or response.error_msg is not null or response.status_code not in (200,409)) then
      urgent:='Scout collection is stopped and needs attention.';
    elsif exists(select 1 from scout.collection_runs where stats->>'model_blocker'='configuration'
      and (stats->>'model_retry_at')::timestamptz>clock_timestamp()) then
      urgent:='Scout model credentials or configuration need attention.';
    end if;
  end if;
  select issues||coalesce(jsonb_agg(problem order by problem),'[]'::jsonb) into issues from (
    select t.name||': unsupported enabled tracker' problem from scout.trackers t where t.enabled
      and not exists(select 1 from jsonb_array_elements(control.stats->'supported') s
        where s->>'collector'=t.collector and s->>'url'=t.url)
    union all
    select t.name||': source retrieval problems' from scout.trackers t join lateral (
      select stats,outcome from scout.collection_runs where tracker_id=t.id and stats->>'stage'='fetch'
      order by started_at desc,id desc limit 1) r on true
      where t.enabled and (r.outcome='failed' or coalesce((r.stats->>'failed')::int,0)>0)
  ) problems;
  select jsonb_build_object('awaiting_initial',count(*) filter(where queue_state in ('awaiting_initial','deferred')),
    'oldest_awaiting_at',min(q.collected_at) filter(where queue_state in ('awaiting_initial','deferred')),
    'parked',count(*) filter(where queue_state in ('needs_repair','uncertain','held','version_held')),
    'source_problems',count(*) filter(where queue_state in ('feed_only','preparation_failed'))) into backlog
    from scout.source_queue q join scout.trackers t on t.id=q.tracker_id where t.enabled;
  if (backlog->>'parked')::int>0 then issues:=issues||jsonb_build_array('Captured sources parked for repair or uncertainty'); end if;
  if (backlog->>'source_problems')::int>0 then issues:=issues||jsonb_build_array('Captured sources have preparation/full-body problems'); end if;
  if (backlog->>'oldest_awaiting_at')::timestamptz<clock_timestamp()-interval '7 days' then
    issues:=issues||jsonb_build_array('Initial-review backlog includes captures older than seven days'); end if;
  if exists(select 1 from scout.collection_runs where (stats->>'model_retry_at')::timestamptz>clock_timestamp()+interval '10 minutes'
    or stats->>'model_blocker'='configuration' and (stats->>'model_retry_at')::timestamptz>clock_timestamp()) then
    issues:=issues||jsonb_build_array('Model review blocked by provider quota or configuration; fetching continues'); end if;
  if exists(select 1 from scout.collection_runs where stats->>'purpose'='notification'
    and (stats#>>'{delivery,status}' in ('unknown','dispatching') or stats#>>'{delivery,status}'='sent'
      and coalesce((stats#>>'{delivery,communicated}')::int,0)<jsonb_array_length(stats#>'{delivery,records}'))
    and started_at<clock_timestamp()-interval '3 minutes') then
    issues:=issues||jsonb_build_array('Slack delivery uncertain; affected record versions held from automatic resend'); end if;
  if exists(select 1 from scout.collection_runs where stats->>'purpose'='notification' and outcome='failed'
    and started_at>clock_timestamp()-interval '30 minutes' and not (stats ? 'delivery')) then
    issues:=issues||jsonb_build_array('Finding notification selection/configuration failed; inspect retained notification run'); end if;
  if pg_database_size(current_database())>367001600 then issues:=issues||jsonb_build_array('Database storage exceeds 350 MiB; review storage capacity'); end if;
  -- Urgent DMs are opt-in through Vault. Reserve one attempt per persistent
  -- incident; unknown delivery never retries. #scout remains announcements-only.
  dm:=coalesce(control.stats->'urgent_dm','{}'::jsonb);
  if dm ? 'request_id' and dm->>'status'='queued' then
    select * into response from net._http_response where id=(dm->>'request_id')::bigint;
    if found then
      begin
        dm:=dm||jsonb_build_object('status',case when response.timed_out or response.error_msg is not null then 'unknown'
          when response.status_code=200 and response.content::jsonb->>'ok'='true' then 'sent' else 'failed' end);
      exception when others then dm:=dm||jsonb_build_object('status','unknown'); end;
    end if;
  end if;
  if urgent is null then dm:=dm-'incident'-'since'-'request_id'-'status';
  else
    if dm->>'incident' is distinct from urgent then
      dm:=(dm-'request_id'-'status')||jsonb_build_object('incident',urgent,'since',clock_timestamp());
    end if;
    if not (dm ? 'request_id') and (dm->>'since')::timestamptz<clock_timestamp()-interval '15 minutes'
      and coalesce((dm->>'last_attempt_at')::timestamptz,'-infinity')<clock_timestamp()-interval '6 hours' then
      select decrypted_secret into token from vault.decrypted_secrets where name='scout_loop_slack_bot_token';
      if token is not null then
        request_id:=net.http_post(url:='https://slack.com/api/chat.postMessage',
          headers:=jsonb_build_object('Authorization','Bearer '||token,'Content-Type','application/json'),
          body:=jsonb_build_object('channel','U0AQY6J9SG7','text',urgent||' https://bbnj-scout.web.app',
            'unfurl_links',false,'unfurl_media',false),timeout_milliseconds:=10000);
        dm:=dm||jsonb_build_object('request_id',request_id,'status','queued','last_attempt_at',clock_timestamp());
      end if;
    end if;
  end if;
  update scout.collection_runs set stats=stats||jsonb_build_object('health',jsonb_build_object('checked_at',clock_timestamp(),
    'issues',issues,'backlog',backlog),'urgent_dm',dm) where id=control.id;
  return jsonb_build_object('issues',issues,'backlog',backlog);
end $$;

create or replace function scout.loop_retention() returns void
language plpgsql security definer set search_path='' as $$
begin
  -- Source evidence, accepted records, rejected work and all model accounting
  -- survive. Only redundant successful fetch reports lose duplicated bodies.
  update scout.collection_runs r set report=null,stats=stats||jsonb_build_object('report_compacted',true)
    where stats->>'stage'='fetch' and outcome in ('success','no_change') and report is not null
      and finished_at<clock_timestamp()-interval '6 hours';
  update scout.collection_runs r set stats=stats-'document_source' where stats->>'stage'='fetch'
    and finished_at<clock_timestamp()-interval '6 hours' and exists(select 1 from scout.collection_runs newer
      where newer.tracker_id=r.tracker_id and newer.stats ? 'document_source' and newer.started_at>r.started_at);
  with redundant as (
    select id,tracker_id,finished_at,stats,first_value(id) over(partition by tracker_id,finished_at::date order by finished_at desc,id) keeper
    from scout.collection_runs where stats->>'stage'='fetch' and outcome='no_change'
      and finished_at<clock_timestamp()-interval '7 days' and not (stats ? 'document_source')
      and coalesce((stats->>'prepared')::int,0)=0 and coalesce(jsonb_array_length(stats->'model_attempts'),0)=0
  ), removed as (
    delete from scout.collection_runs r using redundant d where r.id=d.id and d.id<>d.keeper
      returning d.keeper,r.stats
  ), totals as (
    select keeper,sum(1+coalesce((stats->>'compacted_runs')::int,0)) n,
      sum(coalesce((stats->>'requests')::int,0)+coalesce((stats->>'compacted_requests')::int,0)) requests
      from removed group by keeper
  ) update scout.collection_runs r set stats=stats||jsonb_build_object(
    'compacted_runs',coalesce((r.stats->>'compacted_runs')::int,0)+totals.n,
    'compacted_requests',coalesce((r.stats->>'compacted_requests')::int,0)+totals.requests)
    from totals where r.id=totals.keeper;
  delete from cron.job_run_details where jobid in (select jobid from cron.job where jobname like 'scout-%')
    and end_time<clock_timestamp()-interval '7 days';
end $$;

revoke all on function scout.loop_tick(text),scout.loop_health(),scout.loop_retention() from public,anon,authenticated,service_role;

-- Install paused. Activation follows release verification and a real bounded turn.
select cron.schedule('scout-collection','30 seconds',$$select scout.loop_tick('next')$$);
select cron.schedule('scout-findings','*/15 * * * *',$$select scout.loop_tick('notify')$$);
select cron.schedule('scout-health','*/5 * * * *',$$select scout.loop_health()$$);
select cron.schedule('scout-retention','17 * * * *',$$select scout.loop_retention()$$);
select cron.alter_job(jobid,active:=false) from cron.job
  where jobname in ('scout-collection','scout-findings','scout-health','scout-retention');
