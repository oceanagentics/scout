# Scout refactor consumption plan

Status (11 October 2026): collector v133 at b78252f and the Firebase frontend are deployed with collection and notifications paused. The current understanding/final-finding contract reduction is mechanically reviewed and committed locally, with 286 checkout tests, 268 isolated Git-index tests and build passing. Its deployment is held: the simplified in-memory E04 candidate failed clock and organization-role acceptance, and a medium-thinking variant failed the first-response contract. No production E04 finding was written. Production preserves 71 records, uses 13,964,979 database bytes and retains 14 quota reservations; the model policy is disabled. Native migration preservation and authorized legacy cleanup completed. Account-wide Supabase analytics usage, revised live cost and broad corpus acceptance remain pending. All four cron jobs and the manager heartbeat remain paused.

## Current architecture proposal and operating budget

This section supersedes the earlier requirements to retain raw evidence, prepared documents, model traffic, stage-by-stage job payloads, and reports. The user explicitly wants the machinery generating that material removed. On 11 October the user also authorized clearing legacy operational data while preserving useful findings and required active accounting. Historical benchmark fixtures are test inputs, not a reason to persist production inputs.

**Read a due source in memory, extract and validate useful facts, save changed findings and source URLs, discard the working material.** Events, announcements, and treaty changes remain in scope. Funding remains a future extension.

### What stays and what stops

| Keep | Stop generating or persisting |
| --- | --- |
| Current finding fields: identity, title, short description, dates, organizations and roles, type-specific details, priority, uncertainty, human overrides | Webpage/API/PDF captures, prepared text, OCR output and intermediate document versions |
| Source URLs, native identity keys, compact fingerprints and publication metadata | Saved prompts, model responses, quoted proof trails and complete record snapshots |
| One compact current state per tracked source/work item: due time, lease, fingerprints, attempt count and short error code | A new collection-run/report record for each poll, per-step report writes, growing JSON histories |
| Small durable quota reservations and numeric usage, retained only for their required accounting window | Quota bookkeeping embedded in large run JSON; model settings rewritten on each call |
| Existing access rules, tracker configuration and notification deduplication | Report/artifact UI and RPCs; health reconstruction from run history; background evidence repair/replay |

Persist URLs and final facts, never original content in a different table, job payload, cache, log, or error string. Model support checks can inspect source text and citations in memory. Human corrections retain the corrected value, source URL and a compact override marker. No new tracing system or replacement artifact store.

### Prompt and model-directed research — agreed 11 October

Each in-memory attempt has two responsibilities: understand the source and select research, then produce the final supported findings. Both prompts begin with Scout's purpose, record types and important information. Only the final prompt includes the typed finding contract, citation examples and relevance rubric. Instructions remain readable in `collector/finding-contract.js`; `collector/finding-jobs.js` supplies source material separately and `collector/model.js` sends each complete request. There is no implicit conversation memory.

| Record | Nature and important information |
| --- | --- |
| Event | A particular gathering or session: purpose, supported organization roles, start/end dates, location or online format, registration and status |
| Announcement | A specific development: what changed, issuer and affected organizations, publication, effective and response dates where applicable |
| Treaty change | An official treaty action: treaty, jurisdiction, action, responsible authority, action date and effective date |

Dates retain supported calendar precision even when clock or timezone is unknown. A participant, product, logo or reporting publisher does not establish an organizer. Source text and working notes are untrusted data. Keep supported facts and Low findings; distinguish genuinely unpublished facts from unresolved research. Funding commitments remain announcements; funding-opportunity collection remains future work.

**First pass: understanding and explicit source requests.** Supply the complete main material and safe available links with labels, context and native reference URLs. Return only `{understanding,research:{requests}}`. Understanding is working prose of at most 6,000 characters describing developments, stated facts and uncertainties. It contains no typed findings, citation wrappers, completeness decision or relevance rating. Nothing from this pass is saved.

```json
{
  "understanding": "An ocean workshop is announced. The programme may establish dates and hosts.",
  "research": {
    "requests": [{
      "url": "https://example.org/event/programme",
      "needed_for": ["details.start", "organizations"],
      "reason": "The page says the programme lists the schedule and hosts."
    }]
  }
}
```

Only this response may request supporting pages: at most three supplied URLs across the entire attempt, with nonempty declared field paths and a bounded reason. The field whitelist comes from the record contract, never from model notes. Code validates public URLs, supplied links, duplicates and shared request/byte/deadline budgets. No automatic registration/organizer fetches, guessed URLs, search or recursive browsing. An empty request list makes no supporting reads and never proves completeness.

**Final pass: supported findings and completeness.** After requested reads, supply the full main and supporting documents, working understanding, fetch statuses, important fields and input hash. Always perform this pass, including when understanding is empty or incomplete and no links were requested. The model must read the documents, recover omissions and correct mistaken notes; notes cannot serve as citation targets.

Return `{input_hash,complete,reason,checked_documents,findings,relevance,checks}`. Findings alone contain typed values and their direct citations, correction sources and explicit unknowns. Each aligned check is `{checked_fields,occurrence:{status,reason}}`: coverage of important fields plus whether the cited occurrence establishes the named development, kind and title. Do not reproduce values or proofs in a per-claim audit ledger.

Every populated final fact must be supported in meaning. Remove unsupported organizations/identities, set unsupported ordinary facts to null and omit unsupported clock/zone components while preserving supported date precision. Explain uncertainty using the existing field paths and reasons. The literal final example shows both description and canonical URL as claim objects.

Code validates the final finding shape, exact supplied citation locations, PDF pages, dates and native calendar semantics, allowed roles, identities and official treaty authority. These mechanical checks do not establish arbitrary passage meaning; that remains a model responsibility requiring live validation. Malformed check shapes are finite technical retries; well-formed unsupported or uncertain occurrence decisions retain identity-conflict handling.

