begin;

alter table scout.trackers alter column enabled set default false;
comment on column scout.trackers.enabled is
  'True only for a working, tested collector proven to receive and persist real source data for this configuration. Not a schedule or pause flag; see tasks.md SCOUT-16 for promotion evidence.';

-- One-time reconciliation to the five configurations with reviewed live proof
-- (SCOUT-04, SCOUT-08 and SCOUT-10.01; rechecked 2026-10-02).
-- Future collectors must pass SCOUT-16 before a separate explicit promotion.
update scout.trackers set enabled = coalesce((collector, url) in (
  ('bluesky_feed', 'https://bsky.app/profile/highseasalliance.bsky.social'),
  ('bluesky_feed', 'https://bsky.app/profile/deepstewardship.bsky.social'),
  ('bluesky_feed', 'https://bsky.app/profile/globalfishingwatch.org'),
  ('bluesky_feed', 'https://bsky.app/profile/iddri.bsky.social'),
  ('web', 'https://www.hubocean.earth/events-calendar')
), false);

commit;
