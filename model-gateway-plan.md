# Scout tracker model backup plan

## Current direction — 12 October 2026

**For review: tracker fallback is not implemented or activated.** Tracker intake should try `gemini-3.5-flash-lite` first and, if extraction fails, try `gpt-6-luna` once. Reuse the existing gateway, discovery, public reader and record workflow. The heartbeat, recurring collection and notifications remain paused.

The separately authorized completeness change excludes an absent event end from required completeness fields. Start dates, supplied ends and invalid/conflicting-date diagnostics retain their existing behavior. Missing clocks were already optional. Follow-up judgment and the prompt remain unchanged; no prohibition on end-time research. No bulk rewrite of existing records.

## Inspected baseline

- Gateway `7110843` provides reusable task routes, bounded OpenAI transport and injected reserve/settle, but only recovers explicit Gemini URL retrieval ERROR. It is not wired into trackers.
- Storage `c30175f`, optional-research correction `e39e7d5` and subsequent F06/F11 handoff `ea5784e` are in this checkout. Current `processDocument` saves first-pass useful facts before optional research, counts actual `_usage.generations` and allows two generations. Current code controls where historical status prose disagrees.
- `hostedHSA` constructs Gemini directly. Direct-source and tracker-discovery paths both reach `processDocument`; discovery already processes at most one source per invocation. Preserve native identities, source URLs, supported date precision, ranked organization names, relevance, human corrections and unchanged/pending behavior.
- One extraction-only E02 Luna request succeeded: 5,989 input / 413 output tokens, 6.7 s provider latency, conservative estimated cost $0.00096. It recovered the source-supported date and registration, leaving end unknown. Its inferred `Europe/Paris` identifier still needs source-grounding correction. This was not a production gateway/accounting/save test.
- Ignored `.env.local` uses `OPENAI_SCOUTER_API_KEY`. Models Read and one Responses call succeeded. Serving-bucket headers reported 30,000 requests and 180,000,000 tokens; project headroom and available credit remain unverified. Last Gemini account check reported 500/day, 15/minute and 250,000 input/minute with billing disabled. Refresh actual controls before live use.

## Tracker behavior

1. Discover/select one source and run existing unchanged-input checks before model reservations. Try Gemini using the current rubric/schema and URL Context.
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
| `collector/finding-contract.js` / `collector/finding-jobs.js` | Reuse acceptance/normalization without a second incompatible validator; preserve capture, identity, overrides, research and generation bounds. |
| `collector/hosted-hsa.js` / `collector/octo-documents.js` | Bind one source-scoped gateway after discovery for direct and discovered sources, sharing existing reader, invocation and deadline limits. |
| `supabase/functions/scout-collect-hsa/index.ts` | Pass a dedicated OpenAI runtime secret and disabled-by-default backup configuration to the existing entrypoint. |
| One quota migration | Extend compact current accounting for OpenAI, with existing access boundaries. |
| Existing gateway/workflow/hosted tests | Cover distinct recovery behavior and consolidate obsolete/duplicated tests. |

No new collector, scheduler, capture/history table or test harness. Use one writer after plan approval, coordinate overlapping workflow/collector files with current owners, independently review and make one focused commit. Preserve unrelated explorer, README and task changes. This request launches no worker.

## Durable budgets and limits

Keep Gemini's existing quota controls. Add one bounded OpenAI policy object to the existing singleton `quota_policy`: exact model, enablement, verified access/expiry, credit allocation, spending/rate/token limits, cooldown and numeric charges. Add provider/model labels and numeric reserved/settled cost to existing `quota_reservations`, defaulting old rows to Gemini. Rate windows filter by provider; invocation attempts count both.

Atomic reserve/settle must serialize against the policy row and enforce shared attempt/spending limits. Remove double accounting at the adapter/gateway boundary. Unknown dispatches retain conservative charges. Existing bounded expiry folds uncertain charges into provider totals before deleting expired rows; spending must survive expiry. Keep fixed backend operations and existing grants; no model SQL or database credentials.