Preserve the input-hash and document-coverage checks, important-field coverage and unresolved-unknown gates. Only adequately checked results receive a processed fingerprint. Failed requested reads are not evidence that a fact was unpublished. Save useful validated facts with their unresolved state when appropriate, but do not mark the source successfully processed. Keep human overrides, established facts, existing-provenance correction requirements, native identities, leases and optimistic concurrency. Save only final facts, URLs and compact state; discard all notes, citations, source bodies and model traffic after the invocation.

**Parked sources still receive bounded change checks.** Keep the three-attempt bound for unchanged unsuccessful input; pre-dispatch quota refusal does not consume an attempt. Recheck main material and previously requested supports within the HTTP/runtime budgets. Unchanged completed or exhausted input makes no model calls or finding writes. Relevant changes or fetch recovery may reopen processing without resetting attempts on routine wakes. Retain only current fingerprints, URL/status metadata, counters, due time and short error codes.

The operating bounds remain two generations with exact token preflight and three requested supporting reads per attempt. No new stages, recurring jobs, tables or model retries are introduced. Persistence paths and SQL budgets remain unchanged; measure actual revised cost before unattended operation. One hourly selection still cannot promise 400 source checks/day. Collection, notifications and the manager heartbeat stay paused until reviewed.

Acceptance before further live expansion:

- With empty or misleading understanding and no requests, the final pass can recover a stated date and actual organization from the main source and save them. The same input then makes zero model calls or finding writes.
- Through manual and scheduled entrypoints, fetch only requested supplied links after the first response. Preserve URL safety, deduplication, native references, three-read limits, failure/recovery handling and parked change checks.
- Final invalid shapes, invalid citations, stale hashes, missing coverage, unsupported occurrences and unresolved research cannot establish successful processing. Preserve event/announcement/treaty meanings, product-versus-organizer decisions, independent date components, human overrides and explicit correction requirements.
- Mocked responses establish mechanics only. Refresh shared quota/account usage, preserve all existing charges and run one bounded real-model intake with SQL/mutation/retained-byte measurements. A single successful run is not reliability evidence. Live source/model correctness, native PostgreSQL WAL/I/O cost and the existing frozen/held-out precision and recovery gates remain acceptance work. Do not create source/prompt/response archives or reuse the old persistent benchmark runner unchanged.

### Implementation sequence

1. Replace acquisition persistence with compact source state. Keep useful HTML/calendar/PDF/API readers and fetch limits. Keep observed and successfully processed fingerprints distinct: a failed or quota-deferred attempt must not mark its input processed. An identical completed input returns before any model call. Capture/preparation IDs no longer drive processing.
2. Execute the model-directed research flow above, identity matching and relevance decisions in memory within a bounded invocation. Use native identities and source URLs first. Allow at most two model generations: initial working understanding with explicit source requests, then final supported findings and completeness checking. A failure ends the attempt with a compact reason and retry deadline. Re-fetch on a later attempt; do not persist intermediate packets to resume a stage.
3. Save final facts and acceptance together in one record write. Insert source associations/native identity rows only when new. Compare canonical useful fields before UPDATE; a recheck alone must not update a finding, append a version, or rewrite its identities. Save atomically with optimistic concurrency and preserve human overrides. A one-line cursor may support a large listing; never store its body or extracted packet.
4. Replace the growing run-based model ledger with fixed-shape, small reservation rows. Retain the existing pre-dispatch reservation, exact token preflight and usage reconciliation protections: three small row mutations per generation attempt. Expire only reservations whose quota window has closed and whose accounting is settled; carry unresolved charges conservatively into bounded numeric accounting. Honor provider retry deadlines. Do not reset old accounting or modify limits to make a benchmark pass.
5. Collapse orchestration to one hourly due-work check, with source refresh every six hours by default and daily for quiet sources. This deliberately trades sub-minute polling for hours-scale source freshness; specific sources can receive a deliberate tighter schedule. Check for due work before dispatching HTTP. Use a source lease and current-state row, not a new run history. Make health a read of current state. Keep one bounded maintenance action for expired operational metadata, piggybacked on scheduling. Preserve notification eligibility/deduplication; remove repeated model re-assessment of unchanged accepted facts.
6. Remove the obsolete production paths and their dependent UI/tests: report.js/report_entries, capture/preparation persistence, capture-based job replay, history-based queue/health reconstruction and persisted proof reconstruction. Keep the small source readers, factual validators and meaningful behavioral tests. The compatible migration copies useful fields, primary and supporting source URLs, identities and active quota charges, then drops the legacy evidence/run tables. Unresolved notification deliveries block this deletion. Old producers must remain disabled through cutover.
7. Review the whole diff and measured operating cost before deployment. Apply compatible schema/backend/frontend changes with schedules still paused; run a bounded comparison and inspect saved records. Resume schedules only after acceptance. One focused implementation commit excludes unrelated dirty work. The existing worker remains the only implementation writer when work is resumed.

### Storage estimate

Budget lookup on 11 October: the original Services tab explicitly requires $0/month recurring fees, Supabase Free and Gemini Free, and records Tavily's 1,000-credit allowance. Current official Supabase limits are 500 MB database per project, 5 GB monthly egress and 500,000 monthly Edge invocations. Nano baseline is 5 MB/s and 250 IOPS; design below baseline rather than depend on burst credits. Database quotas are shared with other services in chm, and several allowances are organization-wide. SQL has no separately published per-statement free allowance; internal operation budgets must protect actual compute/I/O and storage. Sources: https://docs.google.com/document/d/13HIEN45IEKQN-i29pQuoRD-eeFOl-t70a1_2TBpV7zI/edit?tab=t.1h6brasprb8e ; https://supabase.com/docs/guides/platform/billing-on-supabase ; https://supabase.com/docs/guides/platform/compute-and-disk .

