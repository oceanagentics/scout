# Scout database optimization plan

Status: proposal; database changes are not authorized by this document. Prepared 12 October 2026 from the deployed URL-intake implementation, existing numeric evaluation artifacts, and read-only production measurements at approximately 15:24–15:29 UTC. The only requested change is to document the review.

The earlier estimate of about 40,000 additional records was not a measured capacity. A working estimate for similarly sized records is **3–6 KB of additional physical storage per record**, including indexes, links, identities, an allowance for operational state, and page slack. That suggests approximately **65,000–130,000 additional records** before Scout's 400,000,000-byte operational ceiling. This is a planning range, not a demonstrated storage guarantee.

## 1. Current database state, shape and content

### Deployment and operating constraints

- PostgreSQL 17.11; 8,192-byte pages; autovacuum enabled; default TOAST compression is `pglz`; WAL compression is `zstd`.
- Collector v135 corresponds to committed refactor `242878490ec4c770306ecee02ccc8fb4ee649841`.
- All four Scout cron jobs and the model policy were disabled at measurement time. Collection and notifications remain paused until separately reviewed and authorized.
- Scout's model gate requires fresh model and database budget verification and a database size below 400,000,000 bytes. A disabled or expired policy permits no research calls.
- The recorded provider allowances were 500 generations/day, 15/minute and 250,000 input tokens/minute. These are provider allowances, not an allocation for this review or permission to resume work. The saved policy's daily Scout limit was 42 for the bounded test; the code's maximum is 250/day. Current shared headroom must be verified before further live research.
- The organization-entitlements endpoint returned HTTP 403. Project API-count analytics were readable, but those counts do not establish organization-wide allowances or count the collector's direct SQL work. This plan uses Scout's existing 400 MB ceiling, not an assumed public-plan entitlement.
- Another chat owns intake correctness. This plan does not authorize concurrent collector changes, historical-content cleanup, quota resets, migrations, deployments or new recurring jobs.

### Tables and relationships

Scout stores findings and compact current operational state in the `scout` schema. Source bodies, prepared documents, prompts, model responses, quoted proof trails and operation reports must not be persisted.

| Table | Measured rows | Heap bytes | Total relation bytes | Purpose and retained content |
| --- | ---: | ---: | ---: | --- |
| `records` | 84 | 139,264 | 458,752 | Current findings: event, announcement or treaty status; title, short description, canonical URL, organizations/roles, typed details, relevance, completeness, human overrides, provenance and version metadata. |
| `record_sources` | 106 | 24,576 | 98,304 | Supporting URLs, linked to a record and optionally a tracker, with a relationship such as primary, support or human review. Primary key: `(record_id, url)`. |
| `record_identities` | 87 | 16,384 | 81,920 | Stable lookup/alias strings mapped to record UUIDs. Identity is the primary key; record ownership is separately indexed. |
| `source_state` | 46 | 16,384 | 98,304 | One current row per tracker/source identity: URL, compact native reference, hashes, lease, attempts, scheduling/retry state and bounded research metadata. |
| `trackers` | 35 | 16,384 | 106,496 | Source configuration and cadence; 30 enabled in configuration, while global execution remains paused. |
| `quota_policy` | 1 | 8,192 | 57,344 | Verified budgets and expiry, enablement, cooldown and accumulated numeric uncertain-call charges. |
| `quota_reservations` | 30 | 8,192 | 98,304 | Current model-call accounting: invocation, reservation time, input/output tokens, state and compact reason. |
| `delivery_state` | 12 | 8,192 | 32,768 | Latest delivery version, status and timestamp per record, including uncertain delivery needed for deduplication. |

Total relation bytes include indexes, TOAST and auxiliary forks; they are not the size of live values alone. `finding_reader`, `findings`, `finding_jobs` and `tracker_status` expose bounded projections or queries rather than stored copies. Preserve row-level security, role checks and the restricted backend write path.

