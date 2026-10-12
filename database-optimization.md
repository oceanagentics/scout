# Scout database optimization plan

Updated 12 October 2026. **Approach: compare the current design with one compact alternative before choosing implementation changes.** This replaces the earlier list of incremental optimizations. The user has authorized this plan rewrite; schema, collector, data migration and recurring-work changes remain proposals.

The objective is to keep useful findings well within the existing free allowances by deciding what deserves durable storage, representing it simply, and writing only when necessary. Record capacity is an outcome to measure, not a fixed 100,000-record ceiling or a promised 500,000-record target.

## 1. Current database state and content

Scout uses PostgreSQL 17.11 with 8 KiB pages, autovacuum enabled, default `pglz` TOAST compression and `zstd` WAL compression. Findings and compact operational state live in the `scout` schema. Source bodies, prepared documents, prompts, responses, quoted proof trails and operation reports must not be persisted.

The latest implementation checkpoint is collector **v136**, commit `663c8cb`. Organization intake now retains ranked names without role labels; existing records can still contain older role-bearing objects. The live E04 check updated the same record and preserved its date/time and registration. Storage work must follow this current contract rather than rebuild the retired role model. Broader intake correctness remains separate work; see [refactor-consumption.md](refactor-consumption.md).

Read-only verification at **16:02 UTC on 12 October** found **84 records**, a database size of **14,153,395 bytes**, no active Scout cron jobs and a disabled model policy. Collection and notifications remain paused.

The earlier detailed relation inventory at 15:24–15:29 UTC provides the following baseline. Row counts, especially quota accounting, are dated observations rather than current operating limits.

| Table | Baseline rows | Total relation bytes | Content and purpose |
| --- | ---: | ---: | --- |
| `records` | 84 | 458,752 | Current event, announcement or treaty-status findings; facts, relevance, completeness, human overrides, provenance and version metadata. |
| `record_sources` | 106 | 98,304 | Source URL, record, optional tracker and relationship; unique on record/URL. |
| `record_identities` | 87 | 81,920 | Identity/alias strings mapped to record UUIDs; globally unique identity and an owner index. |
| `source_state` | 46 | 98,304 | Tracker/source identity, URL, compact native reference, hashes, attempts, lease, due time, retry state and bounded research metadata. |
| `trackers` | 35 | 106,496 | Source configuration and cadence; 30 enabled in configuration, subject to the disabled global gate. |
| `quota_policy` | 1 | 57,344 | Budget verification and expiry, enablement, cooldown and accumulated numeric uncertain-call charges. |
| `quota_reservations` | 30 | 98,304 | Current model-call reservations and token usage, invocation, timestamp, state and compact reason. |
| `delivery_state` | 12 | 32,768 | Latest delivery version/status/time per record, including uncertain delivery needed for deduplication. |

Relation totals include indexes, TOAST and auxiliary forks. Views and reader functions expose projections rather than stored copies. Preserve their access controls and the restricted backend write path.

The record has ordinary columns for UUID, kind, title, description, canonical URL, priority and version/timestamps. JSONB contains organizations, typed details, overrides, provenance, completeness and relevance. A generated date range supports filtering. Legacy scalar fields and the legacy identity constraint also remain. Some apparently old fields still have consumers: notification eligibility reads `last_communicated_at`.

Important baseline measurements:

- All Scout tables and indexes occupied **1,032,192 bytes**; record/source/identity relations accounted for **638,976 bytes**. Most of the 14.15 MB database is catalog/service infrastructure.
- The record heap was **139,264 bytes** and its twelve indexes occupied **262,144 bytes**. Small indexes include minimum page allocations; their current size divided by 84 is not their marginal cost.
- Existing provenance occupied **36,691 bytes**, with 477 URL mentions already represented in source links. Legacy scalar columns accounted for about **11,509 bytes**. New automated records already start with empty provenance, so cleaning historical repetition would provide little future benefit.
- PostgreSQL estimated three dead record tuples. Only one current field used external TOAST storage. Exact page slack and index bloat have not been measured.
- Source state, quota policy, quota reservations and delivery state together occupied **286,720 bytes** at the later check: approximately **0.07% of the 400 MB ceiling**, not a demonstrated 30–50% operational overhead.

Historical cleanup is outside this plan's implementation scope. Preserve useful facts, URLs, identities, human corrections and active quota/delivery accounting.

## 2. What is written during record research

Current flow: **select and gate → claim → fingerprint → reserve/call → normalize and save partial findings → optional improvement → finish or defer**.

