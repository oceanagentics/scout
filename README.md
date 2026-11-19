# Scout

Scout collects BBNJ events, announcements and official treaty developments, saves useful findings with source URLs, and makes them available through a private website, Slack and calendar tools. The website opens on volunteer review: one finding at a time with its model ranking, an independent volunteer ranking and required notes explaining the ranking. Reviewers use their existing Ocean Agentics Google accounts; saved feedback drives their personal count and a celebration every 12 reviews. Records, Trackers and Calendar have their own navigation links. Calendar links to the shared Scout Google calendar with instructions for adding it.

Review also has a separate **Slack postings** section for relevant links shared by people in public OA channels. These compact reference cases live in the review table and retain the source link, author, Slack permalink, posting time, observed model priority when available, expected priority and a short rationale. The daily local Triage task collects new postings. Active sharing carries more weight when assessing ranking changes than a volunteer rating alone; Aaron’s shared webinar is an expected High example. These cases do not count as volunteer reviews, create production findings, change operational priorities or trigger notifications/calendar publishing.

Collection wakes every six minutes and checks one due tracker. Current trackers have a daily cadence: a fully successful check completes that New York calendar day. New findings post to Slack after saving; morning events post daily at 8 a.m. and the weekly high-priority digest posts Mondays at 9 a.m., America/New_York. This guide describes the local code; it does not certify what is currently deployed.

Bluesky collection resumes after its last successfully committed checkpoint so consumed posts are not investigated again. New trackers and changed URLs have no checkpoint. Shared ingestion excludes native posts originally published before the one-calendar-month cutoff in America/New_York, before model calls or per-post writes. Eligible posts run oldest first across bounded attempts; feed pagination stops at the age boundary or committed checkpoint. A recent repost does not make an expired original eligible. The age cutoff never seeds or replaces committed progress.

Web trackers have an explicit Page or Index setting. Tracker configuration is managed agentically; the website's Trackers table is read-only. Page investigates the configured page itself and can follow supporting links. Index uses RSS or webpage discovery to supply individual publication URLs to the same item ingestion service. Their publication dates are hints: an old date alone does not discard new or changed content. Compact pending-item state resumes interrupted lists. Index freshness is checked before discovery, and article freshness before investigation; unknown freshness still requires investigation. A parent checkpoint never establishes article freshness. Confirmed old findings still pass through the existing save-age filter. Finding URLs are saved separately from supporting and unclassified legacy URLs.

## Files and responsibilities

| Location | Purpose |
| --- | --- |
| [website/](website/) | Browser interface, sign-in, records, trackers and calendar controls. Includes the HTML entrypoint, public environment settings, Firebase configuration and generated `dist/`. |
| [reader/](reader/) | Check tracker URLs, call models, save findings and update tracker state. |
| [reader/models/](reader/models/) | Model gateway and provider adapters. |
| [slackbot/](slackbot/) | Post newly saved findings and scheduled digests using Scout's bot token; contains the desired Slack app manifest. Explicit repeated requests can send the same findings again. |
| [calendar/](calendar/) | OAuth publishing and reconciliation for the shared High-only Scout calendar and Danny's private all-priority Scout Everything review calendar. |
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
npm run notify -- --send --kind=weekly
```

Omit `--tracker` to check the next due enabled tracker. An explicit tracker ID also retries a tracker that stopped after three unsuccessful attempts. URLs come from the tracker row. Both commands require `SCOUT_BACKEND_KEY`. Local model diagnostics also make real model calls; use [diagnostics/README.md](diagnostics/README.md) for their separate behavior and capture exception.

## Slack credentials

Scout uses one Slack app, `A0C5P53NAPM`, in workspace `TFZ8FRLBV`. Its bot is `B0C5TDBU5UN`, user `U0C6PNRPX4G`, displayed as Scout. High-priority findings post to private `#scout` (`C0C5PE21KN1`). Newly saved Normal/Low findings go immediately to Danny Vallentyne (`U0AQY6J9SG7`) in Scout's existing DM (`D0C5XA5RT41`). Keep this app, bot and installation as the enduring identity; identify them by these IDs rather than a display name or username. Keep credentials in the ignored root `.env.local` and load them in memory without printing values.

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

The deployed reader and notifier use the bot token; `scout-slack` receives signed HTTP events, replacing the unused Socket Mode configuration. Releases must preserve each job's active state; these functions need no SQL or cron reinstall. Measure event activity against the actual shared Supabase allowance before adding work: each receipt uses one function invocation, zero model calls, zero SQL and zero retained message-body bytes; Slack retries add invocations. Nonempty outbound batches use two SQL reads, zero delivery-state writes and one posting request per finding. For an authorized live check, prove post/read/edit/read/delete in `#scout` and a DM, verify record metadata and the saved finding URL, and verify delivery of unmentioned replies. Require Slack `ok:true`, not merely HTTP 200. Mocked tests do not establish live permissions or ownership. If a local backend key is absent, the scheduler's existing credential is in Vault as `scout_loop_backend_key`; use it only in memory for authorized backend invocations, without printing it.

Incoming webhooks are disabled and their three historical authorizations have been removed. Only the bot installation remains authorized. Remove obsolete webhook secrets locally and hosted; do not restore them. The two Slack credentials listed above are the only ones Scout needs. Keep the signed Events API/interactivity receiver enabled: removing outbound incoming webhooks does not remove inbound channel/DM event delivery.

