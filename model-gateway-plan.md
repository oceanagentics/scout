# Scout model gateway — bounded URL recovery

## Authorized scope and inspected baseline

The 12 October user direction, relayed by Recordsrefactor manager, starts gateway implementation now. Slack completion is no longer a prerequisite. The heartbeat, recurring collection and notifications remain paused. This first change is a backend module for finite manual URL extraction and explicitly configured Gemini → OpenAI retrieval recovery. No deployment, production cutover, record cleanup or new recurring work is included.

Inspected baseline: collector v136, source commit `663c8cb`; current checkout also includes `2d64f2d` and storage documentation commits. `refactor-consumption.md` controls the record contract: full intake rubric; structured useful partials; ranked organization names without roles; date meanings and supported precision; source URLs; first capture before at most one requested-link improvement. Preserve identities, existing facts and human corrections. F14 diagnosis and F15 organization simplification are complete; F09 recovery, F10 recovery and F12 diagnostics remain open until their live acceptance is demonstrated.

The storage optimization chat is changing `collector/finding-jobs.js`, corrections, notifications, storage tests and its compact-record migration. Gateway ownership excludes those files, `collector/hsa.js`, explorers and all pre-existing dirty work. One collaboration worker owns only the gateway/provider module and its new tests. The parent owns this plan, independent review, concise checkpoint and focused commit.

## Interface and extension

Keep the existing asynchronous `(instruction, input, schema)` model callback. A small task-route configuration selects injected provider adapters, with exact provider/model labels in invocation-local diagnostics. Start with `url_intake`; verify a second configured task can use the same dispatcher without URL-specific orchestration. No model-generated SQL, new task stages or job tables.

Gemini retains `gemini-3.5-flash-lite`, URL Context and its existing durable reservation accounting. OpenAI uses Responses with candidate model `gpt-6-luna`, `store:false`, bounded input and output, and no built-in search or file storage. Model access and pricing must be verified before live use. Adapt the existing JSON schema to OpenAI strict Structured Outputs: object properties required, formerly optional properties nullable, objects closed. Semantic validation still belongs to the existing normalization/record workflow.

For OpenAI URL intake, read only explicitly supplied public source URLs through Scout's existing DNS/redirect-safe reader. Provide fetched HTML text/links or complete native JSON in memory, with requested URL, observed final URL, HTTP status and coverage. Preserve complete URLs, JSON and identifiers. Refuse unsupported/bounded-out content or mark bounded HTML coverage honestly; do not treat a search snippet, model assertion or guessed answer as proof that a page was read. Page contents are data, never instructions. Reuse full user rubric, partial records and explicit requested-link questions. No per-site patches or persisted source packet.

Fallback is opt-in and allowed only for an explicit Gemini URL retrieval failure. Missing metadata, model unreadability, malformed output, authentication, rate limits and uncertain transport failures remain distinct. Return original Gemini diagnostics alongside OpenAI/direct-reader diagnostics. Google's generic retrieval ERROR does not identify an origin HTTP cause. Never silently replace a requested provider.

## Budgets and accounting

Both provider attempts share one invocation/source allowance: at most two generations total, including failed/uncertain calls and requested-link improvement. A fallback consumes the second call; it cannot create a third improvement call. No automatic retries. Preserve provider deadlines/cooldowns and uncertain charges. Missing, expired or unverified provider/credit limits prevent OpenAI dispatch.

OpenAI requires an explicit finite verified budget and an injected reservation/settlement contract before network dispatch. That contract must retain only numeric current usage/reservations and short provider/error labels, preserve conservative charges after uncertain requests, and enforce credit/spending limits across attempts. Do not attach OpenAI to the existing Gemini-only production quota policy or claim that policy proves OpenAI access. The initial extraction-only proof can use compact manual current accounting; unattended/production accounting integration is a later reviewed requirement, not permission to add a tracing history.

