# Scout refactor consumption plan

## URL-only core — 12 October 2026

The user's latest direction shuts down local source reading/preparation and fingerprint change detection while proving the core. Hosted manual and due-source collection both pass the source URL and shared instructions directly to the model; the hosted collector no longer enters the legacy document-discovery adapters. Model-requested research supplies URLs and existing findings to the model, without application-side support reads. Legacy reader modules remain outside this active route.

Completed and parked sources require explicit reopening through the existing state reset/correction path. Page changes alone no longer reopen them, and a skipped completed source is reported as complete rather than claiming its content is unchanged. Keep finite retries, quota accounting, useful records and human corrections. No source bodies or new hashes are retained; existing database columns remain for compatibility. Recurring collection and notifications stay paused. This supersedes earlier requirements below for automatic fingerprint checks; it does not resolve relevance selection, URL-provider reading failures or programme completeness.

## Current failure status and ownership — 12 October

This snapshot supersedes older next-action/status descriptions below; historical test results remain unchanged. **Seven solved, eight open.** Open items include implemented work awaiting live proof, blocked validation and pending decisions; they are not eight new implementation projects. Solved means the item's stated implementation or diagnostic scope has evidence; it does not imply complete intake reliability or permission for recurring operation.

| Failure | Status | Current evidence / remaining work | Owner |
| --- | --- | --- | --- |
| F01 — Useful output rejected by strict structure | Solved | Optional fields and malformed siblings normalize independently; useful partials save. | Completed URL intake |
| F02 — Oversized prepared source input | Solved | URL intake replaced prepared packets; E03/A09 now produce useful output within measured limits. | Completed URL intake |
| F03 — Overlong prose | Solved | Prose clips locally; structured values remain valid or unknown. Local regression coverage. | Completed URL intake |
| F04 — Malformed/interrupted output | Solved — closed by user | New response contract saved E04/A03; the latest twelve-source run reported no malformed-output/final-validation failures. Local checks protect saved partials. Ordinary provider failures remain F10/F12. | Completed response redesign |
| F05 — Missing fields block capture | Solved | Useful incomplete findings save successfully; research decision/state is tracked separately under F06/F11. | Completed URL intake |
| F06 — Model decision and requested follow-up | In progress — live evaluation | Research metadata is optional under `e39e7d5`. The active twelve-undated-record batch is examining real requests; its first nine responses requested no follow-up. Zero requests alone is not a defect; useful linked-fact recovery remains unproven. | Solve Scout follow-up decisions F06/F11 |
| F07 — Incorrect facts / authority | Open — current factual error observed | A02 people and E05 clock repaired. The active test used a parent meeting's June 24–26 range for a June 25 session. Reviewer correction is separate from model success. A01 authority and unsupported date inference remain review targets. | F06/F11 live review; undated rerun for wider evidence |
| F08 — Duplicate identity | Open — replay assigned | Equivalent CBD URLs created an old duplicate. The undated-source rerun will distinguish existing-record enrichment, genuinely new records and possible duplicates before further identity changes. | Rerun sources for undated Scout events |
| F09 — URL retrieval failures | In progress — deployed fallback test queued | `123b2fc`/collector v138 deploy bounded recovery. The dedicated backend secret is now saved; the earlier invalid-local-key blocker is stale. E02/E09/A07 live fallback tests await release of shared controls; no recovery success yet claimed here. | Model gateway |
| F10 — Temporary provider failure | Open — integration/validation | Finite attempts, cooldowns and uncertain charges have local coverage. Keep this within gateway integration; no separate retry engine or claim that an upstream 503 is an extraction bug. | Model gateway |
| F11 — Pending research / completed inputs | Open — local behavior verified | Finite research and record/override preservation have local coverage. Research metadata is optional; URL-only completed/parked work now requires explicit reconsideration, not fingerprint changes. Live requested improvement remains unproven. | Solve Scout follow-up decisions F06/F11 |
| F12 — Failure diagnostics | Open — provider portion implemented | Gemini diagnostics and gateway error boundaries exist with local tests. Review any remaining silent field rejection narrowly; no new tracing system. Gateway live proof remains blocked. | Model gateway for provider portion; remainder unassigned |
| F13 — Announcement containing an event | Pending — selection/test decision | IUCN A03's event may be the useful result. Agree a general selection rule and revised expectation separately from the frozen baseline; identity concerns belong with F08. | Unassigned |
| F14 — Ambiguous URL failure diagnosis | Solved (diagnosis only) | Present provider metadata explicitly reports retrieval ERROR; missing metadata and model unreadability are distinguishable. Underlying cause/recovery remain F09. | Completed diagnostic comparison |
| F15 — Organization role complexity | Solved | Ranked organization names without roles are deployed; E04 live verification and local ordered-name coverage passed. | Completed organization simplification |

F06/F11 owner: **Solve Scout follow-up decisions F06/F11**, chat `01a13144-dec9-7ec1-9e25-589ced6b39d7`, existing local checkout. Its original implementation `4f48ef2` was relaxed by `e39e7d5`: research metadata is optional and must not obstruct useful record creation. Research is requested only when the agent considers it necessary to understand the development. The later URL-only route `e2a9427` supersedes fingerprint reopening. The chat is running a separately authorized twelve-undated-record evaluation. Model gateway (`01a121ba-6d77-7b31-889d-c2c5dbd75bca`) owns provider recovery and its queued live comparison. Keep one owner of manual quota controls at a time; no extra workers, worktrees, automatic crawl or recurring activation. The original rr worker remains stopped.

