begin;

alter table scout.deliveries
  drop constraint deliveries_kind_check,
  add constraint deliveries_kind_check check (kind in ('finding', 'change', 'digest', 'baseline')),
  add column payload jsonb,
  add column snapshot jsonb,
  add column last_attempt_at timestamptz,
  add column slack_ts text,
  add column reconciliation_note text;

-- Existing RLS and backend-only grants also protect payloads and receipts.
commit;