Proposed live ceiling: **$0.10 total from verified existing API credit**, one generation for E02 first, then at most one each for E09/A07 only after E02 succeeds. No repeat Gemini diagnostics. No automatic purchase, paid overage or live attempt before credentials, available credit and actual model limits are established. Bound complete OpenAI request input conservatively by UTF-8 request bytes plus framing, with at most 60,000 reserved input tokens and 4,096 output tokens, response bytes to 128 KiB and invocation time to 100 seconds. The existing Gemini adapter retains its actual 60,000 input / 8,192 output reservation bounds. Current published short-context standard `gpt-6-luna` prices are $0.10/M input, $0.125/M cache writes and $0.50/M output; reserve at the conservative $0.125/M input rate. These are pricing inputs, not account/balance evidence or billed-cost measurements.

Estimated initial extraction-only operation: up to three model generations, zero model tool calls, one bounded source read per case (plus explicitly bounded redirects), zero production SQL or finding/source mutations, zero source/model bytes persisted by Scout, zero recurring daily activity. OpenAI `store:false` disables saved Responses; it does not establish an account-level Zero Data Retention policy. Compact quota/current status bytes must be measured if used. Database cost and attributable WAL are zero for a no-database extraction comparison; do not claim production persistence validation from it.

Credential preflight on 12 October: read-only `/v1/models` requests returned `401 invalid_api_key` for both process and `.env.local` keys. Zero generation calls/charges. A valid project API key must be installed securely in ignored `.env.local`; verify existing API credit and project model/rate limits before generation. Never print keys, save model traffic or use unsupported internal account tokens.

## Restricted key and token economy