### Authorized rerun of undated-event sources

The user requested production replay of sources associated with the missing-date events, with before/after evidence of existing-record updates and added records. Owner: **Rerun sources for undated Scout events**, chat `01a131c1-c712-7961-9999-3167f72fdce1`, existing local checkout; concise plan/results go in `undated-events-rerun.md`.

Freeze the manager's original 32 event IDs supplied to that chat: 30 older records plus E03 and A03 from URL intake. At that read-only snapshot Scout held 69 events, 33 announcements and one treaty-status record. Preserve the denominator as concurrent work repairs rows. Map stored source associations, deduplicate shared URLs, and reuse the active F06/F11 twelve-record evidence without duplicating calls. A direct model response or reviewer-applied correction is not automatically proof of normal pipeline matching. Wait for that batch and the already queued gateway comparison to release shared controls before running remaining sources; mapping and review can proceed now.

Use the current deployed URL-only pipeline, with one scoped reconsideration of selected completed/parked source states when needed. Permit normal production inserts/updates; preserve identities, human corrections and unrelated records. At most 32 distinct primary-source invocations and 64 total generations including credited overlapping evaluation work, with at most two per source across extraction/fallback/improvement. Fresh actual shared headroom can lower those caps. No global state/quota reset, automatic repeat of failures, unallocated OpenAI spend, runtime changes or recurring activation. Verify one case's persistence/cost before expanding. Report supported dates recovered on original IDs, other updates, genuinely new rows, possible duplicates, unresolved cases, provider usage and database costs. Distinguish model output, reviewer correction and unknown facts; save no source/model archives. This is validation/repair work under existing F06–F13, not a new failure category.

The latest full twelve-source URL run saved output from nine sources and requested no follow-up links. E03/A04 retained honest unknown dates; recoverability from linked pages is not established. Only complete A09 received the live unchanged-input check. Skipping an unchanged partial is a code-observed consequence, not a demonstrated live loss of a recoverable fact. F06/F11 must assess the model's judgment rather than require research whenever an optional field is absent.

Subsequent single-case E05 test in the F06/F11 chat used one real generation with findings held in memory: the model declined research and supplied October 8, 2026 at 16:00 UTC, while retrieval metadata listed only the primary page. Its event date line lacks the year; the linked registration independently establishes 2026. Matching the expected value does not demonstrate supported year recovery. This overlaps F07 factual grounding; it does not justify forcing a follow-up merely because none was requested. No model traffic was retained, so do not infer more about the model's reasoning than these observations establish.

## Organization simplification and URL diagnostics — 12 October

F15 implementation removes organization role labels from the prompt/schema, normalization, manual corrections and display. Ranked `{name}` entries retain their array order and the existing organization filter; old records remain compatible without a migration or bulk rewrite. Three regression checks failed before the change and pass afterward (saved names, corrections, display). All 248 local tests and the frontend build pass. Deployed as collector v136; the Firebase asset matches the local build byte-for-byte. One live E04 rerun updated the same IDDRI record to `[{name:"IDDRI"}]`, displaying `IDDRI`, with its February 26 17:00 UTC date/time and registration URL preserved. All 83 other record rows and human overrides are unchanged. This single live result validates role-free intake; multiple-name ranking is covered by the local persistence/display checks. This change adds no SQL statements, row mutations or model calls to intake and removes role bytes from newly saved organization entries.

F14 diagnostic comparison completed using the original `2428784` prompt/schema and the same Gemini model, one request each for E02, E09 and A07. All three returned HTTP 200, `STOP`, present URL metadata with `URL_RETRIEVAL_STATUS_ERROR`, model status `unreadable`, zero records and no prompt block. These were explicit provider retrieval errors, not absent metadata or JSON rejection. The conditional fourth request was unnecessary. Google exposes no origin HTTP status or specific cause in this metadata; the underlying retrieval cause remains unknown. F09 remains open. Next proposed remedy is one bounded in-memory source-text fallback within the existing two-generation limit, rather than repeated identical URL requests; no fallback has been implemented or tested.

Diagnostic cost: three generations, 7,199 input tokens (including tool input), 462 output tokens, 18 adapter SQL statements and six quota row mutations; six additional policy-control writes opened/closed the three finite manual windows, plus read-only preflight/verification queries. All 84 record rows are byte-for-byte unchanged; database size remains 14,153,395 bytes and quota-row storage grew 303 bytes. No findings or source state were written. Attributable WAL was not measured for this comparison. Actual Google limits were freshly verified at 500 generations/day, 15/minute and 250,000 input tokens/minute, with 28 calls used before this comparison and billing disabled. Returned diagnostics are transient; only short error codes and numeric quota charges enter current database state. Recurring collection and notifications remain paused.

Live F15 verification cost: one generation, 9,877 input / 474 output tokens, 23 collector SQL statements and five row mutations, plus three manual setup/disable mutations. Record storage fell 64 bytes, the active quota ledger grew 80 bytes, physical database growth was zero, and attributable statement WAL was 34,565 bytes. Total model activity for this task was four generations (17,076 input / 936 output tokens). All four jobs and the model policy are disabled, with no uncertain charges. F15 is complete; F14 diagnosis is complete; F09 capture recovery and broader F12 diagnostics remain open.

