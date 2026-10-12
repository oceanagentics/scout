# Undated event intake evaluation — 12 October 2026

## Result and scope

Fixed denominator: **32 original undated event IDs**, including concurrent F06/F11 saves. **8/32 (25%) now have starts; 6/32 (18.75%) have supported starts; 24 remain undated and 2 have unverified dates.** Ten originals changed: eight gained starts and two were otherwise updated. Twenty-two original rows stayed unchanged.

The new deployed run processed **17 unique URLs for 18 originals**, using 17 Gemini generations. It updated five originals: three gained dates, but only the SIDS4 recovery is independently verified; two gained other fields. It also updated one existing treaty row and added two records. Reused overlap: 12 direct Gemini cases, with two additional originals sharing those URLs. No duplicate calls for those inputs. Total credited evaluation: **29 primary inputs / 29 generations**, within the 32-input/64-generation ceiling.

Supported starts comprise **four model-extracted dates** (three overlap, one deployed) and **two independent reviewer corrections** from the overlap. Among eight original-record date proposals across the model calls, **4 were supported, 2 were wrong, and 2 remain unverified**: a strict supported-date pass rate of **4/8 (50%)**. Missing dates remain in the 32-record recovery denominator; they are not date-accuracy attempts. Unsaved ambiguous output is not exposed by the route and cannot be scored. The additional forum's rejected date is outside this original-record accuracy count.

No runtime edits, deployment, manual finding correction, deletion, merge, notification or recurring activation occurred in this chat. All original IDs, prior source URLs/identities and human overrides are preserved. Final database: 106 records, 14,259,891 bytes. Both provider policies are disabled; active Scout jobs and leases are zero.

## Method and attribution

**D** = current deployed URL-only intake, collector **v139**, Gemini `gemini-3.5-flash-lite`, 16:22–16:47 America/Kralendijk. Version and local contract hash stayed fixed across all 17 invocations and final verification. One associated source per original initially, deduplicated; individual UN programmes/flyers were selected from existing canonical URLs instead of repeating the shared index. The full prompt/schema was unchanged, without date hints or per-case tuning. Native source metadata was reused when present; matched selected states had no native ID.

**O** = the completed [F06/F11 evaluation](f06-f11-plan.md), which used direct Gemini calls with original-event context, followed by reviewed manual saves. It proves those returned facts/research decisions, **not deployed identity matching**. **S** = that same URL was tested for a different original; no second call was made. **R** = independent reviewer correction in that other chat, never credited as model extraction. Its expressly authorized diagnostic artifact was left untouched.

Base prompt SHA-256: `c7762b8a412945a9729f14ec27892b36f46d30bfbb072dccce16c0fed26f2763`; schema: `06af2be6b8b9e2a7b3397a710e90b0e115d0ba5ed26374f40c316188499926a0`; workflow: `bbb374c094603b7140890d67f51dc920ee5152343bfb21cd4089f1556f02faaf`. These match the overlap's base files, but its additional original-event context differs.

The IUCN pilot saved within budget but exposed a type/identity concern (B below). Persistence/accounting checks passed; the frozen evaluation continued without correcting that output. One ingress attempt returned 401 before any model call; the existing vaulted backend key fixed invocation. That attempt reopened only original 32's source once. Other new sources were not reset globally. Completed-state skips were not counted as unchanged-content checks.

Both queued chats were given priority. When the gateway resumed, preflight stopped this sequence before dispatch, and its charges/windows were preserved. Gateway runtime OpenAI authentication remained blocked; its $0.10 allocation was not reused. This chat made **zero OpenAI calls**. Its six Gemini retrieval failures end with route reason `provider_budget` because fallback is disabled; the transient attempt diagnostics correctly identify `url_retrieval_failed`.

## Per-original outcomes

“none/0” means no observed follow-up question and zero follow-up generations; it does not imply an explicit “no” decision. “n/a/0” means retrieval/provider failure prevented a meaningful research judgment. All 29 inputs requested/used zero follow-ups. O had seven explicit declines, two readable omissions, two unreadable responses and one 503.

