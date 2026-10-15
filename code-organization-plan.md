# Scout code organization plan

Approved 15 October 2026. Status: implemented and locally verified; included with the focused refactor commit.

## Objective

Make Scout's existing files and workflows easier to understand, remove circular dependencies, and give shared code clear ownership. Preserve behavior while reorganizing the current implementation. This is a local code refactor, with no live model calls, source scraping, database changes, deployment, Slack sends, or recurring-work activation.

## Agreed folder names

| Current | Agreed destination | Purpose |
| --- | --- | --- |
| `notifications/` | `slackbot/` | Select findings, compose Slack messages, deliver them and track delivery. |
| `src/` | `website/` | Browser interface, sign-in, records, filters, trackers and calendar controls. |
| `dev/` | `diagnostics/` | Local troubleshooting tools and their documentation. |
| `collector/` | Keep | Source intake, model integration, findings and discovery code. |
| `calendar/` | Keep | Calendar feeds and Google Calendar synchronization. |
| `supabase/` | Keep | Database migrations, permissions, scheduling SQL and hosted entrypoints. |
| `tests/` | Keep | Automated verification. |

Add `shared/` for existing pure finding/date/record functions used across features. Keep website rendering in `website/` and Node-specific source URL validation in `collector/source-url.js`.

## Target responsibilities

```text
website/                       Browser interface
slackbot/                      Slack selection, messages and delivery
calendar/                      Calendar feeds and synchronization
collector/
  hosted.js                    HTTP request handling and dependency setup
  run.js                       Command-line launcher
  intake.js                    Coordinate processing one source URL
  source-state.js              Source claims, leases and completion
  finding-store.js             Matching, merging and atomic finding writes
  finding-contract.js          Model instructions, schemas and normalization
  corrections.js               Human corrections
  database.js                  Bounded queries and transactions
  source-url.js                Source URL validation
  models/
    gateway.js                 Dispatch, quotas, accounting and fallback
    gemini.js                  Gemini request/response handling
    openai.js                  OpenAI request/response handling
    contract.js                Shared dispatch/error contract
  discovery/                   Existing publisher discovery/preparation code
shared/
  finding-dates.js             Typed date normalization, intervals and labels
  records.js                   Shared ordering, timing and source-link rules
diagnostics/                   Local troubleshooting tools
supabase/                      Database and deployment definitions
tests/                         Automated checks
```

## Workflows to preserve

- **Source intake:** manual URL request or due-source selection -> authenticated hosted handler -> source claim -> accounted model call -> normalize, match and save findings -> bounded scheduling follow-up when required -> completion or finite retry state. Completed/parked work must retain its current handling and human corrections remain protected.
- **Slack:** explicit notification request -> hosted handler -> read saved findings -> select eligible records -> prepare message -> reserve delivery -> webhook -> delivery outcome. Collection and notification remain separate operations. The existing code posts announcements; this refactor adds no conversational Slack listener.
- **Calendar and website:** continue reading saved records and using existing access controls and calendar semantics.
- **Discovery:** publisher listings and adapters identify candidate source URLs. Keep this existing code separate from the active hosted URL-intake import graph. Group it without redesigning publisher behavior or activating collection.
- **Diagnostics:** preserve the existing explicitly scoped local diagnostic behavior and keep it out of hosted/browser import graphs.

## Implementation checklist

Logical stages are review checkpoints. Finish with one focused commit covering this authorized refactor and this progress document; exclude unrelated work.

- [x] Record the agreed plan before starting implementation.
- [x] Inspect current status, applicable instructions, imports and test commands; establish relevant baseline results.
- [x] Rename `notifications/` -> `slackbot/`, `src/` -> `website/`, and `dev/` -> `diagnostics/`; update imports, HTML/config entry paths, package commands, tests and relevant documentation references.
- [x] Move provider integration into `collector/models/`; separate the shared dispatch/error contract so provider adapters do not import the gateway. Preserve quota enforcement, accounting permits, error classification and fallback behavior.
- [x] Extract the existing database wrapper to `collector/database.js`; rename `hosted-hsa.js` -> `hosted.js` and `run-hsa.js` -> `run.js`. Preserve the existing deployed endpoint names and behavior.
- [x] Separate `finding-jobs.js` into `intake.js`, `source-state.js` and `finding-store.js`. Keep matching and writes within their current transaction boundaries; use direct functions rather than a repository framework.
- [x] Keep model instructions, response schemas and normalization together in `finding-contract.js`, including the scheduling instruction/schema currently embedded in the workflow where appropriate. Preserve instruction text and schema behavior exactly.
- [x] Move genuinely shared finding/date/record functions into specifically named modules under `shared/`. Keep single-use helpers with their callers and rendering in `website/`.
- [x] Group `hsa.js` and existing publisher `*-documents.js` modules under `collector/discovery/`; update references and preserve unrelated Explorers working changes. Defer redesign of the generic preparation code inside `octo-documents.js`.
- [x] Add a small import-boundary check using the existing test approach: reject local module cycles, prevent shared rules from depending on feature modules, and exclude discovery/diagnostics from the active hosted intake graph. Keep diagnostics out of the website graph too.
- [x] Update the current file/workflow map and relevant references concisely. Preserve unrelated README/task edits and avoid rewriting historical project notes.
- [x] Run appropriate existing tests and the frontend build. Use the existing in-memory end-to-end workflow test to verify saved findings, corrections, repeat handling and mocked model accounting. Distinguish local/mock evidence from live validation.
- [x] Review the final diff and staged contents for behavior changes, unnecessary files/abstractions, accidental prompt changes and unrelated dirty work.
- [x] Create one focused commit; record the commit, checks and any remaining uncertainty below.