The 84 findings include 58 events; 26 events have dates and 68 findings have organizations, according to the post-batch snapshot. Records can remain useful while provisional. Storage success does not establish that extracted dates, organization roles or identity matching are correct: the twelve-source evaluation has known correctness failures.

The record envelope uses ordinary columns for identity, kind, title, description, canonical URL, priority and version/timestamps; JSONB holds organizations, typed details, overrides, provenance, completeness and relevance. A stored generated `date_span` supports date filtering. Typed dates retain their meaning and precision; local clocks, explicit zones and derived UTC values must remain distinguishable.

The table also retains legacy columns, including `organization`, `location`, `event_url`, `registration_url`, `starts_at`, `ends_at`, `status`, `identity_key`, `evidence_rank` and `evidence_at`. New intake generally leaves these unset except for defaults. `last_communicated_at` remains read by notification eligibility code and must not be treated as obsolete merely because delivery state also exists.

### What occupies the space

| Measurement | Bytes | Interpretation |
| --- | ---: | --- |
| Current `postgres` database | 14,153,395 | The database measured by Scout's operational gate. |
| All Scout tables and their indexes | 1,032,192 | About 7.3% of the database; most remaining space is catalog/service infrastructure. |
| Records + source links + identities | 638,976 | Includes fixed relation overhead and page slack. |
| `records` indexes | 262,144 | Twelve indexes; larger than the current 139,264-byte record heap. |
| Record TOAST relation including its index | 24,576 | Only one current field was externally stored; TOAST is not the principal current cost. |
| Current WAL directory | 134,218,098 | Cluster-level retained WAL, separate from database size and from cumulative WAL generated by a batch. |

The two template databases together occupy another 15,115,294 bytes. They are outside `pg_database_size(current_database())`; do not present the 14.15 MB number as all cluster disk usage or a verified organization billing measurement.

The twelve record indexes cover primary identity, legacy identity, legacy kind/update ordering, canonical URL, lowercased title, kind/priority, two pagination orders, primary/effective dates, organizations and full-text search. The full-text index is 90,112 bytes; many other indexes occupy only one or two pages. Dividing these allocations by 84 overstates their likely marginal cost at larger volumes.

Other measured characteristics:

- Provenance occupies **36,691 stored bytes** across existing records. It contains **477 URL mentions**, representing 41,892 bytes of URL text; every mention is also present in `record_sources`. Thirteen provenance values are compressed. These are source-reference mappings, not source-body archives.
- The listed legacy scalar columns occupy approximately **11,509 bytes** in total. All 71 legacy identity keys have corresponding `legacy:` entries in `record_identities`. This is evidence for a future dependency review, not authorization to remove either representation.
- There are 106 source links but 87 distinct URLs. Some sharing is legitimate: one source can support multiple findings. Canonical URLs and linked sources also serve different read/matching purposes; repetition alone does not justify a new URL registry.
- PostgreSQL estimated three dead record tuples, 42 dead source-state tuples and 34 dead reservation tuples. These are statistics estimates, not an exact bloat measurement. Exact free space, GIN pending-list occupancy and index bloat were not measured.
- Ordinary vacuum makes obsolete tuple space reusable; it does not generally shrink allocated files. No vacuum, reindex or table rewrite was performed for this review.

## 2. How record research writes data

The current path is **select/gate → claim source → compare fingerprints → reserve/call model → normalize/match/save → optional improvement → finish source**. The collector uses a direct database connection; model/source traffic is kept in invocation memory.

