begin;

alter table scout.records
  add column identity_key text unique,
  add column evidence_rank integer not null default 0,
  add column evidence_at timestamptz,
  add column material_hash text;
alter table scout.collection_runs
  add column coverage_since timestamptz,
  add column stats jsonb not null default '{}';

-- Refreshing provenance alone is not a material record update.
drop trigger updated_at on scout.records;
create trigger updated_at before update of title, organization, description, summary,
  location, event_url, registration_url, start_on, end_on, starts_at, ends_at,
  time_zone, status, published_on, material_hash on scout.records
  for each row execute function scout.set_updated_at();

create table scout.source_versions (
  id uuid primary key default gen_random_uuid(),
  tracker_id uuid not null references scout.trackers(id),
  url text not null,
  content_hash text not null,
  content text not null,
  published_at timestamptz,
  collected_at timestamptz not null default now(),
  parsed jsonb,
  unique (tracker_id, url, content_hash)
);
create table scout.record_changes (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references scout.records(id),
  source_version_id uuid not null references scout.source_versions(id),
  changed_at timestamptz not null default now(),
  previous jsonb,
  current jsonb not null
);
create index on scout.source_versions (tracker_id, url, collected_at desc);
create index on scout.record_changes (record_id, changed_at desc);

do $$
declare name text;
begin
  foreach name in array array['source_versions', 'record_changes'] loop
    execute format('alter table scout.%I enable row level security', name);
    execute format('revoke all on scout.%I from public, anon, authenticated, service_role', name);
    execute format('grant select, insert, update, delete on scout.%I to service_role', name);
  end loop;
end $$;

-- Raw fetched documents stay backend-only; members may read material changes.
grant select on scout.record_changes to authenticated;
create policy scout_read on scout.record_changes for select to authenticated
  using (exists (select 1 from scout.memberships where user_id = (select auth.uid())));

commit;