## Dependency rules

- Entrypoints assemble dependencies; workflows receive the existing `db`, `model` and transport functions.
- Shared pure rules do not import feature modules, HTTP handlers or provider integrations.
- Providers and the gateway depend on their common contract without a circular import.
- Active hosted intake does not import publisher discovery/preparation or local diagnostic modules.
- Use specific module names and direct imports. Avoid generic utility collections, re-export barrels and new frameworks.
- Preserve current SQL, statement/mutation bounds, model-call allowances, retention and delivery accounting. Expected runtime-cost change is zero; report any discovered exception rather than silently changing it.

## Workspace and ownership

- Work only in `/Users/danvallentyne/dev/oceanagentics/scout`, on the supplied checkout. No clone, worktree or branch switch.
- The delegated worker is the sole implementation writer for this refactor. The originating chat will leave implementation files alone.
- Re-read status because other authorized work may change it. At planning time HEAD is `382d565` (`Finalize shared finding intake instructions`); the earlier unchanged URL-validator extraction is `4f299c1`.
- At planning time unrelated modified files are `README.md`, `collector/hsa.js`, `tasks.md`, and `tests/document-integration.test.js`. Untracked files are `collector/explorers-documents.js` and `tests/explorers-documents.test.js`.
- Preserve those working changes, including through necessary path moves. Stage only this refactor's changes in already-dirty files. Pre-existing untracked content must not be swept into the commit. Check staged and working versions explicitly when renaming a dirty file.
- Use current prompt contents and narrow edits. Do not restore an older prompt or reword instructions. Coordinate through this checklist and concise worker-chat updates.
- Do not introduce behavior changes, new schemas, tables, processing stages, retry/fallback paths, model providers, dependencies or a wholesale formatting pass.

## Progress and verification

- 15 October 2026: Worker dispatched as sole implementation writer. Confirmed HEAD `382d565` and the six unrelated modified/untracked files listed above; saved their starting contents for precise staging checks.
- Baseline checks: `npm test`: 148 passed, 3 failed (pre-existing Explorers API/detail outage-resume assertions and their parent in uncommitted `tests/document-integration.test.js`). `npm run build`: passed (53 modules).
- Folder checkpoint: moved `notifications/`, `src/`, and `dev/` to the agreed names and updated code/test/HTML/package references. Historical notes are unchanged.
- Dependency checkpoint: providers now import their accounting permit/error contract directly; gateway/provider cycles removed. Extracted the database wrapper byte-for-byte and updated hosted/CLI entry paths, retaining deployed endpoint names.
- Intake checkpoint: extracted source claims/completion and transactional matching/writes into direct modules. Intake and scheduling instruction literals and schemas were moved without wording or field changes.
- Ownership checkpoint: shared date/record rules now have direct imports; website-only labels/rendering remain in `website/`, and the single-caller calendar parser stays with document preparation. Discovery files moved together, including the untracked Explorers adapter (still excluded from staging).
- Focused verification: 68 gateway/hosted checks passed; 34 workflow/record/calendar/Slack/diagnostic checks passed. The existing diagnostic import-graph check was expanded into one dedicated boundary check, which passes.
- Final checks: full `npm test` remains 148 passed / 3 pre-existing Explorers failures, exactly matching baseline. `npm run build` passed (54 modules; 239.40 kB JavaScript / 63.56 kB gzip). Existing in-memory intake tests verified saved IDs, human corrections, finite retries, completed-source repeats and mocked provider accounting.
- Cost comparison (local PGlite, mocked models): two-event intake/follow-up remains 40 statements, 10 counted mutations, 8,528 submitted bytes, 7,928 result bytes, 365 research bytes; completed repeat makes zero model calls/finding writes and two source-state mutations. Provider fallback fixture remains 37 statements / 9 counted mutations. Both diagnostics match baseline exactly; these are not live database/WAL measurements.
- Preservation review: exact comparisons confirmed unchanged intake/scheduling instruction text and schemas, normalization, provider and hosted bodies, claim/completion SQL, database bounds and transactional matching/writes. SQL/schema/configuration/accounting policies are unchanged.
- Staged review: all local imports resolve without cycles in the exact index contents. Renamed `hsa.js` was compared explicitly with both HEAD and its working version: only the source-URL import move is committed, while all Explorers changes remain uncommitted. README includes only the new file map; document integration includes only import moves. Original task edits and both untracked Explorers files remain excluded. No unrelated formatting, dependencies or additional tests were added. `git diff --cached --check` passed.
- Commit: `refactor: organize Scout by workflow` (this document is included in that single commit, directly after `382d565`; its hash is reported in the worker chat).
- Remaining uncertainty: pre-existing Explorers outage-resume failures remain in unrelated uncommitted work. No live model correctness, remote SQL/WAL cost, deployed bundling or hosted runtime validation was performed; those are outside this local organization-only request. Recurring collection and notifications remain paused.
