begin;

-- Preserve existing admin grants without trusting user-editable metadata.
update auth.users u set raw_app_meta_data = coalesce(u.raw_app_meta_data, '{}'::jsonb) ||
  jsonb_build_object('scout', (case when jsonb_typeof(u.raw_app_meta_data->'scout') = 'object'
    then u.raw_app_meta_data->'scout' else '{}'::jsonb end) || '{"admin":true}'::jsonb)
from scout.memberships m where m.user_id = u.id and m.role = 'admin';
create or replace function scout.access_role() returns text language sql stable security definer
  set search_path = '' as $$
  select case when exists (
    select 1 from auth.identities i where i.user_id = (select auth.uid()) and i.provider = 'google'
      and i.identity_data @> '{"iss":"https://accounts.google.com","email_verified":true,"custom_claims":{"hd":"oceanagentics.com"}}'::jsonb
  ) then case when exists (
    select 1 from auth.users u where u.id = (select auth.uid())
      and u.raw_app_meta_data @> '{"scout":{"admin":true}}'::jsonb
  ) then 'admin' else 'reader' end end
$$;
drop table scout.memberships;

drop trigger updated_at on scout.trackers;
alter table scout.trackers rename column method to collector;
update scout.trackers set collector = case collector
  when 'Web retrieval + extraction' then 'web'
  when 'Bluesky API: getAuthorFeed' then 'bluesky_feed'
  when 'Bluesky API: searchPosts; separate keyword queries' then 'bluesky_search'
  else collector end;
alter table scout.trackers
  drop column channel, drop column cadence_note, drop column configuration_note,
  drop column last_attempt_at, drop column last_success_at, drop column last_outcome,
  drop column last_error, drop column next_run_at, drop column created_at, drop column updated_at;

-- Warnings are stored once, including errors from earlier failed runs.
update scout.collection_runs set stats = jsonb_set(stats, '{warnings}',
  coalesce(stats->'warnings', '[]'::jsonb) || jsonb_build_array(error))
where error is not null and error <> '' and
  error is distinct from (select string_agg(value, '; ') from jsonb_array_elements_text(stats->'warnings'));
update scout.collection_runs set stats = stats - 'models';
alter table scout.collection_runs drop column error;

create view scout.tracker_status with (security_invoker = true) as
select t.*, activity.last_attempt_at, activity.last_success_at,
  latest.outcome as last_outcome,
  (select string_agg(value, '; ') from jsonb_array_elements_text(latest.stats->'warnings')) as last_error
from scout.trackers t
left join lateral (
  select max(started_at) as last_attempt_at,
    max(finished_at) filter (where outcome in ('success','no_change')) as last_success_at
  from scout.collection_runs where tracker_id = t.id
) activity on true
left join lateral (
  select outcome, stats from scout.collection_runs where tracker_id = t.id and finished_at is not null
  order by finished_at desc, started_at desc, id limit 1
) latest on true;
revoke all on scout.tracker_status from public, anon, authenticated, service_role;
grant select on scout.tracker_status to authenticated, service_role;

-- Each current source points to its capture instead of copying the document.
alter table scout.source_versions add column published_on date;
alter table scout.sources add column source_version_id uuid references scout.source_versions(id);
update scout.sources s set source_version_id = v.id from scout.source_versions v
where v.tracker_id = s.tracker_id and v.url = s.url and v.content_hash = s.content_hash;
-- An unmatched legacy source must be reconciled before any evidence is removed.
alter table scout.sources alter column source_version_id set not null;
do $$ begin
  if exists (select source_version_id from scout.sources group by source_version_id
    having count(distinct published_on) > 1) or exists (
    select 1 from scout.sources s join scout.source_versions v on v.id = s.source_version_id
    where s.published_at is not null and s.published_at is distinct from v.published_at
  ) then raise exception 'Conflicting source publication evidence requires reconciliation'; end if;
  if exists (select 1 from scout.sources s join scout.source_versions v on v.id = s.source_version_id
    where s.excerpt is not null and position(s.excerpt in v.content) = 0
  ) then raise exception 'Uncaptured source excerpt requires reconciliation'; end if;
end $$;
update scout.source_versions v set published_on = s.published_on from (
  select source_version_id, max(published_on) as published_on from scout.sources group by source_version_id
) s where v.id = s.source_version_id and s.published_on is not null;
alter table scout.sources rename column collected_at to last_seen_at;
alter table scout.sources drop column id, drop column tracker_id, drop column published_at,
  drop column published_on, drop column excerpt, drop column content_hash,
  drop constraint sources_record_id_url_key, add primary key (record_id, url);
create index on scout.sources (source_version_id);

-- This restricted projection deliberately uses owner privileges to keep raw
-- captures private. Its explicit access check protects every returned row.
create view scout.source_details with (security_barrier = true) as
select s.record_id, s.url, s.last_seen_at, s.authoritative,
  v.tracker_id, v.published_at, v.published_on, v.collected_at
from scout.sources s join scout.source_versions v on v.id = s.source_version_id
where (select scout.access_role()) is not null;
revoke all on scout.source_details from public, anon, authenticated, service_role;
grant select on scout.source_details to authenticated;

drop trigger updated_at on scout.records;
update scout.records set date_evidence = jsonb_strip_nulls(jsonb_build_object(
  'schedule_source', date_evidence#>'{calendar_date,source_versions,0}',
  'zone_source', date_evidence#>'{time_zone,source_versions,0}'))
where date_evidence <> '{}';
-- Direct timestamps also retain their establishing capture when a later fetch
-- no longer contains a usable schedule.
update scout.records r set date_evidence = jsonb_build_object('schedule_source', evidence.source_version_id)
from (
  select distinct on (r.id) r.id, c.source_version_id from scout.records r
  join scout.record_changes c on c.record_id = r.id
  join scout.source_versions v on v.id = c.source_version_id
  where r.starts_at is not null and r.date_evidence = '{}'
    and v.parsed->>'starts_at' = to_char(r.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  order by r.id, c.changed_at desc, c.id
) evidence where evidence.id = r.id;
alter table scout.records drop column created_at, drop column material_hash, drop column time_zone,
  add constraint records_event_fields check (kind = 'event' or
    (starts_at is null and ends_at is null and status is null));
create trigger updated_at before update of title, organization, description,
  location, event_url, registration_url, starts_at, ends_at, status
  on scout.records for each row execute function scout.set_updated_at();
alter table scout.deliveries drop column record_updated_at;

-- Historical change entries and sent payloads remain untouched. The notifier
-- rejects old pending snapshot formats before sending and can reprepare them.
commit;