| Stage | Durable writes | Material retained only in memory |
| --- | --- | --- |
| Select due work and check policy | Selection and budget checks are reads. A failed gate stops research before source/model work. | Request-local control values. |
| Expire accounting | Delete at most 32 reservations outside both the provider day and 120-second safety window; first preserve uncertain charges as numeric policy totals. | No accounting report. |
| Claim a source | Insert/update its `source_state` row with bounded attempts, current state and a 120-second lease. | Source content has not been stored. |
| Fingerprint source/support pages | Hashes are saved when finishing the state row. A matching processed fingerprint skips model and finding writes. | Source bodies and up to three support-page reads. |
| Reserve and settle a model call | Insert a reservation before dispatch; settle token totals/state/reason afterward, retaining conservative charges when usage is unknown. Update cooldown when necessary. The current input reservation is 60,000 tokens, with at most two generations per invocation. | Prompt, schema, request, response and retrieval metadata. |
| Match and save findings | In a lease-checked transaction, insert a finding or update a changed finding/version. Attempt identity and source-link inserts with conflict protection. | Normalized model output and candidate comparisons. |
| Improve a partial finding | If requested, a second reservation/settlement and a second save for matching developments; successfully retrieved requested links can become support links. | Requested questions and intermediate response material. Failure preserves the first saved result. |
| Finish or defer | Update current hashes, state, attempts, due time and compact research metadata; clear the lease. | Invocation counters are returned, not stored as an operation history. |

A normal finding save writes kind, title, description, canonical URL, organizations, details, provenance, completeness, priority and relevance. Changes advance the version and accepted version as appropriate. Human overrides and established facts survive missing optional output. New records use database defaults for UUIDs/timestamps. Serialized save parameters are limited to 12,288 bytes; that is not a physical storage limit including indexes and related rows.

The generated identity currently includes tracker, source identity, kind and normalized title. Title rephrasing can therefore introduce another alias even when the record matches. Source links retain the primary input URL and any successfully retrieved support URLs. Conflict attempts count as SQL statements even when no row is added. The record equality guard and the earlier fingerprint shortcut are separate protections.

Despite its name, `source_state.research` stores a revision, main-source hash and up to three support URL/hash pairs, not a research narrative. Completed rows in the earlier sample averaged about 583 tuple bytes. The source row also holds observed/processed hashes needed to avoid repeat model work.

Other writes around research must be included in a complete comparison:

- Discovery leases a tracker-root row, processes at most one document per invocation, can add at most 16 inventory rows and saves a bounded cursor. It currently retains about 200 documents per tracker, or roughly 6,000 slots across 30 enabled trackers. No completed-source eviction strategy has been demonstrated; this is an intake constraint separate from record storage.
- A human correction updates the same finding, stores its source URL and override, advances the version, clears acceptance and reopens associated non-running sources for research.
- Notifications separately claim and settle the latest delivery state. Unknown/sending states protect against duplicate delivery.
- Quota expiry is already bounded, and cron cleanup is scoped to Scout's collection job. Removing fingerprints or accounting to shrink state can cause duplicate research or lost charges; it is not a free optimization.

The fixed twelve-source v135 batch measured **252 collector SQL statements, 71 row mutations and 221,839 bytes of attributable statement WAL**, producing six new findings and three updates. Harness/control writes were additional. The unchanged repeat measured **zero model calls, zero finding writes, nine SQL statements and two source-state mutations**. Preserve that zero-model/zero-finding-write behavior.

## 3. Define the durable finding before designing its storage

The baseline comparison must preserve the same useful information and reader behavior. A smaller representation is not an improvement if it silently removes facts or breaks matching.

| Information | Requirement for the compact candidate |
| --- | --- |
| Stable internal identity, type, title and priority | Preserve record IDs and classification; maintain reliable lookup and concurrent deduplication. |
| Factual description | Retain what the development is and why it is useful. Do not replace useful content with an opaque classification. |
| Organizations | Preserve ranked names, including multiple organizations, under the current role-free intake contract. |
| Dates and event/publication/treaty details | Preserve meaning, precision, explicit clock/timezone, location, registration and useful type-specific facts. Unknown dates must stay unknown. |
| Source URLs and aliases | Preserve primary and supporting URLs, human-review associations and established identity mappings. |
| Human corrections and explicit uncertainty | Retain protected values, their source associations and meaningful conflicts or missing-information explanations. Derive redundant defaults where behavior is equivalent. |
| Concurrency and delivery eligibility | Preserve the minimum version/acceptance and delivery state required for safe updates and notifications. |
| Separate priority explanation | Keep it for the equivalent-information comparison. Separately assess whether it adds useful information beyond the description. Combining/removing it is a product decision requiring review. |

