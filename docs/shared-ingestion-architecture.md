# Shared ingestion service architecture plan

Status: implementation authorized on 18 November 2026. This document records the agreed design; [architecture.md](architecture.md) describes the implemented modules and contracts.

The primary outcome is correct finding URLs: when a finding comes from a specific post or article, save that publication's public URL and use it for Slack Read more. Preserve it through matching, updates and resumption, and expose it in the website and calendar. A feed endpoint, tracker homepage or index URL must not silently replace an available publication URL. Architecture cleanup alone does not satisfy this requirement.

Scout will turn source lists into individual source items and run every item through one ingestion service. An item begins with the text or summary available from its source; web articles pass a freshness check before model investigation. The model decides whether it is relevant, whether to read further, and whether its developments create, update or leave existing findings unchanged. A webpage discovery step produces items for that same service.

The service runs inside the existing Scout backend and collection job. Its first sources are Bluesky, RSS and webpage entries. Existing CBD content retrieval moves to a source adapter. The shared service owns ingestion rules; source adapters own enumeration and source identity. This replaces the current direct-index extraction path and the saver’s independent heuristic matcher.

## Decisions and scope

- Keep one common item investigation, including further reads and read-only finding searches. Do not add a second matching or summarization job.
- Keep a general URL reader for safe fetching, freshness and content preparation. Separate source enumeration, item investigation and transactional storage from that reader.
- Supply the item URL as trusted caller context. The model does not invent or select the starting URL when it returns findings.
- Preserve existing findings, access controls, committed Bluesky checkpoints, source URLs and operational job states.
- Store current source identities, pending URLs and committed progress. Keep source text, summaries, model traffic and lookup working state in memory.
- Keep the existing invocation deadline. A list can span invocations; there is no requirement to finish it in one model conversation.
- Extend the service by adding a source reader that produces the item contract. Do not add a configurable pipeline framework, plugin registry or new hosted service.

The simpler change—asking the current index investigation to return a preferred URL—would improve links but would still combine discovery, relevance, investigation and coverage in one response. Appending RSS and more website branches to the current intake and source reader would retain their mixed responsibilities. The shared service is justified by three concrete inputs that need the same investigation, matching, commit and resume behavior. It introduces a source-item contract, compact pending-item storage for sources without a reliable watermark, and clear owners for those responsibilities.

## Replaced baseline

The replaced baseline included Bluesky checkpoints from be34b4f and the shipped freshness checker from 280f76e. Intake combined claiming, investigation, saving, progress and callbacks. The former reader/sources.js mixed general URL reading with Bluesky/CBD collection. The model gateway validated every response as findings; the saver matched records only after the model finished, and normalization assigned the starting URL even when an article was read.

Those responsibilities are reassigned in the replacement map below. [architecture.md](architecture.md) remains the description of deployed behavior.

## Source item contract

A source item describes a publication or entry, not a finding. One item may yield zero, one or several findings of any supported type.

The caller supplies a source context containing the tracker ID, its claimed URL, lease and current collection window. The model cannot change that context. Each item has:

| Field | Meaning |
| --- | --- |
| key: string | Stable identity within this source: a native post URI, feed GUID or observed publication URL. |
| url: string | Public HTTP(S) permalink of the item. Preserve an evidenced fragment when it identifies an embedded entry. |
| published_at: string or null | Published timestamp when supplied by the source; otherwise null. It is not the event date or a generic collection checkpoint. |
| version: string or null | Source-provided revision or digest of stable, source-supplied item material; otherwise null. A model paraphrase is not a reliable revision. |
| content: object | Available text, summary or structured post content, with its media type. This uses the existing prepared-content/native-file distinction and lives only in memory. |

For example, an RSS reader can supply a GUID, article URL, publication date and summary. Bluesky supplies its post URI, individual post URL and post context. The common investigator receives available material after the article freshness gate and reads further only when useful. A confirmed unchanged index skips discovery; a confirmed unchanged candidate article skips its model investigation. Pending items remain resumable independently of the index gate.

The material object has url and media_type strings and an optional content value containing text or structured JSON. Omitted content is reserved for an evidenced native PDF/image descriptor; it does not mean an empty source. Source text is untrusted evidence throughout. The contract carries the available item context, not a normalized finding or an invented completeness score.

