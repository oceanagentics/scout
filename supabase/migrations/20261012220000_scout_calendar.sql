begin;
-- One finite trial shared by feed reads and Google API calls; no scheduled job.
-- Disabled until the live endpoint is measured. For a reviewed seven-day trial:
-- update scout.calendar_trial set expires_at=now()+interval '7 days',remaining=64 where id;
-- A feed refresh uses 3 SQL statements/1 counter mutation. Sync reserves at most
-- 26 Calendar requests and refunds only undispatched requests. Finding writes/model calls: 0.
create table scout.calendar_trial(
 id boolean primary key default true check(id),
 expires_at timestamptz, remaining integer not null default 0 check(remaining between 0 and 64)
);
insert into scout.calendar_trial(id) values(true);
alter table scout.calendar_trial enable row level security;
revoke all on scout.calendar_trial from public,anon,authenticated;
grant select,update on scout.calendar_trial to service_role;

-- Credentials remain encrypted in the existing Vault, never in finding records.
create function scout.save_calendar_secret(p_name text,p_value text) returns void
language plpgsql security definer set search_path='' as $$
declare secret_id uuid;
begin
 if p_name is null or p_value is null or p_value='' or p_name not in ('scout_calendar_google','scout_calendar_feed') or length(p_value)>8192
 then raise exception 'Invalid calendar secret';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_name,0));
 select id into secret_id from vault.secrets where name=p_name;
 if secret_id is null then perform vault.create_secret(p_value,p_name);
 elsif p_name='scout_calendar_google' then perform vault.update_secret(secret_id,p_value);end if;
end $$;
revoke all on function scout.save_calendar_secret(text,text) from public,anon,authenticated;
grant execute on function scout.save_calendar_secret(text,text) to service_role;
commit;