| Stage | Reads and processing | Database writes |
| --- | --- | --- |
| Select work and verify budget | Read tracker or next due source, then current policy. A failed gate returns before source/model work. | None from selection or the gate itself. |
| Expire old accounting | Inspect reservations outside both the current provider day and the 120-second safety window. | Delete at most 32 eligible rows; first accumulate numeric uncertain-call/token totals in `quota_policy` when necessary. Active charges are preserved. |
| Claim source | Check tracker/source identity, due time, capacity and expired lease. | Insert or update one `source_state` row with running/parked state, bounded attempt count, lease UUID and 120-second lease deadline. |
| Read and fingerprint | Read the main source and up to three previously requested support URLs in memory. Compute hashes and compare with processed state. | No body, prompt or response write. Hashes are retained when source state is finished. |
| Unchanged shortcut | A successfully fingerprinted input matching the processed hash returns before the model and finding-save path. | Finish the same source row; no reservation, record, source-link or identity writes. The live check measured two source-state mutations in total, including the claim. |
| Reserve a model call | Lock/read policy and count current-window and invocation charges. Maximum two generations per invocation. | Insert a `quota_reservations` row in dispatched state, reserving 60,000 input tokens before the current URL-context request. |
| Call and settle | Send URL/rubric/schema, parse structured output and retrieval metadata in memory. No `countTokens` call in this path. | Update that reservation with actual input/tool and output/thinking tokens when available, or preserve conservative unknown charges. Update policy cooldown when a provider deadline or overrun requires it. |
| Normalize and match | Normalize at most eight findings. Query existing identities, title/date candidates, canonical URL and linked source URL; resolve or leave ambiguous. | Matching reads do not create a second finding. A transaction checks the lease, takes the findings advisory lock and performs the saves below. |
| Save first-pass findings | Merge supported values with existing facts and protected human fields. Compare current values before updating. | Insert a new `records` row or update a changed row and increment its version. Add identity and source-link rows using `ON CONFLICT DO NOTHING`. |
| Optional improvement | Read at most three model-requested links in one additional model call. Match returned developments back to first-pass titles/kinds. | A second quota reservation/settlement, and another save transaction for matched findings. Successfully retrieved requested URLs can be added as support links. A failed improvement preserves first-pass records. |
| Finish or defer | Determine completion, retry reason and next due time; attempts remain finite. | Update the leased `source_state` row with current hashes, research metadata, state, attempts and schedule; clear the lease. Successful work records the processed hash. Failure retains compact retry state. |

### Exactly what a finding save retains

`saveFindings` writes `kind`, `title`, `description`, `canonical_url`, `organizations`, `details`, `provenance`, `completeness`, `priority` and `relevance`. New IDs and timestamps use database defaults. An assessed insert has accepted version 1; an assessed update advances `accepted_version` with `version`. An update uses the existing version as a concurrency condition and refreshes `updated_at`.

Current normalization caps title at 300 characters, description at 280, relevance reason at 600, organizations at 12, and joined missing-information explanation at 480. The save rejects a candidate whose serialized save parameters exceed 12,288 bytes. This is not a whole-record physical storage cap: indexes, links, source state, retained overrides and allocation overhead are separate.

Missing or empty optional output does not erase established values. Fields protected by `overrides` retain their human-corrected values. Current automated intake preserves existing provenance, but starts new records with `{}` rather than generating per-field source mappings. The six new records each have only the five-byte empty JSONB provenance value.

The current generated identity is a `source:` prefix plus SHA-256 hex digest of tracker ID, source identity, finding kind and normalized title. Because the title participates, a rephrased title can produce another alias for a matched record. Existing aliases must be preserved; avoiding unnecessary new aliases depends on the separately owned stable-identity work.

The first pass links the input URL as `primary`. Improvement can link successfully retrieved requested URLs as `support`. The `(record_id, url)` key prevents duplicate link rows. Conflict attempts remain SQL statements even when they create no row or change.

The finding update guard already avoids a record update when compared values are equal. It excludes provenance from the change comparison. This is separate from the earlier fingerprint shortcut: reaching a save transaction can still attempt identity/source inserts even if the record itself is unchanged.

### What `source_state.research` means

Despite the name, this field is compact processing state, not a research report. The current value contains an intake revision, a main-source hash, and up to three support entries containing URL and hash. Source-level observed and processed hashes are also retained. Requested questions, response prose and source text are not stored in this field.