## Slack schedules and timezone

Scout uses `America/New_York` for schedules, calendar-day boundaries, tracker retirement, model “today” and operational time display. Stored timestamps remain UTC; source dates and timezones remain as published.

- New findings: after committed collection work, the hosted reader posts newly created High findings to `#scout` and DMs newly created Normal/Low findings to Danny. Updates, unchanged findings and unassessed records do not post.
- Morning: 8 a.m. daily, high-priority exact-day events occurring today in New York. Without a known instant, use the published calendar date. Partial dates are excluded.
- Weekly: 9 a.m. Monday, pending high-priority events, including undated events, plus high-priority announcements first saved in the preceding seven New York days.
- Every notification message contains one finding: its saved description and evidenced finding link, plus the record ID in metadata. Legacy records without an evidenced finding URL omit Read more. Messages send sequentially, spaced at least one second apart; no grouped posts or model calls. Empty notifications are skipped. Delivery stops on a failed or uncertain send and reports the confirmed send count. Delivery is best effort, with no persistent delivery state or automatic retry after uncertain sends.

The model's priority rubric is stored in [reader/instructions.js](reader/instructions.js). Priority selection, destinations, individual message format and delivery rules are enforced in [slackbot/slack.js](slackbot/slack.js), shared by the reader and scheduled notifier.

[scout-loop.sql](supabase/scout-loop.sql) installs three paused jobs and replaces the obsolete notification jobs. Supabase cron uses GMT: digest jobs wake at both possible UTC hours and dispatch only at the matching New York hour, including daylight saving. The shared loop bounds these jobs’ completed cron history to one day. After deploying and verifying the reader and notifier, restore each job's prior active state as required by [AGENTS.md](AGENTS.md). On initial setup or an explicitly requested restart, enable `scout-collection`, `scout-morning` and `scout-weekly`.

Manual notification requests require `kind=morning`, `kind=weekly`, or `kind=findings&ids=UUID,...`. Repeating a request may repeat the post. `npm run notify -- --send --kind=morning` sends the morning digest immediately, regardless of hour.

## Supabase deployment

Scout's Supabase project is **`vhlfumeyhkeospnemukq`**. `scout-calendar` is the Supabase Edge Function reconciling both Scout Google calendars. Deploying it replaces its running code on Supabase.

Function deployment uploads files from the current checkout. Make sure it contains the intended reviewed change. Pushing to Git, deploying the Firebase website and updating database rows are separate operations; this checkout has no automatic Supabase deployment workflow. Eligible new or edited findings publish to Google Calendar without a code deployment.

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

For calendar changes, verify that `feed-link` and `feed.ics` return HTTP 404. Reconcile and read back both Google calendars: the shared Scout calendar must contain only High events, while Danny's private Scout Everything calendar must contain all saved events, including Normal, Low and unassessed events. Both require exact start dates and include past events. Keep Google event IDs unchanged and leave unmanaged entries untouched. Verify that the feed token, feed-secret SQL function and obsolete trial table are absent while the Google credential remains. For website changes, deploy Firebase separately and verify the released assets too.

Google publishing uses the encrypted Vault secret `scout_calendar_google` containing `client_id`, `client_secret`, `user_id` and `refresh_token`. The shared Scout calendar is `c_c4eba5697d3a3e33c4590daa7c20c8791d7d608b787ff959bf3117f3a7d02df5@group.calendar.google.com`; Danny's private Scout Everything calendar is `c_d6d8bace0ef22918c156fc9878f310a210a4feb47a7f078744a99cceef293633@group.calendar.google.com`. The backend-only `POST scout-calendar/reconcile` accepts an empty body and the existing backend `apikey`. It returns confirmed create/update/remove/unchanged counts across both calendars, Google request counts and SQL costs. Run it after deploying the shared publishing code; a repeat should make no event writes. An unchanged full reconciliation uses one OAuth refresh, two Google list requests and two SQL reads, with no SQL writes or model calls. The daily job reconciles at 4 a.m. New York time. Preserve each existing job's prior active state, including after installing `supabase/scout-loop.sql`.

A function deployment does not apply database migrations. For a requested schema change, inspect remote migration history and apply only the reviewed pending Scout migrations, coordinating the affected consumers. If the release requires a temporary pause, restore each job's prior active state after verification as required by [AGENTS.md](AGENTS.md). Do not invoke the reader, send Slack messages, or run historical cutover SQL merely to verify deployment. Report what was checked locally, what was verified live, and any remaining blocker.

## Website deployment

The website uses Firebase project `ryustatic`, site `bbnj-scout`, target `scout`: [Scout](https://bbnj-scout.web.app). Configuration and target mapping live together in [website/firebase.json](website/firebase.json) and [website/.firebaserc](website/.firebaserc).

With the Firebase CLI installed and authenticated, run an approved deployment from the repository root:

```sh
(cd website && firebase deploy --project ryustatic --only hosting:scout)
```

The predeploy hook runs the root npm build and deploys `website/dist/`. It uses Firebase's documented [`PROJECT_DIR` hook variable](https://firebase.google.com/docs/cli#environment_variables). Keep the Scout target, security headers, shared-project capacity and disabled billing intact; verify the released assets after deployment.

Backend releases follow [Supabase deployment](#supabase-deployment). A website deployment does not deploy functions or SQL. The legacy `scout-collect-hsa` function is a retirement response, not the current reader.
