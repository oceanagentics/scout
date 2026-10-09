# Scout refactor consumption plan

Status: approved for implementation; baseline pending. Written 2026-10-09.

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

`discover -> gather evidence -> extract typed facts -> validate and match -> save -> assess relevance and surface`

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

- Manager: plan written; old omission-repair workflow replaced by manager oversight every 30 minutes.
- Worker: dispatched and active in `01a121b8-ef1b-78e3-9b28-ec8b86f33dbe`; Phase 1 only until manager review.
- Phase: 1, baseline pending.
- Before/after results: not yet measured.
- Production changes for this refactor: none.
