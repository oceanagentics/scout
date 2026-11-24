# Scout

Scout collects BBNJ events, announcements and official treaty developments, saves useful findings with source URLs, and makes them available through a private website, Slack and calendar tools. The website opens on volunteer review: one finding at a time with its model ranking, an independent Low/Normal/High volunteer ranking and required notes explaining the ranking. Reviewers use their existing Ocean Agentics Google accounts; saved feedback drives their personal count and a celebration every 12 reviews. Calendar, Records, Trackers and Jobs have their own navigation links. Calendar links to the shared Scout Google calendar with instructions for adding it.

The daily local Triage task stores relevant links shared by people in public OA channels as distinct Slack reference cases in the review table, for background ranking analysis. They retain the source link, author, Slack permalink, posting time, observed model category or numeric score when available, expected relevance and a short rationale. Active sharing carries more weight when assessing ranking changes than a volunteer rating alone; Aaron’s shared webinar is an expected High example. These cases are not surfaced in the review UI, do not count as volunteer reviews, create production findings, change operational scores or trigger notifications/calendar publishing.

Collection wakes every six minutes and checks one due tracker. Current trackers have a daily cadence: a fully successful check completes that New York calendar day. New findings post to Slack after saving; a daily 8 a.m. America/New_York reconciliation checks for unposted findings scoring at least 75. Channel receipts prevent repeats; dev DMs have separate delivery behavior. This guide describes the local code; it does not certify what is currently deployed.

Bluesky collection resumes after its last successfully committed checkpoint so consumed posts are not investigated again. New trackers and changed URLs have no checkpoint. Shared ingestion excludes native posts originally published before the one-calendar-month cutoff in America/New_York, before model calls or per-post writes. Eligible posts run oldest first across bounded attempts; feed pagination stops at the age boundary or committed checkpoint. A recent repost does not make an expired original eligible. The age cutoff never seeds or replaces committed progress.

Web trackers have an explicit Page or Index setting. Tracker configuration is managed agentically; the website's Trackers table is read-only. Page investigates the configured page itself and can follow supporting links. Index uses RSS or webpage discovery to supply individual publication URLs to the same item ingestion service. Their publication dates are hints: an old date alone does not discard new or changed content. Compact pending-item state resumes interrupted lists. Index freshness is checked before discovery, and article freshness before investigation; unknown freshness still requires investigation. A parent checkpoint never establishes article freshness. Confirmed old findings still pass through the existing save-age filter. Finding URLs are saved separately from supporting and unclassified legacy URLs.

## Files and responsibilities

| Location | Purpose |
| --- | --- |
| [website/](website/) | Browser interface, sign-in, records, trackers and calendar controls. Includes the HTML entrypoint, public environment settings, Firebase configuration and generated `dist/`. |
| [reader/](reader/) | Check tracker URLs, call models, save findings and update tracker state. |
| [reader/models/](reader/models/) | Model gateway and provider adapters. |
| [slackbot/](slackbot/) | Post newly saved findings and scheduled digests using Scout's bot token; contains the desired Slack app manifest. Explicit repeated requests can send the same findings again. |
| [calendar/](calendar/) | OAuth publishing and reconciliation for the shared Scout calendar for scores of at least 75 and Danny's private Scout Everything review calendar. |
| [shared/](shared/) | Pure date and record rules used by multiple features. |
| [supabase/](supabase/) | Database migrations, hosted entrypoints, access rules and operational SQL. |
| [diagnostics/](diagnostics/) | Local model troubleshooting; see its [instructions](diagnostics/README.md). |
| [tests/](tests/) | Automated checks. |
| [package.json](package.json), [package-lock.json](package-lock.json) | Commands and pinned dependencies for the whole project. |

Read [architecture](docs/architecture.md) for the workflows and storage design, and [AGENTS.md](AGENTS.md) for engineering constraints. Completed plans and run diaries are available in Git history.

## Local development

Use Node.js 22.18+ and npm. Tests import the Supabase TypeScript entrypoint directly. Run from the repository root:

