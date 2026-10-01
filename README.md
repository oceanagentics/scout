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

Current remote limitation: the CLI's linked-query path fails its IPv6 connection preflight even after relinking, and unattended token access is currently unavailable. Remote inspection and migration have not run. If this CLI preflight remains a problem after authentication is restored, use Supabase's documented [Management API](https://supabase.com/docs/reference/api/introduction) with the same authorized project access; inspect before applying a migration.

After migration, append `scout` to the project's existing Data API exposed-schema list, preserving every existing service setting. Do not push a replacement project configuration. RLS and explicit grants are included in the migration; no client receives future-table defaults. Provision reader/admin membership only for explicitly approved Auth user IDs through trusted backend access. An admin can manage trackers but cannot provision membership, modify collected evidence, or read delivery state through the browser. Project-wide service-role access bypasses RLS and belongs only in trusted backend processes.

## Hosting deployment

Scout uses Firebase Spark project `ryustatic`, site `bbnj-scout`, deployment target `scout`, and [https://bbnj-scout.web.app](https://bbnj-scout.web.app). `.firebaserc` maps only this target. Recheck shared Hosting capacity and keep billing disabled, then deploy with the saved Firebase login:

```sh
firebase deploy --project ryustatic --only hosting:scout
```

The predeploy step builds `dist`. The initial deployment uses the documented [Hosting REST API](https://firebase.google.com/docs/hosting/api-deploy) and the same saved login refreshed in memory, because CLI credential-cache writes are restricted here. No new credential or paid service is required. The live shell intentionally shows setup status until the database and authorized membership are ready; a hosted database sample read remains an open SCOUT-02 criterion.
