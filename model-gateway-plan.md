# Scout tracker model backup plan

## Current direction — 12 October 2026

**Implemented and deployed; the first production pilot is blocked by OpenAI authentication.** Tracker intake tries `gemini-3.5-flash-lite` first and, if extraction fails, can try `gpt-6-luna` once within a finite enabled allocation. Reuse the existing gateway, public reader and record workflow. The heartbeat, recurring collection and notifications remain paused. The user explicitly authorized the credential transfer and manually saved `SCOUT_OPENAI_API_KEY` after the deployment token lacked secret-write permission; OpenAI rejected the production value with HTTP 401.

The separately authorized completeness change excludes an absent event end from required completeness fields. Start dates, supplied ends and invalid/conflicting-date diagnostics retain their existing behavior. Missing clocks were already optional. Follow-up judgment and the prompt remain unchanged; no prohibition on end-time research. No bulk rewrite of existing records.

## Inspected baseline

- Gateway `7110843` supplied the initial reusable routes and bounded OpenAI transport. This release adds tracker integration, the failure policy below and durable provider accounting.
- Storage `c30175f`, optional-research correction `e39e7d5` and subsequent F06/F11 handoff `ea5784e` are in this checkout. Current `processDocument` saves first-pass useful facts before optional research, counts actual `_usage.generations` and allows two generations. Current code controls where historical status prose disagrees.
- The current `e2a9427` contract uses URL-only intake: complete/parked sources stay closed until explicitly reset; no legacy body fetching, preparation or content-change probes. `hostedHSA` now constructs the gateway for selected due sources and direct-source runs, preserving native source metadata. Only Luna recovery reads source content locally. Preserve native identities, source URLs, supported date precision, ranked organization names, relevance and human corrections.
- One extraction-only E02 Luna request succeeded: 5,989 input / 413 output tokens, 6.7 s provider latency, conservative estimated cost $0.00096. It recovered the source-supported date and registration, leaving end unknown. Its inferred `Europe/Paris` identifier still needs source-grounding correction. This was not a production gateway/accounting/save test.
- Ignored `.env.local` uses `OPENAI_SCOUTER_API_KEY`. Models Read and one Responses call succeeded. Serving-bucket headers reported 30,000 requests and 180,000,000 tokens; project headroom and available credit remain unverified. Last Gemini account check reported 500/day, 15/minute and 250,000 input/minute with billing disabled. Refresh actual controls before live use.

## Tracker behavior

1. Select one source and run existing complete/parked checks before model reservations. Try Gemini using the current rubric/schema and URL Context.
2. Accept useful Gemini partials. Missing optional fields, provisional completeness, rejected malformed siblings alongside useful records, or a valid `none` result do not trigger Luna. No comparison or grading call.
3. Use Luna once when Gemini has no usable result because retrieval/parsing failed: explicit retrieval ERROR, missing retrieval metadata, `unreadable`, invalid JSON/output, truncation, or `found` with no normalized useful records. Permit transient 429/5xx or uncertain transport failure only if independent OpenAI budget and remaining deadline permit. Preserve the Gemini charge and failure code; no Gemini retry.
4. Stop on authentication/configuration, safety refusals/blocked finishes, database/accounting/access failures, unsafe sources, spending/attempt exhaustion or shared deadline exhaustion. Local quota denial or an active Gemini cooldown is not a parse failure and does not secretly enable OpenAI-only intake.
5. Use Scout's DNS/redirect-safe reader for Luna. Reuse already-read safe content within the invocation when available; otherwise read the selected public source once. Supply observed HTML text or complete native JSON, the same rubric/schema, identity and established facts. Keep everything in memory. Refuse unsupported or oversized content; do not claim absent JavaScript content was read.
6. Save Luna's useful result through the existing record path. Return exact provider/model and both attempts' short diagnostics transiently. If both fail, preserve records and existing compact retry/pending state; no fabricated record.

Extraction, fallback and optional improvement share **two generations total**. Gemini failure plus Luna consumes both. Gemini success plus an improvement also consumes both; no third fallback for failed improvement. Optional research remains the model's judgment and never gates the initial save.

## Files and implementation

| File | Planned change |
| --- | --- |
| `collector/model-gateway.js` | Extend explicit task fallback policy and useful-result validation, retaining reusable dispatch and existing normalization. |
| `collector/model.js` | Distinguish auth/safety failures from transient provider failures; coordinate accounting so each actual Gemini attempt is reserved/settled once. |
| `collector/finding-contract.js` / `collector/finding-jobs.js` | Reuse existing normalization without changing the URL-only workflow or follow-up judgment. Optional end was already committed separately. |
| `collector/hosted-hsa.js` | Bind one source-scoped gateway for direct and selected due sources, sharing existing reader, invocation and deadline limits. |
| `supabase/functions/scout-collect-hsa/index.ts` | Pass a dedicated OpenAI runtime secret and disabled-by-default backup configuration to the existing entrypoint. |
| One quota migration | Extend compact current accounting for OpenAI, with existing access boundaries. |
| Existing gateway/workflow/hosted tests | Cover distinct recovery behavior and consolidate obsolete/duplicated tests. |

No new collector, scheduler, capture/history table or test harness. The existing implementation worker wrote the bounded changes; the parent independently reviewed them. Deployment uses owned changes and committed unowned inputs from `e2a9427`, excluding concurrent explorer/README/task edits. One focused implementation commit excludes those unrelated changes.

## Durable budgets and limits

