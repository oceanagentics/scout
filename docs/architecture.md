# Scout architecture

The reader, production schema and website were deployed on 19 October 2026. Recurring collection and notifications remain paused.

## Tracker investigation

```mermaid
flowchart TD
  start[Manual request or scheduled wake] --> endpoint[Supabase function: scout-reader]
  endpoint --> intake[reader/intake.js]
  trackers[(scout.trackers: URL and checking state)] -->|Select and claim one tracker| intake
  intake -->|Stored tracker URL and instructions| model[reader/models: model reads the URL]
  model -->|Findings| save[reader/findings.js: normalize and save]
  save --> records[(scout.records)]
  save -->|Finish check in the same transaction| trackers
  records --> output[Website, Slack and calendar]
```

[The Supabase function](../supabase/functions/scout-reader/index.ts) authenticates a backend secret, opens one database connection and calls [intake.js](../reader/intake.js). It accepts a POST without parameters for the next due tracker, or `tracker_id` for an explicit check/retry. The URL is read from that tracker, unchanged. `reader/` runs inside this function; it is not a separate hosted service.

Intake selects and claims a tracker atomically before model HTTP. A 120-second lease excludes overlapping checks. It supplies the URL, current date and [instructions/schema](../reader/instructions.js) to the model. The model can follow relevant links during its investigation. Missing dates do not prevent saving useful findings.

For public Bluesky `getAuthorFeed` tracker URLs, [bluesky.js](../reader/bluesky.js) fetches the JSON directly. Each check supplies one complete post, including its record, links and every attached image description/URL, to the model. The first check starts with the oldest entry in the URL's configured initial window. Later checks page from the same tracker URL back to the last processed feed entry and process the oldest new entry. Reposts use their feed identity; pinned entries are excluded. Unchanged feeds make no model or accounting calls. Search endpoints retain ordinary URL investigation behavior.

One check processes at most one post, so an initial 20-post window needs 20 successful checks. HTTP work is bounded to ten pages, one MiB per page and 15 seconds overall. If the saved entry is deleted or the page bound prevents reaching it, the check fails without advancing progress; it does not silently skip a gap. This requires review rather than automatically discarding the boundary. Source bodies remain in memory. Browsing remains available for relevant links and images, but model retrieval of the whole feed is unnecessary. There is no second source list or stored post inventory.

The response is normalized and saved in a transaction that also finishes the tracker check. The lease and unchanged tracker URL are checked before saving. A changed URL resets its state and disables automatic checks until backend enablement. Failed saves roll back the finding and successful completion together.

## Tracker state

Source configuration and current progress live together in `scout.trackers`:

| Field | Meaning |
| --- | --- |
| `next_check_at` | When an enabled tracker becomes eligible again. Success schedules from its cadence. |
| `last_checked_at` | When the last attempt finished, including failure. |
| `last_error` | Short reason for the latest unsuccessful attempt; cleared on success. |
| `failure_count` | Attempts since success, including the current claimed attempt. Three stop automatic retries. |
| `lease_id`, `lease_until` | Temporary ownership of an in-flight check; cleared when finished. |
| `reader_progress` | Last successfully processed feed-entry URI for incremental Bluesky reading; saved in the findings transaction and reset when the URL changes. Backend-only, at most 1,024 bytes. |

A terminated worker's attempt remains counted. An explicit tracker-ID request starts another bounded cycle after three failures, without stealing a live lease. `last_checked_at` does not imply successful retrieval; inspect `last_error` too.

There is no stored status enum, permanent completion flag or separate source-state table. The legacy `collector` configuration column remains for the retained scraper files; the reader does not inspect it. The dashboard queries tracker rows directly, with no finding-job backlog view. Browser users cannot write operational state or read lease tokens.

## Findings and model calls

[findings.js](../reader/findings.js) converts the model response into records and saves them under a transaction advisory lock. Records have one `description`, no title, overrides or per-field provenance. Correction endpoints and protected-field merging are removed, without replacing their metadata elsewhere. Existing ordinary finding values and source URLs remain; correction-specific source labels are removed.

The existing description/source matching heuristics remain temporarily: identity aliases, exact descriptions, word overlap and a sole same-kind source candidate. A live check confirmed that different wording and an index-page URL can duplicate an existing event; the duplicate created by verification was removed. Model-directed lookup is separate work. No record catalog is added to the prompt. Responses are currently limited to eight findings. These limitations are not resolved by this refactor.

