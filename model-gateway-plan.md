# Scout tracker model backup plan

## Current direction — 15 October 2026

**Centralized admission is deployed in collector v147.** The gateway obtains every model admission from `scout.reserve_provider(invocation, id, provider, deadline)`. This SQL function atomically owns enablement, verified Gemini account headroom, independent provider cooldowns, the shared two-generation allowance and model deadlines. It returns request settings, the remaining allowance and the conservative reservation cost. Adapters consume those settings and the gateway's abort signal; they cannot dispatch directly. Collectors, handlers and diagnostics have no separate model admission policy. Authentication, URL/record validation, source retry state, Tavily's included-credit check and database resource protection remain with their existing components.

Applied migration `20261015200000_scout_model_admission` replaces the old `reserve_model` and integer-argument `reserve_provider` entry points without adding tables or jobs or changing existing records/charges. The compatible collector and migration were deployed together while collection was paused. One reserve and one settle remain per generation; request settings exist only in memory. SQL is the only source for the two-generation/100-second bounds, the Gemini 45-second request deadline and provider token/tool/source settings. The gateway caches SQL's remaining allowance to avoid a needless third reservation RPC.

**Provider limit cleanup is deployed in collector v146 with migration `20261015180000_scout_provider_limits`.** OpenAI's request/token rates, model context/output capacity and project/organization spending are the authority. Remove the duplicate JavaScript budget object and SQL checks for per-invocation/day/lifetime spending, copied RPM/TPM, manual/credit modes and access/quota/allocation expiry. The migration retains only OpenAI enablement and provider cooldown in the policy object, preserving cumulative costs, uncertain charges and existing access controls.

The adapter uses provider web access with the shared intake instruction, URL and response contract. No source bodies are prepared by Scout. Its Responses request uses `gpt-6-luna`, standard tier, low reasoning, `store:false`, strict schema adaptation and provider source metadata. Existing finite workflow bounds remain: two generations per source invocation, three tool operations per Luna call and the shared 100-second deadline. Collection and notifications stay paused. Concurrent intake-schema work is excluded from this implementation.

The following deployment history and text-reader design describe the previous adapter and are superseded by the URL-based direction above.

**Implemented and deployed; production authentication, fallback and saving are verified as of 14 October.** Collector v145 tries `gemini-3.5-flash-lite` first and, if extraction fails, can try `gpt-6-luna` once within a finite enabled allocation. Production recovery and completed repeats now work through the existing gateway, public reader and record workflow. Clock/timezone validation remains incomplete; preserve established facts and the two-generation bound rather than treating successful provider calls as full factual acceptance. The heartbeat, recurring collection and notifications remain paused. Secret-management access still lacks read permission, but production OpenAI requests authenticate successfully. Test cleanup has its own chat, `01a13a90-4fe1-7260-8ee5-e7449619d752`.

The separately authorized completeness change excludes an absent event end from required completeness fields. Start dates, supplied ends and invalid/conflicting-date diagnostics retain their existing behavior. Missing clocks were already optional. Follow-up judgment and the prompt remain unchanged; no prohibition on end-time research. No bulk rewrite of existing records.

## Inspected baseline

- Gateway `7110843` supplied the initial reusable routes and bounded OpenAI transport. This release adds tracker integration, the failure policy below and durable provider accounting.
- Storage `c30175f`, optional-research correction `e39e7d5` and subsequent F06/F11 handoff `ea5784e` are in this checkout. Current `processDocument` saves first-pass useful facts before optional research, counts actual `_usage.generations` and allows two generations. Current code controls where historical status prose disagrees.
- The current `e2a9427` contract uses URL-only intake: complete/parked sources stay closed until explicitly reset; no legacy body fetching, preparation or content-change probes. `hostedHSA` now constructs the gateway for selected due sources and direct-source runs, preserving native source metadata. Only Luna recovery reads source content locally. Preserve native identities, source URLs, supported date precision, ranked organization names, relevance and human corrections.
- One extraction-only E02 Luna request succeeded: 5,989 input / 413 output tokens, 6.7 s provider latency, conservative estimated cost $0.00096. It recovered the source-supported date and registration, leaving end unknown. Its inferred `Europe/Paris` identifier still needs source-grounding correction. This was not a production gateway/accounting/save test.
- Ignored `.env.local` uses `SCOUT_OPENAI_API_KEY`, matching the Supabase Edge Function secret name. Use the same working Scouter key in both places; the former local name `OPENAI_SCOUTER_API_KEY` is retired. Models Read and one Responses call succeeded. Serving-bucket headers reported 30,000 requests and 180,000,000 tokens; project headroom and available credit remain unverified. Last Gemini account check reported 500/day, 15/minute and 250,000 input/minute with billing disabled. Refresh actual controls before live use.

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