The old hosted policy (Oct 9 snapshot) was two attempts/minute, ten/run, and zero configured daily/TPM caps. Those zeros do not establish unlimited provider quota. The manager verified bbnj-chm/gemini-3.5-flash-lite at 22:14 UTC on 11 October: 15 RPM, 500 RPD, 250,000 input TPM, billing disabled, and no usage reported today. The exact check is in `.cache/scout-refactor/model-budget-check.json`; telemetry can lag and fresh verification is required at pilot time. Gemini limits are per project/model; RPD resets at midnight Pacific. Source: https://ai.google.dev/gemini-api/docs/rate-limits . Supabase API connectivity and database headroom are verified, but the current token cannot read account-wide analytics usage. This permission gap does not authorize uncapped or recurring work.

Single-record pilot selected: E04, IDDRI's “Making MPAs work in the High Seas” page. Independently read official source: https://www.iddri.org/en/publications-and-events/conference/making-mpas-work-high-seas-sharing-lessons-learned-established . Expected essentials: event on 2026-02-26, local start 12:00 EST (UTC-05:00; 17:00Z), IDDRI as speaker/participant, registration URL; no invented end time or organizer. This exercises both date/time and organization roles. The web tool's page is a cached source read; the live pilot must fetch its own source. Preserve the existing expected development facts and report any real source change separately.

Enforced operating policy for the replacement: no unattended model dispatch without verified finite quota configuration; allocate no more than half the verified project allowance after reserving known shared usage. Preserve in-flight/unsettled charges. The first manual pilot is one record, at most two generations, no search and no notifications, and cannot exceed the actual verified remaining allowance. Use compact SQL/model/runtime guards and fail closed on missing budgets. Stop new source/model work at 80% of the database-size allowance (400 MB for this 500 MB project); current size must be checked before live writes. Runtime/SQL/IO measurements remain release evidence, not inferred from pricing. All numeric cost estimates below remain unverified until tested.

These are design estimates, not measurements of the replacement. Use decimal KB/MB. Assumptions: ordinary short description, 1–3 organizations, 1–3 source URLs, small typed dates/identity metadata, and one or two model calls. Multi-source and unusually large records cost more in proportion to their actual fields.

As a size sanity check, projecting only labeled facts/title/kind/unknowns from the 24 existing development cases produced JSON of 207–635 bytes (median 318 bytes). This is an incomplete record projection: it excludes descriptions, URLs, database representation, indexes and operational state. It does not establish physical storage cost. Held-out cases were not opened.

| Item | Proposed estimate / bound |
| --- | --- |
| Final finding plus its source/identity metadata | Typically 2–5 KB logical data; approximately 10–20 KB physical storage allowance including rows/indexes and a share of source state |
| Source state shared across its findings | Approximately 0.3–1 KB logical data per source, updated in place |
| Quota reservation | Approximately 0.2–0.5 KB logical data per model attempt; short-lived within the applicable accounting window |
| Saved source bodies, prepared text, prompts, responses, reports | Zero new bytes |
| 71 ordinary records | Approximately 0.71–1.42 MB incremental physical storage allowance |
| 10,000 ordinary records | Approximately 100–200 MB incremental physical storage allowance |

These figures exclude existing historical content, database/system-table minimum sizes, platform logs, backups and transaction logs. Record refreshes replace current values; there is no history accumulation per refresh. PostgreSQL still creates dead tuples that ordinary vacuum must reclaim for reuse. Operational storage scales with tracked sources and active accounting windows, not all past polls. Bound retained source/lead inventory too: use existing tracker horizons, and expire completed unreferenced leads so discovery cannot become a permanent crawl archive.

### Database write estimate

Count row INSERT/UPDATE/DELETE mutations, including quota expiration, not just SQL calls or transactions. A bulk INSERT touching ten rows counts as ten. SQL statement count can be lower through batching; transaction commits, indexes, triggers and physical disk I/O are separate. The implementation must account for triggers and platform writes in verification.

For a normal processing pass, let S be source-state rows claimed/completed, M model generation attempts, R new/materially changed record rows, L new source associations and I new identity rows:

`processing row writes = 2S + 3M + R + L + I`

Later expiration adds one DELETE per retired quota row (M). Extra provider-wide cooldown updates, recovery work, lead discovery, notification sends and platform maintenance are separate; they cannot be hidden inside this formula.

| Scenario | Processing mutations | Later quota expiration | Total application mutations |
| --- | --- | --- | --- |
| New record, one source, one new source link and identity, one model call | 8 | 1 | 9 |
| Same, with a second completion/checking call | 11 | 2 | 13 |
| Existing record changes; source/identity associations already exist; 1–2 model calls | 6–9 | 1–2 | 7–11 |
| Source changed, but extracted facts are unchanged; 1–2 model calls | 5–8 | 1–2 | 6–10 |
| Completed source unchanged at its next due check | 2 source-state updates; zero finding writes/model calls | 0 | 2 |
| Fetch fails before any model call | 2 source-state updates | 0 | 2 |
| Model attempt fails after reservation/preflight | Up to 5, plus at most one shared cooldown update if required | 1 | Up to 7 |
| No source due | 0 application mutations and no HTTP/model dispatch | 0 | 0 application mutations |

Newly discovered URL inventory adds one compact source-row insertion if it cannot be combined with claiming. Each extra source link or native identity adds one insertion. Multiple records on one page share source and model overhead. For example, 20 new findings from one source and one model call, each with one source link and identity, require 65 processing mutations plus one quota-row expiration: 66 total, or 3.3 per finding. This assumes the page fits one adequate model call; it is not a quality claim.

Notification delivery is separate from extraction: propose one compact per-record/version delivery marker written before sending and finalized after sending (two mutations), with uncertain deliveries held from automatic resend. No stored message body or model re-selection poll. Any retained notification model call adds the same four lifecycle quota mutations and must be justified explicitly. No messages are sent during validation.

The hourly schedule adds 24 scheduler wakes/day. pg_cron/pg_net can create their own operational rows even when application work is small. Budget provisionally up to ten small platform row mutations per wake (240/day), including retention deletions. The replacement scheduler deletes at most 48 of its own completed log rows older than one day per wake, even when budgets block collection. Installed pg_net has a six-hour response TTL; expiry may wait for worker activity. Unrelated job histories and fresh shared HTTP responses are preserved. Platform write/WAL cost still needs measurement before release; do not exclude it from the budget.

