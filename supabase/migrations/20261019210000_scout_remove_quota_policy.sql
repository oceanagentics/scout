begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
lock table scout.quota_policy,scout.quota_reservations in access exclusive mode;
do $$ begin
 if exists(select 1 from scout.trackers where lease_until>clock_timestamp())
 or exists(select 1 from scout.quota_reservations where state in ('reserved','dispatched') and reserved_at>clock_timestamp()-interval '120 seconds')
 or exists(select 1 from scout.delivery_state where status='sending')
 then raise exception 'Pause in-flight Scout work before removing quota policy';end if;
 if to_regclass('cron.job') is not null then
  if exists(select 1 from cron.job where active and (jobname like 'scout-%' or command ilike '%scout%'))
  then raise exception 'Pause Scout jobs before removing quota policy';end if;
 end if;
end $$;

-- Keep per-call accounting and finite invocation bounds. Provider limits are
-- enforced by the providers; no capacity snapshots or enablement table remain.
create or replace function scout.reserve_provider(p_invocation uuid,p_id uuid,p_provider text,p_deadline timestamptz default null)
returns table(allowed boolean,reason text,retry_at timestamptz,mutations integer,sql_statements integer,
 settings jsonb,remaining_attempts integer,cost_usd numeric)
language plpgsql set search_path='' as $$
declare moment timestamptz; turns integer; started timestamptz; ends timestamptz;
 request jsonb; cost numeric:=0;
begin
 if p_invocation is null or p_id is null or p_provider is null or p_provider not in ('gemini','openai') then raise exception 'Invalid model request';end if;
 perform pg_advisory_xact_lock(hashtextextended('scout:model:'||p_invocation::text,0));
 moment:=clock_timestamp();
 select count(*),min(reserved_at) into turns,started from scout.quota_reservations where invocation=p_invocation;
 ends:=least(coalesce(p_deadline,moment+interval '100 seconds'),coalesce(started,moment)+interval '100 seconds');
 if turns>=2 or exists(select 1 from scout.quota_reservations where id=p_id) then
  return query select false,'attempt_bound'::text,moment,0,3,null::jsonb,0,0::numeric;return;
 end if;
 if ends<=moment+interval '5 seconds' then
  return query select false,'runtime_bound'::text,moment,0,3,null::jsonb,0,0::numeric;return;
 end if;
 if p_provider='gemini' then
  request:='{"model":"gemini-3.5-flash-lite","inputTokens":60000,"outputTokens":8192,"inputBytes":24000,"outputBytes":131072,"maxToolCalls":0}'::jsonb;
  ends:=least(ends,moment+interval '45 seconds');
 else
  request:='{"model":"gpt-6-luna","inputTokens":1050000,"outputTokens":128000,"maxToolCalls":3,"maxUrls":4,"maxFollowups":3}'::jsonb;
  cost:=0.3885;
 end if;
 request:=request||jsonb_build_object('deadline',ends-interval '3 seconds');
 insert into scout.quota_reservations(id,invocation,input_tokens,output_tokens,state,provider,model,cost_usd)
  values(p_id,p_invocation,(request->>'inputTokens')::integer,(request->>'outputTokens')::integer,'dispatched',p_provider,request->>'model',cost);
 return query select true,null::text,moment,1,4,request,1-turns,cost;
end $$;

create or replace function scout.settle_provider(p_id uuid,p_input integer,p_output integer,p_state text,p_reason text,p_cooldown timestamptz,p_cost numeric)
returns table(settled boolean,mutations integer,sql_statements integer) language plpgsql set search_path='' as $$
declare q scout.quota_reservations; cost numeric;
begin
 if p_id is null or p_input is null or p_output is null or p_state is null or p_cost is null or p_input<0 or p_output<0
 or p_state not in ('settled','unknown') or p_reason !~ '^[a-z_]{1,48}$' or p_cost<0 or p_cost>='Infinity'::numeric then raise exception 'Invalid settlement';end if;
 select * into q from scout.quota_reservations where id=p_id for update;
 if not found then return query select false,0,1;return;end if;
 if p_state='unknown' then p_input:=greatest(p_input,q.input_tokens);p_output:=greatest(p_output,q.output_tokens);end if;
 cost:=case when q.provider='openai' then greatest(p_cost,(p_input*0.125+p_output*0.50)/1000000) else 0 end;
 if p_state='unknown' then cost:=greatest(cost,q.cost_usd);end if;
 if q.state in ('settled','unknown') then
  return query select q.state=p_state and q.input_tokens=p_input and q.output_tokens=p_output and q.cost_usd=cost and q.reason is not distinct from p_reason,0,1;return;
 end if;
 update scout.quota_reservations set input_tokens=p_input,output_tokens=p_output,state=p_state,reason=p_reason,cost_usd=cost where id=p_id;
 -- Retry-After is handled by the tracker; no shared policy cooldown is stored.
 return query select true,1,2;
end $$;

create or replace function scout.expire_quota() returns table(mutations integer,sql_statements integer) language plpgsql set search_path='' as $$
declare n integer;
begin
 delete from scout.quota_reservations where id in (
  select id from scout.quota_reservations where reserved_at<clock_timestamp()-interval '120 seconds'
  and reserved_at<(date_trunc('day',clock_timestamp() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles')
  order by reserved_at limit 32 for update skip locked);
 get diagnostics n=row_count;
 return query select n,1;
end $$;

-- The reader migration retired the previous scheduler. Its paused replacement
-- in scout-loop.sql has no policy dependency.
drop function if exists scout.loop_tick(text);
drop table scout.quota_policy;
notify pgrst,'reload schema';
commit;