```sh
npm ci
npm run dev
```

The dev server uses `http://127.0.0.1:5173/` and requires that port. Vite loads [website/index.html](website/index.html).

If browser settings are not already configured, copy [website/.env.example](website/.env.example) to the ignored `website/.env.local` and set the Supabase URL and publishable key. Only public settings belong in `VITE_` variables; never use a secret/service-role key. Mode-specific browser environment files also belong in `website/`.

Local sign-in uses the hosted Supabase project. Its Auth Redirect URLs must include exactly `http://127.0.0.1:5173/`; keep the shared Site URL and existing production redirects. Use the printed address consistently rather than substituting `localhost`. Without browser settings, the app displays its setup state.

```sh
npm test
npm run build
npm run preview -- --port 5173 --strictPort
```

The build writes ignored `website/dist/`; preview serves that output. Stop the dev server before previewing so port 5173 is available. Use the same `http://127.0.0.1:5173/` origin for sign-in and calendar controls. Database tests use in-memory PGlite. Mocked tests establish mechanics, not live extraction accuracy or production costs.

## Backend commands

Local credentials stay in the ignored root `.env.local`; [the example](.env.example) distinguishes deployment, endpoint and model credentials. Hosted entrypoints read their own Edge Function secrets. Another checkout does not inherit your local file.

The following commands contact production and require an explicitly scoped run within provider allowances. They do not start recurring work:

```sh
npm run reader -- --tracker=UUID
npm run notify -- --send --kind=unposted
```

Omit `--tracker` to check the next due enabled tracker. An explicit tracker ID also retries a tracker that stopped after three unsuccessful attempts. URLs come from the tracker row. Both commands require `SCOUT_BACKEND_KEY`. Local model diagnostics also make real model calls; use [diagnostics/README.md](diagnostics/README.md) for their separate behavior and capture exception.

### Scraping fallback

Scout reads source URLs directly first. A Cloudflare challenge or a recognized HTML challenge/empty Angular shell uses Jina, then Tavily Advanced Extract, then Firecrawl. Successful direct reads, unchanged responses, native PDF/images, ordinary HTTP errors and rejected private URLs do not call extractors. All attempts share the existing 15-second URL-read deadline. Search is not connected to these services.