Example ongoing workload: 100 sources checked every six hours gives 400 checks/day and 800 source-state mutations/day when unchanged, with zero model calls, zero record changes and zero retained source bodies. Add the provisional platform allowance of 240/day and a small measured bounded-maintenance allowance. Record count alone cannot predict polling work; source count and refresh interval are explicit inputs.

The current implementation deliberately selects at most one due source per hourly invocation: at most 24 selections/day. It does **not** deliver the illustrative 400-check/day workload above. Recurring operation remains paused; source freshness and throughput require separate acceptance before activation.

Recreating 71 records from 71 independent sources would therefore budget 639–923 application row mutations including quota expiration, plus scheduler/notification work where applicable. This is a planning scenario, not an attribution of the historical 366,861 report updates to those 71 records.

### Transaction-log estimate and release tests

Provisional WAL planning range: roughly 20–200 KB for an ordinary new-record lifecycle under the assumptions above, or 1.42–14.2 MB for 71 independent creations, excluding unrelated/platform workloads. Use 250 KB average per ordinary new record as an initial review ceiling; do not claim it achieved without measurement. Updates and deletes produce WAL even when retained data size stays flat. Full-page images, indexes and checkpoint timing make WAL different from logical saved bytes: https://www.postgresql.org/docs/17/wal-configuration.html . The range is an engineering allowance, not a measured result or a guaranteed physical-I/O ratio.

Before deployment, use the existing runner and a real PostgreSQL test environment to verify:

- New record: correct dates/organizations/type/URLs, one final record save, expected row mutation counts including side effects. Repeat with two model calls and multiple sources.
- Unchanged record/source: 100 scheduled repeats produce exactly 200 source-state mutations, no model calls, no new records/history, and no accumulating source content. Empty due checks produce zero application writes. Test changing irrelevant source content separately from materially changed facts.
- Large sources: increase a page/PDF from small to large while keeping the same final facts. No body, prompt, response, quote trail or irrelevant sentinel may appear in database parameters, normal logs or error state. Saved storage and writes must not scale with input size.
- Failure/crash: preserve pre-dispatch quota charges, do not mark unfinished input processed, re-fetch when resuming, reject stale concurrent writes, and enforce a finite processing-attempt cap. Initial proposal: at most three processing attempts for unchanged content, each with at most two model generations; then park. New cron wakes do not reset that cap. Provider cooldowns prevent dispatch until due.
- Storage/WAL: measure table/index deltas, row mutations, statement counts and per-statement WAL on identical workloads with warm pages and across checkpoint boundaries. Include quota expiry and scheduler/pg_net overhead. Compare against a baseline without resetting accounting or statistics. Do not use PGlite or serialized-byte counts as proof of measured PostgreSQL WAL. Keep ordinary vacuum/reuse behavior in the steady-state check.
- Quality/access: keep the existing source-backed before/after accuracy gates, uncertainty behavior, human overrides, isolation and notification dedupe checks. Removing persistence does not weaken the factual contract. Missing live semantic validation remains pending.

No production restart based only on passing functional tests or a theoretical cost estimate. Manager reports the proposed deletion of code and actual test/cost results before production cutover.

### Earlier verification snapshot — 11 October

Before the current contract reduction, the local suite passed all 283 tests, build and whitespace checks. Separately, all 265 tests in that focused staged tree passed with JavaScript loaded directly from the Git index and unstaged Explorers modules inaccessible; no second checkout was created. Manual and scheduled entrypoint tests recover deliberately omitted dates and organizations from the main page or one explicitly requested programme, with no unrequested or recursive reads. Additional checks cover announcement/treaty date meanings and roles, genuine unknowns, saved-value conflicts, support failure/recovery, parked checks, finite retries and quota refusals. The E04 test uses the production reader, model quota wrapper, factual validators and save path with the tracked IDDRI fixture and mocked provider responses. It saves 26 February 2026, 12:00 EST / 17:00Z, IDDRI as participant, and registration; no invented end time. These verify mechanics, **not live model judgment**. Compact results and exact implementation hashes are in `.cache/scout-refactor/requested-research-checkpoint.json`.

| Measured offline result | Value |
| --- | --- |
| First creation | 33 counted SQL statements (including instrumented function statements), 11 row mutations |
| Provider HTTP in the test | 2 token-count requests and 2 generations; replies and token counts mocked |
| Retained final record, source link, identity, source state and two quota rows | 4,208 bytes serialized as JSON; 2,427 bytes via `pg_column_size` |
| Source page | 56,738 bytes read; zero source-body bytes persisted |
| 100 unchanged due checks | 200 statements, 200 source-state mutations, zero model calls, zero finding changes, unchanged table row counts |
| Irrelevant source-text change | Final finding unchanged; source/model processing still occurs |
| Full hosted creation | 40 statements / 11 mutations for main only; 41 / 12 with one additional programme source association |
| Full hosted unchanged or parked check | 9 statements / 2 source-state mutations; zero model calls or finding writes |
| Compact source state in hosted fixtures | 642 bytes main-only; 773 bytes with one requested source; research metadata capped at 8 KiB |

Row sizes exclude indexes, heap-page allocation, platform data and WAL. Quota expiration adds two later deletions for this two-call case. Manual hosted pilots run the same bounded quota expiration as scheduled collection: up to 32 expired rows, with unresolved charges carried into numeric totals. This adds five counted statements when no expired rows exist; the direct processing test's 33 statements exclude hosted entrypoint work. The manager's native PostgreSQL migration rehearsal passed against the exact migration hash and rolled back, preserving all 71 records and final facts/URLs/delivery markers; see `.cache/scout-refactor/native-migration-rehearsal.json`. That rehearsal does not measure workflow WAL or prove live extraction quality. Both remain pending, with fresh finite model/database budget verification required before the bounded pilot. Recurring collection, notifications and the manager heartbeat remain paused.

