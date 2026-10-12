# Scout database optimization

Implemented and deployed **12 October 2026 at 18:08 UTC**, collector **v137**. Finding-related storage fell **32.5%**, from **679,936 to 458,752 bytes**, while preserving all **95 findings, 117 source associations and 98 identity aliases**. Recurring collection and notifications remain paused.

Each finding, its source links and identity aliases now belong in one row. Obsolete scalar columns and redundant historical provenance are removed while useful facts, record IDs, human corrections and accounting are preserved. No synthetic benchmark, additional benchmark database, new test suite or recurring measurement job is required.

## Database shape and content

Scout runs on Supabase PostgreSQL 17.11 with 8 KiB pages, autovacuum, `pglz` TOAST compression and `zstd` WAL compression. The `scout` schema stores useful findings and compact current operational state. Source bodies, prepared documents, prompts, model responses, quoted proof trails and operation reports stay in memory and are discarded.

Before optimization work, collector v136 stored **84 findings, 106 source associations and 87 identity aliases**. Findings describe events, announcements and treaty status. Organizations use ranked names; older records can still contain historical role labels. Dates retain meaning, precision, clock and timezone. Descriptions, priority explanations, completeness, corrections and meaningful provenance remain useful content.

Read-only inventory at **17:43 UTC on 12 October**:

| Relation | Rows | Heap bytes | Index bytes | Total bytes | Stored content |
| --- | ---: | ---: | ---: | ---: | --- |
| `records` | 84 | 139,264 | 262,144 | 458,752 | Facts, review state, versions and timestamps; 29 columns including legacy fields. |
| `record_sources` | 106 | 24,576 | 40,960 | 98,304 | Record/URL associations, optional tracker and relationship. |
| `record_identities` | 87 | 16,384 | 32,768 | 81,920 | Identity aliases mapped to record UUIDs. |
| `trackers` | 35 | 24,576 | 49,152 | 114,688 | Source configuration and cadence. |
| `source_state` | 46 | 16,384 | 49,152 | 98,304 | Source identity/URL, fingerprints, lease, attempts, deadline and bounded research state. |
| `quota_policy` | 1 | 8,192 | 16,384 | 57,344 | Verified budgets, enablement, expiry, cooldown and numeric uncertain charges. |
| `quota_reservations` | 49 | 8,192 | 49,152 | 98,304 | Model-call accounting, tokens, state, timestamp and short reason. |
| `delivery_state` | 12 | 8,192 | 16,384 | 32,768 | Latest delivery version/status/time, including uncertain delivery. |

Totals include indexes, TOAST and auxiliary forks. The whole database occupied **14,161,587 bytes**; Scout relations occupied **1,040,384 bytes**, including **638,976 bytes** for findings and their two relationship tables. Most database storage belongs to PostgreSQL/Supabase infrastructure. Minimum page allocations mean these small-table totals are not a per-record growth slope.

The separately authorized COP17 batch added eleven findings before cutover. The production comparison below starts after that batch finished, excluding its growth from the optimization result.

## Implemented storage and write path

`records` is now a **20-column table**:

| Information | Representation |
| --- | --- |
| Identity and classification | UUID, kind, title, description, canonical URL and priority in ordinary columns. |
| Organizations and facts | Existing ordered organization-name JSONB and typed-details JSONB, preserving the reader/API shape. |
| Review state | Completeness, relevance including priority explanation, human overrides and meaningful provenance in JSONB. |
| Lifecycle | Version, accepted version, discovery/update/last-communication timestamps and generated date range. |
| Sources | Inline JSONB array of `{url, tracker_id, relationship}` objects. |
| Aliases | Inline `text[]` of established identity strings. |

Eleven obsolete scalar columns and two relationship tables are removed. Migration checks that useful legacy values already have a current home. It removes a provenance field only when its URL set repeats the complete source list and no human override protects that field. Field-specific and human provenance stay intact.

The table is rebuilt transactionally to reclaim the old row layout and dead versions immediately. An in-place rewrite was rejected after rehearsal retained dead versions and grew physical storage. Migration requires the model policy and Scout cron jobs to be disabled, no active source lease, and at most 1,000 findings; locks/statements have finite timeouts. Delivery foreign keys, access policies, grants and the reader function are preserved. Operational tables are not migrated.

Existing reader indexes remain except the obsolete legacy identity and kind/update indexes. GIN indexes support inline identity/source lookup. The compact table has **12 indexes**, replacing **15 across the previous three relations**. Organizations remain JSONB because changing their public shape for the previously measured 28-byte sample saving would widen this change unnecessarily.

