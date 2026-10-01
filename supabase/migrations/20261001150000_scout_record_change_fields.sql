begin;

-- Keep each history entry and its evidence/timestamp, but discard equal fields.
-- SQL NULL marks a creation; JSON null is a value, distinct from a missing key.
update scout.record_changes c set (previous, current) = (
  select
    case when c.previous is null then null else
      coalesce(jsonb_object_agg(b.key, b.value) filter (where b.key is not null), '{}'::jsonb) end,
    coalesce(jsonb_object_agg(a.key, a.value) filter (where a.key is not null), '{}'::jsonb)
  from jsonb_each(coalesce(c.previous, '{}'::jsonb)) b
  full join jsonb_each(c.current) a on a.key = b.key
  where b.value is distinct from a.value
);

comment on column scout.record_changes.previous is
  'Before values of changed fields only; SQL NULL denotes initial creation. Missing keys differ from JSON null.';
comment on column scout.record_changes.current is
  'After values of changed fields only; creation includes all initial fields. Captured evidence remains in source_versions.';

commit;