### Current local verification — 11 October

The reduced two-pass contract passes all 286 checkout tests, 268 isolated Git-index tests, build and whitespace checks. The index run loads only staged JavaScript and excludes the unrelated Explorers addition; no second checkout is used. Forty focused workflow/record/integration tests cover empty or misleading understanding, the 6,000-character bound, typed final facts and citation rejection, important-field/document coverage, technical retries versus unsupported occurrences, independent date components and corrected organization roles. Existing-value corrections require prior provenance; a new regression rejects an otherwise valid correction from an unrelated source URL. Human overrides and stale-version/lease protections remain intact. The mocked E04 path still uses 33 SQL statements and 11 mutations, with two token-count requests and two generations; unchanged repeats make zero model calls or finding writes. These are mechanical results, not live factual acceptance. The manager-run simplified E04 candidate failed clock/timezone and organization-role acceptance despite completing its in-memory save. A controlled medium-thinking variant then failed the first-response research shape before completion. No production finding was written; deployment of this reduction is held.

### Legacy operational retirement — verified 11 October

Applied `supabase/scout-retire-operations.sql` in one bounded transaction after checking paused jobs, closed quota windows, resolved notification accounting and local rollback/preservation tests. Removed 5,729 run rows, 8,338 unlinked evidence rows, 7,491 Scout cron log rows and 328 HTTP responses older than the installed six-hour TTL. Cleared captured documents, proof quotations and processing histories from the 114 linked rows; retained accepted values/times, assessment details, source URLs and association metadata for the deployed reader. All 71 record rows remain byte-for-byte identical.

| Live measurement | Before | After |
| --- | ---: | ---: |
| Database | 39,622,323 bytes | 13,440,691 bytes |
| Finding table, including indexes | 139,264 bytes | 139,264 bytes |
| Linked/unused evidence storage | 13,107,200 bytes | 360,448 bytes |
| Run storage | 6,488,064 bytes | 32,768 bytes, empty |
| Cron run history | 1,556,480 bytes | 16,384 bytes, empty |
| HTTP responses | 5,472,256 bytes | 32,768 bytes, empty |

The cleanup executed four table truncations and reinserted 114 compact source rows; no model calls or finding mutations. PostgreSQL also changed catalog rows for the retired views/functions and write guards. Cluster-wide WAL advanced 17,197,248 bytes between the surrounding snapshots; that includes any concurrent platform activity and is **not** a per-finding pipeline cost measurement. No statistics or quota accounting were reset. Earlier body/report cleanup had already reduced the database from 931,763,891 bytes to roughly 39.6 MB.

Pre/post fingerprints matched for record bytes, all linked source metadata, accepted values/acceptance times/supporting URLs and assessment fields. PostgreSQL rejected native owner-role attempts to write a new run or update evidence. `loop_tick`, `loop_health`, `loop_retention`, `source_backlog` and `source_queue` are removed. The four existing cron jobs remain disabled. Empty run storage and compact linked facts remain temporarily for compatibility with the deployed reader; the reviewed replacement migration transfers those facts and drops both tables without CASCADE.

Prevention fixes: remove legacy tables at cutover, carry supporting URLs before deletion, expire quota rows on manual pilots too, and bound the hourly scheduler's own log history. Source inventory is currently capped at 200 child URLs per tracker; horizon-based retirement of unreferenced completed leads remains a freshness/coverage review item before unattended use. No new source captures or reporting system was introduced.

Evidence: `.cache/scout-refactor/cleanup/retirement-outcome.json`, `retirement-verification.json`, `retirement-targeted-tests.log` and `full-tests.log`. The original date/organization quality gates remain pending; this cleanup does not establish live extraction correctness.

## Purpose and authority

Replace Scout's intertwined document extraction, completion, identity resolution, and repair core with a shared finding-oriented workflow. The user approved the architectural proposal and asked for the complete plan, before/after tests, and a manager supervising a worker chat. This file is the implementation handoff and acceptance contract.

The manager is chat `01a12083-438a-7453-acc9-23b9d76c66fc`; the worker is chat `01a121b8-ef1b-78e3-9b28-ec8b86f33dbe` (local). One worker implements in the existing `/Users/danvallentyne/dev/oceanagentics/scout` checkout. No clones, worktrees, checkout switches, or additional workers. Manager review is a work checkpoint, not another request for user authorization.

Current scope: events, announcements, and treaty changes. Design and test the extension boundary for funding opportunities; production funding discovery/application workflows remain future scope. An announcement about funding is in scope today even when no application opportunity exists.

This plan supersedes the ongoing omitted-date/organization patch loop and its incompatible architectural constraints. It deliberately revisits the decision to exclude calendar dates from records. Keep the source inventory, relevance policy, validated Low findings, existing app purpose, access controls, and recurring free-tier budget. Existing repository instructions still apply elsewhere.

## Baseline and ownership

- Starting committed revision: `bfc89bb6faece472ac64c4e9d885247edbe9aed5`; deployed omission checkpoint reports collector 131 / resolve-32. Verify live state before any release.
- Omission change at this checkpoint: 48 files, 1,999 insertions, 103 deletions, and 28 migrations. These include tests and SQL, not 1,999 lines of event logic.
- Latest saved verified repair counts: 21 organization fields, 18 calendar starts, five UTC ranges. These are historical checkpoint counts, not a new independent database audit.
- Source checkpoint: `.cache/scout-omission-repair/checkpoint-summary.json`. Provider reset recorded as 2026-10-10 07:00 UTC; revalidate the ledger before any model call. Frontend date display publication is blocked by Firebase authentication.
- The old repair heartbeat was paused, then repurposed as **Manage Scout finding refactor**, retaining its 30-minute cadence and targeting the manager chat. It checks worker progress and review boundaries. Do not reactivate the superseded patch workflow or run a competing production repair worker.
- Pre-existing dirty work: `README.md`, `collector/hsa.js`, `tasks.md`, `tests/document-integration.test.js`, and untracked `collector/explorers-documents.js`, `tests/explorers-documents.test.js`. Inspect and preserve it. Record its diff/hash baseline. Coordinate overlapping edits; never stage or discard unrelated hunks.
- Worker owns implementation/test edits after baseline approval. Manager owns review and release decisions and avoids simultaneous edits to worker-owned files.
- Keep this document's checkpoint concise: phase, evidence paths, decisions, remaining work, blocker/retry deadline. Do not append a transcript of every command.