For RSS, calculate a version from the publisher's stable entry fields: identity, link, title, summary/content and published/updated metadata. Do not include feed ordering, request times or engagement counters. This item revision detects changes in the advertised entry; it does not prove that every linked document is unchanged. Web-model paraphrases receive no fabricated revision. An unchanged discovery scope is likewise not evidence about independently changing linked pages.

Source identity and HTTP identity remain separate. The publication URL identifies what the finding concerns; a request URL identifies the resource actually fetched. A CBD API endpoint, redirect destination or feed endpoint must not replace the public publication URL. Query parameters remain part of HTTP resource identity; fragments identify entries but are removed for the HTTP request.

Missing optional dates do not reject an otherwise useful item. Do not manufacture a GUID, timestamp, permalink or ordering guarantee. When a page has no separately addressable entries, represent the page as one item. Multiple developments on that page still pass through the common investigator. Repeated entries with the same publication key are one source item, not automatically multiple findings.

Source adapters also supply their enumeration scope and native progress information separately from items. Bluesky’s consumed-through timestamp is a proven source-specific watermark. An arbitrary webpage position or publication date is not.

The backend call is ingestSource(db, claimedTracker, dependencies): it accepts the claimed tracker/lease, existing database wrapper, absolute deadline, source reader, model gateway and URL-reading capability. It returns completion/deferred/needs-attention state, counts, created finding IDs and changed event IDs. It does not return source bodies or send notifications. The caller remains responsible for authentication, claiming and post-commit callbacks.

Source adapters expose discovery; retained URLs reload through the shared URL reader. Discovery returns items, whether its configured scope was completely enumerated, and trusted source progress metadata; reload reconstructs one retained item for investigation. Readers make no database writes. Only the source-specific progress owner interprets native timestamp-group acknowledgements; webpage discovery output cannot supply executable progress decisions.

## Source discovery

### Structured sources

Bluesky and RSS readers parse the publisher’s list without a discovery model call. They preserve source text and item URLs and pass items to the shared service individually. Relevance is decided by the item investigator, rather than by an RSS-specific or Bluesky-specific filter.