## Provider limit categories

| Category | Authority and Scout behavior |
| --- | --- |
| Requests (RPM/RPD) | OpenAI project/organization/model limits; report request throttles and honor `Retry-After`. No extra Scout request quota. |
| Tokens (TPM/TPD) | OpenAI limits; report token throttles. No copied Scout token-rate counter or allowance. |
| Model capacity | Luna has a 1,050,000-token context and 128,000 maximum output. Set the API output maximum to 128,000; let OpenAI validate context. Web search has its own 128,000-token context. Remove Scout's 60,000-input, 1,500-output and 128-KiB response gates. |
| Spending | OpenAI project/org monthly hard limits, approved usage limit and available credits. Report billing/spend-limit errors separately from temporary throttling; no automatic retry inside the invocation. Scout does not configure these account controls or claim they have been verified. |

Official sources: [rate limits](https://developers.openai.com/api/docs/guides/rate-limits), [Luna capacity/pricing](https://developers.openai.com/api/docs/models/gpt-6-luna), [spend limits](https://developers.openai.com/api/docs/guides/spend-limits). Account limits can be below published tiers. The last serving-bucket headers are not proof of project headroom. Spend alerts do not stop requests; only an enforced hard limit does. No billing-balance questions or expanded key permissions are required for this change.

Atomic reserve/settle remains for numeric usage, shared finite attempts, enablement and provider cooldown. It does not impose OpenAI spend/rate quotas. Known calls settle actual token counts and observed search fees using conservative prices. Unknown calls retain an upper estimate based on model capacity and long-context pricing: $0.3585 tokens plus up to $0.03 search fees. These are estimates, not invoices or new allowances. Historical unknown charges remain unchanged. Replacing policy settings cannot erase spending; compact expiry carries uncertain totals forward. No new tables, jobs or retained traffic.

Gemini uses the verified free-project request/day/token allowances directly, without Scout's lower caps or the half-headroom multiplier. Both provider adapters require the gateway's accounted dispatch; the standalone Gemini reservation path is removed. The earlier migration removed the obsolete `rpm`, `rpd`, `tpm` columns. Authentication, record validation, URL security, completed-input deduplication and finite retries remain intact.

Use restricted Responses Write and List Models Read permissions and the existing `SCOUT_OPENAI_API_KEY` secret. The release uses owned gateway/hosted changes with committed dependencies from `d8549c8`; unrelated dirty intake/collector code is excluded. Collection and notifications remain disabled. Provider/account settings are not changed by deployment.

## Cost and retention estimate

Successful intake remains one Gemini call; recovery adds at most one Luna call and normally one bounded public read. No planning, token-count or diagnostic generation. Completed unchanged input remains zero model calls/finding writes; ordinary source bookkeeping is unchanged.

Target additional recovery accounting: one reserve and one settle RPC, roughly 6–10 internal SQL statements and 3–4 row mutations. Measure actual cost within the existing 96-statement / 256 KiB submitted-SQL ceiling. Target policy object under 1 KiB and added reservation metadata under 256 B/active attempt; measure bytes and attributable WAL. Only useful findings, source URLs and compact numeric/error state persist. Source bodies, prompts, responses and proof trails persist zero bytes. Recurring activity remains zero until reviewed activation.

## Verification, cleanup and activation

Use existing tests to verify Gemini success never calls Luna; retrieval/parsing recovery saves the expected record; valid partial/empty results do not fallback; auth/safety/accounting/budget failures stop; separate cooldowns and uncertain charges; atomic concurrent reservations; two total generations including improvement; unchanged input; identity/human corrections; no persisted traffic. Cover both selected-source and tracker-discovery paths. Retain a small second-task configuration check without creating that product feature.

The user authorized production tests for the rejected URLs. With the backend key saved, run **one E02 tracker pilot first**, then frozen E09 CBD and A07 UN notification cases: at most six total generations and three Luna calls, within the then-authorized $0.10 test allocation (historical; retired by the current direction). Measure actual calls, reads, tokens, latency, estimated cost, SQL/mutations and retained bytes; report billed cost/WAL only if actually measured. Independently check source-supported dates, registration, organizations and timezone; preserve old duplicate records. Verify a completed repeat makes no model call or finding write. Mock mechanics/direct extraction are not production fallback proof.

**Verification for centralized admission:** 134 tracked checks pass with unrelated dirty dependencies loaded from `1d60775` in memory; the build passes. Existing tests cover atomic shared attempts, provider cooldowns, deadline expiry, direct-adapter rejection, settings propagation, known/uncertain accounting, fallback, saving, unchanged inputs and access controls. Obsolete standalone/duplicate-limit tests were removed; no new test files, harnesses or fixtures. Production verification confirms the new function signature, paused denial, unchanged record/accounting digests and zero active jobs/leases. This release made no billable model calls and makes no new extraction-quality claim. Concurrent intake-schema work is excluded from both verification and deployment.

The reviewed migration and collector v138 were deployed; the subsequently active v139 retains the recovery markers. Unauthenticated 401 ingress remains established. Report visible saves and measured cost before recurring activation. Recurring trackers, notifications and the stopped heartbeat remain separate actions. Later Slack Q&A retains its agreed provider/compare commands and is outside this tracker-backup change.

## Production pilot — 12 October 2026

The initial E02 pilot took 8.5 seconds: Gemini HTTP 503, a successful production HSA read, then Luna HTTP 401. It used two actual attempts, 32 collector SQL statements and nine mutations. After the operator reported a corrected secret, one E02 retest took 14.6 seconds: Gemini explicitly reported retrieval ERROR (2,355 input / 90 output tokens), but the production source read returned HTTP 400 before any Luna dispatch. That used 31 SQL statements and eight mutations; E02 reached its existing three-source-attempt ceiling and is parked.

E09 then took 4.2 seconds: Gemini retrieval ERROR (3,119 input / 293 output tokens), a successful complete native-JSON read, then Luna HTTP 401. It used 31 SQL statements and eight mutations. Existing CBD record facts were preserved; they are not recovered output from this failed test. Across all three production invocations, no finding was created, changed or removed. Concurrent authorized work raised the independent record baseline from 104 to 105; all 105 present before the later tests were preserved. A07 and a completed-source repeat remain untested.

A minimal local control used the same gateway adapter and durable ledger, a second task configuration and a 16-token output ceiling. Luna returned HTTP 200 in 3.1 seconds, using 87 input / 14 output tokens, with conservative estimated cost $0.000017875. Supabase's displayed SHA256 does not match this working key, including checks against the exact parsed Scout `.env.local` value. This establishes local credential/transport access, not production recovery or grounding correctness. No further unchanged credential retries are authorized by this test window.

The test and credential checks total six actual generation attempts, including three OpenAI requests. Two rejected OpenAI calls returned no usage; their combined $0.0165 conservative charge remains held. Current cumulative accounting is $0.016517875, not an invoice. The failed source read's undispatched Luna reservation settled to zero. Every finite manual window was closed: model intake and backup disabled, zero active source leases and zero scheduled jobs. Source bodies, prompts and responses remain unpersisted. Live recovery/save acceptance awaits matching production credentials and the HSA reader failure remains a separately observed limitation.