The schema bounds research JSON to 8,192 serialized bytes, native-reference JSON to 512 bytes, and cursor text to 512 characters. In this sample, completed source rows averaged approximately 583 tuple bytes and research values were 136 bytes. Longer URLs and support lists can cost more.

### Discovery, corrections and delivery

Discovery is a separate write source around record research. It leases a tracker-root state row, reads existing known sources, processes at most one document per invocation, and can insert at most 16 URL/native-reference inventory rows before finishing the root cursor. It keeps about 200 documents per tracker; `claimSource` allows 201 total state rows including the root. There is no demonstrated completed-source eviction strategy. At 30 enabled trackers, approximately 6,000 known document slots can fill before storage capacity is reached; this is not a hard count of findings because a document can contain several findings or later change.

A human correction updates the same finding under a version check, stores the corrected field's source URL in `overrides` and provenance, increments the version, clears accepted status and marks relevance pending. It inserts a `human_review` source link when absent and reopens associated non-running source states by clearing their processed hash and attempts. These preservation and re-research behaviors must survive optimization.

Notifications are not part of record research. Their separate path claims/updates one `delivery_state` row per record and then settles its status. Sending/unknown delivery states are required for deduplication. Do not remove them to save space.

Quota reservations retain a current window, with bounded expiry on permitted work; uncertain historical charges survive as numeric totals. Delivery state retains the latest state rather than a delivery history. Scheduled cron-run cleanup is scoped to Scout's collection job, retains one day, and removes at most 48 completed rows per wake. Pausing collection stops new research writes; it does not authorize deleting accounting or fingerprints.

## 3. Measured cost and the faulty 40,000-record extrapolation

The fixed twelve-source URL-intake batch created six findings, updated three and made twelve model generations. It measured **252 collector SQL statements**, **71 collector row mutations** and **221,839 bytes of attributable statement WAL**. Harness/control writes were additional and separate.

| Finding storage change | Six created records | Three updated records | Total |
| --- | ---: | ---: | ---: |
| Record/link/identity logical JSON growth | 14,201 B | 1,308 B | 15,509 B |
| Record/link/identity tuple-byte change in batch artifacts | 10,874 B | 680 B | 11,554 B |
| Physical relation allocation growth | 32,768 B | 24,576 B | 57,344 B |

All measured logical growth, including operational state, was 19,166 bytes. Whole-database growth was 57,344 bytes. Thus **24 KiB of the 56 KiB allocation occurred during updates**, and must not be assigned to the six inserts.

Read-only measurements of the six new records found:

- **1,174 bytes per record** of useful JSON: kind, title, description, canonical URL, organizations, typed details, priority and relevance reason. This is a defined projection, not a claim that other fields have no value.
- **1,533 bytes per record** for the record tuple alone.
- **1,812 bytes per record** including its source-link and identity tuples, before index entries and page overhead. The live aggregate differs by three bytes from the earlier tuple delta; do not treat either as a byte-exact physical marginal estimate.
- **2,367 bytes per record** of serialized record/link/identity logical growth in the batch artifact. JSON wire size is different from tuple size and retained relation allocation.

The original calculation used `57,344 / 6`, approximately 9.56 KB per new record. Even the insert-only `32,768 / 6`, approximately 5.46 KB, is not a stable slope: some inserts reused pages while others triggered allocations, and source-state rows already existed for these test inputs.

The unchanged live repeat measured **zero model calls, zero finding writes, no version changes, nine collector SQL statements and two source-state mutations**. This is a protected baseline. For scale context only, 24 such checks would mean 216 collector SQL statements and 48 state mutations; scheduler/control work would be additional. No daily workload is authorized here.

WAL generated by a statement is not permanently retained record size. Full-page images, checkpoint timing, index maintenance and update churn affect it. Do not add cumulative WAL to database-growth projections or promise a WAL reduction solely from fewer SQL statements.

## 4. Prioritized optimization proposals