Identical findings make no record writes. A substantive change increments the version; adding only source URLs or aliases preserves it. Missing optional fields do not erase existing facts. Dates retain their meaning and precision; missing clocks and timezones remain unknown.

[The model gateway](../reader/models/gateway.js) reserves and settles shared usage through existing SQL functions. Gemini uses URL Context; the existing OpenAI fallback uses provider web access. Normally one generation is needed; eligible Gemini failures allow one fallback within the same two-generation allowance. Provider deadlines and uncertain charges remain enforced. Provider errors defer the tracker until its retry time. There is no custom URL validator or canonicalizer in the reader.

There is no quota-policy table, budget-verification expiry or global policy enablement switch. The providers enforce their account limits. The existing reservation table retains current numeric usage, including uncertain requests; bounded cleanup removes rows after their accounting window. Scheduling is controlled by the cron job itself, which remains disabled.

[database.js](../reader/database.js) wraps the Postgres connection with parameterized queries, transactions and per-invocation statement/byte bounds. It returns numeric statement, mutation and byte counters without retaining query parameters or result bodies. It is an internal SQL wrapper, not another network API.

## Other components

- [website/](../website/) displays findings and tracker state. Firebase hosts the static interface; Supabase Auth and RLS protect data. Verified Ocean Agentics Google identities retain reader access and backend-granted admin roles.
- [scout-notify](../supabase/functions/scout-notify/index.ts) calls the existing [Slack workflow](../slackbot/slack.js) for explicitly requested sends. Delivery accounting and uncertain-send protection remain. No notifications are sent during reader checks.
- [scout-calendar](../supabase/functions/scout-calendar/index.ts) retains the existing private subscription feed and explicit Google Calendar synchronization. It reads saved findings.
- [diagnostics/run-reader.js](../diagnostics/run-reader.js) launches a hosted check. Its explicit diagnostic mode runs the local reader with in-memory findings and shared model accounting; see [diagnostics instructions](../diagnostics/README.md).
- [collector/](../collector/), including `discovery/`, is retained for later review/removal. Nothing in the new hosted reader imports it. Legacy database integration tests use the pre-reader schema. The old deployed endpoint returns HTTP 410.

Production stores findings, source URLs and compact current state. Source bodies, prompts, responses and proof trails are not production records. The requested local traffic capture remains confined to diagnostics.

## Cutover and operating cost

The description-only, reader and quota-policy removal migrations are applied in production. The reader, notification and calendar functions and website are deployed. The replacement [scout-loop.sql](../supabase/scout-loop.sql) is installed with its hourly schedule disabled. All four Scout cron jobs remain paused. Do not run the legacy collector against the new schema.

Migration verification confirmed that all 108 existing findings and 101 per-call usage rows retained their facts and values. The removed tables and columns are absent, and no remaining Scout database function references the quota-policy table.

The reader migration drops source-state rows, the backlog function/view, correction columns and the HTTPS-format constraint. It does not convert article URLs into trackers or reconstruct old operational history. It leaves delivery accounting unchanged. The following removal migration drops the quota-policy table; current per-call charges remain in the existing reservation table. Migration guards require paused work, no active source claims or sends, and at most 1,000 records/500 trackers. The later reader-progress migration adds one compact boundary to existing trackers; it does not enable them. This Bluesky change requires that migration and reader deployment before production use.

Estimated normal activity is one generation, two tracker-row mutations and only changed/new finding writes, plus existing quota accounting. Six fixed state columns replace up to 201 source-state rows per tracker. The current scheduler serves at most one tracker per hourly wake: at most 24 checks/48 generations per day if explicitly enabled. A faster cadence may therefore wait longer when many trackers are due. Manual requests also consume provider allowances.

Local PGlite tests with mocked providers measured 26 counted SQL statements and seven row mutations for a fallback check saving one finding. A one-generation repeat measured 17 statements and four mutations (two tracker and two accounting writes), with no finding write. These tests do not prove live extraction accuracy or current account capacity. Measure one real tracker check before enabling unattended work.

Production verification used two Gemini generations with 23,303 input tokens and 474 output tokens, with no fallback. The first tracker returned no findings; the HUB Ocean tracker saved four, including the duplicate noted above. Three new findings remain, with descriptions, dates and local times checked against the publisher's calendar. The two checks counted 40 SQL statements and 12 row mutations, plus 64 expired accounting-row deletions. Both tracker leases cleared and all recurring jobs stayed disabled. This verifies the live pipeline, not complete retrieval or reliable matching; recurring operation still needs review.