Proposed Luna configuration: Responses, `gpt-6-luna`, `store:false`, standard tier, reasoning `none`, strict schema adaptation, no search/tools/files. Reserve at most 60,000 input and **1,500 output tokens**; retain 24 KiB source-text/JSON and 128 KiB response bounds. Gemini retains 60,000 input / 8,192 output. Share the existing 100-second deadline; bound Gemini's first wait to leave a fallback window, never extend total time.

Initial pilot: **$0.10 total and $0.01/source invocation**, from verified existing credit. Proposed later backup ceilings for review: 2 Luna calls/minute, 10/day and $0.05/day, always limited by actual account/project headroom. Conservative prices $0.125/M input and $0.50/M output reserve **$0.00825/call** at those ceilings; published standard input is $0.10/M. These are estimates, not billing evidence. [Official OpenAI Luna documentation](https://developers.openai.com/api/docs/models/gpt-6-luna) was fetched for this plan.

Current gateway evidence expires within 15 minutes, suitable for manual tests. Automatic operation needs a reviewed finite provider allocation with explicit expiry and durable remaining-credit accounting, rather than relabelling old evidence as newly verified. Start with manual windows; retain fail-closed expiry and no new polling job. Missing/expired OpenAI budget disables backup, while otherwise-authorized Gemini-only intake remains available.

Restricted key permissions remain Responses Write and List Models Read, everything else None. Move the Scouter key into the backend secret store only for approved deployment; never print/commit it or overwrite the unrelated older key. No purchases or paid overages.

## Cost and retention estimate

Successful intake remains one Gemini call; recovery adds at most one Luna call and normally one bounded public read. No planning, token-count or diagnostic generation. Completed unchanged input remains zero model calls/finding writes; ordinary source bookkeeping is unchanged.

Target additional recovery accounting: one reserve and one settle RPC, roughly 6–10 internal SQL statements and 3–4 row mutations. Measure actual cost within the existing 96-statement / 256 KiB submitted-SQL ceiling. Target policy object under 1 KiB and added reservation metadata under 256 B/active attempt; measure bytes and attributable WAL. Only useful findings, source URLs and compact numeric/error state persist. Source bodies, prompts, responses and proof trails persist zero bytes. Recurring activity remains zero until reviewed activation.

## Verification, cleanup and activation

Use existing tests to verify Gemini success never calls Luna; retrieval/parsing recovery saves the expected record; valid partial/empty results do not fallback; auth/safety/accounting/budget failures stop; separate cooldowns and uncertain charges; atomic concurrent reservations; two total generations including improvement; unchanged input; identity/human corrections; no persisted traffic. Cover both selected-source and tracker-discovery paths. Retain a small second-task configuration check without creating that product feature.

After implementation approval and fresh provider/credit/SQL preflight, run **one E02 tracker pilot first**. Measure both actual calls, reads, tokens, latency, estimated versus observed billed cost, SQL/mutations, retained bytes and WAL. Independently check date/time/registration, optional end and source-supported timezone. Review E02 before extending to frozen E09 CBD native-ID and A07 UN notification cases. Then verify an unchanged run makes no model call or finding write. Mock mechanics/direct extraction are not production fallback proof.

Completion includes **test-bloat cleanup**: consolidate repeated setup and remove obsolete/duplicated affected coverage, preserving distinct failure/accounting/partial/unchanged/factual checks. Measure test lines, fixture bytes and runtime before/after; run retained regressions/build. No replacement framework or unrelated cleanup.

Deploy reviewed migration, secret/config and collector together after concrete code/tests are ready for review. Begin with a manual tracker window and report the visible save and measured cost before recurring activation. Recurring trackers, notifications and the stopped heartbeat remain separate actions. Later Slack Q&A retains its agreed provider/compare commands and is outside this tracker-backup change.
