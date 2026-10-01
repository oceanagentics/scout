begin;

-- Schema-specific revokes cannot undo global default grants. Refuse those
-- defaults without changing privileges used by an existing service.
do $$
begin
  if exists (
    select 1 from pg_default_acl d, lateral aclexplode(d.defaclacl) a
    where d.defaclrole = (select oid from pg_roles where rolname = current_user)
      and d.defaclnamespace = 0 and d.defaclobjtype = 'r'
      and (a.grantee = 0 or a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated')))
  ) then
    raise exception 'Global client table defaults require review before creating Scout';
  end if;
end $$;

-- Fail on a name collision; never replace another service's schema.
create schema scout;
revoke all on schema scout from public, anon, authenticated;
grant usage on schema scout to authenticated, service_role;
alter default privileges in schema scout revoke all on tables from public, anon, authenticated, service_role;
alter default privileges in schema scout revoke all on functions from public, anon, authenticated, service_role;

create table scout.memberships (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('reader', 'admin')),
  created_at timestamptz not null default now()
);

create table scout.trackers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  url text not null check (url ~ '^https://'),
  coverage text,
  channel text not null,
  method text not null,
  cadence interval not null check (cadence > interval '0 seconds'),
  enabled boolean not null default true,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_outcome text check (last_outcome in ('success', 'no_change', 'partial', 'failed', 'quota', 'unsupported')),
  last_error text,
  next_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (url, method)
);

create table scout.collection_runs (
  id uuid primary key default gen_random_uuid(),
  tracker_id uuid not null references scout.trackers(id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome text not null default 'running' check (outcome in ('running', 'success', 'no_change', 'partial', 'failed', 'quota', 'unsupported')),
  error text,
  check (finished_at is null or finished_at >= started_at),
  check ((outcome = 'running') = (finished_at is null))
);

-- One record can have several sources. Dates without evidence stay null.
create table scout.records (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('event', 'announcement', 'treaty_status')),
  title text not null check (length(trim(title)) > 0),
  organization text,
  description text,
  summary text,
  location text,
  event_url text check (event_url ~ '^https?://'),
  registration_url text check (registration_url ~ '^https?://'),
  start_on date,
  end_on date,
  starts_at timestamptz,
  ends_at timestamptz,
  time_zone text,
  status text check (status in ('scheduled', 'rescheduled', 'cancelled')),
  published_on date,
  country text,
  treaty_action text,
  recorded_on date,
  collected_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (start_on is null or starts_at is null),
  check (end_on is null or (start_on is not null and end_on >= start_on)),
  check (ends_at is null or (starts_at is not null and ends_at >= starts_at)),
  check (starts_at is null or time_zone is not null),
  check (kind = 'event' or (start_on is null and end_on is null and starts_at is null and ends_at is null and time_zone is null and status is null))
);

create table scout.sources (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references scout.records(id) on delete cascade,
  tracker_id uuid references scout.trackers(id),
  url text not null check (url ~ '^https?://'),
  published_at timestamptz,
  published_on date,
  collected_at timestamptz not null default now(),
  excerpt text,
  content_hash text,
  authoritative boolean not null default false,
  unique (record_id, url)
);

create table scout.deliveries (
  id uuid primary key default gen_random_uuid(),
  record_id uuid references scout.records(id),
  record_updated_at timestamptz,
  kind text not null check (kind in ('finding', 'change', 'digest')),
  channel_id text not null,
  idempotency_key text not null unique,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'unknown', 'baseline')),
  attempts integer not null default 0 check (attempts >= 0),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  error text
);

create index on scout.collection_runs (tracker_id, started_at desc);
create index on scout.records (kind, updated_at desc);
create index on scout.sources (tracker_id);
create index on scout.deliveries (record_id);

-- Grant a fixed set of tables only. Every future migration must do the same.
do $$
declare name text;
begin
  foreach name in array array['memberships', 'trackers', 'collection_runs', 'records', 'sources', 'deliveries'] loop
    execute format('alter table scout.%I enable row level security', name);
    execute format('revoke all on scout.%I from public, anon, authenticated, service_role', name);
    execute format('grant select, insert, update, delete on scout.%I to service_role', name);
  end loop;
  foreach name in array array['trackers', 'collection_runs', 'records', 'sources'] loop
    execute format('grant select on scout.%I to authenticated', name);
    execute format('create policy scout_read on scout.%I for select to authenticated using (exists (select 1 from scout.memberships where user_id = (select auth.uid())))', name);
  end loop;
end $$;

grant select on scout.memberships to authenticated;
create policy own_membership on scout.memberships for select to authenticated
  using (user_id = (select auth.uid()));

-- Tracker management is the only browser write in the foundation.
grant insert (name, url, coverage, channel, method, cadence, enabled),
  update (name, url, coverage, channel, method, cadence, enabled)
  on scout.trackers to authenticated;
create policy scout_admin_insert on scout.trackers for insert to authenticated
  with check (exists (select 1 from scout.memberships where user_id = (select auth.uid()) and role = 'admin'));
create policy scout_admin_update on scout.trackers for update to authenticated
  using (exists (select 1 from scout.memberships where user_id = (select auth.uid()) and role = 'admin'))
  with check (exists (select 1 from scout.memberships where user_id = (select auth.uid()) and role = 'admin'));

create function scout.set_updated_at() returns trigger language plpgsql
  set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;
revoke all on function scout.set_updated_at() from public, anon, authenticated;
create trigger updated_at before update on scout.trackers
  for each row execute function scout.set_updated_at();
create trigger updated_at before update on scout.records
  for each row execute function scout.set_updated_at();

commit;
