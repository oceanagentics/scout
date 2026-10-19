# Scout outstanding work

Consolidated on 19 October 2026 from the previous plans and working documentation. These are acceptance gaps and deferred requirements, not authorization to start every workstream. Historical observations below need current record/source verification before repair; no live revalidation was performed for this documentation cleanup.

Current acceptance remains a correct saved record through the simplified pipeline within verified model and SQL budgets. Recurring collection, notifications and the stopped heartbeat remain paused until reviewed. Follow [AGENTS.md](../AGENTS.md); see [architecture.md](architecture.md) for the implementation that exists now.

## Source completeness

- [ ] Capture all distinct events and announcements on the sources below, including later programme sections, dynamic content and repeated scheduled occurrences. Compare independently identified developments with actual saved Scout records; HTTP success, valid JSON and the model's completeness claim are insufficient.
- [ ] Review the current eight-finding response cap and source/description identity against this requirement. Choose the smallest shared correction; tracker-specific prompts and a new extraction framework are not prescribed.
- [ ] Apply the existing shared High/Normal/Low rubric to each development. Low relevance must not silently suppress capture; missing dates/organizations must not lower priority. Keep uncertain facts and ratings unresolved.
- [ ] Prove one correct saved record first, then the small Pavilion programme, then GEO and ICRI. Include announcements, later entries, all four dated Daily Ocean Huddle occurrences, duplicate prevention and source-supported dates, organizations and URLs. Account for every omission or incorrect rating before declaring completion.