## URL intake result — 12 October 2026

**Deployed and tested; unattended acceptance remains incomplete.** Collector v135 uses the URL-based prompt and structured partial output. The fixed twelve-source run saved output from **9/12 sources**, captured **8/12 intended records**, and passed the frozen date/organization checks for **7/12**. Six cases had no identified target, core-fact, or relevance-verification defect. These are different measures: the IUCN blog yielded an event rather than the frozen publication target, and a saved record can still contain an incorrect role. Whether selecting that event is preferable remains open under F13; the original scores are unchanged.

The old “0/12” was strict completed-intake acceptance; that run did save partial output from five sources. Do not compare its zero directly with the new partial-capture count. Same twelve URLs and expectations, unchanged prompt/model/code across this run, no per-case retry, no held-out claim.

| Measure | Previous run | URL intake run |
| --- | ---: | ---: |
| Sources with saved output | 5/12 | 9/12 |
| Generations | 15 | 12 |
| Other model HTTP calls (countTokens) | 17 | 0 |
| Generation input accounting | 102,041 tokens | 64,183 tokens, including URL retrieval |
| Output tokens | 15,658 | 4,520 |
| Collector SQL statements | 342 | 252 |
| Collector row mutations | 110 | 71 |
| Manual harness SQL statements | 204 | 216 |
| Manual control row mutations | 25 | 36 |
| Attributable statement WAL | 207,552 B | 221,839 B |
| Net finding/URL/identity logical growth | 22,409 B | 15,509 B |
| Whole database growth | 128 KiB | 56 KiB |

The new run created six records and updated three. Existing records and human overrides were preserved. The measured WAL did **not** fall despite fewer SQL operations; page images/checkpoint timing and the different writes affect it. Cluster LSN movement is not physical WAL volume and is not used as the result. The database ends at **84 records / 14,153,395 bytes**. No source bodies, prepared packets, prompts, model responses or proof archives were saved. Evaluation artifacts contain useful stored-record projections and numeric measurements only.

Actual Gemini allowances were reverified: 500 generations/day, 15/minute, 250,000 input tokens/minute, billing disabled. This run used 2.4% of the daily generation allowance. Its largest generation used 21,117 input tokens, below the 60,000 reservation and Scout's 125,000/minute ceiling. There were no token overruns, uncertain requests or quota denials. Account-wide Supabase API usage remains unverified; this manual test does not authorize unattended activity.

**Live unchanged check:** rerunning A09 used zero generations, zero finding writes and zero version changes; nine SQL statements and two compact source-state mutations. This is separate from the twelve-source totals (plus eight harness SQL statements and three control mutations). All four Scout jobs and the model policy are disabled again.

| Case | Result and remaining gap |
| --- | --- |
| E01 — HUB Ocean | Correct October 22 start/end times and HUB Ocean organizer; useful event saved. |
| E02 — HSA CHM webinar | No capture; `url_unreadable` did not distinguish retrieval failure, missing metadata or the model's own unreadable answer. Diagnose under F14. |
| E03 — HSA MGR webinar | Correct HSA/participant organizations; webinar date honestly remains unknown. The former oversized input now works. |
| E04 — IDDRI MPA webinar | Correct February 26, 17:00 UTC, registration and associated organization IDDRI. The old test rejected the host label rather than speaker/participant; that role-only failure is superseded by F15. |
| E05 — OCTO MPA webinar | Existing row gained the missing 16:00 UTC clock; OCTO host/IDDRI presenter correct. Reviewer separately verified October 8, 2026 on the linked Zoom registration. The model requested no follow-up. |
| E09 — CBD session | No capture; ambiguous `url_unreadable` requires F14 diagnosis. Existing duplicate and organization lookup remain unresolved; identity repair is not demonstrated. |
| A01 — HSA recap | Correct October 2 publication, HSA publisher and reported 101 ratifications. **Relevance gap:** it asserted officially verified ratifications/High using the NGO article alone. |
| A02 — IDDRI policy brief | Existing publication repaired: three people replaced by IDDRI publisher; March 2026 precision preserved. The earlier separate PrepCom event with the wrong end date was not revisited. |
| A03 — IUCN blog | **Record selection under review (F13):** returned a preparatory-meeting event rather than the publication announcement; omitted March 24 publication/publisher. The user considers the event much more valuable than the announcement, so this may be an acceptable selection. Event identity and possible duplication of PrepCom3 still need review. |
| A04 — IUCN CHM brief | Correct publisher; generic Secretariat removed; publication date left unknown. |
| A07 — UN notification | No capture; ambiguous `url_unreadable` requires F14 diagnosis. Existing omitted issuer remains unresolved. |
| A09 — Ai2/GFW | Correct September 23 publication and both partner organizations. The former oversized input now works. |

Independent review used the frozen source-backed expectations plus fresh reads of E04, A01, A03 and the E05 Zoom companion. Saved names and dates are not scored by the model itself. “Passed date/organization checks” allows source-supported unknowns (E03/A04); it does not mean every optional field is populated or all identity/native-ID requirements are proven.

