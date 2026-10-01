-- One-time snapshot of BBNJ Scout Trackers, read 2026-10-01.
-- https://docs.google.com/spreadsheets/d/1VtpaC83ybg7zet7VvNXmvctN9s5WJK_NTlJ9wx5NIbM/edit
-- Keys retain the snapshot's source IDs (0–21); never renumber or derive from app fields.
-- Reapply as a trusted backend/operator; existing rows are never updated.
begin;

insert into scout.trackers
  (seed_key, name, coverage, url, channel, method, cadence, cadence_note, enabled, configuration_note)
values
  ('bbnj-trackers-2026-10-01:0', 'UN Treaty Collection', 'BBNJ ratifications, accessions, acceptances and approvals.', 'https://treaties.un.org/Pages/ViewDetails.aspx?src=TREATY&mtdsg_no=XXI-10&chapter=21&clang=_en', 'Website', 'Web retrieval + extraction', '7 days', 'Weekly', true, null),
  ('bbnj-trackers-2026-10-01:1', 'UN BBNJ / DOALOS', 'Official notifications, announcements, meeting dates and deadlines.', 'https://www.un.org/bbnjagreement/en', 'Website', 'Web retrieval + extraction', '7 days', 'Weekly', true, null),
  ('bbnj-trackers-2026-10-01:2', 'UN BBNJ meeting and side-event pages', 'Programmes, workshops, side events and schedule changes.', 'https://www.un.org/bbnjagreement/en/capacity-building-and-technical-assistance/side-events', 'Website', 'Web retrieval + extraction', '7 days', 'Weekly; daily during meeting periods', true, null),
  ('bbnj-trackers-2026-10-01:3', 'High Seas Alliance', 'Webinars, events, registration links and BBNJ updates.', 'https://highseasalliance.org/', 'Website', 'Web retrieval + extraction', '7 days', 'Weekly', true, null),
  ('bbnj-trackers-2026-10-01:4', 'IUCN — High Seas', 'BBNJ events, expert discussions and implementation workshops.', 'https://iucn.org/our-work/topic/high-seas', 'Website', 'Web retrieval + extraction', '7 days', 'Weekly', true, null),
  ('bbnj-trackers-2026-10-01:5', 'IDDRI — High Seas', 'Webinars, conferences and BBNJ briefings.', 'https://www.iddri.org/en/publications-and-events/high-seas?page=0', 'Website', 'Web retrieval + extraction', '7 days', 'Weekly', true, null),
  ('bbnj-trackers-2026-10-01:6', 'BBNJ Symposium Series', 'Symposium announcements, programmes and participation information.', 'https://bbnjsymposium.org/', 'Website', 'Web retrieval + extraction', '7 days', 'Weekly; daily during meeting periods', true, null),
  ('bbnj-trackers-2026-10-01:7', 'CBD side-event registry', 'BBNJ-related sessions at CBD meetings.', 'https://www.cbd.int/side-events/', 'Website', 'Web retrieval + extraction', '7 days', 'Weekly; daily during meeting periods', true, null),
  ('bbnj-trackers-2026-10-01:8', 'Conference-specific official programmes', 'BBNJ sessions within other relevant conferences.', null, 'Website', 'Web retrieval + extraction', '7 days', 'Weekly; daily during meeting periods', false, 'Set per conference'),
  ('bbnj-trackers-2026-10-01:9', 'Deep-Ocean Stewardship Initiative (DOSI)', 'Scientific webinars, capacity-building sessions and BBNJ working-group updates.', 'https://www.dosi-project.org/biodiversity-beyond-national-jurisdiction-bbnj/', 'Website', 'Web retrieval + extraction', '7 days', 'Weekly', true, null),
  ('bbnj-trackers-2026-10-01:10', 'RISE UP for the Ocean', 'Civil-society webinars, regional workshops and upcoming events, including Caribbean perspectives.', 'https://riseupfortheocean.org/latest/rise-up-navigator/', 'Website', 'Web retrieval + extraction', '7 days', 'Weekly', true, null),
  ('bbnj-trackers-2026-10-01:11', 'Global Ocean Forum', 'BBNJ webinars, implementation workshops, capacity-building activities and conference side events.', 'https://globaloceanforum.com/', 'Website', 'Web retrieval + extraction', '7 days', 'Weekly', true, null),
  ('bbnj-trackers-2026-10-01:12', 'OceanCare', 'BBNJ meeting updates and side events, including the Clearing-House Mechanism.', 'https://www.oceancare.org/en/', 'Website', 'Web retrieval + extraction', '7 days', 'Weekly', true, null),
  ('bbnj-trackers-2026-10-01:13', 'The Pew Charitable Trusts', 'Treaty implementation updates, policy briefings and high-seas marine protected areas.', 'https://www.pew.org/en/projects/protecting-ocean-life-on-the-high-seas', 'Website', 'Web retrieval + extraction', '7 days', 'Weekly', true, null),
  ('bbnj-trackers-2026-10-01:14', 'The Ocean Foundation — Harvest Strategies', 'Technical webinars connecting BBNJ with fisheries management.', 'https://harveststrategies.org/abnj/', 'Website', 'Web retrieval + extraction', '7 days', 'Weekly', true, null),
  ('bbnj-trackers-2026-10-01:15', 'Blue Marine Foundation', 'BBNJ-related conference events, high-seas protection initiatives and treaty gatherings.', 'https://www.bluemarinefoundation.com/our-events/', 'Website', 'Web retrieval + extraction', '7 days', 'Weekly', true, null),
  ('bbnj-trackers-2026-10-01:16', 'Global Fishing Watch (GFW)', 'BBNJ announcements, policy updates and conference events on ocean data and transparency.', 'https://globalfishingwatch.org/mediacenter/', 'Website', 'Web retrieval + extraction', '7 days', 'Weekly', true, null),
  ('bbnj-trackers-2026-10-01:17', 'High Seas Alliance', 'BBNJ webinars, registration links, calls for participation, announcements and relevant reposts.', 'https://bsky.app/profile/highseasalliance.bsky.social', 'Bluesky', 'Bluesky API: getAuthorFeed', '1 day', 'Daily', true, null),
  ('bbnj-trackers-2026-10-01:18', 'Deep-Ocean Stewardship Initiative (DOSI)', 'Scientific webinars, BBNJ working-group updates, side events and relevant reposts.', 'https://bsky.app/profile/deepstewardship.bsky.social', 'Bluesky', 'Bluesky API: getAuthorFeed', '1 day', 'Daily', true, null),
  ('bbnj-trackers-2026-10-01:19', 'Global Fishing Watch (GFW)', 'BBNJ and high-seas policy updates, ocean-data events and relevant reposts.', 'https://bsky.app/profile/globalfishingwatch.org', 'Bluesky', 'Bluesky API: getAuthorFeed', '1 day', 'Daily', true, null),
  ('bbnj-trackers-2026-10-01:20', 'IDDRI — High Seas', 'BBNJ and high-seas webinars, conferences and policy briefings in English and French.', 'https://bsky.app/profile/iddri.bsky.social', 'Bluesky', 'Bluesky API: getAuthorFeed', '1 day', 'Daily', true, null),
  ('bbnj-trackers-2026-10-01:21', 'BBNJ discovery search', 'Discover events, announcements and new organizers. Search separately for BBNJ, High Seas Treaty, traité sur la haute mer, and relevant conference tags.', 'https://bsky.app/search?q=BBNJ', 'Bluesky', 'Bluesky API: searchPosts; separate keyword queries', '7 days', 'Weekly; daily during major BBNJ meetings', true, null)
on conflict (seed_key) do nothing;

commit;
