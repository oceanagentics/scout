-- OpenAI enforces request/token rates, model capacity and project/org spending.
-- Keep enablement, provider cooldown and numeric accounting; retire Scout's caps.
create or replace function scout.reserve_provider(p_invocation uuid,p_id uuid,p_provider text,p_max integer,p_web_calls integer)
returns table(allowed boolean,reason text,retry_at timestamptz,mutations integer,sql_statements integer)
language plpgsql set search_path='' as $$
declare policy scout.quota_policy; moment timestamptz:=clock_timestamp(); today timestamptz;
  calls integer; daily integer; tokens bigint; turns integer; cooldown timestamptz;
  cost numeric:=0; why text; retry timestamptz; extra integer:=0;
begin
  if p_web_calls is null or p_web_calls not between 0 and 3 or p_provider='gemini' and p_web_calls<>0 then raise exception 'Invalid web bounds';end if;
  if p_invocation is null or p_id is null or p_provider is null or p_provider not in ('gemini','openai') or p_max is null or p_max not between 1 and 2 then raise exception 'Invalid model bounds';end if;
  select * into policy from scout.quota_policy where id for update;
  if not coalesce(policy.enabled and policy.database_verified_until>moment and policy.database_bytes between 0 and 399999999,false) then
    return query select false,'quota'::text,moment+interval '120 seconds',0,2;return;
  end if;
  select count(*) into turns from scout.quota_reservations where invocation=p_invocation;
  if turns>=p_max or exists(select 1 from scout.quota_reservations where id=p_id) then
    return query select false,'attempt_bound'::text,moment,0,4;return;
  end if;
  if p_provider='gemini' then
    -- Gemini's shared free-project allowance is independent of OpenAI.
    if not coalesce(policy.verified_until>moment and policy.verified_rpm>0 and policy.verified_rpd>0 and policy.verified_tpm>0,false) then
      return query select false,'quota'::text,moment+interval '120 seconds',0,4;return;
    end if;
    today:=date_trunc('day',moment at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles';
    select count(*) filter(where reserved_at>moment-interval '60 seconds' or state in ('reserved','dispatched','unknown') and reserved_at>moment-interval '120 seconds'),
      count(*) filter(where reserved_at>=today or state in ('reserved','dispatched','unknown') and reserved_at>moment-interval '120 seconds'),
      coalesce(sum(input_tokens) filter(where reserved_at>moment-interval '60 seconds' or state in ('reserved','dispatched','unknown') and reserved_at>moment-interval '120 seconds'),0)
      into calls,daily,tokens from scout.quota_reservations where provider='gemini';
    cooldown:=policy.cooldown_until;
    if calls>=policy.verified_rpm or daily>=policy.verified_rpd or tokens+60000>policy.verified_tpm then
      why:='quota';retry:=case when daily>=policy.verified_rpd then
        ((date_trunc('day',moment at time zone 'America/Los_Angeles')+interval '1 day') at time zone 'America/Los_Angeles') else moment+interval '120 seconds' end;
    end if;
  else
    if not coalesce((policy.openai->>'enabled')::boolean,false) then
      return query select false,'quota'::text,moment,0,4;return;
    end if;
    cooldown:=(policy.openai->>'cooldown_until')::timestamptz;
    -- Model maximum (1,050,000 context / 128,000 output), long-context prices.
    -- An uncertain call retains this estimate; it is never an admission budget.
    cost:=0.3585+p_web_calls*0.01;
  end if;
  if cooldown>moment then why:='provider_cooldown';retry:=cooldown;end if;
  if why is not null then return query select false,why,retry,0,4;return;end if;
  insert into scout.quota_reservations(id,invocation,input_tokens,output_tokens,state,provider,model,cost_usd)
    values(p_id,p_invocation,case when p_provider='gemini' then 60000 else 1050000 end,
      case when p_provider='gemini' then 8192 else 128000 end,'dispatched',p_provider,
      case when p_provider='gemini' then 'gemini-3.5-flash-lite' else 'gpt-6-luna' end,cost);
  if cost>0 then update scout.quota_policy set openai_spent_usd=openai_spent_usd+cost where id;extra:=1;end if;
  return query select true,null::text,moment,1+extra,5+extra;
end $$;

-- One admission path for standalone Gemini and the provider gateway.
create or replace function scout.reserve_model(p_invocation uuid,p_id uuid,p_tokens integer,p_max integer)
returns table(allowed boolean,retry_at timestamptz,mutations integer,sql_statements integer)
language plpgsql set search_path='' as $$
begin
  if p_tokens<0 or p_tokens>60000 then raise exception 'Invalid model bounds';end if;
  return query select r.allowed,r.retry_at,r.mutations,r.sql_statements
    from scout.reserve_provider(p_invocation,p_id,'gemini',p_max,0) r;
end $$;
alter table scout.quota_policy drop column if exists rpm,drop column if exists rpd,drop column if exists tpm;

-- The four-argument deployed caller already delegates to the function above.
-- Preserve every charge and the current enabled state; do not activate anything.
update scout.quota_policy set openai=jsonb_strip_nulls(jsonb_build_object(
  'enabled',coalesce((openai->>'enabled')::boolean,false),'cooldown_until',openai->'cooldown_until')) where id;