Saving matches and merges under the existing lease check and transaction advisory lock, then performs **one finding-row insert/update** containing facts, sources and aliases. Separate identity/source insert statements disappear. Exact aliases take precedence; repeated identical model entries in one save pass are skipped. Automated finding writers use the same lock: the inline alias array does not provide global SQL uniqueness by itself.

Semantic changes advance version/acceptance. Adding only a source or alias preserves the semantic version and update timestamp. An identical save performs no finding mutation. Existing source order is retained, avoiding rewrites caused only by array reordering. Human corrections use one finding update and one associated source-state update.

## What record research writes

Research remains **gate → claim → fingerprint → reserve/call → save useful partial findings → optional improvement → finish/defer**.

| Stage | Durable writes | In memory only |
| --- | --- | --- |
| Select work and verify budgets | Reads; failed gates stop before source/model work. | Request-local control values. |
| Expire accounting | Delete at most 32 expired reservations; preserve uncertain charges as numeric policy totals first. | No accounting report. |
| Claim source | Insert/update one `source_state` row with bounded attempts and a 120-second lease. | No source capture. |
| Fingerprint | Save hashes when finishing. A completed matching fingerprint skips model and finding writes. | Main source and up to three support-page reads. |
| Reserve and settle generation | Insert reservation before dispatch; settle token totals/state afterward. Keep conservative charges for uncertain requests and cooldown when needed. | Prompt, schema, request, response and retrieval diagnostics. |
| Save first useful findings | Match aliases/source/title and insert or update one compact row per changed finding. | Normalized output and candidate comparisons. |
| Improve if requested | At most one further generation and a save of changed findings; retrieved support URLs enter the same row. | Questions/intermediate material. Failed improvement preserves the first result. |
| Finish/defer | Update hashes, state, attempts, due time and bounded research metadata; clear lease. | Invocation counters returned to caller. |

Each save retains factual description, ranked organizations, typed details, priority/explanation, explicit unknowns, useful URLs and aliases. Missing optional output does not erase established facts or human corrections. The serialized save bound remains 12,288 bytes; it is not a physical disk limit. `source_state.research` contains a revision and source/support URL fingerprints, not a narrative.

Quota, discovery and delivery retain their own compact current state. Discovery retains a bounded cursor/inventory; notifications claim and settle a latest-delivery marker. This optimization does not change research selection, model prompts, retry limits, discovery cadence or delivery behavior. It adds **zero model calls and zero recurring daily work**.

## Verification and measured results

The existing one-record workflow verifies partial capture, improvement, human corrections, reader access and unchanged repeats using injected model output. The full existing **248-test suite passed**, followed by 17 focused workflow/access/delivery checks after final review; the frontend build passed. Existing fixtures were adapted, with no new test suite. Mocked output proves persistence mechanics, not live extraction correctness.

A migration rehearsal loaded all **84 actual final records** and associations into the existing in-memory test setup. It preserved useful fields, IDs, dates, versions, 106 sources, 87 aliases, corrections and specific provenance. Equality comparisons confirmed the five operational tables were unchanged. Reader output retained all records. Source/model traffic was not copied or persisted.

| Rehearsal allocation | Before | After | Change |
| --- | ---: | ---: | ---: |
| Finding-related heap | 172,032 B | 106,496 B | −65,536 B |
| Finding-related indexes | 327,680 B | 262,144 B | −65,536 B |
| Finding-related total | 614,400 B | 417,792 B | **−196,608 B (32%)** |

These are PGlite rehearsal allocations for real stored records. The production comparison used all 95 findings present after the COP17 batch:

| Live allocation, 18:08 UTC | Before | After | Change |
| --- | ---: | ---: | ---: |
| Finding-related heap | 196,608 B | 122,880 B | −73,728 B |
| Finding-related indexes | 360,448 B | 286,720 B | −73,728 B |
| Finding-related total | 679,936 B | 458,752 B | **−221,184 B (32.5%)** |
| Whole database | 14,210,739 B | 14,030,515 B | −180,224 B |
| Finding-related index count | 15 | 12 | −3 |

Whole-database savings include catalog/migration overhead and therefore differ from the finding relations. These allocations are not a long-term capacity forecast.

Migration copied 95 rows, with zero semantic finding updates or model calls. The migration API returned success in 767 ms; collector v137 was then activated from its prepared bundle. Before/after hashes confirmed preservation of all useful facts, sources, aliases, versions, timestamps and corrections, with only the documented redundant provenance removed. All five operational tables were unchanged. The local migration filename matches the API-assigned history version `20261012180805`.

