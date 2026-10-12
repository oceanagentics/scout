-- One-time snapshot of BBNJ Scout Trackers, read 2026-10-01.
-- https://docs.google.com/spreadsheets/d/1VtpaC83ybg7zet7VvNXmvctN9s5WJK_NTlJ9wx5NIbM/edit
-- Keys retain the snapshot's source IDs (0–21); never renumber or derive from app fields.
-- Reapply as a trusted backend/operator; existing rows are never updated.
-- Enabled means a proven collector, not intended coverage. Only the four exact
-- Bluesky configurations have reviewed live proof (tasks.md SCOUT-16).
begin;

insert into scout.trackers
  (seed_key, name, coverage, url, collector, cadence, enabled)
values
  ('bbnj-trackers-2026-10-01:0', 'UN Treaty Collection', 'BBNJ ratifications, accessions, acceptances and approvals.', 'https://treaties.un.org/Pages/ViewDetails.aspx?src=TREATY&mtdsg_no=XXI-10&chapter=21&clang=_en', 'web', '7 days', false),
  ('bbnj-trackers-2026-10-01:1', 'UN BBNJ / DOALOS', 'Official notifications, announcements, meeting dates and deadlines.', 'https://www.un.org/bbnjagreement/en', 'web', '7 days', false),
  ('bbnj-trackers-2026-10-01:2', 'UN BBNJ meeting and side-event pages', 'Programmes, workshops, side events and schedule changes.', 'https://www.un.org/bbnjagreement/en/capacity-building-and-technical-assistance/side-events', 'web', '7 days', false),
  ('bbnj-trackers-2026-10-01:3', 'High Seas Alliance', 'Webinars, events, registration links and BBNJ updates.', 'https://highseasalliance.org/', 'web', '7 days', false),
  ('bbnj-trackers-2026-10-01:4', 'IUCN — High Seas', 'BBNJ events, expert discussions and implementation workshops.', 'https://iucn.org/our-work/topic/high-seas', 'web', '7 days', false),
  ('bbnj-trackers-2026-10-01:5', 'IDDRI — High Seas', 'Webinars, conferences and BBNJ briefings.', 'https://www.iddri.org/en/publications-and-events/high-seas?page=0', 'web', '7 days', false),
  ('bbnj-trackers-2026-10-01:6', 'BBNJ Symposium Series', 'Symposium announcements, programmes and participation information.', 'https://bbnjsymposium.org/', 'web', '7 days', false),
  ('bbnj-trackers-2026-10-01:7', 'CBD side-event registry', 'BBNJ-related sessions at CBD meetings.', 'https://www.cbd.int/side-events/', 'web', '7 days', false),
  ('bbnj-trackers-2026-10-01:8', 'Conference-specific official programmes', 'BBNJ sessions within other relevant conferences.', null, 'web', '7 days', false),
  ('bbnj-trackers-2026-10-01:9', 'Deep-Ocean Stewardship Initiative (DOSI)', 'Scientific webinars, capacity-building sessions and BBNJ working-group updates.', 'https://www.dosi-project.org/biodiversity-beyond-national-jurisdiction-bbnj/', 'web', '7 days', false),
  ('bbnj-trackers-2026-10-01:10', 'RISE UP for the Ocean', 'Civil-society webinars, regional workshops and upcoming events, including Caribbean perspectives.', 'https://riseupfortheocean.org/latest/rise-up-navigator/', 'web', '7 days', false),
  ('bbnj-trackers-2026-10-01:11', 'Global Ocean Forum', 'BBNJ webinars, implementation workshops, capacity-building activities and conference side events.', 'https://globaloceanforum.com/', 'web', '7 days', false),
  ('bbnj-trackers-2026-10-01:12', 'OceanCare', 'BBNJ meeting updates and side events, including the Clearing-House Mechanism.', 'https://www.oceancare.org/en/', 'web', '7 days', false),
  ('bbnj-trackers-2026-10-01:13', 'The Pew Charitable Trusts', 'Treaty implementation updates, policy briefings and high-seas marine protected areas.', 'https://www.pew.org/en/projects/protecting-ocean-life-on-the-high-seas', 'web', '7 days', false),
  ('bbnj-trackers-2026-10-01:14', 'The Ocean Foundation — Harvest Strategies', 'Technical webinars connecting BBNJ with fisheries management.', 'https://harveststrategies.org/abnj/', 'web', '7 days', false),
  ('bbnj-trackers-2026-10-01:15', 'Blue Marine Foundation', 'BBNJ-related conference events, high-seas protection initiatives and treaty gatherings.', 'https://www.bluemarinefoundation.com/our-events/', 'web', '7 days', false),
  ('bbnj-trackers-2026-10-01:16', 'Global Fishing Watch (GFW)', 'BBNJ announcements, policy updates and conference events on ocean data and transparency.', 'https://globalfishingwatch.org/mediacenter/', 'web', '7 days', false),
  ('bbnj-trackers-2026-10-01:17', 'High Seas Alliance', 'BBNJ webinars, registration links, calls for participation, announcements and relevant reposts.', 'https://bsky.app/profile/highseasalliance.bsky.social', 'bluesky_feed', '1 day', true),
  ('bbnj-trackers-2026-10-01:18', 'Deep-Ocean Stewardship Initiative (DOSI)', 'Scientific webinars, BBNJ working-group updates, side events and relevant reposts.', 'https://bsky.app/profile/deepstewardship.bsky.social', 'bluesky_feed', '1 day', true),
  ('bbnj-trackers-2026-10-01:19', 'Global Fishing Watch (GFW)', 'BBNJ and high-seas policy updates, ocean-data events and relevant reposts.', 'https://bsky.app/profile/globalfishingwatch.org', 'bluesky_feed', '1 day', true),
  ('bbnj-trackers-2026-10-01:20', 'IDDRI — High Seas', 'BBNJ and high-seas webinars, conferences and policy briefings in English and French.', 'https://bsky.app/profile/iddri.bsky.social', 'bluesky_feed', '1 day', true),
  ('bbnj-trackers-2026-10-01:21', 'BBNJ discovery search', 'Discover events, announcements and new organizers. Search separately for BBNJ, High Seas Treaty, traité sur la haute mer, and relevant conference tags.', 'https://bsky.app/search?q=BBNJ', 'bluesky_search', '7 days', false)