| # | Original ID | Original title | Primary source | Path | Result / independent check | Follow-up |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 25eb65f7-e6e8-4eb1-9cb9-d4e790e6a735 | Celebrating the Entry into Force of the High Seas Treaty | [source](https://bsky.app/profile/did:plc:mj2ygegzodk3fdjdgihjko23/post/3mclxgtna532f) | D | Unchanged/undated; existing treaty row updated instead (T below). | none/0 |
| 2 | 43c2cf60-4ff6-470b-bd2e-1bbabfdf4b9b | DOOS Deep Ocean Collective Solution Accelerator meeting | [source](https://bsky.app/profile/did:plc:d2kekyg6gt42ubsdap53shlf/post/3mvb5hoz66v2s) | O | Unchanged; model found DOOS but no supported date. | none/0 |
| 3 | 2b03d323-f81d-4a2f-99da-558bf956513c | DOSI BBNJ town hall | [source](https://bsky.app/profile/did:plc:d2kekyg6gt42ubsdap53shlf/post/3mvb5hoz66v2s) | S | Undated; shared test returned only DOOS. DOSI-specific selection/matching unproven. | none/0 |
| 4 | 629c71e1-5692-4760-93d0-6df45cac391b | Third United Nations Conference on the Ocean (UNOC-3) | [source](https://www.iddri.org/en/publications-and-events/billet-de-blog/third-united-nations-ocean-conference-commitments-be-turned) | S | Undated; shared IDDRI input failed retrieval. | n/a/0 |
| 5 | f0e4d1ba-dd40-472a-9a9b-6b5b7eb81c99 | 11th Our Ocean Conference | [source](https://iucn.org/news/202606/iucn-and-partners-convene-ocean-leaders-advance-ocean-action-ahead-africas-first-our) | O | Date recovered: **2026-06-16**, supported by IUCN chronology. Manual save of model fact. | none/0 |
| 6 | f8a5654a-07d8-4599-bbda-aace07ea36e8 | Devex Impact House @ UNGA81 | [source](https://bsky.app/profile/did:plc:2uyb5qno7evcal62puikbs3a/post/3mwvrkmiclk2a) | O | Unchanged; date unknown. | none/0 |
| 7 | 4b89af64-1aaf-4572-b261-6d0fb6d1b0d3 | 3rd “Let’s Talk BBNJ” webinar | [source](https://bsky.app/profile/did:plc:mj2ygegzodk3fdjdgihjko23/post/3meykgfnfgn2q) | D | Updated same ID: online location, title/unknowns; start still unknown. | none/0 |
| 8 | 6f35fc89-db5f-43e7-8bad-7acf710f1a28 | BBNJ Agreement Presentation and Simulation | [source](https://bsky.app/profile/did:plc:sm42lcgzux3f7c7hpb7jn7m6/post/3mwvgavy4nc2p) | D | Saved **2026-10-02**, **unverified**: matches post publication; thread gives 2026 but no explicit calendar day. | none/0 |
| 9 | a6f3b5ff-fa35-4811-bd31-c8052ded6f82 | Our Ocean Conference (OOC) | [source](https://globalfishingwatch.org/press-release/at-u-n-ocean-conference-panama-and-global-fishing-watch-forge-landmark-partnership-to-boost-ocean-protection/) | D | Retrieval ERROR; unchanged. Reviewer read supports **2025-04**; not written. | n/a/0 |
| 10 | 8b1a03ba-a3c5-4aba-9517-456631405dbc | first meeting of the COP of the BBNJ Agreement | [source](https://highseasalliance.org/2026/08/01/my-broken-voice-and-the-ocean/) | D | Saved **2027-01**, **unverified year**: source says January; the supplied source does not establish the year. | none/0 |
| 11 | f825426e-a9e0-49b5-aaeb-6b59455e817e | Webinar on BBNJ Clearing House Mechanism | [source](https://highseasalliance.org/2026/09/07/call-for-expression-of-interest-for-webinar/) | O | Unchanged; date unknown despite explicit no-research decision. | none/0 |
| 12 | 68a52b08-b15c-44dd-a485-1bb4ff8d59a6 | first BBNJ Preparatory Commission | [source](https://highseasalliance.org/2026/08/09/dont-just-celebrate-indigenous-peoples-listen-to-them/) | D, shared 13 | Unchanged/undated; new advocacy publication A below captured instead. | none/0 |
| 13 | 0070041c-6d5e-4de9-862b-1cf8f3274bca | The first BBNJ Conference of the Parties (BBNJ COP1) | [source](https://highseasalliance.org/2026/08/09/dont-just-celebrate-indigenous-peoples-listen-to-them/) | D, shared 12 | Unchanged/undated; January mentioned without an explicit year. | none/0 |
| 14 | e1793179-0df6-44dc-9fa1-bc2cc206ac84 | The BBNJ Agreement as a catalyst for action to achieve SDG14: Looking ahead to opportunities and challenges for effective implementation | [source](https://www.un.org/bbnjagreement/sites/default/files/2025-06/Flyer_BBNJ%20side%20event%E2%80%93%202025%20United%20Nations%20Ocean%20Conference_2.pdf) | D | Retrieval ERROR; unchanged. No independently confirmed date. | n/a/0 |
| 15 | 84c1a90e-00e2-4da1-ab66-6c1a92a46226 | Synergies between fisheries instruments and the BBNJ Agreement | [source](https://www.fao.org/fishery/services/storage/fs/fishery/documents/COFI/COFI36/BBNJSideEventCOFI36.pdf) | D | Retrieval ERROR; unchanged. FAO programme supports **2024-07-10 12:15–13:15**, unzoned; not written. | n/a/0 |
| 16 | 4bbe2339-3fc4-47ab-b42d-19c1acaed206 | DOALOS activities to promote a better understanding of the BBNJ Agreement and prepare for its entry into force, as well as GEF enabling activities and ratification support | [source](https://www.un.org/bbnjagreement/en/capacity-building-and-technical-assistance/side-events) | O + R | Reviewer saved **2024-06-25 13:15–14:30**, unzoned. Model's June 24–26 parent-meeting range was wrong. | none/0 |
| 17 | 779895e2-105c-400c-a300-619c0fd3ff70 | Leveraging UNCLOS and the BBNJ Agreement in support of resilient prosperity in SIDS | [source](https://sdgs.un.org/sites/default/files/2024-04/SIDS4%20Side%20Events%20programme%20V26April2024.pdf) | D | Same-ID recovery **2024-05-28 13:30–15:00**, unzoned; visually verified against programme p.8. | none/0 |
| 18 | 2e4d9dbc-a950-47aa-af66-e2ce6e9c38ac | Stepping Together Toward Ratification and Implementation of the BBNJ Agreement | [source](https://www.un.org/depts/los/UNEA-BBNJ-Landscape.jpg) | D | Retrieval ERROR; unchanged/undated. | n/a/0 |
| 19 | d0fde105-2b0d-486d-8d48-6ae37f06a54f | The BBNJ Agreement and its Linkages with the CMS | [source](https://www.un.org/Depts/los/CMSCOP14BBNJSideEvent.jpg) | D | Retrieval ERROR; unchanged/undated. | n/a/0 |
| 20 | 2805f6b0-d008-41b8-87cc-7f4fc88561d0 | Leveraging the BBNJ Agreement in support of resilient prosperity in SIDS | [source](https://www.un.org/Depts/los/SIDS4PrepCommBBNJSideEvent.jpg) | D | Retrieval ERROR; unchanged/undated. | n/a/0 |
| 21 | 8e50c0b3-3636-49f4-9078-2cc7f626e2e5 | First BBNJ Symposium | [source](https://bbnjsymposium.org/) | O | Date recovered: **2023-10**, supported month precision. Manual save of model fact. | none/0 |
| 22 | e758c60a-c78a-42ac-b42c-6603a06103a0 | The 39th African Union Summit | [source](https://www.iddri.org/en/publications-and-events/blog-post/how-africa-repositioning-itself-disruptive-development-finance) | D | Readable; model returned no relevant findings under rubric. Original unchanged. | none/0 |
| 23 | f4bdef9d-f252-4f3b-b79f-4e8c4557ee54 | Preview screenings + Q&A | [source](https://bsky.app/profile/did:plc:d2kekyg6gt42ubsdap53shlf/post/3mvkhu7jko22v) | D | Identity ambiguous: preview and UK cinema events share source. No write/duplicate. Source supports **2026-09-23** previews; not written. | none/0 |
| 24 | 7af95a43-0021-437a-b98e-ca844aba3fca | Blue Earth Summit 2026 | [source](https://www.bluemarinefoundation.com/our-events/blue-earth-summit-2026-2/) | O + R | HTTP 503, then reviewer saved **2026-10-13–18**. Not model recovery. | n/a/0 |
| 25 | 670b10ed-6061-4be7-85b3-20708e0d4898 | ISA31 Part II | [source](https://bsky.app/profile/did:plc:d2kekyg6gt42ubsdap53shlf/post/3mrmnjkgflf2e) | D | Updated same ID, still undated. New title combines ISA31 participation and BBNJ side event; scope needs review. | none/0 |
| 26 | c6db2c8d-cffd-4aae-8574-2df3f8e89ecf | MOCSI/CliMetS thematic session at the 2026 IDSSD Global Conference | [source](https://bsky.app/profile/did:plc:d2kekyg6gt42ubsdap53shlf/post/3mqqnzwphux2a) | O | Date recovered: **2026-07-16**, supported by “happening today” and post timestamp. Manual save of model fact. | none/0 |
| 27 | c68fdfa8-5f73-481f-a622-1dc96cea327e | Meetings of the Council and Assembly of the International Seabed Authority | [source](https://www.iddri.org/en/publications-and-events/billet-de-blog/third-united-nations-ocean-conference-commitments-be-turned) | O | Retrieval failure; unchanged/undated. | n/a/0 |
| 28 | 5bc87e79-8e8d-4676-bad2-24629680e425 | The Digital Ocean Reshaping Ocean Governance through AI and Technology | [source](https://bsky.app/profile/did:plc:2uyb5qno7evcal62puikbs3a/post/3mwdsupqgag2b) | O | Unchanged; date unknown. | none/0 |
| 29 | 7ba92d04-b5a7-41cc-9e2a-04f7ba2835b1 | BBNJ PrepCom 3 | [source](https://us11.campaign-archive.com/?id=ef9c27f7dd&u=740487e7a7306085143176166) | O | Retrieval failure; unchanged/undated. | n/a/0 |
| 30 | 86c03462-12ad-498b-9e20-72aca7627491 | Regional Environmental Management Plan workshop for the Northwest Pacific Ocean | [source](https://bsky.app/profile/did:plc:d2kekyg6gt42ubsdap53shlf/post/3mmbdh5wqkb2r) | D | Readable; model found no relevant development under rubric. Original unchanged. | none/0 |
| 31 | 7e374f03-a9d7-4d45-8047-d967c362d4d5 | Let's Talk BBNJ Webinar: Unlocking Ocean Equity: What Marine Genetic Resources Mean for the High Seas Treaty | [source](https://highseasalliance.org/2026/10/01/what-marine-genetic-resources-mean-for-the-high-seas-treaty/) | O | Unchanged/undated. Model's **2026-10-01** was the article publication date; rejected by reviewer. | none/0 |
| 32 | 222ac309-44d5-4371-b012-5e1679747859 | First Conference of the Parties (COP1) to the High Seas Treaty Preparatory Meeting | [source](https://iucn.org/blog/202603/entry-force-action-why-moment-high-seas-cannot-be-missed) | D | Original unchanged/undated; new announcement B appears to duplicate its preparatory meeting. | none/0 |

The SIDS4 programme was read/rendered only in memory. Its page 8 conference banner explicitly gives 27–30 May 2024, its heading gives Tuesday 28 May, and the exact event row gives 13:30–15:00. The simulation's [parent thread](https://bsky.app/profile/did:plc:sm42lcgzux3f7c7hpb7jn7m6/post/3mwvg4z4kak2p) establishes the 2026 science session but no explicit day. Neither unverified saved date was manually changed. No timezone was inferred for either verified timed recovery.

## Added and other updated records

| Ref | ID | Outcome |
| --- | --- | --- |
| A | 43063a15-3874-495b-a41e-8190d5cec3bf | New HSA Indigenous participation/advisory-mechanism advocacy announcement; publication **2026-08-09** matches original 12/13's source. Appears to be a genuinely new publication, distinct from its background meetings; Low priority. |
| B | b352fc09-b15b-492f-8219-a32385b0a2a6 | New IUCN “Final substantive preparatory meeting…” announcement, published **2026-03-24**. Appears to duplicate original **222ac309-44d5-4371-b012-5e1679747859** across record types; also needs comparison with existing PrepCom3 rows. Preserved for review, not counted as a genuinely new development. |
| C | 4438443a-b938-419a-9713-726bb5691df9 | Overlap's new Regenerative Ocean Forum partial, Mombasa. Appears genuinely new; date and relevance remain unconfirmed after its review. Created by that chat's manual save, not this deployed path. |
| T | 11a8f089-57c5-4ff2-8d6a-695c57835048 | Existing treaty-status row updated from original 1's post; **2026-01-17** entry-into-force fact and both source associations retained. No new treaty duplicate. No claim that this previously dated row gained its date. |

Thus **3 added rows across the credited evaluation: 2 apparently new developments and 1 suspected duplicate**. This chat created A/B; the overlap created C. Existing duplicates were neither merged nor deleted. Original 23's ambiguous match prevented a write against the two different cinema/preview events sharing that source. Five D originals matched their existing IDs, although original 25's combined-event wording still needs semantic review.

## Measured cost and retained state

Fresh Google project checks before every window confirmed 500 generations/day, 15/minute, 250,000 input tokens/minute and billing disabled. Provider usage observations ranged from 89 to 107 (monitoring lags); each window also read the current shared ledger, database size, cooldowns, leases and stopped jobs. Scout remained at two calls/minute and 125,000 input tokens/minute, reserving 60,000 input per generation. Each three-minute manual window allowed at most two additional Gemini calls. All 17 actual generations settled; no uncertain charge was erased or retried.

| Measure | This chat's 17 deployed inputs | Reused 12-case overlap |
| --- | ---: | ---: |
| Gemini generations / OpenAI generations | 17 / 0 | 12 / 0 |
| Known input / output tokens | 117,002 / 4,421 | 67,912 / 3,730 |
| Uncertain reserved input | 0 | 60,000 (one 503) |
| Collector SQL statements / row mutations | 414 / 76 | Direct ledger: 73 / 25 |
| Scoped window controls, statements / mutations | 51 / 34 | 24 control updates reported |
| Instrumented per-window measurement reads | 195 | 28 reads reported |
| Separate reviewed production save | 0 | 6 SQL requests / 6 finding mutations |
| Finding JSON / source-state JSON / quota JSON net growth | 7,091 / 11,817 / 5,245 B | Prior owner reports 9,222 B final affected-record JSON, not net growth |
| Matching top-level intake SQL WAL | 289,934 B | Not measured |
| Sum of physical DB growth within input windows | 16 KiB | Prior owner: 8 KiB call phase + 24 KiB save phase |
| Retained source/model traffic by this chat | **0 B** | Separate user-authorized response artifact retained by its owner |

Credited calls total **29**, with **184,914 known input / 8,151 output tokens**, plus the overlap's 60,000 uncertain reserved input. Gemini's estimated paid cost is $0 with billing disabled; this is not an invoice measurement. No OpenAI spending allocation was opened here.

The rejected ingress check adds **3 control statements/3 mutations and 10 measurement reads**, zero model/finding writes, and -2 B source-state JSON. The table excludes additional read-only preparation, coordination and final reconciliation queries; it is not an exhaustive whole-chat SQL count. WAL covers matching top-level intake statements, excluding manual controls, and is not full-cluster WAL. Policy-row byte changes and billed SQL cost were not measured. Other chats operated between windows, so whole-database movement is not wholly attributable to this task. Actual shared account API allowance remains a limit on unattended acceptance; this manual result does not authorize it.

## Existing failure mapping / handoff

- **F06/F11:** zero requested investigations across all 29 inputs; positive live enrichment remains unproven. Optional missing facts or omitted research metadata did not block useful saves. No forced research or automatic repeat.
- **F07:** overlap's wrong DOALOS range and publication-as-webinar date; D's unverified simulation day/COP year; original 25's combined meeting/side-event scope. Keep these separate from supported recovery.
- **F08:** suspected new duplicate B; original 23 held ambiguous rather than written; five same-ID D matches demonstrated. Native-ID/equivalent-URL matching beyond these inputs remains unproven.
- **F09:** six D retrieval failures and two overlapping unreadable inputs, including the shared IDDRI URL. Do not infer an origin failure from provider metadata alone.
- **F10:** overlap's 503 retains its charge; this chat had no uncertain model call. Gateway's authentication blocker and allocation belong to its separate owner.
- **F12:** attempt diagnostics distinguish retrieval failure from the final fallback-budget reason. Unsaved ambiguous facts are unavailable for accuracy scoring; no tracing/archive system added.
- **F13:** meeting-vs-announcement selection at IUCN; valid new HSA publication, existing treaty update, and two readable no-relevant-finding results left the corresponding original events untouched. Review selection expectations without silently changing the cohort.

**Next review:** resolve B's identity and the two unverified saved starts; decide original 25's event scope; assess whether linked research should recover the explicitly noted remaining dates. Recurring collection and notifications remain paused pending review.
