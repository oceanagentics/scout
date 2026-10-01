# BBNJ Scout

Scout is Ocean Agentics' planned app for keeping up with BBNJ: treaty ratifications, NGO webinars, official DOALOS announcements, conferences, and side events. It will maintain a central database, surface useful changes in Slack, and make events easy to find and add to a calendar.

The project is currently in planning. The proof-of-concept target is **$0/month in recurring service fees**.

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

There is no application implementation or runnable development setup yet. Add run, migration, and deployment instructions as those capabilities are built.
