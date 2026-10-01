# BBNJ Scout

Scout is Ocean Agentics' planned app for keeping up with BBNJ: treaty ratifications, NGO webinars, official DOALOS announcements, conferences, and side events. It will maintain a central database, surface useful changes in Slack, and make events easy to find with their supporting sources.

The deployed app, remote database, Workspace sign-in, manual HSA collection, and manual Slack delivery are verified. Scheduling and broader collection remain pending. The proof-of-concept target is **$0/month in recurring service fees**.

## Original documentation

The original documents are the source of truth for product direction. They are living documents and may change the app's scope, behavior, or service choices. This README summarizes the current plan; [tasks.md](tasks.md) tracks implementation work.

| Document | Purpose |
| --- | --- |
| [Letter](https://docs.google.com/document/d/13HIEN45IEKQN-i29pQuoRD-eeFOl-t70a1_2TBpV7zI/edit?tab=t.0) | The original request and the problem Scout should solve. |
| [Features](https://docs.google.com/document/d/13HIEN45IEKQN-i29pQuoRD-eeFOl-t70a1_2TBpV7zI/edit?tab=t.98p2iu4vdtbg) | Planned content, record fields, and ways users receive and act on findings. |
| [Services](https://docs.google.com/document/d/13HIEN45IEKQN-i29pQuoRD-eeFOl-t70a1_2TBpV7zI/edit?tab=t.1h6brasprb8e) | Configured services, verified setup status, remaining work, and cost target. |
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
- A searchable, filterable web list with supported UTC event times and source links.
- A frontend list of all trackers showing collection status and last successful collection, including trackers that have never succeeded or are overdue.

The Letter mentions an optional weekly email digest; Features currently specifies a weekly Slack digest. The task plan proposes deferring email and a separate calendar view. Confirm that scope in SCOUT-01 before implementation.

## Records and collection

Records keep a title, type, organization, description of at most 280 characters, location, event/registration links, supported UTC start/end timestamps and status. Publication and collection timestamps belong to sources. Full text, date-only values and treaty details remain in captured source evidence; records no longer duplicate them in summary, date-only, publication, country, treaty-action, recorded-date or collection columns. `updated_at` remains the record version. Compact `date_evidence` references the schedule and zone captures used to establish a UTC instant; the component values stay in those captures. Calendar generation has been removed.

The schema has **five tables and 59 columns**:

| Table | Columns | Purpose |
| --- | ---: | --- |
| `trackers` | 8 | Source configuration: name, URL, coverage, collector, cadence, enabled flag, ID and seed identity. |
| `collection_runs` | 7 | Collection attempts, outcomes, coverage and statistics, with warnings stored once. |
| `records` | 16 | Current finding, supported event times, identity and compact evidence references. |
| `evidence` | 13 | Captured content and parsed facts, linked directly to a record and tracker, with source URL and observation times. |
| `deliveries` | 15 | Exact Slack payloads, comparison snapshots, send state and receipt evidence. |

A tracker defines where to collect; evidence stores what its returned URLs contained; a record holds the current finding supported by those captures. One record can have many captures. Shared captures are copied per record, avoiding a separate source-link table. Captures without a record remain stored. `current_evidence` selects the most recently seen capture for each record/URL, including returns to older content. Capture time, last-seen time and fact-change evidence time remain distinct.

The browser reads current source metadata through `source_details`; raw evidence stays backend-only. `tracker_status` derives attempt/success/outcome/error from runs. These views store no additional data. Trackers have no cadence/configuration notes, cached status, timestamps or next-run field. There is no `memberships` table: backend-controlled Auth app metadata grants admin access to an otherwise eligible Workspace identity.

Source captures and deliveries provide history; there is no separate record-edit log. Exact before/after changes between notifications are not retained. Slack compares current records with the last notification or baseline snapshot. Existing delivery payloads and snapshots remain intact; pending snapshot formats before version 3 require explicit `reprepare`. New snapshots retain only comparison fields, and the aggregate baseline stores only its count.

Cards, filters and digest windows use UTC; records store no time zone, creation time or material hash. New parser captures omit duplicate summaries, publication dates and schedule prose while retaining raw content. See [Database deployment](#database-deployment) for the coordinated migration and release status.

Import the tracker sheet once to seed the database, then let the app own subsequent tracker edits. Each tracker defines what to collect, its collection method, and its cadence. The current plan is daily Bluesky collection, mostly weekly website checks, and weekly discovery searches.

Use direct feeds, public APIs, and website collectors where possible. The sheet specifies Bluesky `getAuthorFeed` for account feeds and `searchPosts` for discovery; Tavily web discovery is a separate tracker. Follow results to supporting source pages, merge duplicate findings while retaining their sources, and update existing records when event details change. Preserve authoritative organizer corrections when older third-party reports are collected later. Verify treaty-status changes against the official record.

Derive each tracker's last attempt, last successful collection and latest completed outcome from collection runs. Failed collection or exhausted quotas must preserve existing records. Scheduling is not implemented.

## Configured services

Status as of 2026-10-01, matching the Services tab. See [tasks.md](tasks.md) for verification evidence and remaining acceptance criteria.

| Service | Purpose | Current status |
| --- | --- | --- |
| Firebase Hosting | Hosts [Scout's website](https://bbnj-scout.web.app) in project `ryustatic`, with its own `bbnj-scout` site. | Deployed on Spark, with billing disabled. |
| Supabase database and API | Stores trackers, findings, evidence, collection history, and deliveries in shared project `chm`, schema `scout`. | Deployment preflight: 25 trackers and 12 records, with access restrictions enforced. Free plan, no paid add-ons. |
| Google sign-in through Supabase Auth | Gives verified `oceanagentics.com` Workspace users automatic reader access. | OAuth configured; real reader sign-in and sign-out verified on the earlier deployed release. |
| Supabase Edge Functions | Runs collection in the cloud. | Private `scout-collect-hsa` function deployed and tested; currently triggered manually. |
| Bluesky public API | Collects High Seas Alliance posts and follows supporting event links. | Working: 11 announcements and one event collected; repeat collection produced no duplicates. |
| Slack Scout app | Posts findings and digests into [#scout](https://oceanagentics.slack.com/archives/C0C5PE21KN1). | Webhook delivery verified with a finding and a digest. Signing secret saved; answering mentions remains pending. |
| Gemini API / Google AI Studio | Intended for extraction, summaries, and answering questions, using project `bbnj-chm`. | Free-tier access and a model request verified. Not yet integrated into collection. |
| Tavily | Intended to discover additional relevant websites and events. | API authentication and the 1,000-credit monthly allowance verified. Discovery integration and paid-use controls remain pending. |

Still to add: Supabase Cron scheduling, automatic daily and weekly Slack delivery, remaining collectors, and Slack questions. Collection and notification schedules are independent; delivery times and time zone still need to be set. Calendar generation has been removed.

Use one shared Supabase project named `chm`, with a schema per service: `scout` now and names such as `otherservice` for future services. These schemas live in the default `postgres` database; `chm.scout` describes project/schema, while SQL table names are `scout.records` and `scout.trackers`. Configure [custom-schema API access](https://supabase.com/docs/guides/api/using-custom-schemas) explicitly, with Data API on, automatic table exposure off, and RLS on. Schemas share project quotas and Auth; allocate Scout's budget from remaining shared capacity. Use Scout-specific permissions and migrations, and prefix its deployed functions and scheduled jobs with `scout-`. Project-wide service-role credentials remain backend-only; schemas do not isolate that privileged access. Other service implementations are outside Scout's scope.

Use recurring free allowances, keep paid upgrades and automatic top-ups off, and confirm account eligibility and quotas during setup. Only process new or changed content with the model, reuse stored results, and stop work at configured usage limits. Record quota exhaustion against the tracker and resume when allowance becomes available.

Scout reuses the Firebase Hosting approach already used for Ryu, with a separate deployment. The [Spark hosting allowance](https://firebase.google.com/docs/hosting/usage-quotas-pricing) is 10 GB storage and 10 GB/month transfer; recheck shared capacity before deployment. Cloudflare signup is no longer needed. [AI Studio supports Workspace accounts](https://ai.google.dev/gemini-api/docs/workspace), subject to administrator controls; the existing OA-controlled `bbnj-chm` key and free-tier model access are verified for Scout. Workspace's included Gemini features do not replace the API's separate quotas and pricing.

Retain Supabase Free and Tavily Free. Firestore offers a free database allowance, but a Firebase backend using Cloud Functions requires the [Blaze billing plan](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans). Sheets and Apps Script would require a backend redesign. [Google's nonprofit cloud offering](https://support.google.com/nonprofits/answer/16245748?hl=en) does not establish a recurring entitlement covering this backend or discovery search. Tavily's free allowance remains 1,000 credits/month without a card; [Google Search grounding terms](https://ai.google.dev/gemini-api/terms#grounding-with-google-search) restrict collecting returned links for indexing or crawling, so it is not a substitute for Scout's discovery pipeline.

The free setup has practical limits: low-activity Supabase projects may pause, worker limits may require local/manual handling of heavy browser or PDF collection, and Gemini's free-tier content may be used to improve Google's products. Keep model inputs to public source material and the specific Scout question. See [tasks.md](tasks.md) for account checks, operating caps, and remaining quota verification before enabling model or discovery work.

## Build plan

Use [tasks.md](tasks.md) for task status, dependencies, acceptance criteria, verification, and blockers.

1. Prove one complete flow: collect HSA's Bluesky feed, store useful records, display them in the web list with source links, and deliver them in Slack.
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

`npm run dev` serves the app at `http://127.0.0.1:5173`. The two public settings in `.env.example` configure the browser. Use only a Supabase `sb_publishable_…` key; secret/service-role keys never belong in a `VITE_` variable. Without those settings, the app displays its setup state and makes no database requests.

For local Google sign-in, set both browser settings in the ignored `.env.local` file and add exactly `http://127.0.0.1:5173/` to the existing project's Supabase Auth Redirect URLs. Keep the shared Site URL and existing production redirects. The dev server requires port 5173 and stops if it is occupied, so it cannot silently move to a port that login does not allow. Use the printed `127.0.0.1` address consistently; `localhost` is a different login origin. The local frontend uses the hosted database and the same Workspace access checks as production.

The accepted access plan (2026-10-01) keeps Firebase Hosting Spark: the login shell/assets are public; Scout data/actions are private. Every Google-verified `oceanagentics.com` Workspace user receives reader access on first sign-in, without individual invitations, passwords or manual membership setup. This supersedes the earlier whole-frontend gateway hold. Supabase Auth remains the single authentication system; no Cloudflare, IAP, Cloud Run, hosting migration or billing upgrade is needed. Google sign-in and hosted reader access are now verified on the deployed site.

### Workspace sign-in

The app uses Supabase's Google OAuth flow with PKCE and tab-scoped `sessionStorage` (`scout-auth`), so the verifier survives the Google redirect without saving a persistent cross-tab login. Sign-out immediately removes rendered data, prevents late access checks from restoring it, clears that tab's session and reloads the login screen. The `hd` sign-in parameter only helps select the account; it grants no access.

The hardened `scout.access_role()` function checks the current user's provider-owned `auth.identities` row: Google provider, Google token issuer, boolean verified email, and `custom_claims.hd = oceanagentics.com` are required. It returns `reader` automatically. Backend-controlled `auth.users.raw_app_meta_data.scout.admin = true` elevates an eligible identity to `admin`; migration `20261001170000` transfers existing admin memberships before removing that table. No admin was provisioned. Read and tracker-write policies enforce access independently of the UI. Clients cannot modify provider identities or app metadata, or read raw evidence and delivery state. User-editable `raw_user_meta_data` is not trusted. This matches the verified GoTrue `v2.197.0` [Google token verification](https://github.com/supabase/auth/blob/v2.197.0/internal/api/provider/google.go), [hosted-domain extraction](https://github.com/supabase/auth/blob/v2.197.0/internal/api/provider/oidc.go) and [separate user-metadata update](https://github.com/supabase/auth/blob/v2.197.0/internal/models/user.go); Google's [OpenID guidance](https://developers.google.com/identity/openid-connect/openid-connect) distinguishes the signed `hd` claim from the request hint.

**OAuth configuration is complete:** After the user configured the dashboards, a read-only check confirmed the Google provider enabled with a client ID/secret, nonce verification enabled, email required and both Scout redirects saved. The shared Site URL remains unchanged. The existing PAT can read Auth configuration but lacks `auth_config_write` and `project_admin_write`; no denied write was retried or scope expanded. Future configuration changes belong in the authorized admin dashboards:

1. In [Google Auth Platform for `ryustatic`](https://console.cloud.google.com/auth/clients?project=ryustatic), create/reuse a Scout web OAuth client. Set JavaScript origins to `https://bbnj-scout.web.app` and `https://bbnj-scout.firebaseapp.com`, and the authorized redirect URI to `https://vhlfumeyhkeospnemukq.supabase.co/auth/v1/callback`. Request only `openid`, email and profile. Preserve any existing clients/branding and do not enable billing.
2. In [chm's Google provider settings](https://supabase.com/dashboard/project/vhlfumeyhkeospnemukq/auth/providers), enter that client ID/secret and enable Google. Keep nonce verification enabled and email required. The secret belongs only in the provider's backend configuration, never Vite, source or chat.
3. In [chm URL Configuration](https://supabase.com/dashboard/project/vhlfumeyhkeospnemukq/auth/url-configuration), retain `https://bbnj-scout.web.app/` and `https://bbnj-scout.firebaseapp.com/` in Redirect URLs. Preserve other entries and the shared Site URL.

No Google OAuth client credentials are needed locally: Supabase holds them in its provider settings, and the frontend needs only its public Supabase URL/publishable key. The user-requested downloaded `client_secret_*.apps.googleusercontent.com.json` was removed and that root filename pattern is ignored. No duplicate was found in `.env.local`, which stayed byte-for-byte unchanged. The credentials were absent from the Git index and branch/remote history; Codex's local diff-snapshot tree refs retained a copy. Those snapshots and history were not rewritten, so this cleanup is not a claim of complete local erasure.

Before the schema cleanup, a real Google sign-in as `danny@oceanagentics.com` loaded all 12 findings and the then-current 22 trackers without a membership row. A rolled-back transaction using that provider identity confirmed reader access and denied tracker writes, raw sources and deliveries. Sign-out removed the dashboard and a reload stayed signed out. Anonymous/forged-token Data API checks returned 401. Calendar generation was subsequently removed by user direction. No synthetic Auth accounts were created remotely.

`npm test` applies the versioned migrations to separate in-memory PostgreSQL databases through [PGlite](https://pglite.dev/docs/). Minimal Auth fixtures exercise anonymous, unrelated-user, Workspace reader, Auth-admin and backend access, including forged metadata and invalid provider claims. Tests cover evidence preservation, shared captures, corrections, UTC timing and delivery state; the shared fixture also checks another service's data, policies, grants and ownership. This does not verify hosted Auth or PostgREST. Native PostgreSQL could not initialize under this host's shared-memory restrictions, so PGlite is the repeatable local test path.

## Database deployment

The shared Supabase project is `chm` (`vhlfumeyhkeospnemukq`), using database `postgres`. Apply migrations `20261001150000` through `20261001180000` together with the matching collector and frontend. The current frontend requires `tracker_status` and `source_details`; it cannot run against the older schema. The notifier remains local-only and applies these migrations to its own database.

Deployment preflight on 2026-10-01 found six applied migrations, all matching local SQL, and 25 trackers, 12 records and 14 captures. The four pending migrations passed a transactionally rolled-back rehearsal against those rows: five tables/59 columns, preserved evidence and configuration, ten shortened descriptions, and private raw captures/deliveries. All 37 local tests and the production build pass. Deployment is awaiting Firebase reauthentication; hosted state is unchanged.

The user confirmed on 2026-10-01 that `chm` is on Free with no paid add-ons. This resolves the plan prerequisite; the denied organization/add-on reads need no retry or broader token scopes. Before later remote changes, inspect remaining capacity, schemas, default grants, exposed schemas and full migration history. Never reset the remote project or repair another service's migration history merely to allow Scout's deployment. The foundation migration refuses an existing `scout` schema or global client table defaults that would undermine private future tables.

Use existing CLI authentication, or explicitly provide `SUPABASE_ACCESS_TOKEN` to the process through an approved secret loader. Merely adding that variable to `.env.local` does not ensure CLI authentication. Keep telemetry disabled on this host:

```sh
export SUPABASE_TELEMETRY_DISABLED=1
supabase functions list --project-ref vhlfumeyhkeospnemukq --output json
supabase link --project-ref vhlfumeyhkeospnemukq
supabase migration list --linked
supabase db push --linked --dry-run
# Only after reviewing shared state and the complete pending batch:
supabase db push --linked
```

On 2026-10-01, the existing token explicitly loaded from `.env.local` applied all five reviewed migrations (`20261001050000` through `20261001090000`) through the [Management API SQL endpoint](https://supabase.com/docs/reference/api/v1-run-a-query), avoiding the CLI's known IPv6 preflight. Before applying, the project had no Scout/application tables or migration history and used 10,786,483 bytes. A single transaction applied the unchanged migration bodies and initialized `supabase_migrations.schema_migrations` using the [CLI's version/name/statements format](https://github.com/supabase/cli/blob/HEAD/apps/cli-go/pkg/migration/history.go). Each original file's full SQL is retained as a statement-array entry; remote versions/names/content hashes match all five files. No history was repaired or reset. The documented migration-apply API has no file-version parameter, so this SQL transaction preserved the existing reviewed versions. Use normal pending-migration checks before future deployments; do not replay the foundation batch.

Original foundation checks confirmed RLS on all eight then-existing Scout tables, fixed grants, backend-only deliveries/raw captures, denied unauthorized writes, and no automatic grants on a newly created future table. A transactional service-role CRUD sample passed and rolled back completely. Metadata/ownership/grants/RLS policies outside Scout and existing default privileges remained unchanged. The cleanup preflight measured 12,244,659 database bytes, below the 500 MB planning allowance.

Data API exposure is `public,graphql_public,scout`; only `db_schema` was appended through the [scoped PostgREST configuration API](https://supabase.com/docs/reference/api/v1-update-postgrest-service-config). Row limits, extra search path and pool settings are unchanged. A request using the existing publishable key and `Accept-Profile: scout` returns HTTP 401 / PostgreSQL `42501` (schema access denied) for anonymous access. RLS and explicit grants accompany the schema; no client receives future-table defaults. Workspace readers require no membership setup. An eventual Scout admin may manage trackers but cannot grant admin access, modify collected evidence or read deliveries through the browser. Project-wide service-role access bypasses RLS and belongs only in trusted backend processes.

## Tracker import

`supabase/seeds/trackers.sql` contains the 22 original, manually reviewed tracker identities imported on 2026-10-01. It now uses the lean configuration columns and requires migration `20261001170000` or later. Hosted inventory has since grown to 25; the seed preserves existing identities, app edits and additional trackers. Re-read the live sheet before any authorized new import. For an explicitly authorized re-import after inspecting current state:

```sh
supabase db query --linked --project-ref vhlfumeyhkeospnemukq --file supabase/seeds/trackers.sql
```

If the CLI preflight is unavailable, submit the same SQL through the documented Management API query endpoint after those checks. The seed's immutable `seed_key` is independent of editable URL/collector. Reapplying it skips existing seed identities and preserves app edits, pauses, and collection history. It never synchronizes later sheet changes. A conflicting URL/collector on a different identity fails the transaction rather than silently dropping a source.

The inventory contains 17 websites, four daily `getAuthorFeed` accounts, and one weekly `searchPosts` discovery tracker. Coverage and discovery keywords are preserved; cadence is a single interval, with no narrative meeting-period overrides. The conference-specific row has `url = null` and `enabled = false`; it cannot be enabled until configured. Imported rows have no collection runs, so their derived freshness is empty; import is not a collection attempt. The current seed requires the lean-schema migration and preserves app edits through `seed_key`.

## Manual HSA collection

```sh
npm run collect:hsa
# Or choose an explicit coverage window:
npm run collect:hsa -- --since=2026-09-01
```

This command uses persistent local PostgreSQL at `.cache/hsa-database`, applies the local migrations/seed, and collects only the configured HSA Bluesky tracker. It cannot connect to the hosted database and needs no service credentials. A process lock protects the local database; after an interrupted process, confirm it has stopped before removing `.cache/hsa-collector.lock`. This development database uses minimal Auth fixtures; it is not a hosted Supabase environment.

The default window is the previous 30 days, using feed/repost indexing time for coverage and original publication time for evidence ordering. The collector requests at most two feed pages of 25 posts, follows up to two event/registration links per post and six pages per run, allows three redirects per request, and caps the total at 24 HTTP requests. Every request uses `BBNJ-Scout-Bot/1.0 (+https://bbnj-scout.web.app)`. HTTPS/DNS checks reject private destinations; responses are limited to 512 KiB, each request to 12 seconds, and the run checks a 120-second budget before starting another request. No retries, models, Tavily, or paid APIs are used.

BBNJ records store source excerpts of at most 280 characters; source captures retain the full text. Events use stable event/registration URLs where available; other posts use their Bluesky identity. Structured JSON-LD event data and the observed Zoom registration metadata supply explicit dates. Date-only evidence stays in captures and never becomes an invented UTC timestamp. For the observed HSA format `29 Sept, 7:30 AM EDT`, the collector combines the post's zone with Zoom's full date only when the event URL, month/day, and wall time agree. `date_evidence` keeps only the `schedule_source` and `zone_source` evidence IDs; disagreements report the exact conflicting values and remain partial. Missing evidence stays unknown. Quoted posts are not expanded. This is bounded HSA coverage, not a general website collector or semantic cross-post merger.

Captures are stored in `scout.evidence` and survive separate runs. Unchanged posts reuse extraction; event pages are checked again for corrections and compared by extracted facts so changing page scripts do not create updates. The `hsa-v3` fingerprint prefix identifies the current parser's cache. HSA-authored posts and organizer/registration pages are authoritative. A page's first snapshot has unknown publication chronology and cannot reverse an explicit HSA correction; subsequent changes in its facts receive an evidence observation time. Re-fetching unchanged facts preserves that evidence time. Newer authoritative corrections can replace older ones; old third-party reposts cannot. Compatible date-only observations preserve a supported timestamp. Cosmetic edits do not create a new event or material change.

Evidence history is retained across runs. Slack compares current records against delivery snapshots; collection does not send notifications.

The command prints its coverage window, outcome, counts, and limitations. Exit code 2 means `partial`, `failed`, or `quota`; existing records are preserved. Only fully successful runs, including `no_change`, contribute to the derived `last_success_at`. A remaining feed cursor at the page bound, unavailable/unsupported pages, quoted content, or incomplete registration metadata keeps the result partial. Scheduling remains later work.

### Hosted manual collection

The private `scout-collect-hsa` Edge Function runs HSA collection against hosted `chm.scout`. Send an empty `POST` to `https://vhlfumeyhkeospnemukq.supabase.co/functions/v1/scout-collect-hsa?since=2026-09-01`, with the project's named `default` secret key in the `apikey` header. Omit `since` for the previous 30 days. Read the JSON `outcome`; HTTP 200 alone does not mean source coverage succeeded. Keep this credential in the backend; a PAT, publishable key, or ordinary user JWT is not collector authorization. No browser invocation or generic SQL endpoint is exposed.

`supabase/config.toml` disables the legacy platform JWT check only for this function. The documented [Supabase secret authentication](https://supabase.com/docs/guides/functions/auth) primitive verifies `secret:default` before database or source work. The platform's [injected `SUPABASE_DB_URL`](https://supabase.com/docs/guides/functions/secrets) supplies PostgreSQL access. One transaction and advisory lock prevent overlapping runs; per-record savepoints preserve the existing collector interface. A process/connection failure rolls back that transaction; an HTTP 500 therefore requires inspection before another manual run. Source failures that the collector handles remain stored outcomes. There is no scheduler or retry framework.

The hosted collection deadline is 100 seconds, each source request has at most 12 seconds and 512 KiB, and database statements have a five-second timeout. This leaves headroom within the [Free worker limits](https://supabase.com/docs/guides/functions/limits). Undici's socket connector retains the checked DNS addresses, TLS hostname verification, explicit User-Agent, and manual redirect validation. This replaces the Node HTTP request hook that the deployed Edge runtime does not implement; no plain fetch/DNS-check gap is introduced. The PostgreSQL adapter accepts both existing serialized JSON parameters and JSON objects without encoding them twice.

The original deployment on 2026-10-01 used the [Management API function deploy endpoint](https://supabase.com/docs/reference/api/v1-deploy-a-function), with only the function's `index.ts`/`deno.json` and `collector/hosted-hsa.js`/`hsa.js` uploaded. The import map pins backend dependencies; no environment file is uploaded. No existing functions were present. Before the schema cleanup, version 4 collected 12 records (11 announcements, one event) from 13 posts and one page in three requests. A separate `no_change` run preserved IDs, material hashes/timestamps, 14 source versions and 14 change entries, while advancing `last_success_at`. That release stored the event at `2026-09-29T11:30:00Z`, with source offset `-04:00` and component evidence. Models/Tavily/Slack usage stayed zero. The earlier real transport failure and adapter partial run remain in history; one double-encoded source `parsed` value and two run `stats` values were decoded in place, without changing source content or inventing records. Unauthorized live requests returned 401 and left Scout data unchanged. Workspace reader sign-in is tracked separately above.

## Records and trackers

After the Workspace access check, the app loads every page of records and trackers from the explicit `scout` client. The page fills the browser width. Records open in a horizontally scrolling table with a column for each loaded record field and expandable sources; titles stay visible while scrolling across fields. Icon controls switch between table and card views, with a single text search field. Both views retain event links. Source details distinguish publication, collection and the tracker's last successful collection; record update time remains separate. The signed-in page starts with a small Sign out link, without the branding, introductory header or access panel.

Every tracker remains visible, including paused, unconfigured and unimplemented collectors. The tracker table shows eight configuration fields plus four status fields derived from runs, using sticky headers and a pinned first column. Timestamps display in UTC, enabled displays Yes/No, and empty values display “—”. Partial/failure outcomes do not replace the last successful collection. Event timing updates from the browser clock every 30 seconds and on visibility changes; this does not run or schedule collection. HSA collection is manual-only, and other collectors remain unimplemented.

For local browser review, run `npm run dev` and open `/` on its printed localhost URL. Workspace sign-in requires the browser settings from `.env.example` and an allowed local OAuth redirect.

## Manual Slack delivery

The local notifier shares the collector database and process lock. It applies versioned local migrations, without collection or remote database writes. Run collection first, then explicitly baseline the historical records once. Repeating the baseline preserves later records' notification eligibility. Preparing a message stores its exact JSON payload and record/version evidence without sending:

```sh
npm run notify -- baseline
npm run notify -- findings
npm run notify -- digest 2026-10-01 2026-10-07
npm run notify -- show DELIVERY_ID
# After reviewing that stored payload:
npm run notify -- send DELIVERY_ID
```

`findings` prepares at most five new/material record versions per run, with source links and before/after details for changes. `verification RECORD_ID` prepares one fixed, clearly labelled historical example for milestone-1 verification. Digests are labelled manual verification, use inclusive UTC dates, and include upcoming/in-progress events plus a separate section for records without supported timestamps. Cancelled/past events are excluded; dates without a time and zone cannot qualify for the dated section. A window may span at most 32 days. Messages show at most five dated and three unknown events with explicit counts and collection coverage. Repeating a window or verification request returns its latest explicitly prepared payload. Changed/expired prepared evidence fails before sending; completed requests never repost.

If a delivery fails with `Prepared evidence changed or expired; no message sent.` and has **zero attempts**, explicitly prepare its replacement, inspect the returned new ID, then send it separately:

```sh
npm run notify -- reprepare STALE_DELIVERY_ID
npm run notify -- show NEW_DELIVERY_ID
# After reviewing the new current payload:
npm run notify -- send NEW_DELIVERY_ID
```

This handles newly collected events in the same digest window and findings whose facts or event timing changed before sending. The original failed row, key, payload and snapshot remain unchanged; the new snapshot records `replaces`. Repeating recovery of an old ID returns its existing latest replacement. If that replacement also expires without an attempt, use its ID to explicitly prepare again. Normal window/verification requests follow these links, and findings suppress versions already represented by a replacement. Recovery rejects pending, baseline, sending, unknown, sent and any attempted delivery, including definite 4xx failures. It never sends automatically, replaces an uncertain outcome or resets an attempt count. Another existing delivery for the current record version must be reviewed instead of creating a duplicate.

Only `send` loads `.env.local`; `SLACK_WEBHOOK_URL` must match the existing Ocean Agentics workspace/Scout installation bound to [#scout](https://oceanagentics.slack.com/archives/C0C5PE21KN1). No other token or scope is needed. Source prose uses plain-text blocks; links disable mention parsing and unfurling. The notifier still contains its earlier hosted-access-pending wording; updating that and adding appropriate hosted actions remain SCOUT-06 review work now that Workspace access is live. No synthetic hosted route is advertised.

Delivery state is separate from collection. The notifier records `sending` and increments attempts before network I/O. HTTP 200 with `ok` records webhook acceptance (`sent`), not an independently inspected receipt. Only a definite HTTP 429 permits one retry, respecting `Retry-After` up to 30 seconds; attempts are capped at two. Other 4xx responses are terminal failures. Network errors, timeouts, 5xx/unexpected responses and interrupted `sending` attempts become `unknown`, requiring inspection instead of automatic resend. Requests have a 12-second timeout and a 4 KiB response bound; sends are spaced by at least one second. See Slack's [webhook response guidance](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/) and [rate limits](https://docs.slack.dev/apis/web-api/rate-limits/).

Inspect #scout for the unique `Delivery UUID` footer. When a matching message is confirmed, persist its Slack timestamp and the inspection evidence:

```sh
npm run notify -- receipt DELIVERY_ID 1790856000.123456 "Read matching UUID and source content in #scout."
```

This can reconcile `unknown`/interrupted sends or attach receipt evidence to an accepted send. Absence from a limited history read is not proof of non-delivery. There is deliberately no automatic retry command for failed/uncertain deliveries; `reprepare` is limited to the zero-attempt stale rejection described above. Attempted failures retain the manual-review limitation. The historical baseline and exact payload snapshots are backend-only under the existing delivery RLS; the browser cannot read or invoke this local notifier. This is manual local delivery, not hosted execution or scheduling.

## Hosting deployment

Scout uses Firebase Spark project `ryustatic`, site `bbnj-scout`, deployment target `scout`, and [https://bbnj-scout.web.app](https://bbnj-scout.web.app). `.firebaserc` maps only this target. Recheck shared Hosting capacity and keep billing disabled, then deploy with the saved Firebase login:

```sh
firebase deploy --project ryustatic --only hosting:scout
```

The predeploy step builds `dist`. Deployment uses the documented [Hosting REST API](https://firebase.google.com/docs/hosting/api-deploy) and the same saved login refreshed in memory, because CLI credential-cache writes are restricted here. The last verified Workspace frontend release before cleanup is `sites/bbnj-scout/releases/1790868487090000`, version `95bc9afd5408b180` (three compressed files, 62,670 bytes). Billing remains disabled; Ryu release `sites/ryustatic/releases/1790266049490000` is unchanged. That release verified the original database, hosted HSA collector and real Google-authenticated reader flow. See Database deployment above for cleanup status.
