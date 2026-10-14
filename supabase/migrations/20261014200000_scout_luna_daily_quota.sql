-- Luna is bounded by spending, rate and invocation limits, not a daily call count.
create or replace function scout.reserve_provider(p_invocation uuid,p_id uuid,p_provider text,p_max integer,p_web_calls integer)
returns table(allowed boolean,reason text,retry_at timestamptz,mutations integer,sql_statements integer)
language plpgsql set search_path='' as $$
declare policy scout.quota_policy; moment timestamptz:=clock_timestamp(); today timestamptz;
  calls integer; daily integer; tokens bigint; turns integer; invocation_cost numeric; daily_cost numeric;
  settings jsonb; rate integer; day_rate integer; token_rate integer; cooldown timestamptz; cost numeric:=0;
  why text; retry timestamptz; extra integer:=0;
begin
  if p_web_calls is null or p_web_calls not between 0 and 3 or p_provider='gemini' and p_web_calls<>0 then raise exception 'Invalid web bounds';end if;
  if p_invocation is null or p_id is null or p_provider is null or p_provider not in ('gemini','openai') or p_max is null or p_max not between 1 and 2 then raise exception 'Invalid model bounds';end if;
  select * into policy from scout.quota_policy where id for update;
  today:=date_trunc('day',moment at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles';
  if not coalesce(policy.enabled and policy.verified_until>moment and policy.database_verified_until>moment
    and policy.database_bytes between 0 and 399999999 and policy.verified_rpm>0 and policy.verified_rpd>0 and policy.verified_tpm>0,false) then
    return query select false,'quota'::text,moment+interval '120 seconds',0,2;return;
  end if;
  select count(*) filter(where provider=p_provider and (reserved_at>moment-interval '60 seconds' or state in ('reserved','dispatched','unknown') and reserved_at>moment-interval '120 seconds')),
    count(*) filter(where provider=p_provider and (reserved_at>=today or state in ('reserved','dispatched','unknown') and reserved_at>moment-interval '120 seconds')),
    coalesce(sum(input_tokens) filter(where provider=p_provider and (reserved_at>moment-interval '60 seconds' or state in ('reserved','dispatched','unknown') and reserved_at>moment-interval '120 seconds')),0),
    count(*) filter(where invocation=p_invocation),coalesce(sum(cost_usd) filter(where invocation=p_invocation),0),
    coalesce(sum(cost_usd) filter(where provider='openai' and reserved_at>=today),0)
    into calls,daily,tokens,turns,invocation_cost,daily_cost from scout.quota_reservations;
  if turns>=p_max or exists(select 1 from scout.quota_reservations where id=p_id) then
    return query select false,'attempt_bound'::text,moment,0,4;return;
  end if;
  if p_provider='gemini' then
    rate:=least(policy.rpm,policy.verified_rpm/2);day_rate:=least(policy.rpd,policy.verified_rpd/2);
    token_rate:=least(policy.tpm,policy.verified_tpm/2);cooldown:=policy.cooldown_until;
  else
    settings:=policy.openai;cost:=0.00825+p_web_calls*0.01;
    begin
      if not coalesce((settings->>'enabled')::boolean and settings->>'model'='gpt-6-luna'
        and (settings->>'expires_at')::timestamptz>moment and (settings->>'access_until')::timestamptz>moment
        and (settings->>'quota_until')::timestamptz>moment
        and (settings->>'verified_rpm')::integer>0 and (settings->>'verified_tpm')::integer>0
        and (settings->>'rpm')::integer between 1 and 2
        and (settings->>'tpm')::integer between 60000 and 125000
        and (settings->>'allocation_usd')::numeric>0 and (settings->>'allocation_usd')::numeric<'Infinity'::numeric
        and (settings->>'invocation_usd')::numeric between cost and 0.08
        and (settings->>'daily_usd')::numeric between cost and 0.10
        and ((settings->>'mode'='manual' and (settings->>'allocation_usd')::numeric<=0.10
          and (settings->>'expires_at')::timestamptz<=moment+interval '1 hour')
          or (settings->>'mode'='credit' and (settings->>'credit_until')::timestamptz>moment
          and (settings->>'credit_usd')::numeric>0 and (settings->>'credit_usd')::numeric<'Infinity'::numeric
          and (settings->>'credit_spent_baseline')::numeric between 0 and policy.openai_spent_usd
          and policy.openai_spent_usd-(settings->>'credit_spent_baseline')::numeric+cost<=(settings->>'credit_usd')::numeric)),false) then
        return query select false,'provider_budget'::text,moment+interval '120 seconds',0,4;return;
      end if;
      rate:=least((settings->>'rpm')::integer,(settings->>'verified_rpm')::integer);
      token_rate:=least((settings->>'tpm')::integer,(settings->>'verified_tpm')::integer);
      cooldown:=(settings->>'cooldown_until')::timestamptz;
      if policy.openai_spent_usd+cost>(settings->>'allocation_usd')::numeric or daily_cost+cost>(settings->>'daily_usd')::numeric
        or invocation_cost+cost>(settings->>'invocation_usd')::numeric then
        return query select false,'spending_bound'::text,moment,0,4;return;
      end if;
    exception when invalid_text_representation or datetime_field_overflow or numeric_value_out_of_range then
      return query select false,'provider_budget'::text,moment,0,4;return;
    end;
  end if;
  if cooldown>moment then why:='provider_cooldown';retry:=cooldown;
  elsif calls>=rate or (p_provider='gemini' and daily>=day_rate) or tokens+60000>token_rate then why:='quota';retry:=case when (p_provider='gemini' and daily>=day_rate) then
    ((date_trunc('day',moment at time zone 'America/Los_Angeles')+interval '1 day') at time zone 'America/Los_Angeles') else moment+interval '120 seconds' end;end if;
  if why is not null then return query select false,why,retry,0,4;return;end if;
  insert into scout.quota_reservations(id,invocation,input_tokens,output_tokens,state,provider,model,cost_usd)
    values(p_id,p_invocation,60000,case when p_provider='gemini' then 8192 else 1500 end,'dispatched',p_provider,
      case when p_provider='gemini' then 'gemini-3.5-flash-lite' else 'gpt-6-luna' end,cost);
  if cost>0 then update scout.quota_policy set openai_spent_usd=openai_spent_usd+cost where id;extra:=1;end if;
  return query select true,null::text,moment,1+extra,5+extra;
end $$;

-- Keep the deployed token-only caller on the same quota checks.
create or replace function scout.reserve_provider(p_invocation uuid,p_id uuid,p_provider text,p_max integer)
returns table(allowed boolean,reason text,retry_at timestamptz,mutations integer,sql_statements integer)
language sql set search_path='' as $$
  select * from scout.reserve_provider(p_invocation,p_id,p_provider,p_max,0);
$$;

update scout.quota_policy set openai=openai-'rpd'-'verified_rpd' where id;