Keep Gemini's existing quota controls. The existing singleton `quota_policy` has one bounded OpenAI policy object for exact model, enablement, access/expiry, finite allocation, spending/rate/token limits and cooldown. Cumulative spending and uncertain totals are separate scalar columns, so replacing policy JSON cannot erase charges. Existing `quota_reservations` carry provider/model and numeric cost, defaulting old rows to Gemini. Rate windows filter by provider; invocation attempts count both. Migration `20261013003000` is applied with backend-only grants; all 103 existing records were preserved.

Atomic reserve/settle must serialize against the policy row and enforce shared attempt/spending limits. Remove double accounting at the adapter/gateway boundary. Unknown dispatches retain conservative charges. Existing bounded expiry folds uncertain charges into provider totals before deleting expired rows; spending must survive expiry. Keep fixed backend operations and existing grants; no model SQL or database credentials.

Proposed Luna configuration: Responses, `gpt-6-luna`, `store:false`, standard tier, reasoning `none`, strict schema adaptation, no search/tools/files. Reserve at most 60,000 input and **1,500 output tokens**; retain 24 KiB source-text/JSON and 128 KiB response bounds. Gemini retains 60,000 input / 8,192 output. Share the existing 100-second deadline; bound Gemini's first wait to leave a fallback window, never extend total time.

Initial pilot: **$0.10 total and $0.01/source invocation**, from verified existing credit. Proposed later backup ceilings for review: 2 Luna calls/minute, 10/day and $0.05/day, always limited by actual account/project headroom. Conservative prices $0.125/M input and $0.50/M output reserve **$0.00825/call** at those ceilings; published standard input is $0.10/M. These are estimates, not billing evidence. [Official OpenAI Luna documentation](https://developers.openai.com/api/docs/models/gpt-6-luna) was fetched for this plan.

The standalone gateway's test budget retains its 15-minute freshness rule. Production uses atomic database checks with explicit policy/access/quota expiry. The requested tests use a manual allocation capped at $0.10 and one hour, without claiming a verified credit balance. No more credit-balance questions are needed for these finite tests. Missing/expired OpenAI allocation disables backup while otherwise-authorized Gemini-only intake remains available; no polling or automatic budget renewal.

Restricted key permissions remain Responses Write and List Models Read, everything else None. Use the working Scouter key in the approved backend secret store; never print or commit it. The invalid local `OPENAI_API_KEY` assignment has been retired. No purchases or paid overages.

## Cost and retention estimate

Successful intake remains one Gemini call; recovery adds at most one Luna call and normally one bounded public read. No planning, token-count or diagnostic generation. Completed unchanged input remains zero model calls/finding writes; ordinary source bookkeeping is unchanged.

Target additional recovery accounting: one reserve and one settle RPC, roughly 6–10 internal SQL statements and 3–4 row mutations. Measure actual cost within the existing 96-statement / 256 KiB submitted-SQL ceiling. Target policy object under 1 KiB and added reservation metadata under 256 B/active attempt; measure bytes and attributable WAL. Only useful findings, source URLs and compact numeric/error state persist. Source bodies, prompts, responses and proof trails persist zero bytes. Recurring activity remains zero until reviewed activation.

## Verification, cleanup and activation

Use existing tests to verify Gemini success never calls Luna; retrieval/parsing recovery saves the expected record; valid partial/empty results do not fallback; auth/safety/accounting/budget failures stop; separate cooldowns and uncertain charges; atomic concurrent reservations; two total generations including improvement; unchanged input; identity/human corrections; no persisted traffic. Cover both selected-source and tracker-discovery paths. Retain a small second-task configuration check without creating that product feature.

The user authorized production tests for the rejected URLs. With the backend key saved, run **one E02 tracker pilot first**, then frozen E09 CBD and A07 UN notification cases: at most six total generations and three Luna calls, within the $0.10 allocation. Measure actual calls, reads, tokens, latency, estimated cost, SQL/mutations and retained bytes; report billed cost/WAL only if actually measured. Independently check source-supported dates, registration, organizations and timezone; preserve old duplicate records. Verify a completed repeat makes no model call or finding write. Mock mechanics/direct extraction are not production fallback proof.

**Test-bloat cleanup is complete for this change:** the separate gateway PGlite fixture/integration and redundant two-generation/due-route fixtures were consolidated into the existing accounting/hosted tests. No new harness or fixtures. Affected tests grew from 664 to 718 lines for distinct routing and durable SQL coverage; isolated gateway runtime fell from about 1.4 s to 0.13 s. All 357 repository checks and the build pass (full run 23.9 s). These are mocked/PGlite mechanics, not live recovery acceptance.

The reviewed migration and collector v138 were deployed; the subsequently active v139 retains the recovery markers. Unauthenticated 401 ingress remains established. Report visible saves and measured cost before recurring activation. Recurring trackers, notifications and the stopped heartbeat remain separate actions. Later Slack Q&A retains its agreed provider/compare commands and is outside this tracker-backup change.

## Production pilot — 12 October 2026

E02 ran through the deployed collector after the operator saved the runtime secret. Gemini returned HTTP 503; the fallback read the HSA source successfully in production and dispatched Luna, which returned HTTP 401. Total latency was 8.5 seconds, with two actual generation attempts, 32 collector SQL statements and nine row mutations. No findings changed or disappeared; all 104 records present before this pilot were preserved. The extra record since the earlier 103-record checkpoint came from concurrent authorized work.

Neither provider returned token usage. Accounting retains the input/output reservation ceilings and $0.00825 conservative Luna charge; these are not measured token consumption or an invoice. The finite manual window was closed, leaving model intake and backup disabled, zero active source leases and zero scheduled jobs. No repeated request, E09 or A07 test was dispatched after the authentication failure. The working local Scouter key still passes Models Read, but Supabase secret metadata access returns HTTP 403 and the available browser requires sign-in, preventing direct verification or repair of the saved production value. Live recovery/save acceptance remains pending credential correction.
