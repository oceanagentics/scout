begin;

alter table scout.trackers
  add column seed_key text unique,
  add column cadence_note text,
  add column configuration_note text,
  alter column url drop not null,
  add constraint enabled_tracker_url check (url is not null or not enabled);

-- The frozen seed identity is backend-managed, independent of editable URL/method.
grant insert (cadence_note, configuration_note), update (cadence_note, configuration_note)
  on scout.trackers to authenticated;

commit;