The RSS scope is the publisher’s available feed. Follow pagination only when the source actually supplies it and its continuation behavior is understood. Do not infer an archive crawl, invent page numbers or substitute a rolling look-back window. The initial High Seas Alliance case has an [advertised feed](https://highseasalliance.org/feed/) with item URLs; it does not require model-based article discovery.

Source dispatch recognizes the existing Bluesky author-feed URLs and CBD page mapping, and otherwise uses the fetched media type to select RSS or web handling. It adds no configurable source registry. For the HSA RSS pilot, explicitly change the tracker to the advertised feed URL during an authorized cutover; do not silently substitute another resource or seed its checkpoint. Readers reuse prepared responses so dispatch does not fetch them twice.

### Web pages

The web reader fetches and prepares the configured page, then asks a model to return a structured list of its publication entries. Its instructions are to identify entries and preserve their observed links and available text, excluding navigation. It does not apply Scout’s relevance rubric, match findings or write records.

Validate returned links against the supplied page and actual retrieval results. A well-formed URL alone is insufficient. Retain valid identified entries when another entry is unusable, and report exclusions in invocation diagnostics. Never turn a partial list into a claim of complete site coverage.

The discovery model’s summaries are provisional input for investigation, not saved facts or authoritative version tokens. A discovered item’s URL becomes durable pending work before its investigation starts. A changing list is reconciled by keys, never by “resume at item 12.”

Discovery covers the configured listing scope. General recursive crawling and exhaustive archive enumeration are outside this revision. Initial web scopes and the HSA RSS feed are reloaded by keys, without a durable list offset. A source reader requiring pagination across invocations must have an actual native continuation and an explicit source-specific storage decision; this revision does not add a speculative generic cursor column. A mutable model-produced array supplies no such cursor.

Enumeration completion means the reader finished its configured retrieval scope without a known failed/truncated listing read. It is not a semantic guarantee that a model noticed every entry, nor a requirement for complete finding fields or successful supporting-document reads. Register useful observed URLs even after a partial discovery, but retain earlier receipts and leave discovery freshness/completion unacknowledged. Do not add a coverage score or block saving those items' useful findings.

## Common item investigation

The investigator receives one item, Scout’s existing instructions and dates, the remaining deadline, and two tools:

| Tool | Contract |
| --- | --- |
| read_url | Read a relevant public resource through shared HTTP/freshness and content preparation. Return URL-labelled content or a read error. |
| search_findings | Accept text phrases and exact source URLs. Search saved descriptions, organizations and details. Return candidate IDs, complete saved fields including details, and the exact latest modified timestamp as the revision. Preserve PostgreSQL timestamp precision as text; do not round it through a JavaScript Date. |

Type and date may help a search, but cannot be mandatory filters that hide a previously misclassified or incompletely dated finding. A shared index URL is a retrieval clue, not proof of identity.

Duplicate searching happens inside reader/investigate.js, before the model returns its final decisions. That module exposes search_findings to the model; reader/findings.js implements its read-only database query. The model compares candidates with source evidence and decides the match. Source adapters, the URL reader and freshness checker do not match findings. The later transactional search recheck is concurrency validation, not a second semantic matching stage.

The model assesses the supplied summary, investigates as needed, retrieves existing records before deciding updates, and returns a complete decision response:

| Decision | Required data and behavior |
| --- | --- |
| create | New finding fields, after searching for existing records. |
| update | Candidate ID, expected revision and full proposed fields, even when facts are unchanged. Only candidates actually returned during this investigation are eligible. |
| skip | Explicit reason such as identity_unresolved. Do not translate uncertainty into a new record or an assumed match. |

An irrelevant item returns a valid empty decision list. It is successfully consumed. Explicitly skipped findings permit other findings and source progress to commit, including when all findings are skipped. This preserves the current collection policy; it creates no review queue. Invalid decision contracts, provider failures and stale reads instead defer the item without consuming it.

A matched finding always uses update. The backend saves a new evidenced item URL even when the finding's facts are unchanged, and makes no finding-row mutation when the merged fields and sources are identical.

Keep tolerant handling of malformed optional scheduling fields and the existing finding-age rule. Apply that rule to the development’s date, not automatically to the feed entry’s publication date. Missing optional fields do not erase established facts.

### Finding descriptions and details

Include the two improvements coordinated with “dump duplicates” in this architecture:

- Description is a short label led by the principal responsible organization or organizations. Preserve identifying titles, versions and distinctions; the organizations field retains the broader associated list. Keep an already compliant description unchanged unless new facts or a correction warrant an update. Apply the format to new findings and naturally revisited labels, without bulk reprocessing.
- Details is one nullable text column containing the maintained factual account of the development, limited to 4,096 UTF-8 bytes. This is a maximum, not a target length. It is not an array, source capture, quoted proof trail or version history. Existing rows start null; do not run a model backfill simply to fill it.

Matching and enrichment happen before the model's final answer. After retrieving a candidate, the model compares its saved details with the new evidence. No substantive addition means preserve the exact saved string. New facts or supported corrections produce one merged account that retains established facts and fits the byte bound; compact the prose when necessary. A new supporting URL can update sources while leaving details untouched.

The backend validates UTF-8 bytes, with a database octet_length constraint as the final bound. Do not confuse character count with bytes or blindly truncate prose. Omit an invalid/oversized optional details proposal, preserve existing details, and report the field issue while saving other useful supported fields. Do not add a model retry solely to rewrite an oversized details field.

Return details through the existing finding reads and record-details view; Slack keeps using the short description. Include details in the existing textual candidate search. Add no separate enrichment pass, duplicate details copy, new search service or speculative index before measuring the actual query plan.

## Commit and concurrency

Investigation makes no finding or progress writes. Keep candidate search arguments and observed IDs/revisions in memory until commit.

For a completed item, use one short database transaction:

1. Verify the tracker lease, unchanged tracker URL and expected pending item version.
2. Acquire the existing finding transaction advisory lock.
3. Before applying decisions, repeat the actual candidate searches and compare candidate IDs and revisions, independent of ordering. Verify revisions for update decisions.
4. If observations changed, roll back and defer for fresh investigation through the finite retry path.
5. Validate and apply decisions, retaining existing optional-field merge rules and making no writes for identical findings.
6. Commit consumed-item progress in the same transaction.

The search comparison prevents a concurrent create visible to those searches from being accepted against an older candidate set. All ingestion writers must use this commit protocol. It does not establish that the model’s searches were adequate, distinguish developments the model conflated, or prove that two creates within one answer are semantically distinct. These remain explicit matching validation cases. Do not hold a database lock during model or network calls, introduce a persistent revision ledger, or silently restore the old heuristic matcher.

For Bluesky, retain the existing atomic timestamp group: investigate its posts individually, then commit the group’s findings and watermark together. A failed tied group can replay, as it can today. Earlier timestamp groups remain committed.

After commit, return created IDs and changed event IDs to the caller for the existing Slack and calendar callbacks. Delivery failure does not rewind collection. Keep best-effort delivery and no persistent send suppression.

## Pending work and resumption

Use the existing Bluesky checkpoint path. Sources without a safe native watermark need a small current item table because finding rows cannot represent consumed irrelevant entries or pending publications.

Proposed table: scout.source_items, backend-only, keyed by tracker ID and item key.

| Column | Purpose |
| --- | --- |
| tracker_id, item_key | Source-scoped identity; primary key. |
| url | Durable public item URL for reloading. |
| observed_version | Latest evidenced list-item revision; nullable. |
| consumed_version | Revision successfully investigated; nullable. |
| pending | Current work flag, needed because an unversioned rediscovery cannot prove unchanged content. |
| consumed_at | Successful processing of this source item, including irrelevant items and unchanged findings. |
| request_url, request_checked_at | Optional evidence for the actual primary item resource read and successfully processed. Both stay null when only a feed summary was consumed. |

Add discovery_request_url and discovery_checked_at to the tracker. These record successful listing discovery, rather than pretending pending articles have been processed. They are separate from the tracker’s full collection completion and from article HTTP freshness.

For RSS/web sources, last_successful_check remains the completed collection-cycle marker for cadence; it is not a feed watermark or HTTP freshness timestamp. Bluesky retains its existing consumed-through use and timestamp-group rules. Scheduler/claim eligibility must explicitly include pending items and incomplete discovery, rather than infer their absence from timestamp equality.

The runner follows this sequence:

1. Claim a due or unfinished tracker using the existing lease and finite retry policy.
2. Reload and drain pending items before starting another discovery pass. Each completed item commits immediately; an unfinished item remains pending.
3. When discovery is due, retrieve the source list through its reader. An unchanged listing can skip discovery, but never hides pending item rows.
4. Register discovered keys/URLs and evidenced versions atomically with discovery progress. A known revision already consumed stays complete; a new or changed revision becomes pending. Unknown revisions remain unknown and cannot be skipped solely because their URL was seen before.
5. Process available items sequentially within the same remaining invocation budget. Source-specific native pagination/checkpoints remain the reader’s responsibility.
6. Mark the tracker’s collection window complete only after its discovered work is consumed and its supported enumeration scope is complete.

Pending metadata survives invocation loss. On resume, the reader reconstructs input from the source or retained item URL. It does not reload a stored summary or model conversation. If the publication changed, investigate its current representation; old source bodies are not replayable. If the retained URL cannot reproduce necessary context, report the retrieval limitation and keep the item pending under the finite retry policy. Do not silently claim it was consumed.

Retain one current row per item, without attempt or version histories. For a successfully enumerated current RSS feed or listing scope, remove completed receipts absent from that scope; retain absent pending URLs until handled. Never prune from a partial, failed or ambiguous enumeration. A resurfacing item whose receipt was removed may be investigated again; matching must prevent a duplicate finding. This is an explicit storage tradeoff, not a promise to remember every item in an unbounded archive forever.

Initial scope is the current configured feeds and listing pages. Measure their retained workset. A growing archive cannot be made constant-size without a separate retention decision; do not quietly add an expiry or look-back limit.

Changing a tracker URL clears its discovery metadata and source-item state in the same backend reset path, while preserving findings. New trackers still start without a fabricated checkpoint. Existing Bluesky watermarks are preserved exactly; do not create duplicate receipts for their already consumed history.

## HTTP and freshness integration

Preserve the shipped [checkFreshness](../reader/freshness.js) behavior from commit 280f76e. Its current call accepts a URL, lastSuccessfulCheck, fetch and signal; it returns the response and an unchanged indication. It handles conditional GET and old Last-Modified values. An unknown or inconclusive result requires investigation.

The general URL reader owns public-address checks, redirect validation, deadline/cancellation, invoking this checker and preparing downloaded content. Its public readUrl call returns unchanged or URL-labelled prepared content, or raises a retrieval error. HTML becomes readable text, JSON remains structured, generic XML remains available to its source parser, and native files retain the existing descriptor behavior. It has no Bluesky, RSS or CBD branches. Fetching and preparation remain distinct functions within this cohesive reader; they do not require a public service or file for every step.

Only the exact requested resource’s successfully committed read metadata may be supplied to the checker, including its query parameters. Re-evaluate metadata identity on redirect. A parent listing checkpoint, a feed entry’s consumed_at, or a read of a different API endpoint does not establish article freshness. Supporting URLs without their own committed metadata are first reads. The stored checked-at value is the conservative request-start boundary, acknowledged only after successful processing; do not use the later model/commit time, which could conceal an intervening resource change.

A successful listing-discovery commit may advance listing freshness while article work remains pending. An article read’s metadata advances only with that article’s successful processing. Do not commit successful HTTP retrieval as successful ingestion when the model or save later fails.

An unchanged article response also does not erase new summary information from a changed feed entry. Continue investigating that supplied material when its item revision is new, returning the linked read's unchanged indication as context. Skip a whole item only when its consumed-version or source-specific progress evidence supports that decision.

Whole-resource fingerprints and additional HTTP validators remain extensions owned by the freshness component. Do not introduce a second checker inside discovery, investigation or source adapters.

## Timeouts and work boundaries

Keep one absolute deadline from the tracker invocation’s claim time. The architectural change is durable discovery/item boundaries, not a fresh timeout for each item inside a loop.

| Limit | Proposed treatment |
| --- | --- |
| Source/model budget | Keep 100 seconds per invocation, including discovery, item reads, model requests, record-search continuations and eligible fallback. |
| HTTP read | Keep at most 15 seconds, clipped to the remaining invocation time. |
| Gemini primary attempt | Keep at most 45 seconds, clipped to the remaining time. |
| OpenAI attempt and continuations | Use remaining invocation time; every continuation receives the same absolute deadline. |
| Database statements | Keep the hosted five-second statement timeout and short transactions. |
| Lease and scheduled HTTP caller | Keep 120 seconds. |
| Manual hosted caller | Keep 125 seconds; it does not extend worker or lease time. |

Enforce an invocation-relative commit deadline at 110 seconds and a post-commit callback deadline at 115 seconds, leaving the last five seconds for failure reporting and connection cleanup. The commit deadline bounds the whole transaction, not just each SQL statement: clip statements/lock waits to the remaining transaction time and cancel/roll back when it expires. These reserved intervals are implemented worker behavior and require validation with the real search/commit path.

Discovery can consume an invocation without leaving enough time for investigation. Its committed pending URLs remain for the next invocation. An item finishing early may be followed by another; every item shares the original deadline. Do not start work after that deadline, reset it at a tool call, or treat the 120-second lease as extra model time.

At expiry, abort the current investigation and leave its item pending. Earlier item commits survive. Trackers with pending work remain eligible on later collection wakes. Preserve three attempts without successful progress before automatic retries stop; a deferral after successful progress does not erase that progress.

Post-commit callbacks share the time before the 115-second cutoff, retaining their existing per-request bounds clipped to that remainder. A large set of new findings cannot be guaranteed immediate Slack delivery there; report partial/uncertain delivery without a new queue or ingestion replay. Existing calendar reconciliation remains its repair path. Measure the complete source/read/search/commit path before unattended rollout; any later timeout change must cover the worker, lease and caller together.

## Module boundaries and replacement map

These are cohesive source modules inside the existing backend, not separate deployed services. The implementation should move responsibilities and delete obsolete paths rather than wrap the current mixed functions.

| Module | Final responsibility and replacement |
| --- | --- |
| reader/intake.js | Thin collection runner: claim/lease/deadline, invoke ingestion, report outcome and run post-commit callbacks. Remove extraction, source branching and finding matching from this function. |
| reader/ingestion.js, new | Shared service: register discovered work, consume items sequentially, coordinate investigation and atomic finding/progress commits, and return resumable outcomes. No source-specific relevance or matcher variants. |
| reader/investigate.js, new | One item’s model conversation, read/search tools, decision validation and in-memory candidate observations. Replaces the extraction-only model call in intake. |
| reader/findings.js | Keep normalization, supported-fact merge rules and record persistence; add read-only search and explicit decision application. Remove description/source candidate selection, 80-percent word overlap and sole-candidate target inference. |
| reader/progress.js, new | Own source_items and committed discovery/item progress SQL. No model calls or source bodies. The common service composes its writes with findings in one database transaction. |
| reader/url.js, new | Move safe HTTP, redirects, resource-scoped freshness and content preparation out of sources.js. Expose the general readUrl interface and reuse freshness.js. Keep readable HTML, JSON, generic XML and native-file preparation here, without source-specific feed/API branches or database writes. |
| reader/freshness.js, existing | Keep the shipped checkFreshness component separate. reader/url.js calls it; it is not absorbed into url.js. It owns the HTTP unchanged decision, while ingestion owns successful-processing acknowledgement. |
| reader/sources/bluesky.js, new | Move profile resolution, native pagination, oldest-first selection and timestamp-group boundaries from readSource. Preserve committed checkpoints. |
| reader/sources/rss.js, new | Parse publisher-supplied entries, identities, URLs and evidenced revisions. Add no relevance or persistence policy. Select one maintained XML parser only after checking its fit; do not parse general RSS with regular expressions. |
| reader/sources/web.js, new | Webpage-to-item discovery and its separate instructions/schema. Does not return findings. |
| reader/sources/cbd.js, new | Move the existing CBD-specific public-page/API mapping and article acquisition here. Supply the public identity and actual request URL explicitly. |
| reader/sources/index.js, new | Small dispatch for these concrete readers. No configurable registry or universal crawler. |
| reader/sources.js, removed | Delete after callers move to the URL reader and explicit source readers. Do not leave it as a second implementation. |
| reader/instructions.js | Common per-item investigation instructions and decision schema. Remove the mixed “investigate a whole directory” branch. |
| reader/models/gateway.js and provider adapters | Keep provider routing, deadlines, finite fallback, schema transport and protocol-specific tool continuations. Move finding validation and finding-specific wrappers to their workflow owners. Discovery and investigation supply their own schemas and tools. |
| supabase/functions/scout-reader/index.ts | Remain authentication, dependency wiring and invocation response. Do not move ingestion policy into the endpoint. |
| diagnostics/diagnose-tracker.js | Invoke the same service with its existing isolated in-memory database and local-only capture. Do not add a second diagnostic pipeline or deploy capture code. |

Retain the existing provider routing as the implementation baseline: Bluesky’s Gemini primary/eligible OpenAI fallback, and OpenAI for web work. The Gemini transport must gain the same source-read and record-search tool interface before Bluesky enters the new common investigation. Its current adapter cannot satisfy that contract. Verify the actual tool/schema combination and complete deadline with real calls; do not silently switch every source to another model or duplicate business logic in provider adapters.

## Finding URLs and consumers

The item URL is attached by the service when it applies decisions. Additional supporting URLs must be evidenced by the investigation; do not save every unrelated search result.

Use the previously discussed labelled-source representation in records: objects with url and role. Roles are finding, supporting and unclassified. The last role preserves existing URLs whose meaning has not been verified. Several publications can support one finding; a shared article can produce several findings.

Merge sources by normalized URL, not object identity. An evidenced item URL can promote the same preserved unclassified URL to finding; it must not append another copy. Preserve established finding roles during later updates.

Convert existing URL strings once to unclassified objects, preserving all values and record IDs without fabricating primary links or appending a content-change timestamp solely for a format migration. New item URLs receive the finding role. Keep tracker URLs on trackers; they become finding links only when the tracked page itself is the actual item.

Use a new migration to change records.sources from text[] to a checked JSON array and replace its source index for the new representation. Add nullable scalar details with its 4,096-byte constraint. Create the source_items primary key and backend-only policies/grants, extend the tracker-reset trigger, and add the two discovery metadata fields. Keep existing migrations immutable. This is one schema/consumer cutover; there is no string/object fallback during normal operation.

Update [Slack](../slackbot/slack.js), [website source links](../website/dashboard.js), [calendar descriptions](../calendar/feed.js), shared URL helpers and relevant RPC projections in the same schema cutover. Read more selects an evidenced finding link, not a broad tracker or an arbitrary supporting URL. For legacy findings without one, omit Read more while keeping their preserved URLs visible in Sources; do not abort an entire digest. No ongoing string/object compatibility path is needed.

Rechecking the two High Seas Alliance findings is a targeted validation step, not authorization to replay every tracker or rewrite historical records. Their article contains a call and webinar; the combined-record granularity identified by “dump duplicates” must be reviewed explicitly rather than generalized into a matching rule.

## Cost and operational budget

This design adds item investigations and compact source state. It adds no cron job or separately hosted component.

Let N be unconsumed/changed source items, D changed webpage discovery pages, R additional investigation continuation requests, F eligible fallback requests, S candidate searches, and W finding-row changes in a period.

| Work | Planning estimate |
| --- | --- |
| Model HTTP requests | At least N + D, plus R + F. Structured list parsing itself makes no model call. Record searches that require another model turn contribute to R. |
| Candidate SQL reads | S during investigation, plus up to S rechecks at commit; no persistent search log. |
| Discovery SQL | One short transaction per successful enumerated scope/page, using set-based receipt registration and safe completed-receipt pruning. Rows touched scale with actual changed registrations and pruning. |
| Item SQL | Budget about 7 + 2S + W statements per non-watermark item: transaction boundaries, lease/item check, advisory lock, timeout setup, two progress writes, initial searches plus their commit rechecks, and finding writes. Empty/skip-only paths can omit unnecessary finding locks/rechecks. Measure the exact SQL after implementation. |
| Retained state | One current receipt per retained non-watermark item; URL/key/version/read metadata only. No source text, summary or model history. |
| Scheduler capacity | Existing six-minute collection schedule provides up to 240 wakes/day. Several items can commit in a wake, but the total source/model window stays 100 seconds. Measure actual throughput and backlog. |

The last live URL audit in this chat found 673 findings and 940 URL entries. At that snapshot, the one-time source-shape migration would update 673 rows; adding the unclassified object wrapper would add roughly 28,200 raw JSON bytes across those entries, before storage overhead/compression. Recount and measure the actual migration when implementing. It must not trigger rediscovery, Slack reposts or details enrichment.

Illustrative storage, not a measurement: with a 16-byte tracker ID, a 100-byte key, 200-byte URL, two 64-byte revision digests, timestamps and tuple/index overhead, budget roughly 0.6–1 KiB per current item; 1,000 items would use roughly 0.6–1 MiB before real index/TOAST measurement. Source URLs and keys have no artificial truncation cap, so actual sizes can be higher. At 100 newly processed items/day, receipt inserts/updates and source enumeration work must be measured alongside finding mutations; a daily item count is not the same as a daily new-finding count.

For an illustrative day with 100 non-watermark items, two searches/item and 30 finding mutations, the item path is approximately 1,130 SQL statements, plus claims, discovery and notifications. New/changed registrations, successful item consumption and tracker progress account for about three operational row mutations/item, plus the 30 finding mutations, discovery metadata writes, claims and pruned receipts. These are workload assumptions, not measured daily activity.

At the 673-record snapshot, filling every details field to its cap would add at most 2.63 MiB of raw text before overhead/compression. K newly saved findings/day add at most K × 4,096 bytes/day of details; enriching an existing finding maintains its single bounded field. Updates can still produce dead tuples, so measure physical table/index growth as well as logical text size.

Before unattended rollout, measure model requests/tokens/latency, SQL statements/row mutations, pending/retained rows and physical table/index size on the three concrete source paths. Measure actual daily source-item volume and shared Scout/Mimi account usage, not just public plan ceilings. The present plan does not claim the account allowances or complete new workflow have been validated.

## Implementation sequence and removal

1. Review this contract, retained workset, timeout behavior and URL-source migration. Resolve CHM record granularity with the matching work. Choose the RSS parser on the actual HSA feed.
2. Move the general URL reader and source adapters out of the mixed sources.js, preserving the shipped freshness checker and Bluesky behavior. Separate workflow-specific model validation from provider transport. Prove that move before adding new source behavior.
3. Introduce common investigation decisions and record search using the matching work. Remove the heuristic matcher only when its replacements pass the actual duplicate and separation cases. Do not keep it as a hidden fallback.
4. Add compact pending/receipt state and discovery progress with backend-only access. Move native and HTML-derived lists through the same service. Extend source-reset and scheduler eligibility to pending work.
5. Cut over labelled URLs and all consumers together; preserve saved records and established access controls. Remove the old direct-index extraction prompt/path and mixed sources.js.
6. Run the end-to-end validation below, measure cost, review the full diff for duplicate paths and unnecessary modules, and create a focused implementation commit only after implementation is authorized.

Implementation and deployment were subsequently authorized by the user. During deployment, follow [README deployment instructions](../README.md#supabase-deployment), preserve each job’s active state and restore any temporary deployment pause before finishing.

## Validation required before rollout

Use existing test suites and diagnostics. Add only tests protecting the new behavior and plausible regressions.

| Case | Required result |
| --- | --- |
| One Bluesky post, one HSA RSS entry and the same HSA entry discovered from HTML | All enter the same item investigator with their specific URLs. Summary-only rejection is possible; further reads occur only when needed. |
| HSA call and webinar | Find the relevant developments from the article/brief and link to that article. Agree record granularity explicitly. |
| Finding URL survives the complete path | Start from the HSA homepage/feed, discover the specific article, match or create findings, commit and resume, then verify Slack Read more uses that article URL and website/calendar retain it. A preserved legacy homepage must not override the evidenced finding link. |
| Irrelevant item and unchanged finding | Commit consumed progress, make no finding-row mutation and send no new-finding notification. |
| Description and incremental details | Lead the short label with responsible organizations. Retrieve saved details before enrichment; add new facts while retaining old ones, preserve the exact string on no substantive change, validate multibyte text against 4,096 bytes and keep existing facts when an optional details proposal is invalid. |
| Reordered index and unchanged index with pending work | Reordering skips no pending URL; unchanged discovery still permits pending items to run. |
| Timeout after one item commits | Keep the first item’s findings/progress; retry only unfinished work, without persisted bodies or conversation replay. |
| Stale update and concurrent create visible to the searches | Roll back the item’s decisions/progress and defer; retain earlier commits. |
| Malformed optional dates and explicit identity skip | Preserve useful facts and existing tolerant/skip behavior. Invalid decision contracts do not consume the item. |
| Tracker URL reset and new tracker | Clear source-specific state, preserve findings and do not invent starting checkpoints. |
| Freshness for index, article, API and redirect | Supply only the exact resource’s committed metadata. A parent checkpoint never skips a newly encountered article. |
| Duplicate and separation cases | Match OCTO paraphrases, equivalent timezone representations and social/article copies; separate IUCN summary/report publications, repeated event dates, language sessions and announcement/reaction developments. Correct the SkyTruth/GFW retrieval misses. |
| Consumer cutover | New Slack Read more links point to publications; preserved legacy sources remain visible; website/calendar do not assume strings. |

Mocked tests establish mechanics. Real-model validation must cover summary triage, linked reading, candidate search, decisions and deadline together. The matching experiment’s 8/12 result is not sufficient: two retrieval misses and two false merges remain. Stale-save handling, concurrent creates and incremental details enrichment also need their own evidence before those behaviors ship.

## Coordination

“Don't reread” confirmed the shipped freshness checker's API, deployed status and current integration: ordinary GET, conditional/Last-Modified checks, no extra HEAD request, no stored ETag/fingerprint, and no inherited checkpoint for model-requested linked URLs. Successful ingestion acknowledgement belongs to the caller. This plan uses that component; the pending-state and retention choices above are proposals in this plan, not additional work assigned to that chat.

“dump duplicates” supplied the lookup/candidate-revision and create/update/no-change contracts, the matching counterexamples and current validation blockers. Its follow-up confirmed explicit identity skips preserve current policy, while stale observations invalidate the transaction. It reviewed the short-lock candidate recheck as a limited concurrent-create defense, not a semantic duplicate guarantee. Danny's later direction there includes the single bounded details field and organization-led descriptions in this shared plan, with matching and enrichment before the final model answer.

The implementation uses fast-xml-parser 5.12.1. Acceptance requires measured complete-path latency and costs, real provider tool validation and the HSA article updating its separate call and webinar findings. Local mocks establish mechanics; deployment acceptance must also verify the live saved URLs.
