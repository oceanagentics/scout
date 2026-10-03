begin;

-- Ordinary admin configuration writes cannot grant or revoke reviewed proof.
-- The existing private backend retains its explicit promotion permission.
revoke insert (enabled), update (enabled) on scout.trackers from authenticated;

create function scout.invalidate_collector_proof() returns trigger language plpgsql
  set search_path = '' as $$
begin
  new.enabled = false;
  return new;
end $$;
revoke all on function scout.invalidate_collector_proof() from public, anon, authenticated, service_role;
create trigger invalidate_collector_proof before update of url, collector on scout.trackers
  for each row when ((old.url, old.collector) is distinct from (new.url, new.collector))
  execute function scout.invalidate_collector_proof();

commit;