| Service | Account and credential | Role |
| --- | --- | --- |
| [Jina Reader](https://jina.ai/reader/) | Anonymous; no key | First extraction fallback. Requests browser rendering, fresh content and no server caching/logging with `DNT: 1`. |
| [Tavily](https://app.tavily.com/) | Existing account; `TAVILY_API_KEY` | Advanced extraction. Search and extraction share the provider's credit balance. |
| [Firecrawl](https://www.firecrawl.dev/) | Free account; `FIRECRAWL_API_KEY` | Final extraction fallback. Requests fresh Markdown with index/cache storage disabled. |

Keep accounts on free plans without automatic paid top-ups. Add keys to the ignored root `.env.local` for diagnostics and to the same-named Supabase Edge Function secrets for hosted collection. Missing keys skip that service; Jina remains available anonymously. A local key is not automatically a hosted secret. No provider key belongs in browser settings or Git.

Quota, authentication, rate-limit and server errors make a service unavailable for the rest of the current collection check; page-specific extraction failures only affect that URL. Each later check evaluates availability again, so renewed allowances recover without a manual switch. There is no local credit ledger or quota polling. Concurrent requests already in flight can encounter the same limit before its first rejection arrives.

Extracted bodies remain in memory and preserve the public source URL. Provider API/cache metadata does not establish source freshness: fallback reads never claim `unchanged` or acknowledge HTTP freshness fields. Invocation diagnostics add numeric `source.scraping` attempt counts by provider alongside existing HTTP request/byte and SQL costs. Routing adds no SQL or model calls itself. At most three extraction requests are added per blocked URL, with known-unavailable services skipped; recovered pages can enable investigations that previously could not run. Before unattended use, measure real provider allowances and daily blocked-page activity from the hosted environment. The local diagnostic capture exception remains unchanged.

## Slack credentials

Scout uses one Slack app, `A0C5P53NAPM`, in workspace `TFZ8FRLBV`. Its bot is `B0C5TDBU5UN`, user `U0C6PNRPX4G`, displayed as Scout. Findings scoring at least 75 post to private `#scout` (`C0C5PE21KN1`). Newly saved findings scoring below 75 go immediately to Danny Vallentyne (`U0AQY6J9SG7`) in Scout's existing DM (`D0C5XA5RT41`). Keep this app, bot and installation as the enduring identity; identify them by these IDs rather than a display name or username. Keep credentials in the ignored root `.env.local` and load them in memory without printing values.

| Credential | Purpose |
| --- | --- |
| `SCOUT_SLACK_BOT_TOKEN` | Same local and hosted secret name. The reader/notifier use `chat.postMessage` as this bot; the same identity can edit/delete its own messages. |
| `SLACK_SIGNING_SECRET` | Same local and hosted secret name. Verifies raw inbound requests to `scout-slack`, including the timestamp. Must belong to the same app as the bot token. |

All Scout posts, maintenance replies and future agent replies must use this bot token with the Slack Web API. The reader and notifier share `botTransport` in [slackbot/slack.js](slackbot/slack.js). There is no webhook transport or fallback. Do not create another app/bot, add an incoming webhook, or override message authorship to obtain posting or editing access. The signing secret authenticates inbound requests; it is not a posting credential.

### Posting, reading and maintaining messages

Use `Authorization: Bearer <SCOUT_SLACK_BOT_TOKEN>` for every call. Use GET query parameters for reads and JSON POST bodies for message writes. These are API operations, not commands to send to Scout in Slack.

| Operation | Slack method and required identifiers |
| --- | --- |
| Post | `chat.postMessage`: `channel`, `text`; keep the returned `channel` and `ts` for subsequent operations. |
| Reply in a thread | `chat.postMessage`: `channel`, `thread_ts` set to the original message's `ts`, and `text`. Leave `reply_broadcast` false. |
| Read channel/DM messages | `conversations.history`: the conversation's `channel` ID; follow pagination. |
| Read a thread | `conversations.replies`: `channel`, `ts` of the parent; follow pagination. |
| Edit a bot-owned message | `chat.update`: `channel`, `ts` of that message and its revised content. |
| Delete a bot-owned message | `chat.delete`: `channel`, `ts` of that message. Deletion is irreversible and requires explicit authorization. |

Before maintenance, check `auth.test` against the workspace, bot and user IDs above, then read the target message and verify its author. Use `bots.info` when its App ID is absent from the message. Read/confirm channel access; do not change membership unless requested. A DM uses its `D…` conversation ID. The connected Slack user account is a separate author and cannot edit Scout's messages.

For a URL correction, preserve the original text, timestamp and unrelated content; update the matching links in both text and existing blocks/attachments. Do not use the legacy `as_user` argument or username/icon overrides. Read the saved message afterward and require `ok: true` in the API response, not merely HTTP 200. If a write times out or its outcome is uncertain, inspect the conversation before repeating it. Report the exact method and sanitized Slack error when blocked.

Remaining historical webhook posts belong to a different posting identity, even though they came from the same app. This bot cannot edit them. Use a bot thread reply for an authorized correction, or the workspace owner's account for an explicitly authorized deletion. Removing webhook authorizations does not transfer ownership of those old posts.

### Enduring Slack app configuration

[manifest.json](slackbot/manifest.json) records the exported configuration of this existing app. Event delivery is enabled at the verified HTTP URL below, and the complete communication scope bundle is granted to the existing token. Before future changes, compare the live manifest and preserve unrelated settings. `apps.manifest.update` replaces the entire configuration and requires an app configuration token; the bot token cannot manage the app. Never create a replacement app to obtain permissions. Reauthorize the same installation when new permissions are required, then verify the actual token identity and granted scopes locally and hosted.

| Capability | Bot scopes / settings |
| --- | --- |
| Post, edit and delete Scout-owned messages | `chat:write`; normal bot identity, without impersonation. |
| Read public/private channels and threads | `channels:history`, `groups:history`; `channels:read`, `groups:read` for discovery and access checks. |
| Enter a public channel when explicitly requested | `channels:join`. Private channels require an invitation. |
| Read/open direct and group direct conversations with Scout | `im:history`, `im:read`, `im:write`, `mpim:history`, `mpim:read`, `mpim:write`. |
| Receive mentions and subsequent replies without another mention | `app_mentions:read`; subscribe to `app_mention`, `message.channels`, `message.groups`, `message.im`, `message.mpim`. |
| Verify bot/user identity | `users:read`. |
| Let people message Scout through its app | Enable the App Home Messages tab with read-only disabled. |
| Receive future calendar button actions | Enable interactivity at the same signed-request URL. |

The stable Events API/interactivity URL is `https://vhlfumeyhkeospnemukq.supabase.co/functions/v1/scout-slack`. Deploy the signed-request endpoint before configuring its URL. It currently verifies URL challenges and acknowledges events/button payloads, discarding their bodies without logs, database work, model calls or replies. Agent answering and actions are deferred; successful event acknowledgement does not establish a working conversation. Future conversation code must preserve prompt acknowledgement, handle Slack retries without duplicate work, ignore its own messages and reconstruct context from Slack without retaining transcripts.

This setup covers conversations Scout participates in, not other people's DMs or private channels it cannot access. Bot edit/delete rights apply only to that bot's posts. Each finding message carries its saved record ID in metadata, so future thread actions can retrieve the record without matching prose. Channel threads and DM follow-ups without mentions use the configured subscriptions and permissions; their deferred answering code belongs behind the same endpoint.

The deployed reader and notifier use the bot token; `scout-slack` receives signed HTTP events, replacing the unused Socket Mode configuration. Releases must preserve each job's active state except explicitly retired jobs. Inbound events use one function invocation, zero model calls, zero SQL and zero retained message-body bytes; Slack retries add invocations. Nonempty outbound batches use two SQL reads and one posting request per finding, plus two small receipt mutations per confirmed channel post. Dev DMs make no channel-receipt writes. Daily reconciliation reads paginated channel history only when unconfirmed records scoring at least 75 exist and can repair receipts in one batch. For an authorized live check, verify the saved description, source URL, author and record metadata, then prove a repeated channel send is skipped. Require Slack `ok:true`, not merely HTTP 200. Mocked tests do not establish live permissions or ownership. If a local backend key is absent, the scheduler's existing credential is in Vault as `scout_loop_backend_key`; use it only in memory for authorized backend invocations, without printing it.

Incoming webhooks are disabled and their three historical authorizations have been removed. Only the bot installation remains authorized. Remove obsolete webhook secrets locally and hosted; do not restore them. The two Slack credentials listed above are the only ones Scout needs. Keep the signed Events API/interactivity receiver enabled: removing outbound incoming webhooks does not remove inbound channel/DM event delivery.

## Slack schedules and timezone

Scout uses `America/New_York` for schedules, calendar-day boundaries, tracker retirement, model “today” and operational time display. Stored timestamps remain UTC; source dates and timezones remain as published.

- New findings: after committed collection work, the hosted reader posts newly created findings scoring at least 75 to `#scout` and DMs newly created findings scoring below 75 to Danny. Updates, unchanged findings and unassessed records do not post.
- Daily reconciliation: 8 a.m. New York (5 a.m. Pacific), all pending or uncertain findings scoring at least 75, with no date/type restriction. This is the only automatic channel-history scan. The weekly repeating digest is retired.
- Every notification message contains one finding: its saved description and evidenced finding link, labeled with the source's brief publisher name (for example, Bloomberg), plus the record ID in metadata. Existing unnamed sources keep Read more; legacy records without an evidenced finding URL omit the link. Messages send sequentially, spaced at least one second apart; no grouped posts or model calls. Empty notifications are skipped. Delivery stops on a failed or uncertain send and reports the confirmed count and sanitized error.
- `records.slack_channel_post` records only delivery to `#scout`: null is pending, `{"state":"uncertain"}` is a claimed/unresolved send, `{"state":"posted","ts":"…"}` is a confirmed Slack message ID, and `{"state":"do_not_post"}` explicitly excludes a finding from channel posting without claiming a message exists. The database constrains these exact shapes. The central sender skips posted and do-not-post records, atomically claims pending channel posts and saves acknowledgements without changing finding revisions. Dev DMs, including a finding scoring at least 75 sent to a DM, neither create nor consume these receipts. Deleting a Slack message or editing a finding does not clear its receipt or exclusion.
- Definite Slack rejections return a claim to pending. Lost acknowledgements remain uncertain; daily history can recover their receipt using Scout's record-ID metadata. Missing/incomplete history never authorizes a blind retry. Unresolved delivery requires review. Existing rows start unconfirmed; seed only evidenced historical receipts, including verified deleted posts. Do not treat missing legacy metadata as proof a finding was never posted.

The model's shared 0–100 ranking policy lives in [shared/rankings.md](shared/rankings.md). Humans edit that file, then run `npm run build:rankings` and `npm test`. The build writes the committed [rankings.generated.js](shared/rankings.generated.js) string imported by [reader/instructions.js](reader/instructions.js). Tests reject stale generated text. Regenerate before deploying `scout-reader`; the existing `--use-api` deployment process bundles ordinary JavaScript, with no runtime file reads. Policy changes require redeployment. The publication threshold is `PUBLICATION_SCORE` in [shared/records.js](shared/records.js), initially 75; destinations and delivery rules remain in [slackbot/slack.js](slackbot/slack.js). Existing Low/Normal/High findings start at 25/60/85. Historical review categories remain intact; human reviewers select Low/Normal/High, stored as categorical feedback alongside the observed numeric model score. Human feedback is reviewed separately to inform future rubric changes; collection does not load reviews or Slack reference cases into model requests. Collection keeps its existing models and reasoning. Daily high-reasoning reranking is deferred; no ranking job is installed.

[scout-loop.sql](supabase/scout-loop.sql) installs collection, daily reconciliation (`scout-morning`) and calendar jobs paused, retiring the weekly notification job. Supabase cron uses GMT: the morning job wakes at both possible UTC hours but dispatches exactly once at 8 a.m. New York, including daylight saving. The shared loop bounds these jobs' completed cron history to one day. After deploying and verifying the reader and notifier, restore each retained job's prior active state as required by [AGENTS.md](AGENTS.md). A receipt cutover pauses collection and notification jobs until old workers finish and confirmed receipts are seeded; restore their prior active state after verification.

Manual notification requests require `kind=unposted`, or `kind=findings&ids=UUID,...`. Channel receipts apply to both routes. Explicit dev-DM requests can still repeat a DM. `npm run notify -- --send --kind=unposted` explicitly runs reconciliation immediately, regardless of hour. Failed or uncertain notification responses use HTTP 502 and include sanitized reasons; no traffic or delivery history is persisted.

## Supabase deployment

Scout's Supabase project is **`vhlfumeyhkeospnemukq`**. `scout-calendar` is the Supabase Edge Function reconciling both Scout Google calendars. Deploying it replaces its running code on Supabase.

Function deployment uploads files from the current checkout. Make sure it contains the intended reviewed change. Pushing to Git, deploying the Firebase website and updating database rows are separate operations; this checkout has no automatic Supabase deployment workflow. Eligible new or edited findings publish to Google Calendar without a code deployment.

The Jobs API needs the `http` extension enabled in the `extensions` schema and one encrypted Vault secret named `scout_functions_read_key`. Use a dedicated scoped Supabase token restricted to this project with only **Edge Functions → Read** permission. The function reads deployed inventory directly from the Management API; there is no saved function list or trigger registry. Keep the token out of browser settings, migrations and logs, and keep the separate deployment access token local. Provision the read credential before applying the Jobs migration and releasing the website. The migration replaces `scout.cron()` with `scout.jobs()` without pausing or changing schedules. Verify a signed-in Jobs read, rejection of an unsigned request, four live Scout function rows and three cron rows, plus preserved job states. Mocked HTTP tests do not establish live inventory access or actual response cost.

### Authentication

An agent authorized to deploy can perform the deployment with configured credentials. It does not require Danny to run the command personally. Local tool/network approvals and Supabase account permissions still apply.

| Credential | Purpose |
| --- | --- |
| `SUPABASE_ACCESS_TOKEN` | Authenticates the Supabase CLI/Management API. Must have access to this project and Edge Functions write permission; fine-grained tokens call this `edge_functions_write`. |
| `SCOUT_BACKEND_KEY` | Invokes deployed Scout reader/notification endpoints. Cannot deploy code. |
| Browser publishable key | Browser API access. Cannot deploy code. |
| Model keys | Model calls by the reader or local diagnostics. Cannot deploy code. |

Check the runtime environment and the ignored root `.env.local` without printing values. Git does not supply this file or its credential values to another checkout. Use an authorized Supabase account/token or an existing CLI login; empty entries copied from `.env.example` do not authenticate. Keep deployment credentials local to the deployment environment, not in browser settings or hosted function secrets.

### Deploy the changed function

Run relevant existing tests and review the diff first. With the Supabase CLI installed and already authenticated, or `SUPABASE_ACCESS_TOKEN` already loaded in its environment, run from the repository root:

```sh
supabase functions deploy scout-calendar --project-ref vhlfumeyhkeospnemukq --use-api
```

The CLI command above does not load the root `.env.local`. If that file holds the token, this command uses [Node's `--env-file` option](https://nodejs.org/api/cli.html#--env-filefile) to load it and pass it to the CLI without printing it:

```sh
node --env-file=.env.local --input-type=module -e '
  import {spawnSync} from "node:child_process";
  if (!process.env.SUPABASE_ACCESS_TOKEN) throw new Error("SUPABASE_ACCESS_TOKEN is missing");
  const result = spawnSync("supabase", [
    "functions", "deploy", "scout-calendar",
    "--project-ref", "vhlfumeyhkeospnemukq", "--use-api"
  ], {stdio: "inherit"});
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
'
```

Replace `scout-calendar` only when deploying a different changed function:

| Changed code | Function to deploy |
| --- | --- |
| `calendar/` shared publishing code | `scout-calendar` and `scout-reader` |
| Calendar hosted entrypoint | `scout-calendar` |
| `reader/` or its hosted entrypoint | `scout-reader` |
| `slackbot/slack.js` | `scout-reader` and `scout-notify` |
| `supabase/functions/scout-notify/index.ts` | `scout-notify` |
| Slack signed-request entrypoint | `scout-slack` |
| A shared module | Each function importing that module, directly or indirectly. |

Keep the entrypoint, import map and `verify_jwt` settings in [supabase/config.toml](supabase/config.toml). The functions enforce their own request authentication. Specify the function name rather than deploying unrelated functions or pruning the shared project. `--use-api` performs server-side bundling without Docker; see the [CLI reference](https://supabase.com/docs/reference/cli/supabase-functions-deploy).

### CLI file-permission errors and direct API deployment

An `EPERM`/`EACCES` while the CLI writes `~/.supabase/telemetry.json` is a local filesystem failure, not a Supabase authorization response. Use the tool's approval mechanism for required local access. If the CLI remains unusable and authorized API access is available, use the [Management deployment API](https://supabase.com/docs/reference/api/v1-deploy-a-function), which has already been used for Scout deployments.

For `scout-calendar`, POST to `https://api.supabase.com/v1/projects/vhlfumeyhkeospnemukq/functions/deploy?slug=scout-calendar` with `Authorization: Bearer <SUPABASE_ACCESS_TOKEN>` and a `multipart/form-data` body. Construct the header in memory from the environment; do not print the credential. Add a `metadata` field containing:

```json
{
  "name": "scout-calendar",
  "entrypoint_path": "supabase/functions/scout-calendar/index.ts",
  "import_map_path": "supabase/functions/scout-reader/deno.json",
  "verify_jwt": false
}
```

Add repeated `file` fields with repository-relative filenames and file contents. Include the entrypoint, import map and all local imports. The current calendar bundle contains:

```text
supabase/functions/scout-calendar/index.ts
supabase/functions/scout-reader/deno.json
calendar/hosted.js
calendar/google.js
reader/database.js
shared/finding-dates.js
shared/records.js
```

Follow any additional local imports introduced by the change. The [Supabase API example](https://supabase.com/changelog/33720-deploy-and-update-edge-functions-using-the-management-api) documents this multipart format. A missing token, a Supabase HTTP 401/403 and a local filesystem denial are different blockers; report the exact failing operation and sanitized error rather than handing deployment to Danny by default.

### Verify the release

Confirm the returned deployment status/version, then read it back through `GET https://api.supabase.com/v1/projects/vhlfumeyhkeospnemukq/functions/scout-calendar` using Management API authentication. Metadata confirms which deployment is active; also verify the requested behavior.

For calendar changes, verify that `feed-link` and `feed.ics` return HTTP 404. Reconcile and read back both Google calendars: the shared Scout calendar must contain only events scoring at least 75, while Danny's private Scout Everything calendar must contain all saved events, including lower-scored and unassessed events. Both require exact start dates and include past events. Keep Google event IDs unchanged and leave unmanaged entries untouched. Verify that the feed token, feed-secret SQL function and obsolete trial table are absent while the Google credential remains. For website changes, deploy Firebase separately and verify the released assets too.

Google publishing uses the encrypted Vault secret `scout_calendar_google` containing `client_id`, `client_secret`, `user_id` and `refresh_token`. The shared Scout calendar is `c_c4eba5697d3a3e33c4590daa7c20c8791d7d608b787ff959bf3117f3a7d02df5@group.calendar.google.com`; Danny's private Scout Everything calendar is `c_d6d8bace0ef22918c156fc9878f310a210a4feb47a7f078744a99cceef293633@group.calendar.google.com`. The backend-only `POST scout-calendar/reconcile` accepts an empty body and the existing backend `apikey`. It returns confirmed create/update/remove/unchanged counts across both calendars, Google request counts and SQL costs. Run it after deploying the shared publishing code; a repeat should make no event writes. An unchanged full reconciliation uses one OAuth refresh, two Google list requests and two SQL reads, with no SQL writes or model calls. The daily job reconciles at 4 a.m. New York time. Preserve each existing job's prior active state, including after installing `supabase/scout-loop.sql`.

A function deployment does not apply database migrations. For a requested schema change, inspect remote migration history and apply only the reviewed pending Scout migrations, coordinating the affected consumers. If the release requires a temporary pause, restore each job's prior active state after verification as required by [AGENTS.md](AGENTS.md). Do not invoke the reader, send Slack messages, or run historical cutover SQL merely to verify deployment. Report what was checked locally, what was verified live, and any remaining blocker.

## Website deployment

The website uses Firebase project `ryustatic`, site `bbnj-scout`, target `scout`: [Scout](https://bbnj-scout.web.app). Configuration and target mapping live together in [website/firebase.json](website/firebase.json) and [website/.firebaserc](website/.firebaserc).

With the Firebase CLI installed and authenticated, run an approved deployment from the repository root:

```sh
(cd website && firebase deploy --project ryustatic --only hosting:scout)
```

The predeploy hook runs the root npm build and deploys `website/dist/`. It uses Firebase's documented [`PROJECT_DIR` hook variable](https://firebase.google.com/docs/cli#environment_variables). Keep the Scout target, security headers, shared-project capacity and disabled billing intact; verify the released assets after deployment.

Backend releases follow [Supabase deployment](#supabase-deployment). A website deployment does not deploy functions or SQL.
