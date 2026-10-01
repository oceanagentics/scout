begin;

-- A page's first snapshot has no known publication time. Subsequent fact changes
-- have an observation time; unchanged retrieval must not advance that evidence.
alter table scout.sources add column evidence_at timestamptz;
alter table scout.records add column date_evidence jsonb not null default '{}';

-- Repair v1's page-fetch ordering using the preserved HSA publication evidence.
-- Facts and their material timestamps remain unchanged.
update scout.records r set evidence_rank=2, evidence_at=hsa.published_at
from (
  select s.record_id, max(s.published_at) as published_at
  from scout.sources s join scout.source_versions v
    on v.tracker_id=s.tracker_id and v.url=s.url and v.content_hash=s.content_hash
  where v.content_hash like 'hsa-v1:%' and case when v.published_at is not null
    then v.content::jsonb->'author'->>'handle' = 'highseasalliance.bsky.social' else false end
  group by s.record_id
) hsa where r.id=hsa.record_id;

commit;