Live API verification returned all 95 records with inline sources/aliases. Anonymous reads were rejected; backend authentication, method and input guards returned the expected 401/405/400. The paused collector returned `unverified_budget` after two reads and zero mutations. Alias, source and text lookup plans used bitmap index access; single observed execution times were 1.456, 0.111 and 0.164 ms respectively, not a latency benchmark. The deployed bundle contains the reviewed storage changes; unrelated local intake changes were excluded.

### Numeric measurement record

Keep a compact checkpoint here after each material change, using measurements from authorized work. Git retains previous checkpoints. Do not add measurement/history tables or recurring jobs.

| Date / revision / environment | Workload | Collector SQL | Row mutations | Attributable statement WAL | Database growth | Index growth | Finding HOT / updates |
| --- | --- | ---: | --- | ---: | ---: | --- | --- |
| 2026-10-12 / v135 / live | Twelve sources; six inserts, three updates | 252 | 71 | 221,839 B | 57,344 B | Unmeasured | Unmeasured |
| 2026-10-12 / v135 / live | One unchanged repeat; no model calls/finding writes | 9 | 2 source-state | Unmeasured | Unmeasured | Unmeasured | N/A |
| 2026-10-12 / v136 / live | One E04 organization update | 23 | 5 | 34,565 B | 0 B | Unmeasured | Unmeasured |
| 2026-10-12 / compact / existing local test | One partial capture; mocked model | 14 | 5 | Unmeasured | Not a disk benchmark | Unmeasured | Unmeasured |
| 2026-10-12 / v137 / live migration | 95 findings consolidated; no generations | N/A: migration | 95 copied rows; operational rows unchanged | ≥553,960 B observed, including 125,614 B for the copy | −180,224 B | −73,728 B across finding relations | 0 / 0 after table replacement; N/A |

Different workloads are not a before/after efficiency comparison. Harness/control operations are additional. The mocked capture removes separate alias/source inserts; its measured submitted/result bytes were 4,056/1,689. Unchanged input still has zero model calls/finding writes and two source-state mutations. Migration WAL includes 473,976 bytes across 32 captured statement deltas plus 79,984 bytes for its uniquely identified table creation. Function recreation, migration-history and other overhead were not fully attributed, so this is a lower bound, not the complete transaction WAL total.

For subsequent ordinary authorized research, retain heap/index/TOAST allocation before/after, SQL statements, row mutations and statement WAL. Separate inserts, updates whose indexed values stay unchanged, updates changing indexed values, and unchanged repeats. Capture `n_tup_hot_upd` and `n_tup_upd` deltas in the same settled statistics window; HOT rate is `100 × ΔHOT / Δupdates`, or N/A for zero updates. Record counter resets and unrelated activity explicitly. The old table's **86 HOT updates / 1,084 updates (7.9%)** is mixed lifetime history, not a workload result. Rebuilding resets its counters.

Inlining removes related-row/index work, but wider rows and changes to indexed source/identity arrays can affect HOT behavior. **HOT and per-update WAL improvements remain unmeasured.** Zero index allocation growth does not mean zero index writes. Record future real results without generating artificial research or edits to populate a metric.

### One-hour checkpoint — 12 October 2026, 19:07:33–20:07:56 UTC

Read-only management API comparison during real writes; no research or database mutations were triggered by this check. Collector deployment advanced from v137 to v138 at 19:53:19 UTC, alongside separate URL-only research, model fallback and calendar work. The research description above records the migration-time implementation; current behavior is governed by `refactor-consumption.md`.

| Measurement | Before | After | Change |
| --- | ---: | ---: | ---: |
| Findings | 95 | 103 | +8 |
| Source links / aliases | 117 / 98 | 132 / 113 | +15 / +15 |
| Finding heap | 122,880 B | 139,264 B | +16,384 B |
| Finding indexes | 286,720 B | 319,488 B | +32,768 B |
| Finding total | 458,752 B | 507,904 B | +49,152 B |
| All Scout relations | 868,352 B | 958,464 B | +90,112 B |
| Whole database | 14,079,667 B | 14,210,739 B | +131,072 B |
| Estimated dead finding rows | 0 | 0 | 0 |

The eight version-1 findings arrived in one batch at 19:36:45 UTC and contain all 15 added links and aliases. Table counters show **8 inserts, 0 updates and 0 deletes**. Observed finding allocation grew **6,144 B per new finding**, including **4,096 B of indexes**; this small page-allocation sample is not a capacity forecast. Identity, organization, source and text GIN indexes each grew 8,192 B, ending at 40,960 / 24,576 / 24,576 / 98,304 B. Other index sizes were unchanged. Scan deltas were primary key +26, canonical/title/identities +16 each, priority-page +11, kind-priority +1 and zero for the other six indexes; one hour of no scans does not establish redundancy.

