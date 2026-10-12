-- URL Context uses a conservative reservation, then settles actual tool + prompt tokens.
create or replace function scout.reserve_model(p_invocation uuid,p_id uuid,p_tokens integer,p_max integer)
returns table(allowed boolean,retry_at timestamptz,mutations integer,sql_statements integer) language plpgsql set search_path='' as $$
declare policy scout.quota_policy; moment timestamptz:=clock_timestamp(); calls integer; daily integer; tokens bigint; turns integer;
begin
 select * into policy from scout.quota_policy where id for update;
 if p_max not between 1 and 2 or p_tokens<0 or p_tokens>60000 then raise exception 'Invalid model bounds'; end if;
 select count(*) filter(where reserved_at>moment-interval '60 seconds' or state in ('reserved','dispatched','unknown') and reserved_at>moment-interval '120 seconds'),
 count(*) filter(where reserved_at>=(date_trunc('day',moment at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles') or state in ('reserved','dispatched','unknown') and reserved_at>moment-interval '120 seconds'),
 coalesce(sum(input_tokens) filter(where reserved_at>moment-interval '60 seconds' or state in ('reserved','dispatched','unknown') and reserved_at>moment-interval '120 seconds'),0),
 count(*) filter(where invocation=p_invocation)
 into calls,daily,tokens,turns from scout.quota_reservations where id<>p_id;
 if not coalesce(policy.enabled and policy.verified_until>moment and policy.database_verified_until>moment
 and policy.database_bytes>=0 and policy.database_bytes<400000000
 and policy.verified_rpm>0 and policy.verified_rpd>0 and policy.verified_tpm>0
 and coalesce(policy.cooldown_until,moment)<=moment
 and calls<least(policy.rpm,policy.verified_rpm/2)
 and daily<least(policy.rpd,policy.verified_rpd/2)
 and tokens+coalesce(p_tokens,16000)<=least(policy.tpm,policy.verified_tpm/2)
 and turns<p_max,false) then
 return query select false,greatest(policy.cooldown_until,case
 when daily>=least(policy.rpd,policy.verified_rpd/2) then
 ((date_trunc('day',moment at time zone 'America/Los_Angeles')+interval '1 day') at time zone 'America/Los_Angeles')
 else moment+interval '120 seconds' end),0,3;return;end if;
 if p_tokens is null then
 insert into scout.quota_reservations(id,invocation,input_tokens,state) values(p_id,p_invocation,16000,'reserved');
 else
 insert into scout.quota_reservations(id,invocation,input_tokens,state) values(p_id,p_invocation,p_tokens,'dispatched')
 on conflict(id) do update set input_tokens=excluded.input_tokens,reserved_at=moment,state='dispatched'
 where scout.quota_reservations.invocation=p_invocation and scout.quota_reservations.state='reserved';
 if not found then raise exception 'Reservation unavailable';end if;
 end if;
 return query select true,moment,1,4;
end $$;
revoke all on function scout.reserve_model(uuid,uuid,integer,integer) from public,anon,authenticated;
grant execute on function scout.reserve_model(uuid,uuid,integer,integer) to service_role;
