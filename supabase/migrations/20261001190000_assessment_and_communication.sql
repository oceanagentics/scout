begin;

alter table scout.records
  add column priority text check (priority in ('high','normal','low')),
  add column last_communicated_at timestamptz;

-- Only confirmed historical sends count. No backfill assessment or notification.
update scout.records r set last_communicated_at = sent.at
from (select record_id, max(sent_at) as at from scout.deliveries
  where status='sent' and record_id is not null group by record_id) sent
where r.id=sent.record_id;
drop table scout.deliveries;

drop trigger updated_at on scout.records;
create trigger updated_at before update of kind,title,organization,description,location,
  event_url,registration_url,starts_at,ends_at,status,priority on scout.records
  for each row when (
    (old.kind,old.title,old.organization,old.description,old.location,old.event_url,old.registration_url,
      old.starts_at,old.ends_at,old.status,old.priority) is distinct from
    (new.kind,new.title,new.organization,new.description,new.location,new.event_url,new.registration_url,
      new.starts_at,new.ends_at,new.status,new.priority)
  ) execute function scout.set_updated_at();

create or replace view scout.source_details with (security_barrier=true) as
select current.record_id,current.url,current.last_seen_at,current.authoritative,current.tracker_id,
  current.published_at,current.published_on,current.collected_at,
  accepted.assessment->>'reason' as priority_reason,accepted.assessment->>'accepted_at' as assessed_at
from scout.current_evidence current
left join lateral (
  select e.parsed->'assessment' as assessment from scout.evidence e join scout.records r on r.id=e.record_id
  where e.record_id=current.record_id and e.parsed#>>'{assessment,priority_accepted}'='true'
    and e.parsed#>>'{assessment,priority}'=r.priority
  order by e.parsed#>>'{assessment,accepted_at}' desc limit 1
) accepted on true
where (select scout.access_role()) is not null;

-- Validation and notification accounting must not claim successful collection.
create or replace view scout.tracker_status with (security_invoker=true) as
select t.*,activity.last_attempt_at,activity.last_success_at,latest.outcome as last_outcome,
  (select string_agg(value,'; ') from jsonb_array_elements_text(latest.stats->'warnings')) as last_error
from scout.trackers t
left join lateral (
  select max(started_at) as last_attempt_at,
    max(finished_at) filter (where outcome in ('success','no_change')) as last_success_at
  from scout.collection_runs where tracker_id=t.id and coalesce(stats->>'purpose','collection')='collection'
) activity on true
left join lateral (
  select outcome,stats from scout.collection_runs where tracker_id=t.id and finished_at is not null
    and coalesce(stats->>'purpose','collection')='collection'
  order by finished_at desc,started_at desc,id limit 1
) latest on true;

commit;
