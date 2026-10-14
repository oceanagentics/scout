-- Reserve provider web calls before dispatch; retain existing accounting and permissions.
create function scout.reserve_provider(p_invocation uuid,p_id uuid,p_provider text,p_max integer,p_web_calls integer)
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
        and (settings->>'verified_rpm')::integer>0 and (settings->>'verified_rpd')::integer>0 and (settings->>'verified_tpm')::integer>0
        and (settings->>'rpm')::integer between 1 and 2 and (settings->>'rpd')::integer between 1 and 10
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
      day_rate:=least((settings->>'rpd')::integer,(settings->>'verified_rpd')::integer);
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
  elsif calls>=rate or daily>=day_rate or tokens+60000>token_rate then why:='quota';retry:=case when daily>=day_rate then
    ((date_trunc('day',moment at time zone 'America/Los_Angeles')+interval '1 day') at time zone 'America/Los_Angeles') else moment+interval '120 seconds' end;end if;
  if why is not null then return query select false,why,retry,0,4;return;end if;
  insert into scout.quota_reservations(id,invocation,input_tokens,output_tokens,state,provider,model,cost_usd)
    values(p_id,p_invocation,60000,case when p_provider='gemini' then 8192 else 1500 end,'dispatched',p_provider,
      case when p_provider='gemini' then 'gemini-3.5-flash-lite' else 'gpt-6-luna' end,cost);
  if cost>0 then update scout.quota_policy set openai_spent_usd=openai_spent_usd+cost where id;extra:=1;end if;
  return query select true,null::text,moment,1+extra,5+extra;
end $$;

create or replace function scout.settle_provider(p_id uuid,p_input integer,p_output integer,p_state text,p_reason text,p_cooldown timestamptz,p_cost numeric)
returns table(settled boolean,mutations integer,sql_statements integer) language plpgsql set search_path='' as $$
declare q scout.quota_reservations; cost numeric; extra integer:=0;
begin
  if p_id is null or p_input is null or p_output is null or p_state is null or p_cost is null or p_input<0 or p_output<0
    or p_state not in ('settled','unknown') or p_reason !~ '^[a-z_]{1,48}$' or p_cost<0 or p_cost>='Infinity'::numeric then raise exception 'Invalid settlement';end if;
  perform 1 from scout.quota_policy where id for update;
  select * into q from scout.quota_reservations where id=p_id for update;
  if not found then return query select false,0,2;return;end if;
  if p_state='unknown' then p_input:=greatest(p_input,q.input_tokens);p_output:=greatest(p_output,q.output_tokens);end if;
  cost:=case when q.provider='openai' then greatest(p_cost,(p_input*0.125+p_output*0.50)/1000000) else 0 end;
  if p_state='unknown' then cost:=greatest(cost,q.cost_usd);end if;
  if q.state in ('settled','unknown') then
    return query select q.state=p_state and q.input_tokens=p_input and q.output_tokens=p_output and q.cost_usd=cost and q.reason is not distinct from p_reason,0,2;return;
  end if;
  update scout.quota_reservations set input_tokens=p_input,output_tokens=p_output,state=p_state,reason=p_reason,cost_usd=cost where id=p_id;
  if q.provider='openai' then
    update scout.quota_policy set openai_spent_usd=openai_spent_usd+cost-q.cost_usd,
      openai=case when p_cooldown>clock_timestamp() then jsonb_set(openai,'{cooldown_until}',to_jsonb(greatest((openai->>'cooldown_until')::timestamptz,p_cooldown))) else openai end where id;extra:=1;
  elsif p_cooldown>clock_timestamp() then
    update scout.quota_policy set cooldown_until=greatest(cooldown_until,p_cooldown) where id;extra:=1;
  end if;
  return query select true,1+extra,3+extra;
end $$;

revoke all on function scout.reserve_provider(uuid,uuid,text,integer,integer) from public,anon,authenticated;
grant execute on function scout.reserve_provider(uuid,uuid,text,integer,integer) to service_role;