Source/model traffic remains transient. Partial findings remain saveable before optional improvement. “Only save finalized records” would discard an existing product requirement and is not the proposed optimization.

## 4. Measured representation sizes, not a theoretical capacity claim

A read-only comparison at 16:02 UTC used the same six newly created record IDs as the earlier batch, with their current values after the organization change.

| Representation | Average bytes |
| --- | ---: |
| UUID, small type/priority values, title and canonical URL | **223** |
| Above, plus description, organization-name array and current typed-details JSONB | **717** |
| Above, plus priority-explanation text | **1,041** |
| Compact envelope also retaining completeness, overrides, provenance, versions and discovery/update timestamps | **1,335** |
| Current record tuple alone | **1,523** |

The alternatives were measured with PostgreSQL `pg_column_size(row(...))` expressions. They are not created tables or disk-growth benchmarks. They exclude indexes, related source/identity rows, source state, page allocation and future correction cases. Details remain JSONB in these expressions; the sizes do not establish the result of a fully typed replacement.

The sample's current source tuples averaged 167 bytes and identity tuples 109 bytes per record before their indexes. Its description averaged 232 text bytes and priority explanation 318 bytes. These two paragraphs alone account for approximately **550 bytes**. A native organization-name array averaged 85 bytes versus 113 bytes for equivalent role-free JSONB names: about **28 bytes saved**, rather than hundreds. Do not count retirement of old role labels again as a new architecture saving.

A 250–350-byte title/link record is plausible; preserving all current finding information at that size has not been demonstrated. Lossless compression or shared representations could change the result, but an “absolute theoretical minimum” cannot be asserted without specifying the information, workload and access requirements.

Earlier capacity numbers are superseded as design targets:

- The original 40,000 estimate divided 56 KiB of whole-database growth by six inserts. Of that growth, **24 KiB occurred during updates** and 32 KiB during inserts.
- Even the corrected insert allocation is affected by page boundaries and existing source-state allocations.
- The prior 3–6 KB/record and 65,000–130,000 additional-record figures were broad estimates for the existing design, not measured physical slopes or hard limits on Scout.
- Promised savings of 1.5–2 KB from indexes, 400–600 bytes from typed columns, or guaranteed 500,000-record capacity have not been established. Kind, priority, title and description are already ordinary columns.

### Optimization measurement record

Keep a compact numeric checkpoint here after each measured design change, using already-authorized work. Record date, deployed revision, environment and workload/result counts so comparable runs can show progress. Sections 1 and 4 hold the initial storage snapshots; this table records measured work. Retain design milestones in this document, with Git preserving edits.

| Date / revision / environment | Workload and result | Collector SQL statements | Row mutations | Attributable statement WAL (bytes) | Database growth (bytes) | Index growth (bytes) | Finding HOT updates / total updates |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| 2026-10-12 / v135 / live | Twelve sources; six inserts, three finding updates | 252 | 71 | 221,839 | 57,344 | Not measured | Not measured |
| 2026-10-12 / v135 / live | One unchanged repeat; zero model calls or finding writes | 9 | 2 source-state mutations | Not measured | Not measured | Not measured | N/A: no finding updates |
| 2026-10-12 / v136 / live | One E04 organization update | 23 | 5 | 34,565 | 0 | Not measured | Not measured |

These are different workloads, not a before/after efficiency comparison. Counts exclude harness/control work. The v135 database growth includes 24 KiB during updates and 32 KiB during inserts; v136 reduced the record's stored fields by 64 bytes without reducing allocated database size. See [the recorded run costs](refactor-consumption.md) for context.

