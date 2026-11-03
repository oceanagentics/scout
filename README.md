# Scout

Scout collects BBNJ events, announcements and official treaty developments, saves useful findings with source URLs, and makes them available through a private website, Slack and calendar tools.

Recurring collection and notifications remain paused pending review. This guide describes the local code; it does not certify what is currently deployed.

## Files and responsibilities

| Location | Purpose |
| --- | --- |
| [website/](website/) | Browser interface, sign-in, records, trackers and calendar controls. Includes the HTML entrypoint, public environment settings, Firebase configuration and generated `dist/`. |
| [reader/](reader/) | Check tracker URLs, call models, save findings and update tracker state. |
| [reader/models/](reader/models/) | Model gateway and provider adapters. |
| [slackbot/](slackbot/) | Select saved findings, compose messages and send explicit webhook requests. Repeated requests can send the same finding again. No conversational Slack listener yet. |
| [calendar/](calendar/) | Private calendar subscription feed. |
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
npm run preview
```

The build writes ignored `website/dist/`; preview serves that output. Database tests use in-memory PGlite. Mocked tests establish mechanics, not live extraction accuracy or production costs.

## Backend commands

Local credentials stay in the ignored root `.env.local`; [the example](.env.example) distinguishes deployment, endpoint and model credentials. Hosted entrypoints read their own Edge Function secrets. Another checkout does not inherit your local file.

The following commands contact production and require an explicitly scoped run within provider allowances. They do not start recurring work:

```sh
npm run reader -- --tracker=UUID
npm run notify -- --send
```

Omit `--tracker` to check the next due enabled tracker. An explicit tracker ID also retries a tracker that stopped after three unsuccessful attempts. URLs come from the tracker row. Both commands require `SCOUT_BACKEND_KEY`. Local model diagnostics also make real model calls; use [diagnostics/README.md](diagnostics/README.md) for their separate behavior and capture exception.

## Supabase deployment

Scout's Supabase project is **`vhlfumeyhkeospnemukq`**. `scout-calendar` is the Supabase Edge Function serving the calendar feed. Deploying it replaces its running code on Supabase.

Function deployment uploads files from the current checkout. Make sure it contains the intended reviewed change. Pushing to Git, deploying the Firebase website and updating database rows are separate operations; this checkout has no automatic Supabase deployment workflow. New or edited findings appear in the live feed without a code deployment.

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
| `calendar/` or its entrypoint | `scout-calendar` |
| `reader/` or its hosted entrypoint | `scout-reader` |
| `slackbot/` or its hosted entrypoint | `scout-notify` |
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
calendar/feed.js
shared/finding-dates.js
shared/records.js
```

Follow any additional local imports introduced by the change. The [Supabase API example](https://supabase.com/changelog/33720-deploy-and-update-edge-functions-using-the-management-api) documents this multipart format. A missing token, a Supabase HTTP 401/403 and a local filesystem denial are different blockers; report the exact failing operation and sanitized error rather than handing deployment to Danny by default.

### Verify the release

Confirm the returned deployment status/version, then read it back through `GET https://api.supabase.com/v1/projects/vhlfumeyhkeospnemukq/functions/scout-calendar` using Management API authentication. Metadata confirms which deployment is active; also verify the requested behavior.

For calendar changes, request the existing private feed URL in memory and require HTTP 200, `BEGIN:VCALENDAR` and the expected event content. Keep the subscription token and event IDs unchanged. Google Calendar refreshes its own copy separately; check the live feed before attributing missing updates to Google. Never print the private token URL. For website changes, deploy Firebase separately and verify the released assets too.

A function deployment does not apply database migrations. For a requested schema change, inspect remote migration history and apply only the reviewed pending Scout migrations, coordinating the affected consumers. Keep recurring jobs paused. Do not invoke the reader, send Slack messages, or run historical cutover SQL merely to verify deployment. Report what was checked locally, what was verified live, and any remaining blocker.

## Website deployment

The website uses Firebase project `ryustatic`, site `bbnj-scout`, target `scout`: [Scout](https://bbnj-scout.web.app). Configuration and target mapping live together in [website/firebase.json](website/firebase.json) and [website/.firebaserc](website/.firebaserc).

With the Firebase CLI installed and authenticated, run an approved deployment from the repository root:

```sh
(cd website && firebase deploy --project ryustatic --only hosting:scout)
```

The predeploy hook runs the root npm build and deploys `website/dist/`. It uses Firebase's documented [`PROJECT_DIR` hook variable](https://firebase.google.com/docs/cli#environment_variables). Keep the Scout target, security headers, shared-project capacity and disabled billing intact; verify the released assets after deployment.

Backend releases follow [Supabase deployment](#supabase-deployment). A website deployment does not deploy functions or SQL. The legacy `scout-collect-hsa` function is a retirement response, not the current reader.
