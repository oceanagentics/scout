begin;

-- GoTrue verifies Google's ID token before writing this provider-owned identity.
-- User-editable auth.users metadata and browser/email-domain hints are not proof.
create function scout.access_role() returns text language sql stable security definer
  set search_path = '' as $$
  select case when exists (
    select 1 from auth.identities i where i.user_id = (select auth.uid()) and i.provider = 'google'
      and i.identity_data @> '{"iss":"https://accounts.google.com","email_verified":true,"custom_claims":{"hd":"oceanagentics.com"}}'::jsonb
  ) then coalesce((select m.role from scout.memberships m where m.user_id = (select auth.uid())), 'reader') end
$$;
revoke all on function scout.access_role() from public, anon, authenticated, service_role;
grant execute on function scout.access_role() to authenticated;

do $$
declare name text;
begin
  foreach name in array array['trackers','collection_runs','records','sources','record_changes'] loop
    execute format('alter policy scout_read on scout.%I using ((select scout.access_role()) is not null)', name);
  end loop;
end $$;
alter policy own_membership on scout.memberships
  using (user_id = (select auth.uid()) and (select scout.access_role()) is not null);
alter policy scout_admin_insert on scout.trackers
  with check ((select scout.access_role()) = 'admin');
alter policy scout_admin_update on scout.trackers
  using ((select scout.access_role()) = 'admin') with check ((select scout.access_role()) = 'admin');

commit;