For subsequent comparable checkpoints, record heap, index and TOAST bytes before/after across all finding-related tables, alongside SQL mutations and attributable WAL. Distinguish inserts, updates that leave indexed values unchanged, updates that change indexed values, and unchanged repeats. For each update group, retain the raw `n_tup_hot_upd` and `n_tup_upd` counter deltas and calculate HOT rate as `100 × Δn_tup_hot_upd / Δn_tup_upd`; zero updates means N/A. Use settled statistics from the same measurement window; mark resets, unrelated activity or unavailable attribution instead of claiming a workload-specific result. PostgreSQL documents these counters in [table statistics](https://www.postgresql.org/docs/17/monitoring-stats.html#MONITORING-PG-STAT-ALL-TABLES-VIEW).

Judge progress by lower retained bytes and write cost for comparable useful output. HOT rate explains update behavior; it is not a target by itself, and zero index allocation growth does not imply zero index writes. Record missing measurements as unmeasured. Keep only these numeric summaries and short workload notes; use the existing measurement path without adding database history tables, recurring jobs or a new test suite.

## 5. Compare two complete designs

**A — current implementation:** measure the deployed shape and write behavior, including all related tables and indexes.

**B — one compact alternative:** design the ordinary finding around a compact row, with additional relationships only where they carry information or enforce required behavior. Prefer less code and reuse existing reader/write patterns.

The candidate should investigate these decisions together:

1. **Typed common fields and small structured extras.** Use ordinary types for stable common attributes, an ordered array for organization names if it preserves filtering, and only the necessary structured detail/override data. Choose types and column layout from the contract above; do not shorten meaningful keys merely to claim savings.
2. **Primary source and identity placement.** Evaluate storing the primary source on the finding and retaining separate rows for additional sources/aliases where needed. Avoid repeating the same primary URL automatically in every representation. Preserve tracker/relationship information and human-review provenance. The current identity map remains the correctness baseline until any replacement proves global uniqueness, lookup and race behavior.
3. **Indexes justified by actual reads.** Include exact lookup, required organization/date filtering, sorting/pagination and text search. Measure representative query plans and latency. Removing an index must not quietly replace normal app operations with costly full scans. Low use counters in an 84-row database are insufficient evidence.
4. **Writes driven by semantic changes.** Save the first useful partial finding; only write improvement when facts or meaningful review state change. Derive ordinary display defaults, retain explicit uncertainty, and avoid new aliases caused only by rephrasing. The current unchanged shortcut and equality guard already do useful work; measure any additional reduction rather than claiming them as new savings.
5. **Small durable operational state.** Keep essential leases, rate-limit charges, retry deadlines, fingerprints and uncertain deliveries durable and bounded. They are shared current state, not inherently a full row of permanent overhead for every finding. Measure their growth separately.

An array of identity strings does not by itself enforce uniqueness across records, and searching its elements may need an index. Moving relationships into arrays is therefore a hypothesis to test, not an automatic 500–800-byte saving. Similarly, moving quota state to worker memory, Redis or unlogged tables is not the starting approach: it introduces dependencies or weakens recovery. PostgreSQL unlogged tables can be truncated after a crash.

The comparison should produce one proposed schema/write path, one dependency/removal list and measured costs. The small empty-field/default/index cleanups from the previous plan may fall out of that design; they are no longer the implementation roadmap. No growing queue of unrelated micro-optimizations, new registry, history system or paid service.

## 6. Storage budgets and free-limit headroom

Scout's existing operational gate is **400,000,000 bytes for the current database**, subject to fresh verification. The organization-entitlements check returned HTTP 403; actual shared allowances remain to be verified before live operation. Readable project API counts do not measure the collector's direct SQL workload or establish account-wide headroom.

Supabase documents database-size quota separately from total disk, which includes WAL. The earlier WAL-directory measurement was 134,218,098 bytes; this is neither permanent finding size nor cumulative batch growth. Monitor both relevant limits using existing bounded checks. Do not add every generated WAL byte to the retained-database model.

With the measured 14,153,395-byte baseline, the following are **maximum average marginal budgets to reach the 400 MB gate**, not forecasts or comfortable operating targets:

| Desired total findings | Available average bytes per additional finding |
| --- | ---: |
| 10,000 | 38,911 |
| 100,000 | 3,861 |
| 250,000 | 1,543 |
| 500,000 | 771 |
| 1,000,000 | 385 |

Formula: `floor((400000000 - 14153395) / (target_records - 84))`. Bytes must cover all growing finding, relationship, index and operational storage. The calculation assumes other service usage remains constant; actual growth there reduces the budget. KB/MB/GB are decimal; KiB is 1,024 bytes.

Staying well within free limits requires an explicit reserve below this gate for other consumers, update churn and measurement uncertainty. Choose that reserve from verified account usage and the measured workload before acceptance. Do not describe fitting just below 400 MB as comfortable headroom or claim that the product inherently stops at 100,000 records.

The decision must consider SQL/row mutations, compute/reader latency, model calls and daily activity as well as bytes. For context, 24 repeats of the measured unchanged path would cause 216 collector SQL statements and 48 state mutations; scheduler/control work would be additional. No daily schedule is authorized. Increasing discovery's approximately 200-document-per-tracker bound also needs a reviewed revisit/retention policy; deleting completed fingerprints can cause new charges on unchanged inputs.

## 7. Verification and decision sequence

Implementation and live writes require further user direction. Work in the existing checkout with one authorized implementation writer, coordinated with the intake-correctness work. Keep recurring collection and notifications paused.

1. **Fix the information and query contract.** Map current fields to their product purpose and current readers. Specify candidate B and every intentional behavior change. Keep the priority explanation in the equivalent-information comparison; show a content-reduction variant separately if proposed.
2. **Prove one record end to end before increasing volume.** Use the existing local test setup to save/read a partial finding, improve it under the same ID, preserve a human correction/source, and repeat unchanged input. Check date precision, multiple ranked organizations, source links, acceptance and access controls. Injected model output proves mechanics, not extraction correctness.
3. **Measure a bounded local physical comparison.** Use final-record shapes in memory, with explicit finite row/batch/time bounds, no production writes and no model calls. After the one-record result passes, compare enough rows to cross page boundaries. Vary titles, URLs, lengths, lexemes, organizations and additional-source counts rather than cloning one highly compressible row. Include representative updates and source-state activity. Use the existing harness rather than creating a new benchmarking subsystem.
4. **Account for the complete cost.** Separate insertion, semantic update, partial improvement, unchanged repeat, failure/recovery and human correction. Measure model calls, SQL statements, row mutations, submitted bytes, live tuple sizes, heap/index/TOAST allocation, state growth and attributable WAL where supported. Update the optimization measurement record above, including HOT counters for updates with unchanged versus changed indexed values. Separate harness/control work. State any unmeasured production/WAL effects; synthetic results are not a live capacity guarantee.
5. **Check read performance and preservation.** Compare required lookup/filter/search/pagination plans and latency at the tested volume. Verify all useful facts, URLs, IDs/aliases and overrides round-trip; all active quota/delivery charges and access rules survive. Default-field compaction must preserve both merge-time completeness and displayed uncertainty.
6. **Review the result before migration.** Select the simpler design only if complete measurements show a worthwhile storage/write improvement with acceptable reads and recovery. Estimate retained bytes and daily activity under the proposed cadence against actual shared limits, retaining explicit reserve. If gains are small, keep the current design; do not expand complexity to force an improvement.
7. **Authorize and verify live separately.** After schema/backend review and renewed model/SQL/account budget checks, confirm one deployed record and its unchanged repeat. Keep useful first-pass capture and finite retries. Do not perform extra live model research solely to measure storage. Review production evidence and any remaining uncertainty before resuming recurring work.

Acceptance requires equivalent useful information, protected human corrections, reliable identities, unchanged-input zero model/finding writes, preserved accounting/access, measured complete storage/write cost, acceptable reader performance and verified headroom. A smaller JSON payload or a passing mock alone is insufficient.

## Evidence and references

- Current product direction and deployment: [refactor-consumption.md](refactor-consumption.md).
- Current schema/retention: [findings migration](supabase/migrations/20261009190000_scout_findings.sql), [URL-intake quota migration](supabase/migrations/20261012150000_scout_url_intake.sql), [scheduler](supabase/scout-loop.sql).
- Research writes and normalization: [finding-jobs.js](collector/finding-jobs.js), [finding-contract.js](collector/finding-contract.js), [model.js](collector/model.js), [hosted-hsa.js](collector/hosted-hsa.js), [discovery](collector/octo-documents.js).
- Corrections and delivery: [corrections.js](collector/corrections.js), [notifications](notifications/slack.js).
- Existing local numeric artifacts: `.cache/scout-refactor/oct12-url-evaluation-results.json`, `oct12-url-final-state.json`, `oct12-url-unchanged-check.json` and `oct12-url-release.json` in the same directory. These v135 snapshots predate the organization change and may not exist in another checkout.
- Read-only review aggregates at 15:24–15:29 and 16:02 UTC are transcribed above. No new source/model capture or benchmark files were created. Refresh dated measurements before implementation.
- PostgreSQL: [page layout](https://www.postgresql.org/docs/17/storage-page-layout.html), [size functions](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADMIN-DBSIZE), [arrays](https://www.postgresql.org/docs/17/arrays.html), [unlogged tables](https://www.postgresql.org/docs/17/sql-createtable.html), [HOT updates](https://www.postgresql.org/docs/17/storage-hot.html), [vacuum](https://www.postgresql.org/docs/17/routine-vacuuming.html).
- Supabase: [database versus disk/WAL size](https://supabase.com/docs/guides/platform/database-size). Public limits do not replace verified account allowances.