**Remaining work:** diagnose the three ambiguous URL failures with the F14 comparison before deciding whether to add an in-memory text fallback; clearer primary-publication versus background-event framing; ranked associated organization names without role labels (F15); separation of official verification from NGO reporting; and a live follow-up test. No response requested a follow-up link, so the second-call enrichment path is proven locally only. Do not add proof wrappers, per-site extraction patches or a capture archive to address these. Prior bad provisional rows were preserved, not silently deleted or counted as repaired.

Implementation removes 584 net lines before this results write-up (plus the unused old rubric module). All 247 local tests and the frontend build passed; the frontend asset is unchanged. The deployed source revision is recorded in `.cache/scout-refactor/oct12-url-release.json`; the baseline remains `oct12-evaluation-results.json`, and the new evidence is `oct12-url-evaluation-results.json`, `oct12-url-review.json`, and `oct12-url-unchanged-check.json`. The immutable manifest remains `oct12-evaluation-manifest.json`.

## Implemented design and pre-test budget — URL intake (October 12)

User-approved replacement: send the complete user rubric and source URL to Gemini URL Context with a small API JSON schema. Save partial findings on the first response; optionally read up to three links explicitly requested by the model in one improvement call. No prepared source packet, mandatory second pass, field citation wrappers, or stored model/source traffic. Optional invalid fields become unknown; prose is truncated. Preserve human corrections and existing record IDs where identity is established.

Budget before implementation: at most two generations per source, 24 across the same frozen twelve-case manifest, no automatic retries. Reserve 60,000 input tokens per call (including unknown URL retrieval), settle actual prompt + tool input; output at most 8,192 tokens. URL Context has no pre-retrieval hard input-token cap: halt subsequent calls on reservation overrun and report it. Keep the 125,000/minute Scout ceiling and actual shared quota checks. Expected normal one-finding first capture: approximately 15–25 SQL statements, 7 row mutations, 2–5 KiB useful retained record/links/state; improvement adds approximately 10–15 statements and 3–5 mutations. These are estimates, not measurements. No histories, new tables or recurring jobs. Recurring activity remains zero until reviewed.

Acceptance: same twelve URLs and frozen source-backed facts; separately report useful capture, correctness of dates/organizations, improvement, duplicates, provider/access failures, model tokens, SQL mutations, retained bytes and attributable statement WAL. First verify one deployed case before expanding. Preserve previous baseline and all useful records; do not clear earlier provisional findings. Completed unchanged inputs use a compact fingerprint and make zero model calls or finding writes. Partial capture is successful with pending research; finite retries and changed-input recovery remain separate from missing optional facts.

This supersedes earlier strict two-pass architecture and F02 packet-pruning proposals. Funding production collection and unattended operation remain outside this run.

## Previous baseline — before URL intake

Baseline status (12 October 2026): collector v134 at 75eb95d is deployed and the authorized twelve-source production test is complete. Acceptance FAILED: 0/12 completed intakes; five attempts saved seven provisional rows with missing facts, incorrect entities/dates and a confirmed duplicate. All original 71 records and human overrides were preserved. Production now has 78 records and uses 14,096,051 database bytes. Collection, notifications and the model policy remain disabled. Persistence costs were small in this bounded test, but reliable date/organization recovery and identity matching are not solved. The separate Supabase access chat contains replacement-token settings and a verification command; organization-wide usage was not verified by this test.

The current manual evaluation permits one invocation per fixed source, at most two generations each and twenty-four total, at two generations per minute. Refresh actual Google limits and shared usage before opening each short model window; preserve all quota charges and measure SQL mutations, retained bytes and native PostgreSQL WAL. Score technical completion separately from correct dates, organization names and roles, and keep failures in the denominator. No prompt tuning or retries between sample cases, source/model archives, recurring work or notifications. The frozen sample and numeric reader preflight are `.cache/scout-refactor/oct12-evaluation-manifest.json` and `oct12-source-preflight.json`; this sample does not establish treaty-status or held-out reliability. This authorization supersedes the earlier one-record limit and deployment hold below.

## Failure tracker — capture partial records, then improve them (12 October)

User-requested direction: **read → extract useful partial records and requested links → normalize and save → investigate requested links → update those same records**. Missing dates or organizations do not prevent capture. Organizations become ranked associated names without role labels under F15, superseding organization-role requirements elsewhere in this plan. Automatically shorten overlong prose and fit source input to the verified model budget. Preserve complete URLs, identifiers and structured dates; never truncate them into invalid values. Keep factual correctness separate from record completeness.

This is the current proposed direction and supersedes conflicting requirements below that make final completeness a prerequisite for successful capture. Checked items have implementation or diagnostic evidence; unchecked items remain open. Check an item only when its acceptance result has been demonstrated, and record the relevant commit and concise test result here. Partial capture alone does not resolve factual mistakes or duplicate creation.