## Why replace the core

| Concern | Current behavior | Required replacement |
| --- | --- | --- |
| Work item | Captured document and processing-version history | A substantive finding with sources |
| Discovery | Source-specific document routes | Shared lead discovery with small source access adapters |
| Research | Link support bolted onto review/repair | Gather authoritative detail sources as normal work |
| Dates | UTC instants on records; date-only proof reconstructed from evidence | Dates and optional times/timezones with explicit meanings |
| Organizations | One overloaded string | Names with supported roles |
| Extraction | Facts, relevance, citation protocols, matching and repairs intertwined | Focused typed extraction, mechanical validation, then matching |
| Identity | Broad lexical candidates and repeated full comparisons | Native IDs/canonical URLs first; bounded ambiguity review |
| Qualification | Completion, identity, relevance and field support interact | Separate identity, completeness and relevance |
| Retry | Nested historical repair state and version-specific queues | Durable jobs, reason categories and finite retries |
| Change | Prompt versions hard-coded in SQL views | Version metadata; migrations only for database changes |
| Outcome | Processing completed | Accurate useful records, measured coverage and visible gaps |

Retain useful acquisition code, source retention, quota accounting, atomic saves, source change detection, and notification safeguards. Replace obsolete paths rather than leave a second permanent engine beside them. Some API-specific access code is legitimate; publisher-specific semantic rules in the shared core are not the default solution.

## Target workflow

`discover -> gather evidence -> extract typed proposals -> validate and match -> assess support and relevance -> save and surface`

These are responsibilities in the existing application, not separate services or autonomous agents.

1. **Discover leads.** Feeds, listings, social posts, official registries, and search produce source-backed candidates. A document can describe several findings; several documents can describe one finding. Retain candidates independently of final acceptance so missed coverage is measurable. Listing segmentation retains headings, edition context, and native identifiers.
2. **Gather evidence.** Prefer the finding's official detail page, registration page, programme, calendar, or official publication. Choose another source according to missing information. Follow relevant links and use bounded targeted search when links are insufficient. Log inaccessible/unvisited sources separately from absent facts. Large documents are processed in relevant sections with retained context, not silently truncated into false absence.
3. **Read sources consistently.** Shared HTML/structured-data/calendar/PDF readers; use native API field references directly where available. Preserve source structure and distinguish metadata from described facts. Provide a shared visual/OCR route for information absent from a PDF text layer. Choose a deployable implementation that respects existing runtime and budgets; if a capability is unavailable, report that limitation rather than claiming full support.
4. **Extract focused facts.** One ordinary fact-extraction pass per finding evidence packet is the starting target. Return values with source references; derive mechanical normalizations in code. Avoid asking the model to rewrite historical arrays to add one value. Discovery may require a separate listing-level call. An extra call must have a recorded purpose, such as new evidence or ambiguous identity.
5. **Validate and match.** Validate shape, reference existence, source roles, date ranges, and native identity consistency. Interpret semantic support with the model where needed. A literal quote match alone is not proof of correct meaning. Match native occurrence IDs and reliable canonical URLs first, then plausible title/edition/date/organization candidates. Never merge sessions or annual editions solely because their titles match. Preserve rescheduling and cancellation against stable internal identity.
6. **Save and surface.** Save supported facts with evidence and optimistic concurrency/atomicity. A disputed field need not erase independent established facts. Assess relevance separately. Notifications use existing eligibility rules and accepted record versions; incomplete facts must not silently create notification duplicates.

## Common record and type-specific facts

Keep a common record envelope: internal ID, kind, title, short description, canonical/source identities, related organizations with roles, evidence references, completeness/review state, relevance and reason, and record version. Use the smallest explicit typed detail structure that supports real reads and filters; do not prebuild a universal ontology or organization registry.

| Kind | Type-specific information | Dates | Organization roles |
| --- | --- | --- | --- |
| Event | Occurrence/edition, optional parent, location/online mode, registration, status | Start/end calendar dates; optional local clock and timezone; derive UTC only when supported | Organizer, host, partner, funder, participant |
| Announcement | What changed/was announced, original publication and subjects | Publication/announcement date; effective date only when applicable | Issuer, publisher, subject organization |
| Treaty change | Treaty, jurisdiction, official action/status | Action and effective dates, independently supported | Official authority; jurisdiction separately |
| Future funding opportunity | Programme/round, purpose, eligibility, amount/currency, geography, application link | Opens, deadline, explicit rolling status | Funder, administrator, delivery partner |

- An announcement about a funding commitment remains a useful announcement before an application opportunity is published. A later opportunity may link to it; do not manufacture one.
- Event day without a clock is valid. Unknown time must not hide a known day. Preserve partial precision such as month/year when useful, without inventing a day. Keep publication, capture, effective, event, and application dates distinct.
- Standard calendar parsing must respect all-day values, timezones and end semantics. Do not reinterpret an exclusive calendar end as an extra event day.
- Organizations have roles. A publisher is not automatically an organizer; a named partner is still a useful associated organization. Retain multiple organizations. A supported affiliation should not require entity-registry enrichment.
- Evidence references point to an immutable source capture and useful location: excerpt/block, JSON path, or PDF page/region. Store a capture once and reference it. Preserve raw material and concise reasoning sufficient for inspection; avoid duplicating whole response histories per record/version.
- Accept contextual interpretation only with recorded evidence and appropriate certainty. Never copy publication dates into event dates, parent-conference ranges into session schedules, or another occurrence's organizations merely to fill blanks.
- Keep type extension explicit. Funding-ready contract examples must demonstrate that a funding deadline cannot be confused with an event start. Do not enable funding ingestion or broaden the tracker inventory in this refactor.

