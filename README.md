# Scout

Scout collects BBNJ events, announcements and official treaty developments, saves useful findings with source URLs, and makes them available through a private website, Slack and calendar tools.

Recurring collection and notifications remain paused pending review. This guide describes the local code; it does not certify what is currently deployed.

## Files and responsibilities

| Location | Purpose |
| --- | --- |
| [website/](website/) | Browser interface, sign-in, records, trackers and calendar controls. Includes the HTML entrypoint, public environment settings, Firebase configuration and generated `dist/`. |
| [reader/](reader/) | Check tracker URLs, call models, save findings and update tracker state. |
| [reader/models/](reader/models/) | Model gateway, provider adapters and accounted dispatch. |
| [collector/](collector/), including [discovery/](collector/discovery/) | Retained legacy code. Excluded from the reader. |
| [slackbot/](slackbot/) | Select saved findings, compose messages and track webhook delivery. No conversational Slack listener yet. |
| [calendar/](calendar/) | Calendar subscription feed and explicit Google Calendar synchronization. |
| [shared/](shared/) | Pure date and record rules used by multiple features. |
| [supabase/](supabase/) | Database migrations, hosted entrypoints, access rules and operational SQL. |
| [diagnostics/](diagnostics/) | Local model troubleshooting; see its [instructions](diagnostics/README.md). |
| [tests/](tests/) | Automated checks and fixtures. |
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

Backend settings stay in the ignored root `.env.local`; [the example](.env.example) documents the OpenAI and Calendar secret names. Hosted entrypoints read their own Edge Function secrets.

The following commands contact production and require an explicitly scoped run within provider allowances. They do not start recurring work:

```sh
npm run reader -- --tracker=UUID
npm run notify -- --send
```

Omit `--tracker` to check the next due enabled tracker. An explicit tracker ID also retries a tracker that stopped after three unsuccessful attempts. URLs come from the tracker row. Both commands require `SCOUT_BACKEND_KEY`. Local model diagnostics also make real, accounted calls; use [diagnostics/README.md](diagnostics/README.md) for their separate behavior and capture exception.

## Website deployment

The website uses Firebase project `ryustatic`, site `bbnj-scout`, target `scout`: [Scout](https://bbnj-scout.web.app). Configuration and target mapping live together in [website/firebase.json](website/firebase.json) and [website/.firebaserc](website/.firebaserc).

With the Firebase CLI installed and authenticated, run an approved deployment from the repository root:

```sh
(cd website && firebase deploy --project ryustatic --only hosting:scout)
```

The predeploy hook runs the root npm build and deploys `website/dist/`. It uses Firebase's documented [`PROJECT_DIR` hook variable](https://firebase.google.com/docs/cli#environment_variables). Keep the Scout target, security headers, shared-project capacity and disabled billing intact; verify the released assets after deployment.

Backend releases are separate. [supabase/config.toml](supabase/config.toml) defines `scout-reader`, `scout-notify`, `scout-calendar`, and a retirement response for `scout-collect-hsa`. The [architecture](docs/architecture.md) describes the coordinated migration and deployment. A website deployment does not deploy backend functions or SQL.