on conflict (seed_key) do nothing;

-- Priority publishers and CBD COP17 Armenia; enable only after live collection proof.
insert into scout.trackers (seed_key,name,coverage,url,collector,cadence,enabled) values
  ('bbnj-trackers-2026-10-08:skylight', 'Skylight (Ai2)', 'Ocean conservation, technology, research, partnerships, events and funding announcements from the configured publisher.', 'https://skylight.global/news', 'web', '7 days', false),
  ('bbnj-trackers-2026-10-08:oceans5', 'Oceans 5', 'Ocean conservation, technology, research, partnerships, events and funding announcements from the configured publisher.', 'https://www.oceans5.org/projects/', 'web', '7 days', false),
  ('bbnj-trackers-2026-10-08:bloomberg-oceans', 'Bloomberg Ocean Initiative', 'Ocean conservation, technology, research, partnerships, events and funding announcements from the configured publisher.', 'https://www.bloomberg.org/environment/protecting-the-oceans/', 'web', '7 days', false),
  ('bbnj-trackers-2026-10-08:minderoo', 'Minderoo Foundation', 'Ocean conservation, technology, research, partnerships, events and funding announcements from the configured publisher.', 'https://www.minderoo.org/media/', 'web', '7 days', false),
  ('bbnj-trackers-2026-10-08:oceankind', 'Oceankind', 'Ocean conservation, technology, research, partnerships, events and funding announcements from the configured publisher.', 'https://oceankind.org/', 'web', '7 days', false),
  ('bbnj-trackers-2026-10-08:skytruth', 'SkyTruth', 'Ocean conservation, technology, research, partnerships, events and funding announcements from the configured publisher.', 'https://skytruth.org/blog', 'web', '7 days', false),
  ('bbnj-trackers-2026-10-08:oceano-azul', 'Oceano Azul Foundation', 'Ocean conservation, technology, research, partnerships, events and funding announcements from the configured publisher.', 'https://oceanoazulfoundation.org/media/', 'web', '7 days', false),
  ('bbnj-trackers-2026-10-08:obis', 'UNESCO-IOC OBIS', 'Ocean conservation, technology, research, partnerships, events and funding announcements from the configured publisher.', 'https://obis.org/', 'web', '7 days', false),
  ('bbnj-trackers-2026-10-08:geo-cop17', 'GEO — CBD COP17 pavilion schedule', 'CBD COP17 programmes, sessions, participation information and schedule changes in Yerevan, Armenia, 19–30 October 2026.', 'https://earthobservations.org/about-us/events/cop17/schedule', 'web', '1 day', false),
  ('bbnj-trackers-2026-10-08:cbd-cop17', 'CBD COP17 — Yerevan, Armenia', 'CBD COP17 programmes, sessions, participation information and schedule changes in Yerevan, Armenia, 19–30 October 2026.', 'https://www.cbd.int/conferences/2026', 'web', '1 day', false)
