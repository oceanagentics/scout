# Scout architecture

This describes the local implementation as of 19 October 2026. Outstanding acceptance work is in [tasks.md](tasks.md); engineering constraints are in [AGENTS.md](../AGENTS.md). Historical deployment versions and account-usage snapshots are not current operating authority.

## Source intake

```text
Explicit URL request or due-source selection
  -> collector/hosted.js
  -> collector/intake.js
     -> source-state.js: claim a source lease
     -> models/gateway.js: reserve, call and settle model usage
     -> finding-contract.js: normalize returned findings
     -> finding-store.js: match and save in a transaction
     -> bounded scheduling follow-up for newly saved undated events
     -> source-state.js: complete, defer or park the source
```

[collector/hosted.js](../collector/hosted.js) handles the private `scout-collect-hsa` endpoint. It authenticates the backend secret, validates the request, opens a bounded database connection and assembles dependencies. It accepts a tracker and source URL, selects an existing due source with `next=true`, applies a correction, or performs a separate notification request. [collector/run.js](../collector/run.js) is the CLI launcher.

[collector/intake.js](../collector/intake.js) coordinates one source. The active route supplies a URL directly to the model. It does not fetch and prepare local page bodies or run publisher discovery. Completed and parked sources require explicit reopening; a completed skip does not establish that a remote page is unchanged.

Useful findings are saved before scheduling follow-up. Newly created events missing a start date, clock or timezone enter the current scheduling pass. A supported result can update only a supplied saved record ID, and its date-source URL must appear in successful provider retrieval metadata. Failure leaves the useful partial record intact. This scheduling pass supersedes the older generic optional-research implementation; do not restore that design from historical plans.

[collector/source-state.js](../collector/source-state.js) owns leases, attempt counts and complete/deferred/parked state. Source retries are finite. [collector/finding-contract.js](../collector/finding-contract.js) owns the shared instructions, schemas and normalization; [collector/corrections.js](../collector/corrections.js) handles human corrections.

The intake schema and normalization currently cap a response at eight findings. Same-source identity also depends on normalized title and kind. These are known limitations for long programmes and repeated occurrences, tracked in [source completeness](tasks.md#source-completeness).

## Models and accounting

[collector/models/gateway.js](../collector/models/gateway.js) routes intake to Gemini and can use OpenAI once for eligible retrieval, output or transient provider failures. A useful partial or valid empty result does not itself request fallback. Authentication, safety and accounting failures stop the route.

The gateway obtains admission and request settings from SQL `scout.reserve_provider`, then settles usage through `scout.settle_provider`. SQL owns shared finite attempts, deadlines, enablement, verified Gemini headroom and provider cooldowns. Intake, fallback and scheduling share the two-generation allowance; fallback is not an extra allowance. Unknown dispatched requests retain conservative accounting.

The [Gemini](../collector/models/gemini.js) adapter uses URL Context; the [OpenAI](../collector/models/openai.js) adapter uses provider web access. Both require a gateway dispatch permit from their [common contract](../collector/models/contract.js). They do not define independent admission policies. OpenAI account limits and Gemini's verified allowance remain external constraints; old numeric usage snapshots do not establish current headroom.

[collector/database.js](../collector/database.js) wraps bounded queries and transactions and returns numeric statement, mutation and byte counters. It does not retain SQL parameters or result bodies. Measure actual model/SQL cost before unattended operation; old migration measurements are not ongoing capacity estimates.

## Findings and storage

The active storage responsibilities are:

| Relation | Responsibility |
| --- | --- |
| `scout.trackers` | Source configuration and enablement. |
| `scout.records` | Useful facts, typed dates, ranked organization names, priority, human overrides, source URLs and identity aliases. |
| `scout.source_state` | Compact current progress, leases, retries and bounded research state. |
| `scout.quota_policy`, `scout.quota_reservations` | Current admission policy and accounted known/uncertain usage. |
| `scout.delivery_state` | Current delivery claims and outcomes. |

[The compact-record migration](../supabase/migrations/20261012180805_scout_compact_records.sql) stores facts, source associations and aliases in one finding row. [finding-store.js](../collector/finding-store.js) checks the source lease and serializes matching/writes with a transaction advisory lock. Inline aliases are not globally unique by themselves; writers must preserve this transaction boundary.

Stable identities and existing source/title candidates guide matching. Ambiguous matches can be withheld. A semantic change advances the record version; adding only a source or alias preserves that version. Identical saves make no finding mutation. Missing optional fields do not erase established facts, and protected human corrections survive model updates.

Events, announcements and treaty changes share the same record structure. Dates preserve their meaning and available precision; unknown clocks/zones stay unknown. Useful Low findings remain available for human review. Their inclusion does not change Slack eligibility.

Production retains useful findings, source URLs and compact operational/accounting state. Source bodies, prompts, replies and proof trails are not production records. The explicitly requested local diagnostic capture is a separate exception described in [diagnostics/README.md](../diagnostics/README.md).

## Website, Slack and calendar

[website/main.js](../website/main.js) starts the browser application. [access.js](../website/access.js) manages sign-in/session access, [dashboard.js](../website/dashboard.js) assembles the interface, [records.js](../website/records.js) renders records and [calendar.js](../website/calendar.js) provides calendar controls. [shared/](../shared/) contains date, ordering, timing and source-link rules used by these features.

Firebase serves the public login shell and static assets. Supabase Auth and database policies protect data: verified `oceanagentics.com` Google identities receive reader access; backend-controlled Auth metadata grants admin access. Browser visibility is not an authorization boundary. Sign-in uses PKCE and a tab-scoped session.

[slackbot/slack.js](../slackbot/slack.js) reads saved findings, selects eligible records, formats messages and claims delivery before posting to the configured webhook. Immediate findings are recent, unannounced High records; digest helpers support dated upcoming High/Normal events. The hosted `notify=true` route and [slackbot/run.js](../slackbot/run.js) currently expose immediate findings. Uncertain sends retain their claim to avoid blind duplicates. There is no incoming Slack question/event listener, and digest scheduling is unfinished.

[calendar/hosted.js](../calendar/hosted.js) serves `scout-calendar`. Management actions verify the configured calendar owner's Google identity. [feed.js](../calendar/feed.js) emits a subscription feed protected by a secret URL; [google.js](../calendar/google.js) reconciles a bounded event snapshot with the explicit Google calendar on request. Refresh authorization and the feed secret live in Vault. Calendar sync does not collect new source content.

## Discovery and diagnostics

[collector/discovery/](../collector/discovery/) contains the existing feed, listing and publisher adapters. `hsa.js` dispatches among those adapters; publisher `*-documents.js` files know their source formats. This code remains available for review and tests, but the active hosted intake graph does not call it. Bringing discovery back into collection requires a scoped decision and source-specific proof.

[diagnostics/diagnose-source.js](../diagnostics/diagnose-source.js) runs the checkout's workflow with in-memory finding state and real shared quota accounting. Its explicit local capture exception does not apply to hosted operation.

Keep entrypoints focused on dependency setup, workflows on coordination, provider adapters on transport, and shared modules on pure rules. Providers and the gateway depend on their common contract without a cycle. [The import-boundary test](../tests/import-boundaries.test.js) protects these boundaries, including keeping discovery and diagnostics out of hosted intake and diagnostics out of the website.
