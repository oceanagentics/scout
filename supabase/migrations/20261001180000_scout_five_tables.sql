begin;

-- Preserve associations before removing the link and record-change tables.
-- Shared captures become independent evidence rows for each record.
create temporary table scout_evidence_links on commit drop as
select capture_id, record_id, case when row_number() over (
  partition by capture_id order by record_id) = 1 then capture_id else gen_random_uuid() end as id
from (
  select v.id as capture_id, s.record_id from scout.source_versions v join scout.sources s on s.url = v.url
  union
  select source_version_id, record_id from scout.record_changes
  union
  select v.id, r.id from scout.records r join scout.source_versions v
    on v.id::text in (r.date_evidence->>'schedule_source', r.date_evidence->>'zone_source')
) links;

drop view scout.source_details;
alter table scout.source_versions rename to evidence;
alter table scout.evidence
  drop constraint source_versions_tracker_id_url_content_hash_key,
  add column record_id uuid references scout.records(id),
  add column last_seen_at timestamptz,
  add column authoritative boolean not null default false,
  add column evidence_at timestamptz;

update scout.evidence e set record_id = l.record_id,
  last_seen_at = s.last_seen_at, authoritative = coalesce(s.authoritative, false), evidence_at = s.evidence_at
from scout_evidence_links l left join scout.sources s
  on s.record_id = l.record_id and s.source_version_id = l.capture_id
where e.id = l.id;
insert into scout.evidence (id, tracker_id, url, content_hash, content, published_at, collected_at, parsed,
  published_on, record_id, last_seen_at, authoritative, evidence_at)
select l.id, e.tracker_id, e.url, e.content_hash, e.content, e.published_at, e.collected_at, e.parsed,
  e.published_on, l.record_id, s.last_seen_at, coalesce(s.authoritative, false), s.evidence_at
from scout_evidence_links l join scout.evidence e on e.id = l.capture_id
left join scout.sources s on s.record_id = l.record_id and s.source_version_id = l.capture_id
where l.id <> l.capture_id;

-- Point schedule proofs at the copy owned by the same record. This changes no
-- record facts or versions, and leaves delivery payloads/snapshots intact.
update scout.records r set date_evidence = r.date_evidence || jsonb_build_object('schedule_source', l.id)
from scout_evidence_links l where l.record_id = r.id and l.id <> l.capture_id
  and r.date_evidence->>'schedule_source' = l.capture_id::text;
update scout.records r set date_evidence = r.date_evidence || jsonb_build_object('zone_source', l.id)
from scout_evidence_links l where l.record_id = r.id and l.id <> l.capture_id
  and r.date_evidence->>'zone_source' = l.capture_id::text;

alter table scout.evidence add unique nulls not distinct (record_id, tracker_id, url, content_hash);
create index on scout.evidence (record_id, url, last_seen_at desc) where last_seen_at is not null;
drop table scout.sources;
drop table scout.record_changes;

-- Captures without a record remain backend-only evidence. An old capture seen
-- again wins by last_seen_at; its original capture time and content stay intact.
create view scout.current_evidence as
select distinct on (record_id, url) * from scout.evidence
where record_id is not null and last_seen_at is not null
order by record_id, url, last_seen_at desc, id;
revoke all on scout.current_evidence from public, anon, authenticated, service_role;
grant select on scout.current_evidence to service_role;

-- Keep the existing restricted browser projection; raw evidence stays private.
create view scout.source_details with (security_barrier = true) as
select record_id, url, last_seen_at, authoritative, tracker_id, published_at, published_on, collected_at
from scout.current_evidence where (select scout.access_role()) is not null;
revoke all on scout.source_details from public, anon, authenticated, service_role;
grant select on scout.source_details to authenticated;

commit;