| Priority | Proposed change | Expected saving | SQL/WAL effect and tradeoff |
| --- | --- | --- | --- |
| 1 | Preserve unchanged-input skipping and resolve duplicate/unstable identities through the existing intake-correctness work. | Avoiding a duplicate saves roughly 3–6 KB of modeled physical storage. Avoiding an unnecessary alias saves its tuple and two index entries. | A merge can replace an insert with an update, so SQL counts need not decrease. Preserve distinct occurrences, existing aliases and human corrections; do not merge solely to reduce size. |
| 2 | Stop writing unused `relevance.fields: []`. | **21 bytes per new record**, measured with JSONB size expressions on the six new records. | Same SQL count; smaller value on insert/update. Verify no current consumer needs the empty field. |
| 3 | Infer ordinary missing-field markers instead of persisting repeated `{reason: "not_established"}` objects. | **About 88 bytes per new record on average** in this sample. | Same SQL count; smaller completeness value. Both merge/completeness logic and the reader must reconstruct the existing meaning. Never mark a record complete merely because redundant markers were omitted. Keep explicit conflicts, invalidity, uncertainty explanations and human corrections. |
| 4 | Review retirement of `(kind, updated_at)` and, separately, the legacy identity constraint/index. | Both currently occupy 16 KiB. The timestamp index is estimated at **40–60 bytes per new record** at scale; the legacy index's marginal cost is smaller/uncertain because new identity keys are null. | No reduction in application SQL statements. Fewer index writes; removing the timestamp index can enable HOT for otherwise eligible metadata-only updates. Verify current reader/notification plans and dependencies. Low scan counts at 84 rows are not sufficient proof. Preserve identity uniqueness through the active identity table. |

The metadata/index changes together plausibly save **0.15–0.25 KB per record**, or **15–25 MB per 100,000 records**. The JSONB expression savings are measured; index, page and WAL savings remain estimates. Do not count duplicate prevention again in this per-record saving.

The proposed first scope is the empty relevance field, default missing-field representation with preserved reader semantics, and only demonstrably unused indexes. Coordinate any collector edits with the sole implementation writer. Stable-identity changes remain with intake correctness.

Do not start with a paid upgrade, a new database, a URL/organization registry, compressed opaque record blobs, abbreviated JSON keys, new history tables, or a tracing/replay system. Existing search and typed data have useful behavior. Removing retained legacy provenance would mainly reclaim tens of kilobytes once; it is outside this task's historical-cleanup authorization and does not improve the new writer, which already avoids generating it. No table rewrite or aggressive vacuum is justified by this sample.

## 5. Capacity model and limits

Use the measured 1.81 KB of current tuples as a starting point, then allow for index entries, tuple/page overhead, operational state and space reuse between vacuum cycles. **3–6 KB per additional finding** is a deliberately broad working range for similarly short records with modest source/identity counts, not a measured large-volume slope. The observed insert-only allocation of 5.46 KB sits within it but did not include newly allocated source-state rows for every finding.

For the proposed small changes, use **2.8–5.8 KB** as an illustrative range, subtracting about 0.2 KB. Longer URLs, more organizations, more support links, repeated updates, index fragmentation or a changed content mix can exceed these ranges. Existing caps bound some work but do not guarantee this storage rate.

The estimates below use `14,153,395 + (total_records - 84) × marginal_bytes`. They conservatively retain the current database baseline and assume other service usage does not grow. KB/MB/GB here are decimal; KiB denotes 1,024 bytes.

| Total findings | Current design, estimated database size | Small changes, estimated database size | Assessment against 400 MB gate |
| --- | ---: | ---: | --- |
| 10,000 | 44–74 MB | 42–72 MB | Comfortable under the storage model; intake and shared budgets are separate. |
| 100,000 | 314–614 MB | 294–594 MB | May fit; cannot be promised without measuring a representative storage slope. |
| 1,000,000 | 3–6 GB | 2.8–5.8 GB | Not credible within the current ceiling and representation. |

