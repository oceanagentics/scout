begin;

-- Unknown fields in a later capture must not erase an accepted calendar fact.
create or replace view scout.source_details with (security_barrier=true) as
select current.record_id,current.url,current.last_seen_at,current.authoritative,current.tracker_id,
  current.published_at,current.published_on,current.collected_at,
  accepted.assessment->>'reason' as priority_reason,accepted.assessment->>'accepted_at' as assessed_at,
  calendar.facts as calendar_dates
from scout.current_evidence current
left join lateral (
  select e.parsed->'assessment' as assessment from scout.evidence e join scout.records r on r.id=e.record_id
  where e.record_id=current.record_id and e.parsed#>>'{assessment,priority_accepted}'='true'
    and e.parsed#>>'{assessment,priority}'=r.priority
  order by e.parsed#>>'{assessment,accepted_at}' desc limit 1
) accepted on true
left join lateral (
  select coalesce(jsonb_object_agg(f.key,f.value) filter (where exists (
    select 1 from jsonb_array_elements(f.value->'sources') s where s->>'url'=current.url
  )),'{}') as facts from (
    select distinct on(x.key) x.key,x.value from scout.evidence e
    cross join lateral jsonb_each(coalesce(e.parsed->'accepted_fields','{}')) x
    where e.record_id=current.record_id and x.key in ('starts_on','ends_on')
    order by x.key,x.value->>'accepted_at' desc,e.id
  ) f
) calendar on true
where (select scout.access_role()) is not null;

commit;
