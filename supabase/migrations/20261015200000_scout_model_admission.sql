-- One model admission decision and one source of request settings. No new state.
drop function scout.reserve_model(uuid,uuid,integer,integer);
drop function scout.reserve_provider(uuid,uuid,text,integer);
drop function scout.reserve_provider(uuid,uuid,text,integer,integer);

create function scout.reserve_provider(p_invocation uuid,p_id uuid,p_provider text,p_deadline timestamptz default null)
returns table(allowed boolean,reason text,retry_at timestamptz,mutations integer,sql_statements integer,
  settings jsonb,remaining_attempts integer,cost_usd numeric)
language plpgsql set search_path='' as $$
declare policy scout.quota_policy; moment timestamptz:=clock_timestamp(); today timestamptz;
  calls integer; daily integer; tokens bigint; turns integer; started timestamptz; ends timestamptz;
  request jsonb; cooldown timestamptz; cost numeric:=0; why text; retry timestamptz;
  changed integer:=0; statements integer:=4;
begin
  if p_invocation is null or p_id is null or p_provider is null or p_provider not in ('gemini','openai') then raise exception 'Invalid model request';end if;
  select * into policy from scout.quota_policy where id for update;
  moment:=clock_timestamp();
  select count(*),min(reserved_at) into turns,started from scout.quota_reservations where invocation=p_invocation;
  -- Anchor the invocation window to its first reservation, across processes.
  ends:=least(coalesce(p_deadline,moment+interval '100 seconds'),coalesce(started,moment)+interval '100 seconds');
  if not coalesce(policy.enabled and policy.database_verified_until>moment and policy.database_bytes between 0 and 399999999,false) then
    why:='quota';retry:=moment+interval '120 seconds';
  elsif turns>=2 or exists(select 1 from scout.quota_reservations where id=p_id) then why:='attempt_bound';
  elsif ends<=moment+interval '5 seconds' then why:='runtime_bound';
  elsif p_provider='gemini' then
    request:='{"model":"gemini-3.5-flash-lite","inputTokens":60000,"outputTokens":8192,"inputBytes":24000,"outputBytes":131072,"maxToolCalls":0}'::jsonb;
    if not coalesce(policy.verified_until>moment and policy.verified_rpm>0 and policy.verified_rpd>0 and policy.verified_tpm>0,false) then
      why:='quota';retry:=moment+interval '120 seconds';
    else
      today:=date_trunc('day',moment at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles';
      select count(*) filter(where reserved_at>moment-interval '60 seconds' or state in ('reserved','dispatched','unknown') and reserved_at>moment-interval '120 seconds'),
        count(*) filter(where reserved_at>=today or state in ('reserved','dispatched','unknown') and reserved_at>moment-interval '120 seconds'),
        coalesce(sum(input_tokens) filter(where reserved_at>moment-interval '60 seconds' or state in ('reserved','dispatched','unknown') and reserved_at>moment-interval '120 seconds'),0)
        into calls,daily,tokens from scout.quota_reservations where provider='gemini';
      statements:=statements+1;
      if calls>=policy.verified_rpm or daily>=policy.verified_rpd or tokens+(request->>'inputTokens')::integer>policy.verified_tpm then
        why:='quota';retry:=case when daily>=policy.verified_rpd then
          ((date_trunc('day',moment at time zone 'America/Los_Angeles')+interval '1 day') at time zone 'America/Los_Angeles') else moment+interval '120 seconds' end;
      end if;
    end if;
    cooldown:=policy.cooldown_until;
    ends:=least(ends,moment+interval '45 seconds');
  else
    request:='{"model":"gpt-6-luna","inputTokens":1050000,"outputTokens":128000,"maxToolCalls":3,"maxUrls":4,"maxFollowups":3}'::jsonb;
    if not coalesce((policy.openai->>'enabled')::boolean,false) then why:='quota';end if;
    cooldown:=(policy.openai->>'cooldown_until')::timestamptz;
    -- Conservative unknown-call estimate; never a spending admission cap.
    cost:=((request->>'inputTokens')::integer*0.25+(request->>'outputTokens')::integer*0.75)/1000000
      +(request->>'maxToolCalls')::integer*0.01;
  end if;
  if why is null and cooldown>moment then why:='provider_cooldown';retry:=cooldown;end if;
  if why is null then
    request:=request||jsonb_build_object('deadline',ends-interval '3 seconds');
    insert into scout.quota_reservations(id,invocation,input_tokens,output_tokens,state,provider,model,cost_usd)
      values(p_id,p_invocation,(request->>'inputTokens')::integer,(request->>'outputTokens')::integer,'dispatched',p_provider,request->>'model',cost);
    changed:=1;statements:=statements+1;
    if cost>0 then update scout.quota_policy set openai_spent_usd=openai_spent_usd+cost where id;changed:=2;statements:=statements+1;end if;
  end if;
  return query select why is null,why,coalesce(retry,moment),changed,statements,
    case when why is null then request end,case when why is null then 1-turns else 0 end,case when why is null then cost else 0 end;
end $$;
revoke all on function scout.reserve_provider(uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function scout.reserve_provider(uuid,uuid,text,timestamptz) to service_role;
