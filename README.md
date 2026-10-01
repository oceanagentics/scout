# BBNJ Scout

Scout is Ocean Agentics' planned app for keeping up with BBNJ: treaty ratifications, NGO webinars, official DOALOS announcements, conferences, and side events. It will maintain a central database, surface useful changes in Slack, and make events easy to find and add to a calendar.

The static app and database foundation are implemented; remote database integration is pending. The proof-of-concept target is **$0/month in recurring service fees**.

## Original documentation

The original documents are the source of truth for product direction. They are living documents and may change the app's scope, behavior, or service choices. This README summarizes the current plan; [tasks.md](tasks.md) tracks implementation work.

| Document | Purpose |
| --- | --- |
| [Letter](https://docs.google.com/document/d/13HIEN45IEKQN-i29pQuoRD-eeFOl-t70a1_2TBpV7zI/edit?tab=t.0) | The original request and the problem Scout should solve. |
| [Features](https://docs.google.com/document/d/13HIEN45IEKQN-i29pQuoRD-eeFOl-t70a1_2TBpV7zI/edit?tab=t.98p2iu4vdtbg) | Planned content, record fields, and ways users receive and act on findings. |
| [Services](https://docs.google.com/document/d/13HIEN45IEKQN-i29pQuoRD-eeFOl-t70a1_2TBpV7zI/edit?tab=t.1h6brasprb8e) | Proposed infrastructure, free-tier assumptions, collection cadence, and budget constraints. |
| [BBNJ Scout Trackers](https://docs.google.com/spreadsheets/d/1VtpaC83ybg7zet7VvNXmvctN9s5WJK_NTlJ9wx5NIbM/edit) | Initial source inventory, channels, collection methods, and cadences. |

Before starting feature work, re-read the relevant original documents and compare them with this README and the affected tasks. Reconcile changed requirements with the latest user direction before coding; resolve material ambiguities with the project owner. If the live documents are unavailable, report that limitation rather than assuming this snapshot is current.

## Product brief

Scout should collect relevant events and official announcements into one maintained record, then help users answer questions such as:

> @scout does HSA have any webinars coming soon?

The planned experience includes:

- Updates on treaty ratifications and other official participant-status changes.
- BBNJ webinars, conferences, side events, and official DOALOS announcements.
- Daily Slack posts for new findings and material changes, plus a weekly roundup of upcoming events.
- Slack answers grounded in collected records, with supporting source links and visible coverage limits.
- A searchable, filterable web list and calendar links or downloads for events with sufficient date information.
- A frontend list of all trackers showing collection status and last successful collection, including trackers that have never succeeded or are overdue.

The Letter mentions an optional weekly email digest; Features currently specifies a weekly Slack digest. The task plan proposes deferring email and a separate calendar view. Confirm that scope in SCOUT-01 before implementation.

## Records and collection

Events need titles, organizations, descriptions, locations or online links, dates, time zones, and last-update information. Announcements need summaries, publication dates, sources, supporting references, and last-update information. Treaty-status records need the country, reported action, recorded date, and official evidence. Keep event dates, publication dates, and collection timestamps distinct; preserve unknown values.

Import the tracker sheet once to seed the database, then let the app own subsequent tracker edits. Each tracker defines what to collect, its collection method, and its cadence. The current plan is daily Bluesky collection, mostly weekly website checks, and weekly discovery searches, with more frequent checks around relevant meetings.

Use direct feeds, public APIs, and website collectors where possible. The sheet specifies Bluesky `getAuthorFeed` for account feeds and `searchPosts` for discovery; Tavily web discovery is a separate tracker. Follow results to supporting source pages, merge duplicate findings while retaining their sources, and update existing records when event details change. Preserve authoritative organizer corrections when older third-party reports are collected later. Verify treaty-status changes against the official record.

Persist each tracker's last attempt, last successful collection, latest outcome or error, and next scheduled run. Failed collection or exhausted quotas must preserve existing records. Collection and notification schedules are independent.

## Proposed services

These choices reflect the agreed recommendations in the Services tab; account access and free quotas still need verification before implementation.

| Component | Proposed setup |
| --- | --- |
| App/backend and database | Firebase Hosting on Spark for Scout's own static site, using OA's existing Google account; Supabase Free project `chm`, with Scout's tables in its `scout` schema, for Postgres, API, and authentication. |
| Scheduler and worker | Supabase Cron and Edge Functions running small jobs for due trackers and scheduled digests. |
| Trackers | Direct webpage/RSS collection and Bluesky's public API; Tavily Free for discovery; a free Gemini Flash-Lite API tier accessed through OA's Google Workspace account for extraction and summaries where needed. |
| Slack integration | A custom Scout app connected to the backend for findings, digests, and questions. |

Use one shared Supabase project named `chm`, with a schema per service: `scout` now and names such as `otherservice` for future services. These schemas live in the default `postgres` database; `chm.scout` describes project/schema, while SQL table names are `scout.events` and `scout.trackers`. Configure [custom-schema API access](https://supabase.com/docs/guides/api/using-custom-schemas) explicitly, with Data API on, automatic table exposure off, and RLS on. Schemas share project quotas and Auth; allocate Scout's budget from remaining shared capacity. Use Scout-specific permissions and migrations, and prefix its deployed functions and scheduled jobs with `scout-`. Project-wide service-role credentials remain backend-only; schemas do not isolate that privileged access. Other service implementations are outside Scout's scope.

Use recurring free allowances, keep paid upgrades and automatic top-ups off, and confirm account eligibility and quotas during setup. Only process new or changed content with the model, reuse stored results, and stop work at configured usage limits. Record quota exhaustion against the tracker and resume when allowance becomes available.

Reuse the Firebase Hosting approach already used for Ryu, with a separate Scout deployment. The [Spark hosting allowance](https://firebase.google.com/docs/hosting/usage-quotas-pricing) is 10 GB storage and 10 GB/month transfer; verify the selected project's plan and available quota. Cloudflare signup is no longer needed. [AI Studio supports Workspace accounts](https://ai.google.dev/gemini-api/docs/workspace), subject to administrator controls; create a Scout API key in an OA-controlled project and verify its free quota. Workspace's included Gemini features do not replace the API's separate quotas and pricing.

Retain Supabase Free and Tavily Free. Firestore offers a free database allowance, but a Firebase backend using Cloud Functions requires the [Blaze billing plan](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans). Sheets and Apps Script would require a backend redesign. [Google's nonprofit cloud offering](https://support.google.com/nonprofits/answer/16245748?hl=en) does not establish a recurring entitlement covering this backend or discovery search. Tavily's free allowance remains 1,000 credits/month without a card; [Google Search grounding terms](https://ai.google.dev/gemini-api/terms#grounding-with-google-search) restrict collecting returned links for indexing or crawling, so it is not a substitute for Scout's discovery pipeline.

The free setup has practical limits: low-activity Supabase projects may pause, worker limits may require local/manual handling of heavy browser or PDF collection, and Gemini's free-tier content may be used to improve Google's products. Keep model inputs to public source material and the specific Scout question. The Services tab contains the detailed assumptions and provider references to verify before setup.

## Build plan

Use [tasks.md](tasks.md) for task status, dependencies, acceptance criteria, verification, and blockers.

1. Prove one complete flow: collect HSA's Bluesky feed, store useful records, display them in the web list, provide calendar actions, and deliver them in Slack.
2. Add scheduling and failure handling, then expand to other feeds, official treaty records, websites, and discovery searches.
3. Add Slack questions and tracker management, then verify the complete proof of concept against the agreed coverage and budget.

## Development

Use Node.js 22.12+ and npm. The frontend uses Vite and the Supabase JavaScript client; it has no server or Firebase Functions dependency.

```sh
npm --cache .cache/npm ci
npm test
npm run dev
npm run build
npm run preview
```

`npm run dev` serves the app at `http://127.0.0.1:5173`. Add the two public settings in `.env.example` to the existing `.env.local`, preserving its other credentials. Use a Supabase `sb_publishable_…` key; secret/service-role keys never belong in a `VITE_` variable. Without those settings, the app displays its setup state and makes no database requests. Sessions stay in memory, with no signup flow or automatic Scout membership.

`npm test` applies the real migration to separate in-memory PostgreSQL databases through [PGlite](https://pglite.dev/docs/). Minimal Auth fixtures exercise anonymous, unrelated-user, reader, admin, and backend access; the shared fixture also checks another service's data, policies, grants, and ownership. This does not verify hosted Auth or PostgREST. Native PostgreSQL could not initialize under this host's shared-memory restrictions, so PGlite is the repeatable local test path.

## Database deployment

The shared Supabase project is `chm` (`vhlfumeyhkeospnemukq`), using database `postgres`. The migration creates only `scout`: memberships, trackers, collection runs, records, sources, and deliveries. One typed records table holds events, announcements, and treaty changes; sources provide multiple references per record. Unknown dates stay null, date-only events stay distinct from timestamps, and collection/update times have separate columns.

Before remote deployment, inspect the project's Free plan, remaining capacity, schemas, default grants, exposed schemas, and full migration history. Never reset the remote project or repair another service's migration history merely to allow Scout's deployment. The migration refuses an existing `scout` schema or global client table defaults that would undermine private future tables.

Use existing CLI authentication, or explicitly provide `SUPABASE_ACCESS_TOKEN` to the process through an approved secret loader. Merely adding that variable to `.env.local` does not ensure CLI authentication. Keep telemetry disabled on this host:

```sh
export SUPABASE_TELEMETRY_DISABLED=1
supabase functions list --project-ref vhlfumeyhkeospnemukq --output json
supabase link --project-ref vhlfumeyhkeospnemukq
supabase migration list --linked
supabase db push --linked --dry-run
# Only after reviewing shared state and the exact pending migration:
supabase db push --linked
```

The saved token now works noninteractively when explicitly loaded from `.env.local` into the authorized process. Project-scoped [Management API](https://supabase.com/docs/reference/api/introduction) reads and read-only SQL succeed, avoiding the CLI's IPv6 preflight. Inspection found no application tables or migration history and approximately 10.8 MB of database usage. Organization-entitlement access returns 403; plan verification remains open. No remote migration has been applied.

After migration, append `scout` to the project's existing Data API exposed-schema list, preserving every existing service setting. Do not push a replacement project configuration. RLS and explicit grants are included in the migration; no client receives future-table defaults. Provision reader/admin membership only for explicitly approved Auth user IDs through trusted backend access. An admin can manage trackers but cannot provision membership, modify collected evidence, or read delivery state through the browser. Project-wide service-role access bypasses RLS and belongs only in trusted backend processes.

## Tracker import

`supabase/seeds/trackers.sql` is a frozen, manually reviewed snapshot of all 22 sheet entries, read on 2026-10-01. Apply the versioned migrations before this seed. Once remote foundation checks pass, an authorized SQL operator can run:

```sh
supabase db query --linked --project-ref vhlfumeyhkeospnemukq --file supabase/seeds/trackers.sql
```

If the CLI preflight is unavailable, submit the same SQL through the documented Management API query endpoint after those checks. The seed's immutable `seed_key` is independent of editable URL/method. Reapplying it skips existing seed identities and preserves app edits, pauses, and collection history. It never synchronizes later sheet changes. A conflicting URL/method on a different identity fails the transaction rather than silently dropping a source.

The inventory contains 17 websites, four daily `getAuthorFeed` accounts, and one weekly `searchPosts` discovery tracker. Original cadence text and coverage are preserved, including meeting-period overrides and discovery keywords. The conference-specific row has no URL: it is retained with `configuration_note = 'Set per conference'`, `url = null`, and `enabled = false`. It cannot be enabled until configured. All imported rows have null attempt, success, outcome, error, and next-run values; import is not a collection attempt. Collector support and scheduling arrive in their assigned later tasks.

## Manual HSA collection

```sh
npm run collect:hsa
# Or choose an explicit coverage window:
npm run collect:hsa -- --since=2026-09-01
```

This command uses persistent local PostgreSQL at `.cache/hsa-database`, applies the local migrations/seed, and collects only the configured HSA Bluesky tracker. It cannot connect to the hosted database and needs no service credentials. A process lock protects the local database; after an interrupted process, confirm it has stopped before removing `.cache/hsa-collector.lock`. This development database uses minimal Auth fixtures; it is not a hosted Supabase environment.

The default window is the previous 30 days, using feed/repost indexing time for coverage and original publication time for evidence ordering. The collector requests at most two feed pages of 25 posts, follows up to two event/registration links per post and six pages per run, allows three redirects per request, and caps the total at 24 HTTP requests. Every request uses `BBNJ-Scout-Bot/1.0 (+https://bbnj-scout.web.app)`. HTTPS/DNS checks reject private destinations; responses are limited to 512 KiB, each request to 12 seconds, and the run checks a 120-second budget before starting another request. No retries, models, Tavily, or paid APIs are used.

BBNJ feed updates are stored with verbatim source summaries. Events use stable event/registration URLs where available; other posts use their Bluesky identity. Structured JSON-LD event data and the observed Zoom registration metadata supply explicit dates. Ambiguous dates, missing years/time zones, and unsupported page formats stay unknown and are retained in evidence. Zoom's displayed local time is preserved in the description when its page does not supply a zone; it is not converted to an invented timestamp. Quoted posts are not expanded. This is bounded HSA coverage, not a general website collector or semantic cross-post merger.

Source versions and material changes are stored in `scout` and survive separate runs. Unchanged posts reuse extraction; event pages are checked again for corrections and compared by extracted facts so changing page scripts do not create updates. The `hsa-v1` fingerprint prefix invalidates cached extraction when the parser is intentionally revised. Newer organizer/registration evidence takes precedence over older reports; source references remain attached. Cosmetic edits do not create a new event or material change.

The command prints its coverage window, outcome, counts, and limitations. Exit code 2 means `partial`, `failed`, or `quota`; existing records are preserved. Only fully successful runs, including `no_change`, advance `last_success_at`. A remaining feed cursor at the page bound, unavailable/unsupported pages, quoted content, or incomplete registration metadata keeps the result partial. Scheduling and hosted deployment are separate pending work.

## Hosting deployment

Scout uses Firebase Spark project `ryustatic`, site `bbnj-scout`, deployment target `scout`, and [https://bbnj-scout.web.app](https://bbnj-scout.web.app). `.firebaserc` maps only this target. Recheck shared Hosting capacity and keep billing disabled, then deploy with the saved Firebase login:

```sh
firebase deploy --project ryustatic --only hosting:scout
```

The predeploy step builds `dist`. The initial deployment uses the documented [Hosting REST API](https://firebase.google.com/docs/hosting/api-deploy) and the same saved login refreshed in memory, because CLI credential-cache writes are restricted here. No new credential or paid service is required. The live shell intentionally shows setup status until the database and authorized membership are ready; a hosted database sample read remains an open SCOUT-02 criterion.
