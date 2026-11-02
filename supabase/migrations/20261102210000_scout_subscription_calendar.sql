begin;
-- Remove personal-calendar authorization; preserve the existing subscription token.
delete from vault.secrets where name='scout_calendar_google';

create or replace function scout.save_calendar_secret(p_name text,p_value text) returns void
language plpgsql security definer set search_path='' as $$
begin
 if p_name is distinct from 'scout_calendar_feed' or p_value is null or p_value !~ '^[a-f0-9]{64}$'
 then raise exception 'Invalid calendar secret';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_name,0));
 if not exists(select 1 from vault.secrets where name=p_name)
 then perform vault.create_secret(p_value,p_name);end if;
end $$;
commit;