| Source | Historical observation from 12 October; re-read before testing |
| --- | --- |
| [ICRI COP17 programme](https://icriforum.org/meetings/cop17-events/) | 110 event entries were observed; output stopped around entry 91, before OA's workshop at entry 100. Embedded programme data matters. |
| [GEO COP17 pavilion](https://earthobservations.org/about-us/events/cop17/schedule) | Provider retrieval returned routing code despite the visible schedule containing 15 sessions and three other highlights. |
| [Ocean Pavilion](https://luma.com/COP17OceanPavilion) | Seven occurrences were observed; ordinary intake returned one. A capture-all diagnostic returned seven with a timezone error. This URL was not a configured tracker at that checkpoint. |

The handoff identifies [OA's workshop](https://luma.com/i6zdidgj) as 29 October 2026, 12:00–13:15 UTC / 16:00–17:15 Yerevan. Recheck the source when testing; labelling 12:00 as UTC+4 is the reported error. Announcement coverage was not established by those historical event counts. Supplying page content locally was an unproven suggestion, not an approved replacement architecture.

## Intake reliability and factual review

| Remaining work | Acceptance |
| --- | --- |
| Scheduling/research improvement (former F06/F11) | Demonstrate supported scheduling recovery on the same saved record through the current follow-up path. Failed/exhausted improvement must preserve partial facts and human corrections. Older zero-follow-up evaluations did not prove enrichment; do not restore mandatory generic research-decision metadata. |
| Factual support and priority (F07) | Verify dates, timezone, organizations and rubric authority against the actual source. Separate existing bad records from new extraction errors; NGO reporting alone is not official treaty verification. Missing optional facts must not discard useful findings. |
| Identity (F08) | Test equivalent URLs/native identities, repeated same-title occurrences, false merges, duplicate prevention and correct updates. Preserve genuinely distinct events and defer ambiguity. Existing data cleanup and future duplicate prevention need separate evidence. |
| Provider recovery (F09/F10) | Verify the current integrated route on failing URLs, including finite attempts, cooldowns, deadlines and uncertain charges. Older authentication failures were later superseded by reported successful recovery; they are not a reason to repeat credential diagnosis. A successful call alone does not prove source-supported facts. |
| Diagnostics (F12) | Distinguish retrieval, provider, normalization and storage failures using compact errors and numeric counts. Investigate unexplained field loss without a production traffic archive or tracing system. |
| Development selection (F13) | For a publication containing an event, decide whether the event, announcement or both represent distinct useful developments. The high-value IUCN meeting must not be changed to an announcement merely to match an old test expectation. |
| Test cleanup | Review the old F06/F11 cleanup obligation against current tests. Remove only redundant/obsolete cases; retain meaningful coverage for partial saves, scheduling failure, identity, human overrides and finite accounting. Some gateway cleanup was already reported complete. |

### Specific records needing review

The following identifiers preserve actionable issues from the undated-event evaluation. Read current rows first; the 12 October observations do not establish their present state.

| Record / source | Unresolved issue |
| --- | --- |
| `6f35fc89-db5f-43e7-8bad-7acf710f1a28` — [BBNJ simulation](https://bsky.app/profile/did:plc:sm42lcgzux3f7c7hpb7jn7m6/post/3mwvgavy4nc2p) | Saved 2026-10-02 matched publication; an event day was unverified. Organizer/scheduled-status support also remained open. |
| `8b1a03ba-a3c5-4aba-9517-456631405dbc` — [HSA COP1 report](https://highseasalliance.org/2026/08/01/my-broken-voice-and-the-ocean/) | Saved January 2027, but the source established January without the year. |
| `b352fc09-b15b-492f-8219-a32385b0a2a6` and `222ac309-44d5-4371-b012-5e1679747859` — [IUCN preparatory meeting](https://iucn.org/blog/202603/entry-force-action-why-moment-high-seas-cannot-be-missed) | Possible event/announcement duplicate; compare existing PrepCom3 rows before changing identity. |
| `670b10ed-6061-4be7-85b3-20708e0d4898` — [ISA31 post](https://bsky.app/profile/did:plc:d2kekyg6gt42ubsdap53shlf/post/3mrmnjkgflf2e) | Saved wording combined ISA31 participation and a BBNJ side event; review event scope. |
| `f4bdef9d-f252-4f3b-b79f-4e8c4557ee54` — [film previews](https://bsky.app/profile/did:plc:d2kekyg6gt42ubsdap53shlf/post/3mvkhu7jko22v) | Same source describes previews and UK cinema events; ambiguous matching prevented a write. September 23, 2026 was reported supported for previews only. |
| `a6f3b5ff-fa35-4811-bd31-c8052ded6f82` — [GFW Our Ocean report](https://globalfishingwatch.org/press-release/at-u-n-ocean-conference-panama-and-global-fishing-watch-forge-landmark-partnership-to-boost-ocean-protection/) | Provider retrieval failed; a reviewer identified April 2025, not yet saved by that evaluation. |
| `84c1a90e-00e2-4da1-ab66-6c1a92a46226` — [FAO fisheries side event](https://www.fao.org/fishery/services/storage/fs/fishery/documents/COFI/COFI36/BBNJSideEventCOFI36.pdf) | Reviewer identified July 10, 2024, 12:15–13:15 without a zone; deployed recovery failed. |
| `7e374f03-a9d7-4d45-8047-d967c362d4d5` — [HSA webinar](https://highseasalliance.org/2026/10/01/what-marine-genetic-resources-mean-for-the-high-seas-treaty/) | October 1 was rejected as a publication date, not an established webinar date. |
| `4438443a-b938-419a-9713-726bb5691df9` — Regenerative Ocean Forum, Mombasa | Date and relevance remained unconfirmed after a separate manually saved model result. |

Other older review cases remain candidates, not verified current defects: the PrepCom end-date discrepancy (April 1 versus April 2); UN session 5378 associated with Cali record `6c839b7d-cfd5-4eba-8ae8-5cde08b46097`; omitted UN schedules for sessions 5378/5838/6915; HSA COP1 duplicates; GFW Gabon ceremony false-zero extraction; unsupported OOC/Unguja priority; DOSI INCISE/Oslo description and status; Symposium satellite omissions; and HUB cross-representation matching. These include outstanding issues from previously uncommitted README/task notes. Reviewer-applied corrections and mocked outcomes do not count as successful model recovery.

## Discovery and source coverage

- [ ] Decide how publisher discovery should feed the URL-only pipeline before reactivating it. Existing adapters are outside active hosted intake; do not restore old capture/fingerprint/report stages merely because historical checklists requested them.
- [ ] Review the uncommitted Explorers adapter/integration work. The documented failure is API object-key reordering after JSONB round-trip changing preparation identity and restarting extraction instead of resuming. Prove API/detail continuity across outages, preserve source fields, then obtain actual save/reader/repeat evidence. The prior full-suite baseline recorded three related failures; this cleanup does not resolve them.
- [ ] Review current tracker inventory and source-specific coverage before enabling collection. Open areas include pagination/history, multi-session programmes, PDFs/media, translations and inaccessible pages. An adapter or fixture passing is not complete coverage.
- [ ] Reconcile legacy publisher observations against the current path: HSA transport/repeat limits; HUB matching; Symposium satellite omissions; Blue Marine/GOF/OceanCare live proof and multilingual/known-page limits; CBD/UNTC/RISE UP integration status; remaining Bluesky discovery coverage. Old deployment receipts and tracker counts are not current acceptance.
- [ ] For future web discovery, verify Tavily paid-use/top-up settings and actual shared quota first. Fetch supporting sources; snippets do not establish facts. Review new publishers before activation. Keep feed/API discovery and source-access limitations explicit; use an identifiable User-Agent if application-side HTTP collection is brought back.
- [ ] Resolve the unspecified conference tracker by obtaining its intended conference and official programme URL; do not guess. Newsletters, individual-person sources and dedicated funding collection remain future work.

## Product and release acceptance

- [ ] Apply the description-only migration and deploy its collector, calendar and website consumers together after verifying current shared account capacity. Local removal of finding titles does not establish the live database or deployment state.

- [ ] Verify the signed-in website against the reviewed hosted schema: records and trackers, source links, Low findings, UTC/date-only/unknown display, calendar controls and sign-out. The earlier browser review was left to the user; this cleanup does not claim it passed.
- [ ] Reconcile local changes with deployed frontend/backend versions before the next release. Deploy only the approved Scout target/function graph, preserve other shared-project services and verify actual assets, access boundaries and migrations.
- [ ] Complete Slack questions when prioritized: signed mention subscriptions, destination restrictions, prompt acknowledgement, duplicate-event handling and bounded queries of stored facts. Distinguish no matches from stale/incomplete coverage; preserve source links and handle unavailable model allowance. A working outbound webhook is not this feature.
- [ ] Complete tracker-management acceptance when prioritized: backend-authorized edits/manual runs, explicit administrator provisioning, configuration persistence and accurate supported/unsupported state. Enablement must not silently bypass proof or resume schedules.
- [ ] Agree notification time, digest weekday/time and IANA timezone before scheduling. Digest selection helpers exist; the current hosted command exposes immediate findings. Slack visual inspection remains a deferred check.
- [ ] Before recurring activation, prove due-source selection, overlap/interruption recovery, finite failure handling, unchanged completed-source suppression, actual model/SQL/storage costs and account headroom. Review live calendar sync/feed access separately. Scheduling and notifications remain paused; old keep-alive/reporting proposals are not new jobs to add.
- [ ] Demonstrate the intended end-to-end product with real saved findings, private website reads and authorized Slack delivery, including event updates/cancellations, an announcement and an official treaty change. Keep incoming Slack questions, broader discovery and source-coverage gaps explicit until implemented and verified.

The [product brief](https://docs.google.com/document/d/13HIEN45IEKQN-i29pQuoRD-eeFOl-t70a1_2TBpV7zI/edit) and [tracker inventory](https://docs.google.com/spreadsheets/d/1VtpaC83ybg7zet7VvNXmvctN9s5WJK_NTlJ9wx5NIbM/edit) are reference inputs; old imported counts and checklist architecture are not current truth. Latest user direction controls scope. Replace an item with its current acceptance result when resolved; keep completed run diaries in Git history rather than appending them here.
