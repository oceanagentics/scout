begin;

-- Advance the record version only when its description actually changes, so
-- prepared notifications cannot silently send an outdated description.
update scout.records r set description = shortened.description from (
  select id, case when char_length(coalesce(nullif(description, ''), summary)) > 280
    then rtrim(left(coalesce(nullif(description, ''), summary), 279)) || '…'
    else coalesce(nullif(description, ''), summary) end as description
  from scout.records
) shortened where r.id = shortened.id and r.description is distinct from shortened.description;

drop trigger updated_at on scout.records;

alter table scout.records
  drop column summary,
  drop column start_on,
  drop column end_on,
  drop column published_on,
  drop column country,
  drop column treaty_action,
  drop column recorded_on,
  drop column collected_at,
  add constraint records_description_length check (char_length(description) <= 280),
  add constraint records_event_fields check (kind = 'event' or
    (starts_at is null and ends_at is null and time_zone is null and status is null));

create trigger updated_at before update of title, organization, description,
  location, event_url, registration_url, starts_at, ends_at, time_zone, status,
  material_hash on scout.records for each row execute function scout.set_updated_at();

-- Historical changes, delivery snapshots and captured sources remain evidence
-- in their original shape. No date-only value becomes an invented UTC instant.
commit;