The current range implies about **64,000–129,000 additional findings**, rounded to 65,000–130,000 for planning. The illustrative optimized range implies about **67,000–138,000 additional findings**. These are conditional storage estimates, not supported ingestion capacities or account entitlements. At one million records, the measured useful JSON projection alone would be approximately 1.17 GB before indexes and operational data.

Source-state capacity and cadence must be reviewed independently before assuming 10k/100k intake. Increasing that cap without a reviewed retention/revisit design would change storage and daily work. Deleting completed fingerprints to make room could re-enable model calls on unchanged sources; do not do that implicitly.

## 6. Before/after verification plan

Implementation and live writes require separate user direction. Keep collection and notifications paused throughout verification.

1. Freeze a small baseline of numeric counts/sizes and the applicable code revision. Keep original IDs, facts, source URLs, human overrides, identity mappings, access controls and active quota/delivery accounting. Persist no source/model captures or new operation histories.
2. Verify one representative finding end to end using the existing test setup: insert/read it, update a supported fact, preserve a human override, retain incomplete-field display, and confirm stable identity and authenticated reader behavior. Cover date, organization, search and pagination behavior when touching their dependencies. Label injected-output checks as mechanics, not live model correctness.
3. Measure insert, changed update and unchanged repeat separately. Record model calls, collector SQL statements/row mutations, submitted bytes, live tuple sizes, heap/index/TOAST allocation and attributable WAL. Keep harness writes separate. The unchanged repeat must retain zero model calls and finding writes; compare against the current nine statements/two state mutations.
4. Only after the one-record result passes, run a bounded local, in-memory volume experiment with representative final-record shapes and enough rows to cross many page boundaries. Vary URLs, titles and lexemes so repeated identical fixtures do not exaggerate index compression. Add an update cycle and measure steady reuse. This does not require a repository clone, worktree, source archive or new production tables. Label these as synthetic physical measurements, not production capacity.
5. For candidate index removal, verify actual query plans and reader/notification behavior against representative data. For missing-field compaction, verify both merge-time state and UI explanations. Do not infer safety from an empty field or unused-index counter alone.
6. After renewed model/SQL/account budget verification and explicit live-test authorization, confirm one deployed case and its unchanged repeat. Do not expand model research just to measure storage. Report physical slope and WAL uncertainty separately, then review capacity and recurring work before resumption.

## Evidence and implementation references

- Current direction and known intake limitations: [refactor-consumption.md](refactor-consumption.md).
- Schema, indexes, access and quota retention: [findings migration](supabase/migrations/20261009190000_scout_findings.sql), [URL-intake quota migration](supabase/migrations/20261012150000_scout_url_intake.sql), [scheduler](supabase/scout-loop.sql).
- Research/persistence flow: [finding-jobs.js](collector/finding-jobs.js), [finding-contract.js](collector/finding-contract.js), [model.js](collector/model.js), [hosted-hsa.js](collector/hosted-hsa.js), [discovery](collector/octo-documents.js).
- Protected corrections and delivery: [corrections.js](collector/corrections.js), [notifications/slack.js](notifications/slack.js).
- Existing local numeric artifacts, which may not be present in another checkout: `.cache/scout-refactor/oct12-url-evaluation-results.json`, `oct12-url-final-state.json`, `oct12-url-unchanged-check.json`, and `oct12-url-release.json` in the same directory.
- Additional table/column/index measurements were read-only aggregates obtained during this review. They are transcribed above; no new capture files were created. Measurements are dated snapshots and should be refreshed before implementation if the database changes.
- PostgreSQL documentation: [page layout](https://www.postgresql.org/docs/17/storage-page-layout.html), [size functions](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADMIN-DBSIZE), [TOAST](https://www.postgresql.org/docs/17/storage-toast.html), [HOT updates](https://www.postgresql.org/docs/17/storage-hot.html), [vacuum and space reuse](https://www.postgresql.org/docs/17/routine-vacuuming.html).
- Supabase documentation: [database versus disk/WAL size](https://supabase.com/docs/guides/platform/database-size). Public plan descriptions do not substitute for verified account allowances.