## Qualification, input and retry behavior

Identity, completeness and relevance are independent. Validated Low findings remain available. Announcements and treaty changes do not need event fields. A real event with an unpublished schedule remains a provisional finding with a clear reason. The main app must distinguish complete/useful records from discoveries awaiting research while keeping the latter inspectable.

Use a small set of specific field/job reasons: not announced, inaccessible source, conflicting evidence, ambiguous identity, research budget exhausted, and technical failure. Relevance does not decrease solely because details are missing. Unknown does not mean proven absent.

Source-URL input or a user-supplied authoritative companion enters the same workflow. Source-backed human corrections must keep their provenance and survive subsequent automated refreshes; reuse existing admin mechanisms where possible. Build only the minimal input/review controls needed by this workflow, not a new editorial product.

Network errors back off. Quota errors wait for the actual provider/shared-ledger deadline and retain reservations. Invalid output gets a bounded correction. Missing facts get bounded targeted research. An unchanged exhausted attempt stays parked until sources change, a scheduled refresh finds new evidence, a reviewed implementation improvement applies, or a human explicitly reopens it. Record the condition. Do not keep retrying to make counts look better.

Budgets apply per finding and globally, including search, visual reading, retries, token counting and all models. Set initial bounds from measured baseline, report spent work and remaining evidence, and prioritize fresh findings over old backlog. No paid fallback, billing enablement, quota resets, or ledger deletion. Choose a model by measured accuracy and cost per correct finding, not advertised strength or repeated prompt escalation.

## Before/after evaluation contract

Freeze the evaluation corpus and expected answers before changing behavior. Use retained real source fixtures/captures and expand only where a required source form is missing. Do not invent expected facts from current model output. Every expected fact must have a human-inspectable source location and correct occurrence/type attribution.

Initial target: 36 real cases across 18 events, 12 announcements, and six treaty changes, split into 24 development cases and 12 held-out cases. If retained evidence cannot support that mix, document the concrete adjustment before implementation. Keep held-out expected answers out of prompts and use them only for evaluation. Add a few small future-funding contract examples without launching funding collection. Case count is a starting scope, not a reason to manufacture repetitive tests.

Required coverage includes:

- Ordinary complete event; date-only conference; explicit UTC calendar; unknown timezone; rescheduling/cancellation; repeated title across editions; session within a parent conference.
- CBD native session/host references; multi-event listings; HTML registration detail; PDF text and image-only fact; multiple organizations with distinct roles.
- Substantive publication/announcement; original versus repost; announcement describing an event; funding commitment announcement with no open application; event/publication dates on the same page.
- Official treaty action with distinct action/effective dates; unofficial reporting that does not independently establish official status.
- Genuine unknowns; unreachable source; conflicting claims; source changes; duplicate discovery; ambiguous identity; quota deferral and resume; invalid output; stale concurrent save; unchanged repeat.
- Existing known failures from omission/identity investigations, plus unseen cases. Include Low relevance and a useful unscheduled/provisional finding.

Record for both versions: discovered candidates, expected findings, accepted/provisional/unresolved/rejected outcomes, field correctness and missingness, identity decisions, source support, model/search calls, tokens, elapsed processing time, and quota wait time separately. Use all expected findings as the recall denominator; dropping difficult records cannot improve the score. Count organization roles and date meanings, not just non-null values.

Before changing the engine, record the exact baseline revision and dirty-file hashes, source-corpus hashes, expected-answer manifest, request envelopes, retained actual responses where available, test/build results and known failures. Compare on identical retained inputs. Historical captured responses are historical evidence, not a fresh paired model run. Injected responses test mechanics, not model quality. If provider quota blocks live evaluation, freeze the requests and complete offline work, then run the bounded paired comparison when allowed. Never present mocks or a replay as current live success.

Acceptance gates:

1. Deterministic contract checks pass for all supported source types, typed dates/organizations, state transitions, saved-reader behavior and idempotency. Date-only values display, sort and filter correctly; announcements/treaty changes show their own applicable dates.
2. No fabricated dates/organizations or incorrect occurrence merges in the evaluated corpus. A disputed case can remain explicitly unresolved.
3. On independently labeled accessible sources, target at least 95% precision and 95% recovery of supported essential fields, with numerators/denominators and per-type breakdown. Small samples and genuine limitations must be disclosed. Held-out cases must pass before release; thresholds may not be weakened to bless a failure.
4. Discovery recall and retention of valid High/Normal/Low findings do not regress. Genuine unknowns remain unknown with accurate reasons.
5. Measured model calls/tokens per correctly resolved finding improve over the comparable baseline. Normal paths avoid completion/re-resolution loops. Report differences in source work and quotas; do not claim speedups from omitted work or different test conditions.
6. Existing auth/access, shared-project isolation, quota accounting and notification behavior remain correct. Document baseline failures and show no new unexplained failures. A flaky rerun alone does not establish that an introduced failure is unrelated.
7. The replacement removes obsolete production paths. Report added/deleted production code, tests and migrations separately. No domain-by-domain semantic patch collection, prompt-version SQL ladder, or legacy repair-history reconstruction.
8. Operational write cost is a release gate. Report persistence must avoid repeatedly rewriting accumulated large evidence payloads. Compare database write counts and submitted bytes on identical representative runs, including failure/recovery checkpoints; measure actual WAL separately when safe database access is available. Clearly distinguish offline size/count proxies from measured WAL. Preserve durable accounting and required evidence; passing functional tests alone does not satisfy this gate.

One meaningful end-to-end benchmark and a compact set of boundary tests are preferable to hundreds of implementation-mirroring tests. Use the existing test runner. A small reusable evaluation fixture/runner is authorized by this before/after requirement; do not add miscellaneous debugging scripts or a new testing framework.

