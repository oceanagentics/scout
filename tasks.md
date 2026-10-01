# Scout build tasks

Build a proof of concept that collects BBNJ events, announcements, and treaty-status changes; stores source-backed records; and makes them available through Slack and a filterable web list. Target recurring service fees: **$0/month**.

## Sources and scope

- [BBNJ Scout Letter](https://docs.google.com/document/d/13HIEN45IEKQN-i29pQuoRD-eeFOl-t70a1_2TBpV7zI/edit): product brief, Features, and Services.
- [BBNJ Scout Trackers](https://docs.google.com/spreadsheets/d/1VtpaC83ybg7zet7VvNXmvctN9s5WJK_NTlJ9wx5NIbM/edit): initial source inventory, collection methods, and cadences; currently 22 trackers. Read the live sheet before importing.
- This file is the authoritative implementation checklist. The letter remains the product brief. Resolve material conflicts with the user before implementing the affected behavior.
- Confirmed POC scope: events, announcements, treaty-status changes, daily Slack findings, a weekly Slack digest, Slack questions, a filterable web list, a tracker status list, tracker management, and add-to-calendar actions.
- Confirmed deferrals: email digests and a separate calendar view, accepted with milestone 1 authorization.
- Deferred: embeddings and semantic search. Use structured queries for the POC.

## Working rules

- Implement only when the user requests implementation. Creating this checklist does not start the build.
- The user authorized milestone 1 (SCOUT-01–06) with a manager/worker workflow. The local manager chat `01a0f59f-1e17-7f70-beb9-6dc786ecd7cb` assigns and reviews each task; one worker is the sole repository writer. Wait for the next assignment after each report and stop for milestone review after SCOUT-06; do not begin SCOUT-07 or later.
- After two unsuccessful approaches or roughly 20 minutes without new evidence, reassess the specific failure and move to independent work; do not automatically hand off or repeat an unchanged failure. Check prior chats/documentation and try materially different supported paths. Respect actual authorization denials and sandbox boundaries. Request user action only for an essential missing capability/decision after authorized alternatives and useful independent work are exhausted. Keep unverified criteria open. Keep the collector sequence; add no upfront feasibility or backup work.
- Record material changes and deviations under the affected task: date, change, reason, verification/gap, and deferred work's revisit condition. Manager-approved independent work may proceed before a dependency is fully complete; dependent deployment/integration, source evidence, correctness, and the $0 constraint remain required.
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

Status: blocked
Depends on: none

Outcome: The agent has a confirmed scope, usable service access, and explicit free usage budgets.

Acceptance criteria:

- [ ] Confirm the proposed POC scope and deferrals, intended app audience, administrators, Slack workspace/channel, and notification schedule/time zone.
- [ ] Confirm Firebase Hosting access through OA's existing Google account, a Spark project with a separate Scout site, Supabase Free project `chm`, Tavily Free, and installation access for a custom Slack app in the existing workspace. Cloudflare signup is no longer needed. Record missing access without storing secrets here.
- [ ] Confirm the shared `chm` project identity, available free capacity, and existing services before provisioning. Use the default `postgres` database with one schema per service (`scout`; `otherservice` is a future-service example). Record Data API on, automatic table exposure off, and RLS on; budget Scout against remaining project-wide quotas.
- [ ] Use OA's Google Workspace account for AI Studio; obtain administrator enablement if needed and create a Scout Gemini API key in an OA-controlled project. Verify a supported free model and its actual quota with a bounded request; Workspace's included Gemini features do not supply API quota.
- [ ] Verify current provider allowances and account eligibility. Planning baseline: Firebase Hosting 10 GB storage and 10 GB/month transfer; Supabase 500 MB database, 1 GB storage, 5 GB egress, and 500,000 function invocations/month; Tavily 1,000 credits/month without a card; model limits are account-specific. Do not count nonprofit Workspace benefits or trial credits as recurring backend/search capacity.
- [ ] Record model/search caps and retry limits within the available free quotas. Verify that paid upgrades and automatic top-ups are off.
- [x] Record decisions and provider references in this task. Identify any blockers for downstream tasks.

Verification (2026-10-01): Bounded read-only account checks and one model request; no provisioning, deployment, Slack posts, or shared-project changes. Incomplete combined criteria above remain unchecked.

- **Scope and sources:** Re-read the live Letter/Features/Services and tracker sheet through Google Drive. The sheet has 22 populated trackers: 17 websites, four daily Bluesky `getAuthorFeed` accounts, and one Bluesky `searchPosts` discovery tracker. Tavily discovery is separate, later work. User authorization confirms the POC scope and email/calendar-view/embedding deferrals, the SCOUT-05 all-tracker list, and preservation of authoritative organizer corrections against older reports. Milestone 1 ends with manual Slack findings/digest delivery; notification scheduling remains SCOUT-07. Audience, administrator identities, exact delivery times, digest weekday, and time zone remain unspecified. The Slack channel was confirmed in the earlier setup chat, as recorded below.
- **Firebase:** Direct API verification with the saved Firebase login confirms OA account `danny@oceanagentics.com`, project `ryustatic` / `622994656148`, and `billingEnabled: false` (Spark). IAM checks return Hosting `sites.create/get/list/update`, `firebase.projects.get`, `resourcemanager.projects.get`, and `serviceusage.services.use`; no permission change is needed. Selected Scout deployment: target `scout`, separate site `bbnj-scout` in `ryustatic`. A `validateOnly=true` create request returned HTTP 200 with that site name and `https://bbnj-scout.web.app`; this validates availability/permission but does not reserve or create the site. Only Ryu's site was provisioned at that checkpoint; SCOUT-02 subsequently created and deployed Scout's site below. Latest complete Monitoring results show 11,045,338 bytes stored (2026-09-30 23:09 UTC) and 55,432,079 monthly bytes transferred (2026-10-01 03:15 UTC), against 10,737,418,240-byte limits. These are sampled values; recheck before deployment. Use separate Scout configuration and `firebase deploy --project ryustatic --only hosting:scout` in SCOUT-02, preserving Ryu's site/configuration. Existing Firebase credentials can be refreshed in memory without Google Cloud CLI cache writes. The earlier browser permission notice did not reflect the successful direct API checks. [Multiple sites and deployment targets](https://firebase.google.com/docs/hosting/multisites); [Hosting allowances](https://firebase.google.com/docs/hosting/usage-quotas-pricing).
- **Supabase:** User-provided project identity is `chm`, ref `vhlfumeyhkeospnemukq`, organization `ktdckerhelrjswqpwoas`. Earlier saved CLI authentication succeeded: `SUPABASE_TELEMETRY_DISABLED=1 supabase functions list --project-ref vhlfumeyhkeospnemukq --output json` succeeded in the setup chat and again here, returning no deployed functions. The original failure was the CLI's optional local telemetry write, not remote authentication. Listing all projects separately returned missing `projects_read`; that did not invalidate the earlier project-specific success. Intermediate SCOUT-02 noninteractive checks returned `Access token not provided`. The subsequently supplied personal token now passes prompt-free project reads and read-only SQL through the Management API (see the SCOUT-02 follow-up); organization plan access remains denied. Remote plan, existing database services/migrations, usage, Data API, automatic exposure, and RLS still need targeted inspection. Required target remains `postgres` / `scout`, Data API on, automatic table exposure off, explicit grants/RLS, preserved existing services. [Published Free allowances](https://supabase.com/pricing): 500 MB database, 1 GB storage, 5 GB egress, 500,000 function invocations/month; [worker limits](https://supabase.com/docs/guides/functions/limits): 150 seconds elapsed and two seconds CPU/request. Allocate Scout's share after inspecting existing usage.
- **Gemini:** OA account can access AI Studio project `bbnj-chm` (BBNJ CHM), showing Free tier / Set up billing. The existing local key matches that project's displayed key; no duplicate key was created. The user supplied this key for Scout; the manager approved reuse on 2026-10-01. Its generic name and possible shared use are not blockers; quotas remain project-wide. `gemini-3.5-flash-lite` model metadata returned HTTP 200. AI Studio's project quota table showed 15 RPM, 250,000 input TPM, and 500 RPD, with zero displayed peak usage before the check. One generation request returned HTTP 200 / STOP, consuming 117 input + 1 output tokens; cap was 64 output tokens, no tools, no retries. Input was only the text of one public HSA post and a Scout relevance question. Public feed check used `getAuthorFeed?actor=highseasalliance.bsky.social&limit=1`, HTTP 200, with an identifiable User-Agent; source URI `at://did:plc:mj2ygegzodk3fdjdgihjko23/app.bsky.feed.post/3mwq6buc3mw2h`. This verifies access, not collector correctness. [Pricing](https://ai.google.dev/gemini-api/docs/pricing) confirms free text input/output; [limits](https://ai.google.dev/gemini-api/docs/rate-limits) are shared by project and RPD resets at midnight Pacific.
- **Tavily:** Existing key's authenticated `GET /usage` returned HTTP 200: Researcher plan, 0/1,000 monthly credits, zero pay-as-you-go usage. Key limit and pay-as-you-go limit were `null`; those values do not establish that paid use/top-ups are disabled. Billing dashboard requires sign-in. No paid search or discovery request was made. [Published allowance](https://docs.tavily.com/documentation/api-credits): 1,000 recurring credits/month without a card, one per basic search or two per advanced search. This service does not block HSA milestone-1 collection.
- **Slack:** The earlier setup chat contains the user's confirmed Scout app and webhook destination: [#scout](https://oceanagentics.slack.com/archives/C0C5PE21KN1), channel `C0C5PE21KN1`, exclusively for reading/writing. Connector workspace `TFZ8FRLBV` is Ocean Agentics, and the local webhook's workspace segment matches. Webhook and signing secret are present. Preserve the one-channel design: post through its webhook and reject other workspace/channel IDs before processing mentions or sending content to Gemini. No general history access or broader posting token is required by this design. Installation scopes have not been independently read; mention endpoint activation remains later backend work. No webhook test was sent in SCOUT-01. The earlier public search missed the already confirmed destination; `#research-team` is not a Scout target. [Incoming webhook behavior](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/); [Slack Free app allowance](https://slack.com/help/articles/115002422943-Usage-limits-for-free-workspaces).

Manager-approved Gemini operating caps (2026-10-01; enforce when model integration is implemented): Gemini maximum two requests/minute, ten attempts/run, twenty attempts/day, 8,000 input tokens and 1,024 output tokens/request, only for new/changed public material. Permit at most one transient retry, included in every cap; no quota retries before allowance returns. Tavily stays at zero calls in milestone 1; the proposed SCOUT-11 budget is at most ten basic-search credits/run and fifty/month, including one possible transient retry per request, with no advanced search or paid fallback. Confirm shared quota headroom and paid-use controls before enabling either production path; the single Gemini verification request above used stricter bounds.

Blockers / bundled missing inputs:

1. **Before remote SCOUT-02 mutations:** Unattended Supabase access is restored and project/database inspection succeeded. Organization entitlements and project add-on reads return 403, so actual plan/paid-use verification remains unavailable. Do not request another token/login or broaden permissions. Resolve that narrow verification gap, then apply and verify migrations/exposure and hosted access. Firebase is deployed; see SCOUT-02.
2. **Before audience-dependent publication:** Reader/admin identities remain unspecified. Manager-approved SCOUT-02 default: deny access until explicit Scout membership is assigned; develop and test policies with local fixtures. Do not infer administrators or public access from OA ownership.
3. **SCOUT-06 delivery:** Use the confirmed Scout webhook and allowlisted channel above, with a bounded live delivery check as part of that task. Verify signing and mention subscriptions in SCOUT-12 while preserving the one-channel restriction. Before SCOUT-07, choose daily delivery time, digest weekday/time, and IANA time zone; the computer's time zone is not a confirmed product setting.
4. **Approved deferrals (2026-10-01):** Tavily billing verification moves to SCOUT-11 before its first discovery request; use zero Tavily calls in milestone 1. Notification timing/time zone moves to SCOUT-07 before scheduling. Neither blocks SCOUT-02. Existing Gemini key reuse and the conservative caps above are approved; no further user approval is needed. Supabase plan/capacity still require inspection.

Manager decision (2026-10-01): proceed with SCOUT-02, including remote steps once their prerequisites are verified. Keep unfinished SCOUT-01 criteria open. Firebase site creation and scoped deployment are authorized after the app is ready; leave Ryu untouched. SCOUT-03 waits for manager review.

## SCOUT-02 — Create the app and database foundation

Status: blocked
Depends on: SCOUT-01

Outcome: A minimal app runs locally and on Firebase Hosting, with Supabase project `chm` and versioned migrations for its `scout` schema.

Acceptance criteria:

- [x] Select a minimal stack with a static frontend deployable to Firebase Hosting on Spark and a Supabase backend; record local, migration, and deployment commands. Reuse the Ryu hosting approach for a separate Scout site without changing Ryu's deployment. Keep workers and schedules on Supabase; Firebase Cloud Functions/Blaze and a Sheets/Apps Script backend redesign are outside this POC plan.
- [ ] A deployed app can read a harmless sample record from the database. Verify local startup and the hosted URL.
- [ ] Create the `scout` schema in `chm`'s default `postgres` database. Put Scout's trackers, collection history, events, announcements, treaty-status changes, source references, and notification delivery state there (for example, `scout.events`). Use the smallest schema that supports these responsibilities.
- [ ] Configure clients and migrations to target `scout` explicitly. Add `scout` to the Data API's exposed schemas while preserving existing services; grant only required schema/table/function privileges and enable RLS with policies in the same migrations. Do not grant automatic access to all future tables.
- [x] Events support organization, title, description, location/URL, source-backed dates/time zones, registration link, status, and last update. Announcements support summary, publication date, sources, and last update. Treaty changes support country, action, and recorded date.
- [x] Keep source publication dates, event dates, collection times, and record update times distinct. Support multiple source references for one record.
- [ ] Enforce Scout-specific access within the project's shared Auth setup. Verify unauthorized writes and access to private records across service boundaries fail; authentication in another service does not confer Scout administrator access. Keep project-wide service-role credentials backend-only and absent from browser assets and logs.
- [ ] Review existing migration history before applying Scout migrations. Verify they succeed in an empty development database and preserve other services' schema objects, data, and permissions in a shared development database. Never reset the shared remote project as a setup step.

Verification and deviations (2026-10-01):

- **Implemented:** Vite + vanilla JavaScript with the Supabase client explicitly targeting `scout`; in-memory sessions, no signup or automatic membership, and a closed setup state without public configuration. Added minimal ignores, public-only environment example, scoped Firebase target, and development/migration/deployment instructions in README. Secrets stay out of source and build assets. One typed `records` table covers the three record kinds to keep the schema small; six tables include memberships, trackers, collection runs, records, sources, and deliveries. No tracker import or collector work started.
- **Authorization:** The migration enables RLS and revokes/regrants only its fixed table set in the same transaction. Anonymous access is denied; authenticated users need explicit Scout membership. Readers can read evidence; admins can edit tracker configuration but cannot forge collection-success fields, grant membership, or write evidence/delivery state. Backend service-role access remains project-wide and privileged. The migration rejects a pre-existing `scout` schema and unsafe global client table defaults rather than changing another service's privileges.
- **Local checks:** `npm test` passes three PostgreSQL suites: empty database, shared-service fixture, and unsafe-global-default rejection. Coverage includes a harmless sample, multiple sources, null/invalid dates, unauthorized reads/writes, admin limitations, backend writes, private future tables, and unchanged other-service data/ownership/grants/policies. `npm run build` passes both without configuration and with a local fixture public key. Browser checks verify local startup, the closed setup state, and configured sign-in failure without granting access. No hosted Auth/PostgREST success is claimed.
- **Local test deviation:** Native PostgreSQL 16 initialization failed twice (including approved elevated execution) at shared-memory creation; Docker is not running. Use the documented PGlite in-memory PostgreSQL runtime as a dev-only dependency for repeatable SQL/RLS tests, with minimal `auth.users`/`auth.uid()` fixtures. This verifies database behavior, not the full Supabase platform. Revisit hosted integration after remote authentication/state checks.
- **Hosting complete:** Created separate site `bbnj-scout` under Spark project `ryustatic`, mapped target `scout`, and deployed [the static shell](https://bbnj-scout.web.app) through the documented Hosting REST API using the existing saved Firebase login refreshed in memory. Release `sites/bbnj-scout/releases/1790829822838000`, version `b04336502bfe48fb`; three compressed files total 1,984 bytes. Predeploy checks confirmed billing disabled and latest sampled usage of 11,045,338 stored bytes / 55,432,079 monthly transfer bytes. Hosted HTML/CSS/JS return HTTP 200, exactly match `dist`, and carry the configured CSP/security headers. Browser rendering verified. Ryu release `sites/ryustatic/releases/1790266049490000` is unchanged.
- **Supabase evidence:** The previously successful functions check remains valid historical evidence. The linked-query CLI currently fails an IPv6 connection preflight even after its supported relink reports success. Official CLI source confirms that this preflight runs before its Management API query. Source review also established the documented native credential service/account names; native retrieval did not yield a token. The manager subsequently verified that bounded functions reads now return `Access token not provided` both normally and with approved elevated execution. No more interactive credential prompts or Keychain permission changes will be attempted while the user is away.
- **Exact unattended prerequisite:** Make an existing authorized Supabase token available noninteractively through the documented CLI credential store or `SUPABASE_ACCESS_TOKEN`, explicitly loaded into the CLI/API process through an approved secret loader. An entry in `.env.local` alone is insufficient. Do not broaden token permissions or expose its value. First verify a bounded project read without stdin/prompts, then inspect the actual database/migration history and shared plan/capacity. If the IPv6 preflight persists, use the documented Management API with that same authorized access. No remote SQL, migration, Data API change, membership assignment, or public-key retrieval was completed.
- **Remaining boundary:** SCOUT-02 is partial, not done. The local migration and policy tests are ready; remote schema creation, preserving/appending Data API exposure, remote permission checks, and the hosted sample read remain unchecked. The deployed shell makes no database requests until configured. Reader/admin identities remain denied by default pending an explicit decision. Revisit these checks when unattended authentication is available; SCOUT-03 still waits for manager review. Previously approved Tavily/scheduling deferrals remain unchanged.

Follow-up and manager review (2026-10-01):

- Manager accepted commit `ad987f7` as a partial SCOUT-02 delivery, including the documented PGlite and Firebase REST deviations; no local corrective change required. Remote criteria remain open. Independent local SCOUT-03 implementation is approved despite the dependency; stop again for review before SCOUT-04.
- **Authentication resolved:** The user added `SUPABASE_ACCESS_TOKEN` to ignored `.env.local`. Explicitly loading it into the authorized Python HTTPS process succeeded without prompts: functions/project/migration/PostgREST reads returned HTTP 200 and read-only SQL returned HTTP 201. No token value was displayed, staged, or sent to the browser. The manager's contemporaneous DNS failures occurred in its execution context; worker-side successful responses verify the token and this supported API path. No repeated login or Keychain prompt is needed.
- **Remote inspection:** `chm` is `ACTIVE_HEALTHY`, PostgreSQL 17.11, database `postgres`, size 10,786,483 bytes. Migration history is empty; the catalog shows platform schemas only, no application tables, and no existing `scout` schema. Data API exposes `public,graphql_public`; preserve both when eventually appending `scout`. Default table grants are scoped to platform schemas, with no global client table defaults. The existing `ensure_rls` event trigger is present; Scout's migration still explicitly enables its own RLS.
- **Narrow remaining prerequisite:** Organization-entitlements read returned HTTP 403 (documented `organization_admin_read`); the separate project add-ons read also returned HTTP 403 with missing `infra_add_ons_read`. These denials limit plan/paid-add-on verification, not database authentication. Do not broaden token permissions. Actual Free-plan/paid-use confirmation remains open before remote mutation. No SQL write, migration, exposure change, public-key retrieval, or membership assignment occurred. Revisit remote integration when that verification is available; identities and a hosted sample read also remain open.

## SCOUT-03 — Import the tracker sheet

Status: blocked
Depends on: SCOUT-02

Outcome: The current sheet seeds the app's tracker inventory without creating an ongoing synchronization dependency.

Acceptance criteria:

- [ ] Read the live sheet and import every populated tracker row, preserving source identity, URL/account, coverage, channel, collection method, and cadence.
- [x] Reconcile the imported inventory against the sheet. Report invalid, incomplete, or unsupported entries instead of silently dropping them.
- [x] Repeating the import creates no duplicates and does not overwrite app edits. Paused trackers remain paused.
- [x] Each tracker can persist enabled state, last attempt, last successful collection, latest outcome/error, and next scheduled run. An imported tracker is initially uncollected, not successful.
- [x] Verify one website, one Bluesky feed, and the discovery tracker retain their distinct methods and cadences.

Verification and deviations (2026-10-01):

- **Manager-approved dependency deferral:** Implemented and verified the local import after the partial SCOUT-02 review; remote import waits for the foundation's prerequisites. This is partial delivery, not a claim that production trackers exist.
- **Live source and reconciliation:** Re-read the live tracker sheet (22 rows, source IDs 0–21, last modified 2026-09-30 23:20:03 UTC). Compared every local imported row against all six sheet fields: source name, coverage, URL/account, channel, method, and complete cadence text. All match. Inventory is 17 websites, four daily `getAuthorFeed` accounts, and one weekly `searchPosts` discovery source. No rows were dropped and no Tavily source was invented.
- **Minimal implementation:** One additive migration supplies backend-managed unique `seed_key`, `cadence_note`, `configuration_note`, and nullable URL with an enabled-requires-URL constraint. One SQL seed is the fixed sheet snapshot; `ON CONFLICT (seed_key) DO NOTHING` preserves existing app state. Keys retain the snapshot's source IDs independently of edited URL/method. This is a one-time import, not sheet synchronization.
- **Incomplete/unsupported configuration:** Row 8, “Conference-specific official programmes,” contains “Set per conference” instead of a URL. Retained that exact value in `configuration_note`, stored a null URL, and paused the row. It cannot be enabled until configured. The other 21 URLs are syntactically valid HTTPS entries; collection support has not been tested in this task and no success is inferred. Original meeting-period cadence instructions remain verbatim in five rows; automation of overrides stays in SCOUT-07.
- **Verification:** `npm test` passes all four suites. The new import suite checks the exact 22 identities, method/cadence distinctions, keyword/override retention, initial null attempt/success/outcome/error/next-run state, the incomplete row, and repeat imports after changing source name, URL, method, coverage, cadence, paused state, and collection history. Two repeated imports leave every row and timestamp unchanged. Admins cannot edit seed identity or enable a URL-less tracker. Existing shared-service data and permissions remain intact; the original isolation tests also pass after the additive migration.
- **Remaining impact/revisit condition:** The seed is ready and demonstrated in local PostgreSQL tests, but not applied to remote `chm`. Apply it only after remote SCOUT-02 prerequisites and foundation verification pass, then reconcile the remote inventory. The first combined criterion stays unchecked for this reason. README records the import command, API alternative, and limitations. SCOUT-04 waits for manager review.


## SCOUT-04 — Collect HSA's Bluesky feed end to end

Status: blocked
Depends on: SCOUT-03

Outcome: A manual collection run produces usable events and announcements from High Seas Alliance's public feed.

Acceptance criteria:

- [x] Fetch HSA's configured public feed using the sheet's Bluesky `getAuthorFeed` method, identify relevant BBNJ items, and follow relevant organizer/registration links within bounded collection limits.
- [x] Store structured records with supporting source links, organization, available dates/time zones, summary, and collection timestamps. Preserve unknown values.
- [x] Use direct structured extraction where sufficient and the agreed free model only where needed. Validate model output before storing it and apply the configured usage caps.
- [x] Unchanged content does not trigger repeat model work. Repeated collection does not create duplicate records.
- [x] A changed event date or cancellation updates the existing event and records a material change; cosmetic source edits do not become new announcements. Prefer the organizer's authoritative correction over stale third-party reports, retain supporting evidence, and verify that collecting an older repost later cannot undo a reschedule or cancellation.
- [x] Persist success, no-change, partial, failure, and quota outcomes accurately. A failed fetch leaves previous records intact.
- [x] Verify a real source example and repeatable cases for initial collection, repeat collection, changed date, missing date, irrelevant content, and failed fetch.

Verification and deviations (2026-10-01):

- **Manager-approved local delivery:** After accepting SCOUT-03 commit `13af6ea`, the manager assigned independent manual HSA collection against the reviewed local schema/seed. Re-read the live brief. `npm run collect:hsa` uses persistent PGlite at `.cache/hsa-database`, applies versioned local migrations/seed, and prevents overlapping local processes with a lock. It cannot connect to hosted Supabase. Remote integration remains deferred; this is partial SCOUT-04 delivery.
- **Bounded collection:** HSA `getAuthorFeed` only, at most two pages of 25 posts, two links per event post, six follow-up pages, three redirects per request, and 24 total requests. Each response is capped at 512 KiB and 12 seconds; a 120-second budget is checked before another request. Every request uses `BBNJ-Scout-Bot/1.0 (+https://bbnj-scout.web.app)`. HTTPS/DNS checks reject private destinations. Zero model, Tavily, Slack, or paid-service calls; no retries, scheduling, other collectors, or SCOUT-05 work.
- **Extraction decision and persistent evidence:** Use verbatim post text, unambiguous JSON-LD Event data, and the observed public Zoom registration fields. No model is needed for this supported path, so model accounting remains zero; any future fallback must implement the already approved persistent caps before its first call. Store source versions, parsed facts, material changes, and outcomes in `scout`. Unchanged posts reuse extraction; event pages are checked for corrections and fingerprinted by extracted facts to ignore volatile scripts. Exact event/registration URLs join related posts. The review correction below replaces the initial page-over-post ordering. Cosmetic edits leave material timestamps unchanged.
- **Database and repeatable verification:** The additive migration brings Scout to eight RLS-enabled tables. Raw source versions are backend-only; members may read record changes. All nine tests pass, including empty/shared database isolation, preserved tracker edits, initial/repeat/no-change runs, reschedule/cancellation, older reposts, an organizer returning to a previously observed date, missing/date-only/timed dates, irrelevant content, fetch/page failures, page bounds, quota responses, and the recorded HSA/Zoom fixture. Frontend build and whitespace checks pass.
- **Initial live evidence:** `npm run collect:hsa -- --since=2026-09-01` stored 12 local records: 11 announcements and one webinar. Initial repeat runs examined 13 posts and one page using three requests, with zero new records, zero material changes, and zero model calls. They reported partial because the first parser did not combine the registration date with the HSA post's explicit EDT time. That specific gap is resolved by the review correction below.
- **Remaining coverage/revisit conditions:** Parsing covers explicit ISO dates, one JSON-LD event, observed Zoom fields, and the narrow observed September/EDT HSA format when matching components agree. Quoted posts, multiple-event listings, unsupported formats, other natural-language date formats, and semantic cross-URL deduplication remain bounded coverage limitations. Revisit these gaps before claiming complete source coverage; preserve unknown values until supported by validated extraction.
- **Remote boundary and review:** Firebase target/permissions are resolved and the shell is already deployed. Supabase authentication and read-only SQL pass; actual Free-plan/paid-add-on verification remains unavailable because the relevant reads return 403. No remote schema, seed, collector, exposure, or membership mutation occurred. Complete the remote SCOUT-02/03 checks before hosted collection. Stop for manager review before SCOUT-05.

Manager-review corrections (2026-10-01), following `060b09c`:

- **New organizer corrections:** The manager reproduced a newer HSA cancellation being rejected because posts ranked below pages. The correction criterion was reopened until regressions passed. HSA posts now have authoritative rank, ordered by publication time. Each source persists its evidence time separately from collection time: a first page snapshot has unknown publication chronology and cannot reverse an explicit correction; only changed page facts receive a new observation time. Unchanged/cosmetic fetches retain the prior evidence time. The additive migration repairs v1's fetch-time ordering from preserved HSA publication evidence without changing record facts or material timestamps.
- **Compatible component reconciliation:** Added the real September 15 HSA post `3mvkyjyep6m24` to recorded fixtures. Its `29 Sept, 7:30 AM EDT` agrees with the same Zoom URL's `Sep 29, 2026 07:30 AM`. This narrowly yields `2026-09-29T11:30:00Z`, offset `-04:00`, without inferring a zone from the page. Records and material-change evidence retain source-version IDs for calendar date, local time, and explicit EDT/offset. Conflicting wall times are reported with both values and leave the timestamp unknown. Compatible later date-only observations preserve the supported instant.
- **Verification and current live result:** All 11 tests pass, including unavailable/unchanged/cosmetic page cases after an HSA cancellation, an older third-party repost, later organizer page/post changes, component provenance, repeat runs, retained time evidence when the earlier post leaves the fetched feed, and conflicting 08:30 page / 07:30 EDT post times. Empty/shared database isolation still passes with the new migration. Live run `13080d92-bb33-47a6-9db5-2838a86a4f2c` updated exactly one existing event and returned success; separate repeat `7585cd99-f5ec-468f-a93d-38c5419f8f07` returned no-change with zero new records/changes. Both examined 13 posts and one page using three requests, no warnings, and zero models. All 12 records remain; the stored event has the supported instant/offset and the tracker's last-success advances. Remote/audience deferrals remain unchanged. Stop for manager review before SCOUT-05.

## SCOUT-05 — Build record and tracker lists and calendar actions

Status: blocked
Depends on: SCOUT-04

Outcome: A user can find collected records, inspect every tracker's status, and add a supported event to a calendar.

Acceptance criteria:

- [x] Show events, announcements, and treaty changes in a searchable list with type, organization, and applicable date filters.
- [x] Show source links, relevant dates, record updates, and collection freshness; provide clear loading, empty, and error states.
- [x] Show all trackers in a frontend list with source, collection method, cadence, current status, and last successful collection time, including paused and unsupported trackers. Show "Never" for uncollected trackers and indicate overdue collection from the next scheduled run even if the backend has stopped updating status.
- [x] Verify that a successful no-change run advances the displayed last-success time, a failed or partial run preserves it and shows its outcome, and an uncollected tracker shows "Never".
- [x] Show rescheduled and cancelled events accurately. Do not present past events as upcoming.
- [x] Provide calendar links or downloads for events with sufficient date information. Preserve time zones and date-only events; do not invent a start time.
- [x] Verify a timed event, an event across a time-zone boundary, a date-only event, and an event with insufficient date information.

Assignment (2026-10-01): manager accepted SCOUT-04 correction commit `89c762e` after reviewing the 11 passing tests and live success/no-change evidence. Independent frontend work is approved using the existing vanilla Vite app and local evidence, while remote plan/paid-use verification and explicit member identities remain open. Keep the production membership gate and unconfigured setup state closed. Verify all-record and all-tracker views, date/status/filter behavior, source-safe rendering, and calendar downloads with a clearly marked local browser fixture; exclude verification data from production assets. A scoped Hosting shell update is authorized after verification. No alternate production backend, remote database writes, scheduling, or SCOUT-06 work. Stop for manager review after a focused commit.

Verification and decisions (2026-10-01):

- **Local frontend delivered:** Retained vanilla Vite and the explicit `scout` client. Only verified members can mount the dashboard; production without public configuration remains closed. Paginated read-only queries replace the old 50-record cap and load all trackers. Findings provide text/type/organization/date/timing filters, source references, separate publication/collection/update timestamps, and source collection outcomes. Date filters use source-zone event dates, publication dates or treaty action dates, including overlapping multi-day events. Source text uses textContent; links accept only HTTP(S) without credentials.
- **Tracker and timing behavior:** The actual 22-source inventory renders, including the unconfigured paused conference row and unsupported collectors. HSA is explicitly manual-only. Complete cadence/meeting-period notes remain visible. Null success is Never and null next-run is Not scheduled. Browser checks verified no-change advancing last-success and partial/failure retaining it. A due fixture became Overdue after the browser clock passed next_run_at without another fetch; the 30-second timer and visibility handler also refresh event timing. No schedule or collection job was introduced.
- **Calendar decisions and checks:** The real HSA event displays September 29, 07:30 EDT (UTC-04:00), labelled Past / started and excluded from Upcoming. Its calendar output has DTSTART 20260929T113000Z and no invented end. A boundary example at 2026-10-02T00:30Z correctly filters/displays on October 1 at UTC-04:00. Date-only ranges retain DATE values and an exclusive next-day calendar end; end_on means the last included day. Unknown dates have no link. Cancelled events have a clearly labelled cancellation file with STATUS:CANCELLED; reschedules retain the record UID. Source URLs and source schedule/zone are included. Escaping, Unicode byte folding, year-boundary all-day dates and stable UIDs pass focused tests. The production function also generated `.cache/hsa-event.ics` from the actual local record.
- **Browser evidence and limitation:** `/tests/browser.html` uses an ignored local database export plus clearly labelled synthetic cases, with no Auth bypass in the production entry. Verified actual record filtering, all 22 trackers, source details, reschedule/cancellation/unknown dates, malicious-looking text rendered literally (zero injected image/script/javascript-link elements), initial loading, empty data, initial error and refresh failure retaining old data. Saved a local UI screenshot at `.cache/scout-events-ui.png`. Calendar links render with the expected .ics filename and browser Blob URL, but the in-app browser's download APIs timed out for both click/download-event and direct-link retrieval; native file-save/import completion is unverified. No additional workaround or native-app permission was requested. Revisit with a supported browser/calendar client before claiming that end-to-end integration.
- **Checks and scoped Hosting update:** All 15 tests pass; both unconfigured production and placeholder-public-key configured builds pass. Exact environment-value scans and fixture-marker scans pass for both builds. Firebase token refresh and site-update permissions passed; billing remains disabled. Latest reported storage is 11,045,338 bytes and monthly transfer 55,456,267 bytes against 10,737,418,240-byte limits. Deployed only `bbnj-scout`: release `sites/bbnj-scout/releases/1790833176225000`, version `be75b7cdb97614ad`, three compressed files totalling 2,696 bytes. Live files return HTTP 200, match dist, and retain security headers. Browser confirms the closed setup state. Verification URLs serve only that shell, not local data. Ryu release `sites/ryustatic/releases/1790266049490000` is unchanged.
- **Remaining boundary:** Acceptance checks above describe local UI/data and generated calendar behavior. Hosted authenticated reads remain unverified until Supabase plan/paid-use checks, remote foundation/import/collection and explicit memberships are resolved. The shell deployment does not make local data public. SCOUT-05 remains partial pending that integration and the native calendar-save check. No remote database writes, model/Tavily/Slack calls, scheduling or SCOUT-06 work. Stop for manager review.

## SCOUT-06 — Deliver Slack findings and digests

Status: in-progress
Depends on: SCOUT-04, SCOUT-05

Outcome: Scout can deliver new findings, material changes, and a weekly upcoming-events digest to the agreed Slack channel.

Acceptance criteria:

- [ ] Configure the custom Slack app with only the access needed for the agreed behavior. Keep tokens server-side.
- [ ] A manual delivery run posts new findings and material changes with concise descriptions, source links, and applicable calendar actions.
- [x] A manually triggered digest lists upcoming events for an explicit reporting window, omitting cancelled events and distinguishing unknown dates.
- [x] Track delivery state separately from collection state. Repeating a completed delivery does not post it again; failed deliveries are not marked successful.
- [x] Bound retries and record ambiguous send outcomes for reconciliation rather than blindly reposting. Verify a transient failure and a repeated delivery request.
- [ ] Initial historical imports have an explicit notification baseline so they do not flood the channel. Verify Slack rendering in the agreed channel.

Assignment (2026-10-01): manager accepted SCOUT-05 commit `da81802` as local partial delivery. Native calendar save/import is an approved bounded verification deferral; hosted authenticated data remains unfinished. Implement the smallest manual delivery path against the existing persistent local records/schema and supplied webhook for #scout (`C0C5PE21KN1`, workspace `TFZ8FRLBV`). Establish an explicit baseline for the 12 historical records before sending. Persist exact payload/version evidence, deduplicate completed requests, bound retries, and require reconciliation after ambiguous sends. Review payloads and tests before the authorized live cap of one clearly labelled source-backed verification finding plus one explicit-window digest. No broader scopes, hosted data claims, remote database writes, model/Tavily work, scheduling or SCOUT-07 onward. Preserve user edits, commit once, and stop for milestone-1 manager review; hosted integration still prevents claiming milestone 1 complete.

Implementation and verification (2026-10-01):

- **Manual local path:** Added `npm run notify` for an explicit historical baseline, preparing at most five findings/material changes, one historical verification example, an explicit-window digest, payload review, individual sends and inspected receipts. It uses the existing persistent local PostgreSQL database and collector lock; collection and delivery state stay separate. A versioned migration adds exact payload/record snapshots, attempt times and receipt evidence to backend-only deliveries without changing browser grants. No new package, remote database write, collector run, model/Tavily call or scheduler was needed.
- **Source and date behavior:** Reused the record/date module. Messages distinguish event, publication, collection and update dates, show source links, and include before/after material changes. Digests omit cancelled/past events, preserve source-local window boundaries and show unknown dates separately, with record/coverage counts. At most five dated and three unknown entries appear; all qualifying version evidence is retained. The same inclusive window returns the same payload. Prepared records that change or cross event timing states fail before send. Source prose uses plain-text blocks and links disable mention parsing/unfurling.
- **Durable outcomes:** Persist exact payloads and version evidence before network I/O. A unique version/window key suppresses completed repeats. Save `sending` before each attempt; timeout, network failure, 5xx, unexpected response and interrupted sends become `unknown`, requiring inspection. Only HTTP 429 retries once, respecting a valid `Retry-After` of at most 30 seconds; every delivery is capped at two attempts. Other 4xx responses fail without reposting. Requests have a 12-second deadline and 4 KiB response limit. HTTP 200 `ok` means accepted; a separate receipt records the inspected Slack timestamp and evidence note. Unknown delivery for a record blocks later notifications until reconciled.
- **Historical baseline:** Created baseline `1cf18543-e3f1-455c-a3c2-cdc07b0e93cc` covering all 12 existing records before notification. Repeating it returns that baseline; preparing ordinary findings returns zero. Tests demonstrate that later new records and material changes remain eligible, while collection-only provenance refreshes do not notify.
- **Verified destination and live cap:** The supplied webhook matches workspace `TFZ8FRLBV`, installation `B0C5TEK4R38`; Slack channel history confirms that installation in #scout (`C0C5PE21KN1`). The transport rejects other bindings. After all 20 tests passed and stored payloads were reviewed, sent exactly one labelled historical HSA finding, delivery `3d0e7455-4bf0-4ceb-a4a5-5cf3e318c2f7`, [Slack message `1790834126.338919`](https://oceanagentics.slack.com/archives/C0C5PE21KN1/p1790834126338919), and one labelled October 1–7 digest, delivery `7dea4bc5-05ba-4196-8e0d-b18ef673da3d`, [Slack message `1790834129.395769`](https://oceanagentics.slack.com/archives/C0C5PE21KN1/p1790834129395769). Both were accepted on attempt 1. Repeating both send commands kept attempts at 1 and produced no duplicate. Slack readback confirms both UUIDs, installation, message content/date labels and source links; timestamps and inspection notes are persisted. The digest honestly has zero upcoming and zero unknown-date events, covering one successfully collected tracker out of 22. No synthetic event facts were posted.
- **Verification scope:** All 20 tests pass, including baseline/new/change eligibility, source-safe formatting, local date boundaries, past/cancelled/ongoing/unknown digest selection, empty results, frozen/stale payload behavior, backend-only delivery access, a 429→success retry with identical payloads, exhausted/permanent rejection, network/5xx/unexpected-response uncertainty, interrupted sends and explicit receipt reconciliation. This tests local PostgreSQL plus the two real Slack receipts; hosted execution remains unverified.
- **Deferrals and user impact:** Calendar downloads and hosted record links are explicitly unavailable in Slack until hosted member access is configured; no placeholder route is advertised. Existing Slack installation scopes have not been independently audited; no new scopes were requested and only the existing webhook sends. Visual browser inspection was rejected by automatic approval review because it could not establish permission to view the private channel. The manager explicitly approved deferring this optional check; no retry or alternate route was attempted. Connector readback verifies receipt and structured content, not visual layout. The earlier optional browser-permission question is not a prerequisite for this delivery. Keep the combined rendering/baseline criterion open until permitted browser or user inspection. Supabase actual Free-plan/paid-add-on verification, member identities, remote integration and the approved native calendar-save check remain deferred. Stop for manager review; SCOUT-06 is local partial delivery and milestone 1 is not complete. Do not start SCOUT-07.
- **Manager handoff:** The cross-chat report tool was rejected by automatic approval review because it could not establish trusted user authorization for messaging the manager chat. No alternate route or retry was attempted. The focused commit, this evidence and the worker's final report are available for the manager's read-only review; direct cross-chat sending requires explicit user authorization.

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

Outcome: Scheduled Bluesky and web discovery trackers find relevant items outside the known source list within their collection and search budgets.

Acceptance criteria:

- [ ] Implement the sheet's Bluesky discovery tracker using `searchPosts`, with separate queries for BBNJ, High Seas Treaty, traité sur la haute mer, and relevant conference tags. Preserve its weekly cadence and daily override during major BBNJ meetings; bound pagination and report partial coverage.
- [ ] Add a separate Tavily web-discovery tracker for BBNJ/High Seas Treaty events, webinars, workshops, conferences, side events, and announcements. Start with 10 searches per weekly run. Do not substitute Gemini's Google Search grounding: its terms restrict collecting returned links for indexing or crawling (see provider references in README.md).
- [ ] Apply the confirmed credit budget, including retries and optional extraction. Planning baseline: basic search costs 1 credit and advanced search costs 2.
- [ ] Follow results to supporting source pages before creating records. Search snippets alone do not establish event facts or official treaty status.
- [ ] Merge findings with existing records, retain evidence, and avoid processing unchanged content again.
- [ ] Surface potential new publishers for review; do not automatically activate new trackers or increase recurring work.
- [ ] Verify both discovery methods, new findings, existing-record matches, irrelevant results, unavailable source pages, and quota exhaustion.

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
- [ ] Extend the SCOUT-05 tracker list with last attempt, latest error details, next run, and recent collection history. Retain last successful collection and distinguish unsupported, partial, and quota-limited coverage.
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