Use a project-scoped Scout key with Restricted permissions: **Responses API Write** (`api.responses.write`, `POST /v1/responses`) and **Models Read** (`api.model.read`, `GET /v1/models`) for access verification. Set all other endpoint permissions to None, including stored-response reads, files, vector stores, assistants/threads, agents, batch, fine-tuning, other inference endpoints, usage administration and project/key management. The owning user/service account's project role must also permit those two scopes. Billing/limit verification uses the owner's dashboard; the runtime key needs no administration privileges. See [permissions](https://developers.openai.com/api/docs/guides/rbac) and the [minimal response-writer example](https://developers.openai.com/api/docs/guides/terraform/service-accounts).

Use the project's model allowlist to permit only `gpt-6-luna` for this pilot; configure it through owner settings, keeping administration permissions off the runtime key. Set a small project hard spend limit as an additional control, while retaining Scout's $0.10 experiment ceiling and numeric reservations. Spend alerts alone do not stop traffic; hard-limit enforcement can lag. See [model access controls](https://developers.openai.com/api/docs/guides/admin-apis) and [spend limits](https://developers.openai.com/api/docs/guides/spend-limits).

Stretch tokens by preserving unchanged-input skipping, using OpenAI only for explicit retrieval gaps, supplying bounded useful source text once, and avoiding repeated diagnostic variants or automatic retries. Keep `gpt-6-luna` with reasoning `none`, no paid built-in tools and one extraction before expansion. Configure the first single-record OpenAI pilot with a **1,500-output-token limit**, within the existing 4,096 maximum; increase it only when the workload demonstrates a need and remaining verified allowance permits. Input/output reservations are conservative ceilings; actual usage is settled separately. Keep the complete rubric, URLs, native JSON and uncertainty behavior intact when reducing budgets.

## Frozen comparison and acceptance

Use `.cache/scout-refactor/oct12-evaluation-manifest.json` expectations in memory. Preserve native CBD identity `cbd:side-event:6915` as caller/source metadata; extraction-only comparison must neither create a duplicate nor claim the separate F08 identity defect is fixed.

1. **E02** — HSA Clearing-House webinar: event on 15 October 2026 at 15:00 UTC+02 / 13:00Z; registration `https://bit.ly/clhmreg1`. September 28 is publication. Main page does not establish an organizer or end time.
2. **E09** — exact encoded CBD reservations URL, side event 6915: expected full session name, 29 July 2026 10:15Z–11:35Z, CBD Secretariat and UN DOALOS when established by actually read sources. Unresolved organization references remain explicit requested links, never guessed names.
3. **A07** — UN notification 2026-001: publication 10 February 2026, response deadline 16 March, DOALOS/OLA/UN when source-supported. Treaty effective date is not an event date.

Local tests must prove: provider dispatch and reusable task routing; strict-schema adaptation without changing the shared schema; full rubric/partial input preservation; explicit successful source-read evidence; no fallback on non-retrieval failures; shared two-attempt cap including failures; account for both calls; fail closed on missing budget/accounting; uncertain charges and provider cooldowns; malformed/truncated/refused output; unchanged processDocument input bypasses models; no source/model material in accounting or checkpoints. Use current workflow regressions to check partials and human overrides without editing storage-owned files.

Independent review precedes one focused implementation commit, staging only owned changes. Report mocked mechanisms separately from real extraction correctness: pages actually read, correct facts and honest unknowns, provider/tool counts, tokens, estimated versus billed cost/credits, latency, SQL/mutations and retained bytes. Live recovery remains unproven while API authentication/credit is blocked. No claims of production recovery or Slack-visible behavior.

## Later Slack use

Retain the agreed commands: `@scout --provider=openai QUESTION`, `@scout --provider=gemini QUESTION`, `@scout --compare QUESTION`; plain mentions use a configurable default initially OpenAI. That later task will reuse the completed Slack ingress/read/delivery flow and restricted record operations. Comparison retrieves once and supplies an identical bounded authorized record snapshot and grounding instructions to both providers, with exact labels, citations and honest failures. Slack activation and record-search implementation are outside this URL test.

## Implemented module boundary

`collector/model-gateway.js` exports `modelGateway`, `openai`, `strictSchema` and `OPENAI_MODEL`. Configure `modelGateway({task, routes, providers, budget, accounting, invocation, deadline})`; its result is the existing model callback. A route contains `provider` and optional `fallback`/`recoverURLRetrieval`. Provider entries contain exact `model` and `generate`. The OpenAI callback is constructed with `openai({apiKey, read, urls, fetch, deadline})`. It also reads explicit caller-normalized `input.requested_links`, at most three, within a four-source bound. HTML text and complete JSON above 24 KiB are refused rather than cutting URLs, UTF-8 or structured values.

Budget evidence is fresh for at most 15 minutes: millisecond `verifiedAt`/`expiresAt`, finite `maxCostUSD` and `creditRemainingUSD`, plus provider model/access verification, remaining attempt/input-token allowances, per-call input/output bounds, conservative prices and cooldown. `accounting.reserve` receives invocation/id/task/provider/model, conservative numeric tokens/cost, shared `max_attempts:2` and deadline, and must return `{allowed:true}` only after atomic current-account checks. `accounting.settle` receives numeric usage/cost, settled/unknown state, short reason and cooldown. Persistence remains the caller's responsibility; injected in-memory test accounting is not proof of a durable production ledger.

Results include aggregate `_usage.generations`, tokens, estimated cost and uncertainty, and provider/model-labelled `_diagnostics.attempts`. Before production integration, the current `processDocument` consumer must honor `_usage.generations` (it currently counts callbacks), and Gemini's existing ledger must not be charged twice by gateway accounting. This change deliberately leaves those shared consumers and runtime activation untouched until live proof and the concurrent storage change are reviewed.

URL intake requires a configured primary source. OpenAI dispatch also requires a module-private permit issued after successful gateway reservation; direct adapter calls cannot bypass that accounting boundary. A valid completed partial survives a token overrun, with actual usage retained and subsequent calls halted. Incomplete/refused/malformed answers remain failures.

F06/F11 follow-up decisions and finite pending research belong to the separate “Solve Scout follow-up decisions F06/F11” chat. Its consumer can use the explicit requested-link contract above after the storage/gateway handoffs; this implementation does not change those shared workflow files.

## Reviewed local handoff — 12 October

Independent verification: **73 gateway checks and 321 total repository checks passed; frontend build passed.** Model transports and accounting are mocked; the intake integration uses local PGlite. These checks prove dispatch/budget/retrieval mechanics and preservation behavior, not real model correctness or production database cost.

**Live recovery is blocked:** E02, E09 and A07 were not sent to OpenAI, so no new result proves these pages read or their expected dates/names extracted. Two read-only authentication requests returned `401 invalid_api_key`. This task made zero live generations/tool calls, zero inference tokens/charges and zero production SQL/mutations/WAL; no source/model traffic was persisted. Real extraction latency, credit consumption and factual correctness remain unmeasured. The compact ignored checkpoint holds only current ownership/status and numeric results.

Next action: securely replace `.env.local`'s invalid API key; verify candidate model access, existing API credit and actual rate/token headroom; use fresh atomic current accounting for one extraction-only E02 call within the $0.10 total ceiling. Continue to E09/A07 only after independent E02 acceptance and remaining budget verification. F09/F10 and provider F12 live acceptance remain open. The heartbeat stays paused; no deployment, Slack activation or recurring-work change is included.

## Current live proof — one E02 request

The user explicitly requested one missing-URL Luna call now, superseding the preflight hold for this single manual probe. Account credit balance was not independently verified; this did not unlock recurring or production work. Used current source/rubric/schema helpers with one request, 1,500 output-token cap and a conservative reservation below $0.01. No automatic retry, model tool, finding/source write or production SQL.

**E02 useful extraction demonstrated:** Scout's public reader fetched the exact HSA page (HTTP 200, 79,151 bytes; 16,248 supplied text bytes), and `gpt-6-luna` returned one event. Independent source review confirms explicit October 15, 2026 / 15:00 CEST (13:00Z) and `https://bit.ly/clhmreg1`. It left end time and organizers unresolved and retained High Seas Alliance as an associated name. One qualification: Luna supplied `Europe/Paris`, which the page does not explicitly name; the UTC result is correct, but a saved fact should retain the source-supported CEST/+02:00 meaning rather than assert that inferred IANA identifier. No response/source/proof trail was retained.

Measured one generation: 5,989 input tokens (5,986 cache-write tokens), 413 output tokens, zero reasoning tokens; 6,712 ms provider latency and 7,353 ms total. Conservative estimated cost **$0.000955125**, not an invoice/balance measurement. Response headers reported request limit 30,000 and token limit 180,000,000 for the serving bucket; no project-specific token header was returned. One source read supplied the request and one additional read independently checked the facts. Production SQL/mutations/WAL and Scout-persisted source/model bytes were zero.

This proves one manual source-text extraction, not a production gateway reservation/dispatch/persistence or native OpenAI URL-tool test. E09/A07 remain untested with OpenAI. No additional model request follows this one-shot authorization. Remaining work includes verified ongoing credit/project controls, gateway accounting/consumer integration, the inferred-zone qualification, other accepted URL tests and completion cleanup. The heartbeat stays paused.

## Completion cleanup — test bloat

Before declaring this plan complete, audit the gateway and affected intake/model tests for duplicate coverage, obsolete pipeline expectations and brittle checks that merely mirror implementation. Consolidate or remove redundant cases, repeated setup and unused fixtures; prefer a smaller set of behavior-focused tests and existing test patterns, without adding a replacement harness. Coordinate overlapping files with the storage and F06/F11 owners before edits.

Preserve distinct coverage for real URL recovery and correct dates/names, source-read proof, restricted dispatch, shared attempt/spending limits, uncertain charges/cooldowns, useful partials, unchanged inputs, identity/human corrections and provider failures. Keep the mocked-mechanics versus live-correctness distinction explicit. Measure before/after test lines, fixture bytes and runtime; rerun retained regressions and the build. Current gateway baseline is 287 test lines / 73 checks; reducing test count alone is not acceptance. This cleanup is a required completion step, not performed by this plan update.

## Official documentation inspected

- [Responses migration and stateless calls](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [Current pricing](https://developers.openai.com/api/docs/pricing)
- [Web search actions](https://developers.openai.com/api/docs/guides/tools-web-search) — search/open actions do not establish a guaranteed direct-read contract; this change uses the existing application reader.
- [Data controls](https://developers.openai.com/api/docs/guides/your-data)