## Execution and manager review

### Phase 1 — freeze baseline and settle the implementation boundary

Worker inventories the reachable current paths and useful reusable components, preserves dirty work, freezes the corpus/expectations, runs baseline tests/build, and captures comparison artifacts. Propose the smallest schema/worker/UI changes and a deletion list. Identify model/search/visual capabilities and measured budget constraints. No production mutation or old-engine patching. Stop for manager review with the concrete baseline; manager then authorizes Phase 2 within this already approved task.

### Phase 2 — implement and verify locally

Replace the core in place. Implement typed records, shared evidence gathering and reading, extraction, matching, finite jobs/retries, and relevant UI/input behavior. Preserve the current three finding kinds and existing notification policy. Reuse source adapters that remain useful and remove replaced paths. Run focused tests during development and the full relevant suite/build once ready. Update the comparison with real results; keep blocked live columns explicitly pending. Stop for manager code and benchmark review before production operations.

### Phase 3 — bounded live verification and cutover

After manager review, run the authorized live comparison through the shared quota ledger. Confirm current deployment/authentication and source state. Deploy schema/backend/frontend as one compatible release, using existing infrastructure and deployment patterns. Pause conflicting collector work during cutover and restore normal scheduling after verification. Avoid sending test notifications to people/channels.

The pre-launch data policy allows Scout test content to be recollected. Prefer that over compatibility machinery. Before any destructive reset, present the exact scoped SQL and preservation/readback checks to the manager. Preserve trackers, credentials, Auth/access, service setup, unrelated shared-project data, and all accounting still required for quotas. Never reset the Supabase project. Retain the frozen benchmark and baseline artifacts outside disposable content.

Recollect a bounded representative set first, inspect saved facts independently, verify app rendering and unchanged-repeat behavior, then resume normal collection. Retain a recoverable prior release and concrete rollback steps; do not switch an incompatible old backend onto a new schema. If frontend authentication blocks publication, preserve the ready build and report the precise user action; do not call the release complete.

### Phase 4 — acceptance and handoff

Manager independently checks the before/after report, selected sources and saved records, deletion scope, release compatibility, and failure/resume behavior. Worker creates one focused implementation commit when verified, excluding unrelated hunks; plan documentation is a separate manager-owned commit. Record deployed revision, remaining genuine source limitations, quotas/capability limits, and rollback instructions. Update README/tasks only where needed to describe the new operative behavior; preserve unrelated work and avoid rewriting historical logs as cleanup.

Done means the current three kinds work through the replacement in the app, acceptance evidence is available, the superseded engine is removed from production paths, and normal collection resumes without the old repair heartbeat. Funding remains an explicit extension with validated examples, not an implied delivered feature. Offline completion alone is not deployed acceptance.

## Stop-and-reassess rules

- After two failed approaches or about 20 minutes without new evidence, document the failed assumption and change the approach or park the case. Do not redeploy another prompt patch for unchanged evidence.
- Do not loosen accuracy requirements, fill speculative fields, hide difficult candidates, or add publisher-specific semantic rules to pass a benchmark.
- Missing external capability blocks only dependent work. Continue authorized local work and keep the checkpoint current. Respect provider reset times without repeated premature calls.
- The manager reviews milestone outcomes and uses compact worker status snapshots. User updates report meaningful progress, decisions, failures, or needed input; unchanged waits stay quiet.

## Current checkpoint

- Phase: replacement migration, collector v133 (`b78252f`) and Firebase frontend deployment are complete. Production retains 71 records and uses 13,964,979 database bytes. The local understanding/final-finding reduction passed mechanical manager review and is committed locally; deployment remains held. Worker chat `01a121b8-ef1b-78e3-9b28-ec8b86f33dbe` is the sole implementation writer in the existing checkout.
- Production controls: all four recurring cron jobs, notifications and the manager heartbeat remain paused. Authorized legacy retirement and the findings migration are complete; do not rerun cleanup. Useful facts, URLs, human corrections, delivery state and active quota accounting remain protected.
- Local verification: 286 checkout tests, 268 isolated Git-index tests, build and whitespace checks pass. Final-only claim validation, bounded understanding, occurrence-check retry classification, source/date/role constraints, existing-provenance corrections, human overrides and unchanged-repeat behavior have mocked coverage. Unrelated README/task/Explorers work remains unstaged; the Explorers mock received only the necessary two-pass protocol adaptation.
- Live acceptance FAILED: the minimal-thinking simplified E04 run created one candidate only in memory but omitted the clock/zone and assigned IDDRI's full name an unsupported organizer role. The alias-sensitive score was a false pass. The prepared source fingerprint matches the live input: no JSON-LD or organizer/host assertion; speaker affiliation and clock text are present. The medium-thinking variant returned the wrong research shape before completion. No production E04 finding was written. Fourteen quota reservations remain retained, including thought-token charges for that diagnostic; the policy is disabled. No further unchanged retries or prompt patches are authorized.
- Access and budgets: Supabase Management API and Firebase authentication are restored. Gemini limits were verified on 11 October (15 RPM, 500 RPD, 250,000 input TPM); remaining shared usage is checked before bounded live work. Preserve every accumulated reservation and uncertain charge. Account-wide Supabase analytics usage remains permission-blocked. These checks do not authorize recurring collection.
- Next: manager reassesses model/interface limitations separately. No further prompt patches, unchanged live retries or deployment of this unaccepted contract are authorized. Revised live model/SQL/physical-WAL costs, full corpus and held-out accuracy remain acceptance work. Collection and notifications resume only on user direction after review.
- Baseline: 36 frozen primary cases (18 events, 12 announcements, six treaty changes), split 24 development/12 held out; historical baseline 330/336 tests and build passed. Source expectations and fixtures remain unchanged. Compact current implementation and verification state is in `.cache/scout-refactor/requested-research-checkpoint.json`.