on conflict (seed_key) do nothing;

-- COP17 programme sources for Aaron and Brandon. Use the shared intake/rubric;
-- keep disabled until collection is verified. No recurring activity is enabled.
insert into scout.trackers (seed_key,name,coverage,url,collector,cadence,enabled) values
  ('bbnj-trackers-2026-10-12:cop17-parallel', 'CBD COP17 — parallel events', 'COP17 forums, workshops, Action Zone, GBF Pavilion and linked associated-event programmes.', 'https://www.cbd.int/conferences/2026/parallel-meetings', 'web', '1 day', false),
  ('bbnj-trackers-2026-10-12:cop17-agenda', 'CBD COP17 — official agenda', 'COP17 formal meeting agenda, programme documents and updates.', 'https://www.cbd.int/conferences/2026/cop-17', 'web', '1 day', false),
  ('bbnj-trackers-2026-10-12:cop17-data-pavilion', 'COP17 — Data to Action Pavilion', 'Full Data to Action Pavilion partner programme beyond the GEO schedule; dynamic programme retrieval remains unverified.', 'https://cop17pavilion.org/', 'web', '1 day', false),
  ('bbnj-trackers-2026-10-12:cop17-nature-positive', 'COP17 — Nature Positive Pavilion', 'Nature Positive Pavilion sessions across both rooms, with schedules, organizations and participation details.', 'https://www.naturepositive.org/events/nature-positive-at-the-un-cbd-cop/cop17-armenia/pavilion/', 'web', '1 day', false),
  ('bbnj-trackers-2026-10-12:cop17-iucn', 'IUCN — COP17 programme', 'IUCN Unite for Nature Pavilion programme and official COP17 side events.', 'https://iucn.org/cbdcop17/programme-iucn-events-cbd-cop17', 'web', '1 day', false),
  ('bbnj-trackers-2026-10-12:cop17-un-pavilion', 'COP17 — UN Pavilion timetable', 'Provisional UN Pavilion timetable for both COP17 weeks; preserve tentative schedules and later revisions.', 'https://armenia.un.org/en/download/217945/324020', 'web', '1 day', false),
  ('bbnj-trackers-2026-10-12:cop17-tnfd', 'COP17 — TNFD Hive', 'TNFD Hive off-site programme, 23–24 October 2026, including session registration and access requirements.', 'https://tnfd.global/cop17-landing-page-tnfd-hive/', 'web', '1 day', false),
  ('bbnj-trackers-2026-10-12:cop17-green-zone', 'COP17 — official Green Zone', 'Public Green Zone activities and programme updates; detailed session programme not yet verified.', 'https://www.cop17yerevangreenzone.com/', 'web', '1 day', false),
  ('bbnj-trackers-2026-10-12:cop17-icri', 'ICRI — COP17 coral reef and ocean events', 'Supplementary discovery guide to CBD side events, Ocean Pavilion sessions and organizer announcements; follow original source URLs for current details.', 'https://icriforum.org/meetings/cop17-events/', 'web', '1 day', false)
on conflict (seed_key) do nothing;

commit;
