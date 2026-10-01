# Scout build tasks

Build a proof of concept that collects BBNJ events, announcements, and treaty-status changes; stores source-backed records; and makes them available through Slack and a filterable web list. Target recurring service fees: **$0/month**.

## Sources and scope

- [BBNJ Scout Letter](https://docs.google.com/document/d/13HIEN45IEKQN-i29pQuoRD-eeFOl-t70a1_2TBpV7zI/edit): product brief, Features, and Services.
- [BBNJ Scout Trackers](https://docs.google.com/spreadsheets/d/1VtpaC83ybg7zet7VvNXmvctN9s5WJK_NTlJ9wx5NIbM/edit): initial source inventory, collection methods, and cadences; currently 22 trackers. Read the live sheet before importing.
- This file is the authoritative implementation checklist. The letter remains the product brief. Resolve material conflicts with the user before implementing the affected behavior.
- Proposed POC scope: events, announcements, treaty-status changes, daily Slack findings, a weekly Slack digest, Slack questions, a filterable web list, tracker management, and add-to-calendar actions.
- Proposed deferrals: email digests and a separate calendar view. Confirm these in SCOUT-01 because the Letter and Features tabs differ.

## Working rules

- Implement only when the user requests implementation. Creating this checklist does not start the build.
- Use statuses `todo`, `in-progress`, `blocked`, and `done`. Keep task IDs stable. Start with the first task whose dependencies are complete.
- Keep changes minimal, follow existing patterns, and avoid speculative helpers, scripts, abstractions, or cleanup.
- Work in the supplied local checkout. Do not clone, create a worktree, or change checkouts unless explicitly requested.
- Before marking a task done, check every acceptance criterion, record verification and material limitations, and create one focused commit for the implemented task unless instructed otherwise.
- Record blockers and the specific missing input. Continue independent authorized work where possible. Do not treat unsupported coverage as successful collection.
- Use small recorded source examples for repeatable checks of parsing, deduplication, dates, and failures; use a bounded live check to confirm each integration. Do not add tests that merely mirror implementation.

## Shared constraints

- Use recurring free tiers. Confirm current account eligibility and limits during setup; quoted allowances below are planning assumptions from the Services tab.
- Keep paid upgrades and automatic top-ups off. Apply model and search budgets from their first use, including retries. Stop at the configured limit and persist quota exhaustion in tracker status.
- Preserve collected records when a source fails or a quota is exhausted. Distinguish successful collection with no changes from failed or partial collection.
- Use source links and collection timestamps for every record. Keep missing dates, time zones, or other unsupported facts unknown. Model output is not evidence.
- Extract and summarize only new or changed content; reuse stored results. Send only public source material and the specific Scout question to the proposed free model service.
- Keep collection and notification schedules independent. Default to daily Bluesky collection, mostly weekly websites, and weekly discovery; use tracker-specific overrides around meetings.
- Import the sheet once to seed trackers. The app owns subsequent edits; do not introduce continuing sheet synchronization.
- Keep credentials server-side. Enforce the access policy agreed in SCOUT-01 for reading the app, administering trackers, and invoking collection.
- Calendar actions are frontend links or calendar-file downloads. They do not require a calendar service or account integration.

## Milestones

1. **First useful flow — SCOUT-01 through SCOUT-06:** one source produces stored records, a usable web list, calendar actions, and Slack delivery.
2. **Scheduled coverage — SCOUT-07 through SCOUT-11:** due trackers run automatically, failures are visible, and official sources and discovery expand coverage.
3. **Complete POC — SCOUT-12 through SCOUT-14:** Slack questions, tracker management, and verified end-to-end behavior.

## SCOUT-01 — Confirm POC scope and service access

Status: todo
Depends on: none

Outcome: The agent has a confirmed scope, usable service access, and explicit free usage budgets.

Acceptance criteria:

- [ ] Confirm the proposed POC scope and deferrals, intended app audience, administrators, Slack workspace/channel, and notification schedule/time zone.
- [ ] Confirm Firebase Hosting access through OA's existing Google account, a Spark project with a separate Scout site, Supabase Free project `chm`, Tavily Free, and installation access for a custom Slack app in the existing workspace. Cloudflare signup is no longer needed. Record missing access without storing secrets here.
- [ ] Confirm the shared `chm` project identity, available free capacity, and existing services before provisioning. Use the default `postgres` database with one schema per service (`scout`; `otherservice` is a future-service example). Record Data API on, automatic table exposure off, and RLS on; budget Scout against remaining project-wide quotas.
- [ ] Use OA's Google Workspace account for AI Studio; obtain administrator enablement if needed and create a Scout Gemini API key in an OA-controlled project. Verify a supported free model and its actual quota with a bounded request; Workspace's included Gemini features do not supply API quota.
- [ ] Verify current provider allowances and account eligibility. Planning baseline: Firebase Hosting 10 GB storage and 10 GB/month transfer; Supabase 500 MB database, 1 GB storage, 5 GB egress, and 500,000 function invocations/month; Tavily 1,000 credits/month without a card; model limits are account-specific. Do not count nonprofit Workspace benefits or trial credits as recurring backend/search capacity.
- [ ] Record model/search caps and retry limits within the available free quotas. Verify that paid upgrades and automatic top-ups are off.
- [ ] Record decisions and provider references in this task. Identify any blockers for downstream tasks.

Verification: Pending.
Blockers: None recorded; scope decisions and service access are unverified.

## SCOUT-02 — Create the app and database foundation

Status: todo
Depends on: SCOUT-01

Outcome: A minimal app runs locally and on Firebase Hosting, with Supabase project `chm` and versioned migrations for its `scout` schema.

Acceptance criteria:

- [ ] Select a minimal stack with a static frontend deployable to Firebase Hosting on Spark and a Supabase backend; record local, migration, and deployment commands. Reuse the Ryu hosting approach for a separate Scout site without changing Ryu's deployment. Keep workers and schedules on Supabase; Firebase Cloud Functions/Blaze and a Sheets/Apps Script backend redesign are outside this POC plan.
- [ ] A deployed app can read a harmless sample record from the database. Verify local startup and the hosted URL.
- [ ] Create the `scout` schema in `chm`'s default `postgres` database. Put Scout's trackers, collection history, events, announcements, treaty-status changes, source references, and notification delivery state there (for example, `scout.events`). Use the smallest schema that supports these responsibilities.
- [ ] Configure clients and migrations to target `scout` explicitly. Add `scout` to the Data API's exposed schemas while preserving existing services; grant only required schema/table/function privileges and enable RLS with policies in the same migrations. Do not grant automatic access to all future tables.
- [ ] Events support organization, title, description, location/URL, source-backed dates/time zones, registration link, status, and last update. Announcements support summary, publication date, sources, and last update. Treaty changes support country, action, and recorded date.
- [ ] Keep source publication dates, event dates, collection times, and record update times distinct. Support multiple source references for one record.
- [ ] Enforce Scout-specific access within the project's shared Auth setup. Verify unauthorized writes and access to private records across service boundaries fail; authentication in another service does not confer Scout administrator access. Keep project-wide service-role credentials backend-only and absent from browser assets and logs.
- [ ] Review existing migration history before applying Scout migrations. Verify they succeed in an empty development database and preserve other services' schema objects, data, and permissions in a shared development database. Never reset the shared remote project as a setup step.

Verification: Pending.
Blockers: None recorded.

## SCOUT-03 — Import the tracker sheet

Status: todo
Depends on: SCOUT-02

Outcome: The current sheet seeds the app's tracker inventory without creating an ongoing synchronization dependency.

Acceptance criteria:

- [ ] Read the live sheet and import every populated tracker row, preserving source identity, URL/account, coverage, channel, collection method, and cadence.
- [ ] Reconcile the imported inventory against the sheet. Report invalid, incomplete, or unsupported entries instead of silently dropping them.
- [ ] Repeating the import creates no duplicates and does not overwrite app edits. Paused trackers remain paused.
- [ ] Each tracker can persist enabled state, last attempt, last successful collection, latest outcome/error, and next scheduled run. An imported tracker is initially uncollected, not successful.
- [ ] Verify one website, one Bluesky feed, and the discovery tracker retain their distinct methods and cadences.

Verification: Pending.
Blockers: None recorded.

## SCOUT-04 — Collect HSA's Bluesky feed end to end

Status: todo
Depends on: SCOUT-03

Outcome: A manual collection run produces usable events and announcements from High Seas Alliance's public feed.

Acceptance criteria:

- [ ] Fetch HSA's configured public feed, identify relevant BBNJ items, and follow relevant organizer/registration links within bounded collection limits.
- [ ] Store structured records with supporting source links, organization, available dates/time zones, summary, and collection timestamps. Preserve unknown values.
- [ ] Use direct structured extraction where sufficient and the agreed free model only where needed. Validate model output before storing it and apply the configured usage caps.
- [ ] Unchanged content does not trigger repeat model work. Repeated collection does not create duplicate records.
- [ ] A changed event date or cancellation updates the existing event and records a material change; cosmetic source edits do not become new announcements.
- [ ] Persist success, no-change, partial, failure, and quota outcomes accurately. A failed fetch leaves previous records intact.
- [ ] Verify a real source example and repeatable cases for initial collection, repeat collection, changed date, missing date, irrelevant content, and failed fetch.

Verification: Pending.
Blockers: None recorded.

## SCOUT-05 — Build the filterable list and calendar actions

Status: todo
Depends on: SCOUT-04

Outcome: A user can find collected records and add a supported event to a calendar.

Acceptance criteria:

- [ ] Show events, announcements, and treaty changes in a searchable list with type, organization, and applicable date filters.
- [ ] Show source links, relevant dates, record updates, and collection freshness; provide clear loading, empty, and error states.
- [ ] Show rescheduled and cancelled events accurately. Do not present past events as upcoming.
- [ ] Provide calendar links or downloads for events with sufficient date information. Preserve time zones and date-only events; do not invent a start time.
- [ ] Verify a timed event, an event across a time-zone boundary, a date-only event, and an event with insufficient date information.

Verification: Pending.
Blockers: None recorded.

## SCOUT-06 — Deliver Slack findings and digests

Status: todo
Depends on: SCOUT-04, SCOUT-05

Outcome: Scout can deliver new findings, material changes, and a weekly upcoming-events digest to the agreed Slack channel.

Acceptance criteria:

- [ ] Configure the custom Slack app with only the access needed for the agreed behavior. Keep tokens server-side.
- [ ] A manual delivery run posts new findings and material changes with concise descriptions, source links, and applicable calendar actions.
- [ ] A manually triggered digest lists upcoming events for an explicit reporting window, omitting cancelled events and distinguishing unknown dates.
- [ ] Track delivery state separately from collection state. Repeating a completed delivery does not post it again; failed deliveries are not marked successful.
- [ ] Bound retries and record ambiguous send outcomes for reconciliation rather than blindly reposting. Verify a transient failure and a repeated delivery request.
- [ ] Initial historical imports have an explicit notification baseline so they do not flood the channel. Verify Slack rendering in the agreed channel.

Verification: Pending.
Blockers: None recorded.

## SCOUT-07 — Schedule collection and handle failures

Status: todo
Depends on: SCOUT-03, SCOUT-04, SCOUT-06

Outcome: Due trackers and notifications run automatically with visible outcomes and bounded work.

Acceptance criteria:

- [ ] Supabase Cron invokes small collection jobs using each tracker's method and cadence; paused and not-yet-due trackers are skipped. Prefix Scout's deployed Edge Functions and scheduled jobs with `scout-` to avoid collisions with other `chm` services.
- [ ] Overlapping runs cannot collect the same tracker concurrently. Interrupted runs can recover without leaving the tracker permanently stuck.
- [ ] Persist last attempt, last success, latest error/outcome, and next run. Retry transient failures within configured caps; quota failures wait for quota availability.
- [ ] Schedule daily Slack findings and weekly digests independently from collection, using the agreed time zone and reporting windows.
- [ ] Verify execution fits current free function limits. Planning baseline: 150 seconds elapsed time and 2 seconds of CPU time per request.
- [ ] Verify due/not-due selection, overlap, interruption, a failed source, exhausted quota, and an actual scheduled invocation. Confirm existing records survive failures.

Verification: Pending.
Blockers: None recorded.

## SCOUT-08 — Add the remaining Bluesky feeds

Status: todo
Depends on: SCOUT-04, SCOUT-07

Outcome: DOSI, Global Fishing Watch, and IDDRI collect through the established Bluesky pattern.

Acceptance criteria:

- [ ] Use the exact accounts in the tracker inventory and verify bounded live collection for all three feeds.
- [ ] Each feed retains its own cadence, collection history, and status. One feed's failure does not stop the others.
- [ ] Cross-posted events merge into one record while preserving all supporting sources. Different events with similar titles remain separate.
- [ ] Verify pagination or collection-window limits and report partial coverage when a run cannot catch up within its budget.
- [ ] Verify repeat collection and one cross-source duplicate using recorded examples.

Verification: Pending.
Blockers: None recorded.

## SCOUT-09 — Collect authoritative treaty-status changes

Status: todo
Depends on: SCOUT-03, SCOUT-04, SCOUT-07

Outcome: Changes in the UN Treaty Collection become source-backed country/action/date records.

Acceptance criteria:

- [ ] Collect the official participant record identified in the tracker inventory and preserve the distinction between ratification, accession, acceptance, approval, and other reported actions.
- [ ] Establish an initial baseline without announcing all historical entries as new. Later verified additions or corrections produce appropriate changes.
- [ ] Store country, action, recorded date, official source, and collection time. Treat NGO/social reports as leads until verified against the official source.
- [ ] A failed or incomplete fetch cannot imply a reversal or deletion of a country's status.
- [ ] Verify initial baseline, a new action, a correction, repeated collection, and an incomplete source response.

Verification: Pending.
Blockers: None recorded.

## SCOUT-10 — Add website and document collectors

Status: todo
Depends on: SCOUT-03, SCOUT-04, SCOUT-07

Outcome: The remaining website trackers have verified collection methods or explicitly documented coverage limitations.

Before implementation, split this task into child tasks here using stable IDs such as `SCOUT-10.01`. Use one task per source or genuinely shared collection pattern, with the source URL, expected record types, sample input, and acceptance checks. Start with official UN/DOALOS announcements and meeting/side-event pages, then the remaining organizer websites and registries from the imported inventory.

Acceptance criteria for every child task:

- [ ] Prefer an available feed/API, then direct webpage collection. Follow relevant event pages and linked programmes/PDFs within bounded depth and page limits.
- [ ] Extract relevant BBNJ events and announcements with source-backed details; preserve unknown values and deduplicate against existing records.
- [ ] Reuse established change detection, model budgets, status reporting, and delivery behavior.
- [ ] Verify initial collection, repeat collection, a material update, and a failed or changed source format.
- [ ] Measure runtime against free-tier limits. If a source requires unsupported browser/PDF processing, leave it visibly limited with an explicit local/manual collection path or blocker; do not silently activate paid infrastructure.

Completion criteria:

- [ ] Every website tracker has a completed child task or a recorded limitation identifying what coverage is missing. Unsupported collectors are not labeled operational.
- [ ] Present remaining coverage gaps at the final POC review. Any gap in required coverage needs an explicit user decision before SCOUT-14 can pass.

Verification: Pending.
Blockers: None recorded; source-specific methods remain to be validated.

## SCOUT-11 — Add discovery search

Status: todo
Depends on: SCOUT-03, SCOUT-04, SCOUT-07

Outcome: A scheduled discovery tracker finds relevant items outside the known source list without exceeding the search budget.

Acceptance criteria:

- [ ] Use Tavily Free queries for BBNJ/High Seas Treaty events, webinars, workshops, conferences, side events, and announcements. Start with 10 searches per weekly run. Do not substitute Gemini's Google Search grounding: its terms restrict collecting returned links for indexing or crawling (see provider references in README.md).
- [ ] Apply the confirmed credit budget, including retries and optional extraction. Planning baseline: basic search costs 1 credit and advanced search costs 2.
- [ ] Follow results to supporting source pages before creating records. Search snippets alone do not establish event facts or official treaty status.
- [ ] Merge findings with existing records, retain evidence, and avoid processing unchanged content again.
- [ ] Surface potential new publishers for review; do not automatically activate new trackers or increase recurring work.
- [ ] Verify new findings, existing-record matches, irrelevant results, unavailable source pages, and quota exhaustion.

Verification: Pending.
Blockers: None recorded.

## SCOUT-12 — Answer questions in Slack

Status: todo
Depends on: SCOUT-05, SCOUT-06, SCOUT-07

Outcome: Scout answers questions using collected records and makes coverage limitations clear.

Acceptance criteria:

- [ ] Receive authenticated Slack mentions, acknowledge promptly, and handle retries without repeated replies.
- [ ] Answer “Does HSA have any webinars coming soon?” with matching upcoming events, source links, and applicable calendar actions. Define “coming soon” using an explicit date window in the response.
- [ ] Support basic organization, record-type, and date questions through bounded database queries. Use the agreed model only where needed and within its budget.
- [ ] Distinguish no matching stored records from stale, failed, or incomplete source coverage. Do not claim comprehensive knowledge of all events.
- [ ] Keep responses grounded in stored facts. Treat source text and Slack questions as data, not authority to change app settings or run arbitrary database operations.
- [ ] Verify matching results, no matches, ambiguous questions, stale coverage, duplicate Slack events, and model quota exhaustion. On quota failure, provide a clear status and a link to the web list.

Verification: Pending.
Blockers: None recorded.

## SCOUT-13 — Manage trackers in the app

Status: todo
Depends on: SCOUT-03, SCOUT-05, SCOUT-07

Outcome: An authorized user can maintain tracker configuration and inspect collection health in the app.

Acceptance criteria:

- [ ] Add and edit trackers using supported methods, including source URL/account, channel, coverage, and cadence. Do not imply that adding an arbitrary URL creates a working scraper.
- [ ] Pause/resume a tracker and request a manual run through the same collection path and usage caps as scheduled runs.
- [ ] Show last attempt, last successful collection, latest outcome/error, next run, and recent collection history. Distinguish unsupported, partial, and quota-limited coverage.
- [ ] App edits survive any repeated seed import. Manual runs do not bypass concurrency protections or reactivate paused schedules.
- [ ] Enforce administrator access and verify an unauthorized mutation is rejected.

Verification: Pending.
Blockers: None recorded.

## SCOUT-14 — Verify the complete POC

Status: todo
Depends on: SCOUT-01, SCOUT-02, SCOUT-03, SCOUT-04, SCOUT-05, SCOUT-06, SCOUT-07, SCOUT-08, SCOUT-09, SCOUT-10, SCOUT-11, SCOUT-12, SCOUT-13

Outcome: A deployed POC demonstrates the complete workflow and its actual coverage and cost limits.

Acceptance criteria:

- [ ] Discover a webinar, store it once, display it in the web list, announce it in Slack, answer a question about it, and add it to a calendar.
- [ ] Reschedule and cancel the example event; verify the existing record changes, material updates are delivered once, and upcoming-event results remain correct.
- [ ] Verify an official announcement and an authoritative treaty-status change complete their applicable storage and delivery paths.
- [ ] Verify an actual scheduled collection and digest, plus repeat/retry behavior without duplicate records or completed notifications.
- [ ] Exercise collection failure, incomplete source data, quota exhaustion, and recovery. Existing records remain available and coverage limitations are visible.
- [ ] Review the complete tracker inventory. Record live, partial, manual, and blocked coverage and obtain a decision on unresolved required coverage before marking the POC complete.
- [ ] Confirm observed provider usage stays within available free quotas, paid upgrades/top-ups remain off, and no service fee has been incurred for the POC.
- [ ] Record the deployed URL, supported behavior, remaining limitations, required account ownership, and minimal run/deploy/recovery instructions without exposing secrets.

Verification: Pending.
Blockers: None recorded.