The bulk insert's existing `EXPLAIN ANALYZE` wrapper recorded **1 call, 46,073 B WAL, 57.283 ms execution, 1,009 shared-buffer hits, 2 reads and 19 dirtied blocks**: **5,759 B WAL per inserted finding**. Its statement entry began at 19:36:45 UTC (`queryid=-4619956265173898327`); its reported row counter is zero because it is an EXPLAIN wrapper. The eight inserted rows are established separately by table counters and discovery timestamps. This is batch SQL execution time, not API latency or full research cost.

Operational activity was separate: reservations had **18 inserts, 18 updates, 17 HOT updates (94.4%)** and 8,192 B growth; policy had **30 updates, all HOT (100%)**, 8,192 B growth and one autovacuum. Their dead-row estimates fell 17→13 and 28→4 respectively. Source-state, delivery and tracker counters/allocations were unchanged; source-state still had 53 estimated dead rows. The new calendar table added 24,576 B, with 1 insert and 11 HOT updates. No observed table had a deletion delta. Matching direct quota DML contributed **48 calls/48 rows, 12,200 B WAL, 53.042 ms, 1,337 buffer hits, 0 reads and 8 dirtied blocks**. Reservation creation is nested in `reserve_model`; tracking is `top` and its function-call baseline was not captured, so these are partial costs, not a complete write total.

All six baseline table OIDs matched. Database statistics reset remained null; statement statistics reset remained **2026-10-08 23:05:13.347985 UTC**, with **0 evictions**, no missing baseline entries and no decreasing captured counters. Deltas match `(userid, dbid, queryid::text, toplevel)`; new direct-DML entries start from zero in this unchanged window.

**Conclusion:** the earlier same-content **32.5% storage reduction** remains established. This hour adds a real insert-cost checkpoint, but the v135 twelve-source run and this bulk save are different workloads, so no write-cost or latency improvement/regression is established. Finding HOT is **N/A (0 updates)**; indexed versus non-indexed update costs and unchanged-save behavior were not measured. Growth accompanies useful new data and separate operational/calendar work; no finding dead-row buildup was observed. These estimates cannot quantify free-page/index bloat, and `pgstattuple` remains unenabled. No maintenance action is justified by this sample. This was a one-time follow-up, with no continuing monitoring.

## Supabase analytics and operating limits

The management API provides useful read-only measurements:

| API | What it establishes |
| --- | --- |
| `analytics/endpoints/usage.api-counts?interval=1day` | Project API traffic; preparation snapshot returned 5 auth and 15 REST requests. |
| `analytics/endpoints/functions.combined-stats?interval=1day&function_id=…` | Function traffic/timing: preparation snapshot had 35 requests, 31 successes, 4 client errors and no server errors. |
| `analytics/endpoints/metrics` | Prometheus database/host metrics, including database bytes and transaction totals. |
| `database/query` | Relation/index/TOAST sizes, HOT counters and `extensions.pg_stat_statements` SQL/row/WAL statistics. |

API counts do not count collector SQL. Function timing includes non-database work. Use PostgreSQL statistics for database costs and analytics for traffic/runtime context; retain only selected numeric values. Migration WAL is separate from research WAL. Do not reset shared statistics or retain full analytics logs.

Scout's existing database gate remains **400,000,000 bytes**, subject to fresh verification and shared account headroom. The organization entitlement endpoint returned 403; readable analytics alone does not establish all account allowances. Model policy remains disabled outside separately authorized manual windows. This optimization authorizes no recurring collection or notifications.

Small-table sizes do not prove 100,000- or 500,000-record capacity. Future capacity estimates must include useful content, indexes, operational growth and service headroom. The earlier six-record representation sample averaged 1,523 tuple bytes for the old row versus 1,335 for a compact envelope excluding related rows/indexes; neither is a physical growth slope. Descriptions and priority explanations alone averaged about 550 bytes and remain preserved.

## Implementation references

- Schema: [compact records migration](supabase/migrations/20261012180805_scout_compact_records.sql).
- Writes: [finding-jobs.js](collector/finding-jobs.js), [corrections.js](collector/corrections.js), [notifications](notifications/slack.js).
- Intake work and historical measured runs: [refactor-consumption.md](refactor-consumption.md).
- PostgreSQL: [table statistics](https://www.postgresql.org/docs/17/monitoring-stats.html#MONITORING-PG-STAT-ALL-TABLES-VIEW), [HOT](https://www.postgresql.org/docs/17/storage-hot.html), [size functions](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADMIN-DBSIZE).
- Supabase: [management API](https://supabase.com/docs/reference/api/introduction), [database versus disk size](https://supabase.com/docs/guides/platform/database-size).