- [x] **F01 — Strict record structure rejects useful output.** Existing code can reject an entire response for missing wrappers, extra keys or mismatched check arrays; exact live rejected fields are not known. **Proposed fix:** simplify extraction fields, normalize predictable variations, ignore extra keys, and validate optional fields and sibling records independently. **Acceptance:** a malformed optional field or sibling cannot discard an otherwise useful record; missing optional fields are accepted.
- [x] **F02 — Source input exceeds the configured allowance.** E03 and A09 failed input-token preflight before generation. **Proposed fix:** remove repeated navigation and duplicate material, budget the complete request including instructions and metadata, and truncate at section boundaries when necessary. Preserve useful metadata and candidate links; record partial coverage so unread material is not treated as absent information. **Acceptance:** both sources produce useful partial records inside the verified token limit without raising the allowance; retain the numeric rejected count if a preflight still fails.
- [x] **F03 — Overlong record prose is rejected.** Length checks exist for titles, understanding and explanations; descriptions may be dropped. This mechanism is confirmed in code, but is not a proven cause of either live output failure. **Proposed fix:** truncate prose to its field limit at a sensible boundary and repair invalid text encoding locally. Keep complete structured values or leave the affected field unresolved. **Acceptance:** an overlong title/description/explanation does not lose the record or valid sibling fields; stored text respects existing bounds.
- [x] **F04 — Malformed/interrupted output or final validation prevents saving. Closed by user on 12 October.** The old contract's E04 output-processing failure and A03 final-validation failure are preserved as historical results. The replacement URL/structured-partial contract saved output for both; the latest full twelve-source run reported no malformed-JSON/final-validation failures. E04 also passed the later live organization-name check at `663c8cb`. Local workflow tests show failed improvement preserves the already saved record; adapters reject invalid/incomplete output instead of inventing facts. Gateway `7110843` covers provider failure boundaries locally. F04 is addressed by the response redesign and requires no separate recovery workstream. Ordinary interruption/cooldown/accounting behavior remains under F10/F12; A03 selection remains F13. This closure does not claim interruptions are impossible or that gateway live recovery is proven.
- [x] **F05 — Missing important fields are treated as failed intake.** Five attempts saved seven provisional rows but returned unresolved research. **Proposed fix:** save supported known fields immediately, leave unknown fields empty, and report capture and pending improvement separately. **Acceptance:** a useful record missing date or organization is a successful partial capture, while the missing field remains visible and eligible for bounded research.
- [ ] **F06 — Optional model-requested research and useful follow-up. Open.** The latest twelve-source URL run requested no links; zero requests alone is not a failure. `4f48ef2` implemented an explicit decision, but the user subsequently rejected mandatory research decisions and explanations for declining research as unnecessary constraints. **Current direction:** save useful records without those requirements; let the agent request research only when it considers it necessary to understand the event/announcement. A request can state a question without a known URL. Fetch only model-requested links; never invent one or crawl automatically. **Evidence:** the one real E05 test returned a correct-looking year without reading the linked registration and declined research; useful linked-fact recovery is unproven, with factual support reviewed under F07. **Acceptance:** optional metadata cannot block capture, useful requested research improves the same record, and failed research preserves the partial. Keep honest unknowns when sources do not establish a fact. Further work belongs to the existing F06/F11 chat; its proposed relaxation is not yet implemented.
- [ ] **F07 — Factual support and meaning. Pending focused review.** The new intake repaired A02's people-as-organizations and E05's omitted clock. A07's issuer cannot yet be reassessed because URL retrieval fails. The earlier separate PrepCom event's April 1 rather than April 2 end date remains unrepaired; this is not proof the new contract repeats that error. Current observed concerns are A01 treating an NGO ratification report as official verification and the single-case E05 test supplying an event year without demonstrated supporting retrieval. **Next:** distinguish supported facts from model inference and existing bad rows before changing extraction. Independently verify targeted dates/names and rubric authority; preserve useful facts and honest unknowns. Roles are not required or scored. Do not add a mandatory validation generation for every record.
- [ ] **F08 — Duplicate identity. Pending focused verification.** The old run duplicated CBD E09 under a different API query; the later URL run could not retrieve it, so duplicate behavior through the new intake is untested. The old canonical-validation conflict is historical. **Next:** test equivalent URLs/native session identity against the current matching path before choosing a change. **Acceptance:** repeated/equivalent inputs enrich the same session while genuinely distinct occurrences remain separate. Preserve ambiguity rather than making unsafe merges; existing duplicate cleanup is separate from proving prevention.
- [ ] **F09 — URL retrieval recovery. Open; live test blocked.** Current failing sources are E02/E09/A07; A01's earlier local/production mismatch no longer describes the latest run. F14 identified explicit Gemini retrieval errors. Gateway `7110843` implements a bounded alternate reader/provider path and has mocked/local proof. Configured OpenAI keys returned 401, so none of the three has live OpenAI recovery evidence. **Acceptance:** independently demonstrate reading the requested page and extracting supported useful facts, then verify the deployed integration separately. Failed reads preserve records and never count as successful extraction. No repeated unchanged Gemini diagnostic loop.
- [ ] **F10 — Temporary provider failures within gateway integration. Open validation.** E01's old 503 was an upstream failure; it later captured successfully. Current finite attempts, cooldowns, shared allowance and uncertain-charge protection have local coverage, including gateway tests. **Remaining:** verify those behaviors in the integrated provider path without exceeding the allowance or losing saved partials. Recovery may use only remaining authorized attempts; no guarantee of provider availability, separate retry engine or automatic budget expansion is required.
- [ ] **F11 — Finite handling of optional requested research after partial capture. Open; locally implemented.** `4f48ef2` tests finite pending/exhausted research, unchanged parked checks, changed-source/manual reopening, and record-ID/human-override preservation. Gateway attempts share the existing two-generation allowance. These mechanics have local proof; live requested improvement has not occurred. **Remaining correction:** align with the user's optional research direction under F06; absent research metadata or missing optional record fields must not create a new required-decision failure. Keep actionable questions visible without hot retries, inventing sources, growing histories or new recurring jobs. Preserve useful partials when follow-up fails; completed unchanged work remains free of model calls/finding writes. No deployment or unattended acceptance is implied by local tests.
- [ ] **F12 — Failure boundaries and diagnostics. Open, partly implemented.** F14 now exposes Gemini retrieval metadata separately from model answers. Gateway `7110843` distinguishes provider authentication/rate/transport, incomplete/refused output, bounds and source-reader errors in local tests. **Remaining:** integrated live proof and a narrow review of unexplained field loss. Deliberately normalizing an invalid optional field to unknown is not itself failed capture. Use compact stage/field codes and numeric counts where they answer a concrete diagnostic question; do not build source/model archives or a tracing system.
- [ ] **F13 — Announcement containing an event: which development should Scout capture? (A03 — IUCN)** The [IUCN blog](https://iucn.org/blog/202603/entry-force-action-why-moment-high-seas-cannot-be-missed) is a publication/announcement containing a preparatory meeting. Gemini saved the event instead of the publication expected by the test. **User assessment:** the announcement is low value and the event is very high value; this selection may be appropriate and needs exploration, not an automatic correction to announcement type. **Investigation:** decide when to capture the event, the publication, or both based on their substantive value; distinguish the page's format from the development's type. Verify the selected event's identity, supported dates/organization roles, rubric priority and possible PrepCom3 duplication. Relative value alone does not establish the rubric's High category. **Acceptance:** review this case and agree on a general selection rule and corresponding test expectation that preserve the more useful development without inventing facts or duplicating a meeting. Keep the original evaluation results intact and report any revised assessment separately. No prompt or production change is authorized by this documentation update.

- [x] **F14 — Ambiguous Gemini URL access failures (E02, E09, A07).** Scout collapses missing retrieval metadata, explicit retrieval failure and the model's own `unreadable` answer into `url_unreadable`; all three sources were directly readable. This is a specific F09/F12 investigation, not proof that Gemini attempted and failed to fetch each page. **Diagnostic comparison before any fallback:** (1) return the existing per-URL retrieval metadata/status, metadata presence, finish reason/message, prompt feedback, response ID, model version and separate token counts independently of the model's answer; (2) repeat each of the three failed requests once with the same URL, model, prompt and schema; (3) if one returns missing metadata, compare that case with a minimal URL-reading request to test whether request configuration affects tool use. **Bounds:** at most four generations, at two per minute within freshly verified shared quotas and existing charge accounting; no automatic retries or finding writes. Return compact diagnostics without retaining source bodies, prompts, model answers or a new log history. **Acceptance:** distinguish provider retrieval status from absent metadata and model-reported unreadability, report the comparison and remaining uncertainty, then choose the fix from that evidence. Generic provider `ERROR` alone does not establish an origin HTTP error or its cause. Completed comparison and remaining F09 retrieval work are recorded at the top of this plan.

- [x] **F15 — Ambiguous organization roles create unnecessary classification failures.** Replace host/speaker/participant/publisher and other role labels with a **ranked list of associated organization names, without roles**. E04 correctly identified IDDRI but failed the old test solely because of its role label; that distinction is no longer a defect to solve. **Proposed change:** carry an ordered list of names through the prompt, response schema, normalization, persistence and display, with the most directly associated organizations first. Preserve useful names and human corrections; exclude people, products and unrelated organizations. Do not add numeric ranking scores or an organization-role taxonomy. **Acceptance:** multiple associated names retain their order through intake and display; ambiguous relationships do not reject or downgrade a finding; neither output nor UI requires role labels. Update future tests to assess associated names and preserved ranking, while retaining the original evaluation as historical evidence. Implemented and verified locally and on live E04; see the current checkpoint above.

Normal processing remains capped at two generations: extraction, then improvement. A transient retry consumes that allowance instead of extending it. Save useful facts and URLs, discard source/model material, update only changed findings, preserve human overrides, and keep recurring collection/notifications paused until reviewed. Measure model calls, all SQL operations/mutations, retained bytes and WAL before expansion.

Evaluate fixes with separate **capture**, **factual accuracy**, and **improvement** scores. Target twelve useful captures from the fixed twelve-source set after bounded recovery, not twelve URL-only placeholders. An honest missing field can be an accepted partial capture; a wrong populated field is still a defect. Track date/organization recovery separately and keep infrastructure failures in the reported denominator.

### F02 source references and known input sizes

| Case | Source and intended record | Prepared text / model packet bytes | Supplied links |
| --- | --- | --- | --- |
| E03 | [High Seas Alliance webinar recap](https://highseasalliance.org/2026/10/01/what-marine-genetic-resources-mean-for-the-high-seas-treaty/): extract the Marine Genetic Resources and Digital Sequence Information webinar and HSA host. October 1 is the article publication date; the main article does not establish the webinar date. | 20,252 / 45,058 | 50 |
| A09 | [Ai2 / Global Fishing Watch partnership announcement](https://globalfishingwatch.org/press-release/ai2-and-global-fishing-watch-unite-to-bring-ai-agents-to-ocean-monitoring/): capture the partnership, September 23 publication and the two organizations. | 21,336 / 49,442 | 70 |

These are local reader-preflight measurements, not retained production requests or model-token measurements. The packet includes source blocks, link labels/context and metadata; system instructions add further input. Both production attempts failed the configured 16,000-token preflight; the exact rejected counts were not retained. The 16,000 values in reservation accounting are placeholders, not proof of actual request size. No generation or supporting-page fetch occurred for these two cases.

The current output contract remains in `collector/finding-contract.js` (`FINDING_INSTRUCTION`, `EXTRACTION_INSTRUCTION`, `REVIEW_INSTRUCTION`); response and whole-finding rejection gates are in `collector/finding-jobs.js`. This tracker does not change those instructions. Factual review compares saved final fields with the source pages; it is separate from the collector's own model/checks. Source citations prove a value was wrong or omitted, but discarded intermediate traffic means they do not establish whether a particular error arose during model extraction, normalization or field rejection.

## 12 October production intake results

Ran the twelve fixed development targets from 13:35–13:49 UTC against the deployed manual endpoint, using the same committed prompt/model throughout. No case was retried. All twelve primary sources were readable locally before dispatch. This measures production intake of selected URLs, not broad discovery, a held-out benchmark or a paired rerun of the old pipeline. The selected targets were six events and six announcements; the model also emitted an additional treaty-status row.

**Full end-to-end success: 0/12 (0%). Attempts that saved some output: 5/12 (41.7%).** Saved rows are not equivalent to correct records. None of the original missing fields was repaired: all 71 original rows remained unchanged. The seven additions comprise three events, three announcements and one treaty status. They remain provisional for review, including the erroneous/duplicate rows; this evaluation did not delete or silently correct them.

| Case | Target | SQL operations / row mutations | Result and independent finding |
| --- | --- | --- | --- |
| E01 | HUB Ocean AI-agents webinar | 21 / 20 | No finding. Google returned HTTP 503 for generation; source read and token preflight succeeded. Google request telemetry independently confirms the 503. Mutations include expiration of 14 settled prior-day quota rows. |
| E02 | HSA Clearing-House webinar | 9 / 2 | No finding. Deployed source read/preparation failed, although the local reader succeeded. Exact remote HTTP/TLS/body failure is not exposed. |
| E03 | HSA marine genetic resources webinar | 15 / 4 | No finding. Input-token preflight refused the request before generation. The exact rejected token count is not retained. |
| E04 | IDDRI Making MPAs work | 31 / 8 | No finding. Both generations were attempted; the final response failed the adapter's STOP/JSON parsing check. The precise finish/parsing failure is not exposed. |
| E05 | OCTO Designing High Seas MPAs | 40 / 11 | One partial event: date value, OCTO host and IDDRI participant match expectations. Explicit 16:00 UTC is missing. No registration support was requested to establish the event year independently of publication metadata. Identity remains unresolved. |
| E09 | CBD/DOALOS synergies session | 40 / 11 | Correct UTC start/end, but no organizations. Created a duplicate of an already dated event. The manual JSON path omitted native organization-reference links. |
| A01 | HSA UNGA/Climate Week reflections | 9 / 2 | No finding. Deployed source read/preparation failed despite local readability. Exact cause unavailable. |
| A02 | IDDRI PrepCom3 policy brief | 46 / 15 | Two rows. Publication month is correct, but three individual authors were saved as organizations and IDDRI was missed. An extra meeting row ends April 1 instead of the source's April 2; the UN General Assembly's mandate was treated as organizer evidence. An existing PrepCom3 row also warrants duplicate review. |
| A03 | IUCN From entry into force into action | 31 / 8 | No finding. Both responses parsed as JSON, but final finding/check validation failed. The generic error code does not identify the rejected field. |
| A04 | IUCN Clearing House brief | 40 / 11 | One provisional announcement: IUCN publisher recovered, date left unknown, generic “Secretariat” also stored as an organization. Linked brief was not requested; identity unresolved. |
| A07 | UN notification 2026-001 | 45 / 14 | Publication and response dates are correct, but the explicit DOALOS/OLA/UN issuer is missing and “Parties to the BBNJ Agreement” was stored instead. Extra treaty-status row has the correct effective date but lacks authority. Both unresolved. |
| A09 | Ai2/GFW partnership | 15 / 4 | No finding. Input-token preflight refused the request before generation. |

The aggregate categories are one provider failure, two source-read failures, two input-bound failures, two output-validation failures and five unresolved research outcomes. All seven attempts that reached the final model pass used no supporting documents, despite available links and missing information. This test therefore provides no successful demonstration of model-directed follow-up research.

The important source comparisons are the [OCTO webinar](https://octogroup.org/designing-high-seas-mpas-that-work-practical-solutions-for-monitoring-control-and-surveillance/), [IDDRI brief](https://www.iddri.org/en/publications-and-events/policy-brief/third-bbnj-agreement-preparatory-committee-smooth-sailing-cop1), [IUCN brief](https://iucn.org/resources/information-brief/brief-clearing-house-mechanism-bbnj-agreement) and [UN notification](https://www.un.org/bbnjagreement/en/notification-2026-001). The fixed expected facts and review notes are in the compact manifest/result files, without source bodies or quoted proof trails.

### Measured usage

| Measure | Result |
| --- | --- |
| Provider requests | 17 countTokens requests; 15 generation requests: 14 HTTP 200 and one HTTP 503, confirmed by Google telemetry |
| Model allowance | Actual verified project limits: 500 generations/day, 15/minute, 250,000 input tokens/minute; billing disabled. Test used 3% of daily generation allowance, below its 24-generation cap and two/minute limit. |
| Input accounting | 134,041 conservative ledger tokens, including two 16,000-token placeholders for failed preflights. Removing those placeholders leaves 102,041 input tokens accounted against generation attempts, including the rejected request. These are not billed-token measurements. |
| Output accounting | 15,658 recorded candidate-output tokens; separate thinking-token totals are not retained by the adapter. Google input telemetry is delayed and differs from conservative ledger accounting. |
| Collector SQL | 342 counted operations, including stored-function work; 28.5 per attempt, maximum 46, within the 96-operation invocation bound |
| Collector row mutations | 110: 24 source claim/finish updates, 49 quota mutations, 7 record inserts, 7 source associations, 8 identities, 14 expired settled reservations and 1 provider cooldown update. No existing record updates. |
| Manual evaluation overhead | 25 additional control mutations: policy on/off for each case and one existing-source due-time update. The measurement harness adds 204 SQL statements for bounded reads/control, plus one failed read-only readiness check and separate reviewer reads. These are outside recurring collector cost. |
| Collector SQL transport | 67,826 submitted bytes and 36,295 result bytes; excludes source/model HTTP traffic and manual review traffic |
| Attributable WAL | 207,552 bytes (about 208 KB), summed from per-statement PostgreSQL deltas during invocations; includes the bounded quota cleanup |
| New findings + URL/identity metadata | 22,409 logical JSON bytes across seven new rows: about 3.2 KB each. This is storage per saved row, not per successful intake. |
| Operational state | Source-state logical size increased 9,153 bytes; total net logical growth across the five measured tables was 32,258 bytes, including quota expiration |
| Physical allocation | Measured tables/indexes grew 65,536 bytes. Whole database grew 131,072 bytes, from 13,964,979 to 14,096,051 bytes. Page allocation and other database activity prevent treating this as exact marginal record size. |

The cluster LSN moved 16,934,952 bytes during invocation windows. **LSN movement is not physical WAL write volume**: it includes other activity and can include segment-switch padding. This server uses 16 MB WAL segments and a two-minute archive timeout. Use the separately measured Scout statement WAL above for attribution; the remainder is not attributed to Scout by this test. Supabase organization-wide egress/Edge/API usage remains a separate access check, and this run does not establish sustainable unattended throughput or disk-I/O rates.

Final readback: 78 records, all four Scout cron jobs inactive, model policy disabled, 17 settled current-day quota rows, zero unsettled reservations and zero uncertain charges. No notification was requested. No source bodies, prompts, model responses or replacement tracing history were persisted. Numeric results and saved-field projections are in `.cache/scout-refactor/oct12-evaluation-results.json`; provider counts and final state are in `oct12-provider-http.json` and `oct12-final-state.json`.

### Findings that block acceptance

1. **Identity handling is inconsistent.** A zero-model-call reproduction shows that `validateFinding` accepts a canonical URL using the document URL plus a title citation, then rejects the same canonical identity unless the URL is literal in the citation. Several live rows have unresolved identities, although discarded model citations mean this is not proof of each individual cause. Identity matching also missed the same CBD session under equivalent API queries: new `c85c8858-d911-4cd6-9cbf-ef011ccefc4f` duplicates existing `43350177-2783-4b65-9094-cccd3f4257f1`, with identical title and UTC schedule. Native identity and reference handling must be consistent before creation.
2. **The manual/native input paths differ.** The manual endpoint passes no native source task to `prepareResponse`; CBD JSON becomes plain text, losing the structured reference metadata used to offer organization lookup links. The prepared CBD packet had zero links. Other inputs failed the token gate or cloud reader despite local readability. These are ingestion-boundary issues, not reasons for more date-specific rules.
3. **Syntactic citations did not ensure factual meaning.** People passed as organizations, an explicit issuer was missed, a date range was wrong, and an explicit clock was labeled unpublished. The model's own completion checks did not prevent these errors. A filled date/organization column cannot serve as the success metric.
4. **Failure reporting is too coarse.** Source failures collapse into `inaccessible_source`; response finish, JSON syntax and finding-shape failures are partly conflated. Future diagnostics should expose only compact error codes and numeric rejected token counts, never page/prompt/response dumps. Exact missing causes remain unknown here rather than being guessed.

Decision: keep recurring work disabled. The bounded persistence behavior is substantially smaller than the former report-write loop, but this run does not demonstrate reliable improvement in record intake. Address the shared input/identity and factual-output boundaries, then repeat a fixed comparison within a fresh verified allocation. No further implementation, prompt changes, retries or content cleanup were performed as part of this measurement.

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
