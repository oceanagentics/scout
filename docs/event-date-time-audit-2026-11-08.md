# Event date and time audit — 8 November 2026

Comparison of the 22 event records first saved on 8 November 2026 (Scout's `America/New_York` day) with missing `starttime` values. The saved values below are the read-only database snapshot used for this audit. Sources were checked on the same date, including linked event pages, programmes and flyers. No Scout code or database records have been changed.

## Findings

- **All 22 records contain an exact calendar date.** None has an unknown day in the saved `date` field.
- **19 have a published start time that Scout left blank.** This includes the formal opening of the multi-day COP conference. Times below are as published, not converted to a common timezone.
- **Three are multi-day events for which a single start time is not required:** the Technology and Innovation Expo, CHM poster fair and Youth Summit. Their missing times are not extraction failures.
- **15 saved dates match the event's actual first day.** A first-day-only record does not capture a multi-day span; the published span is shown below.
- **Seven saved dates use the parent conference's first day instead of the individual session's day.** Record 22's flyer has conflicting dates; an independent official side-event programme and event report establish 25 January 2024.
- `starttime` and `timezone` are null in all 22 saved records. A time can be verified even when its timezone still needs separate verification.

These are current-source comparisons. No retained original model response establishes which pages or images Scout inspected during the original run.

## CBD parallel events — records 1–13

Every record in this table has the saved source [CBD parallel meetings overview](https://www.cbd.int/conferences/2026/parallel-meetings). Individual event links below are linked from that overview. Scout saved the first day of each published span.

| # | Record and ID | Scout date | Scout time | Published event date(s) | Published start time | Assessment / source |
|---|---|---|---|---|---|---|
| 1 | 2026 Biodiversity Technology and Innovation Expo<br>`1d3a0f9d-e80d-4f37-a0c7-b19e22afd1b6` | 2026-10-19 | null | 2026-10-19–2026-10-30 | Not required for this multi-day exhibition; no start time found on the event page | First day correct. [Expo](https://www.cbd.int/conferences/2026/parallel-meetings/tech-innovation-expo). |
| 2 | Nature and Culture Summit 2026<br>`e1622e43-eb0b-4f38-a3f8-4a7031f4a496` | 2026-10-24 | null | 2026-10-24–2026-10-25 | 10:00 on 24 October | First day correct; opening time missed. Second day is a field visit. [Programme](https://www.cbd.int/conferences/2026/parallel-meetings/nature-culture-summit). |
| 3 | 9th Summit for Subnational Governments & Cities<br>`2453682e-470b-40a7-9f04-e69c8db9ce8e` | 2026-10-24 | null | 2026-10-24 | 09:00 opening; doors at 08:00 | Day correct; opening time missed. [Programme](https://www.cbd.int/conferences/2026/parallel-meetings/cities-subnational-summit). |
| 4 | Capacity-Building and Development Forum<br>`24d25165-c286-4ec6-9425-862005e434e4` | 2026-10-24 | null | 2026-10-24 | 09:00, Armenia Time | Day correct; time missed. [Programme](https://www.cbd.int/conferences/2026/parallel-meetings/capacity-forum). |
| 5 | Science Forum<br>`20e8dd1f-10b4-4c42-b035-6306f769ef45` | 2026-10-24 | null | 2026-10-24–2026-10-25 | 08:45 opening on 24 October; doors at 08:30 | First day correct; opening time missed. Detailed page calls this the Seventh Science-Policy Forum for Biodiversity. [Agenda](https://www.cbd.int/conferences/2026/parallel-meetings/science-forum). |
| 6 | Business and Biodiversity Forum<br>`010bac9f-776a-410f-90c3-3c7a657134cf` | 2026-10-25 | null | 2026-10-25 | 09:00 | Day correct; time missed. [Programme](https://www.cbd.int/conferences/2026/parallel-meetings/business-biodiversity-forum). |
| 7 | Finance and Biodiversity Day<br>`7610301d-a493-4bf0-a7f7-aa985bf881ef` | 2026-10-26 | null | 2026-10-26 | 08:30, Armenia Time | Day correct; time missed. [Programme](https://www.cbd.int/conferences/2026/parallel-meetings/finance-day). |
| 8 | Women's Forum<br>`2fc62cc4-0aa1-4f74-a938-c428b39f3760` | 2026-10-27 | null | 2026-10-27 | 10:00, Armenia Time | Day correct; time missed. [Programme](https://www.cbd.int/conferences/2026/parallel-meetings/women-forum). |
| 9 | Judges Day<br>`8009d9a5-2858-48a1-89ff-e04ce4295921` | 2026-10-29 | null | 2026-10-29 | 09:00, Yerevan Time | Day correct; time missed. Published day runs to 17:30. [Programme](https://www.cbd.int/conferences/2026/parallel-meetings/judges-day). |
| 10 | Clearing House Mechanism Knowledge Virtual/Poster Fair<br>`42e319fb-6213-456a-a27b-03327d095ca7` | 2026-10-19 | null | 2026-10-19–2026-10-30 | Not required for this multi-day display; no start time found on the event page | First day correct. Do not substitute the separate award ceremony's time. [Fair](https://www.cbd.int/conferences/2026/parallel-meetings/chm-knowledge-fair). |
| 11 | Biosafety Clearing-House and Risk Assessment Training Workshop<br>`15218900-50e2-421b-b7ff-bf8b5839a37d` | 2026-10-17 | null | 2026-10-17–2026-10-18 | 10:00 opening on 17 October; registration at 09:00 | First day correct; opening time missed. Day two starts at 09:00. [Agenda](https://www.cbd.int/conferences/2026/parallel-meetings/bch-workshop). |
| 12 | ABS Clearing-House Workshop: Strengthening ABS Relationships, Information Exchange and Effective Implementation<br>`8a9752a5-13ef-48a9-9ec7-d606d2da70e8` | 2026-10-25 | null | 2026-10-25 | 09:30 | Day correct; time missed. Published hours are 09:30–17:00. [Workshop](https://www.cbd.int/conferences/2026/parallel-meetings/absch-workshop). |
| 13 | The Global Youth Summit for Biodiversity<br>`2cb42c2a-977e-427e-8894-4334afe03d60` | 2026-10-17 | null | 2026-10-17–2026-10-18 | Not required for this multi-day summit; no start time found on the CBD event page | First day correct. [Summit](https://www.cbd.int/conferences/2026/parallel-meetings/youth-summit). |

## COP conference — record 14

| # | Record and ID | Scout date | Scout time | Published event date(s) | Published start time | Assessment / source |
|---|---|---|---|---|---|---|
| 14 | United Nations Biodiversity Conference (COP 17 / CP-MOP 12 / NP-MOP 6)<br>`2cb3a8d2-4b96-40cc-b6ac-79476dab00b6` | 2026-10-19 | null | 2026-10-19–2026-10-30 | Formal opening plenary: 10:00 on 19 October | First formal day correct; formal opening time available. The separate opening ceremony on 18 October at 17:30 should not silently replace it. Saved source: [COP17](https://www.cbd.int/conferences/2026/cop-17). Evidence: official [scenario note](https://www.cbd.int/doc/c/7245/a6ac/cff171091ec3aa64037aa7d2/cop-17-01-rev1-add2-rev1-en.pdf), annex II, PDF page 9, and annex III, page 10. |

## UN BBNJ side events — records 15–22

Every record in this table has the saved source [UN BBNJ side events overview](https://www.un.org/bbnjagreement/en/capacity-building-and-technical-assistance/side-events). The overview generally lists the parent conference's span; the linked session details are needed to identify the actual day and time.

| # | Record and ID | Scout date | Scout time | Published session date | Published start time | Assessment / source |
|---|---|---|---|---|---|---|
| 15 | All hands on deck in support of the effective implementation of the BBNJ Agreement in the Asia-Pacific region, an event at Asia-Pacific Ocean Week<br>`cbf13b18-710b-4774-921b-5c4545c320fd` | 2026-10-26 | null | **2026-10-27** | 09:00 | Wrong day and missing time. Overview says Ocean Week is 26–30 October; the [linked programme](https://www.un.org/bbnjagreement/sites/default/files/2026-10/20261006_apow_bbnj_doalos_programme.pdf) specifies 27 October, 09:00–12:00. |
| 16 | DOALOS activities to promote a better understanding of the BBNJ Agreement and prepare for its entry into force, as well as GEF enabling activities and ratification support — information session at the Preparatory Commission organizational meeting<br>`829ad655-6997-4911-92fc-29b9ba990d7d` | 2024-06-24 | null | **2024-06-25** | 13:15 | Wrong day and missing time. The [linked programme](https://www.un.org/bbnjagreement/sites/default/files/2024-06/bbnjinformationsessionprogramme.pdf) visually prints 25 June 2024, 13:15–14:30. These details are absent from its extracted text and must be read from the rendered page. |
| 17 | Leveraging UNCLOS and the BBNJ Agreement in support of resilient prosperity in SIDS — SIDS4 side event<br>`f296e853-3239-4adb-96bd-bdb215e78052` | 2024-05-27 | null | **2024-05-28** | 13:30 | Wrong day and missing time. The overview links to a programme version that returned 404 during the audit. The official [29 April programme](https://sdgs.un.org/sites/default/files/2024-04/SIDS4%20Side%20Events%20programme%20V29April2024.pdf) places the matching title under Tuesday 28 May, 13:30–15:00. |
| 18 | Towards living in harmony with the ocean from coasts to areas beyond national jurisdiction: Synergies between the BBNJ Agreement and the work under the CBD — SBSTTA-26 side event<br>`3c9cfee7-a2a6-4b00-b41a-702853bbd09e` | 2024-05-13 | null | 2024-05-13 | 10:15 | Day correct; time missed. [Linked CBD session #5378](https://www.cbd.int/side-events/5378) displays `2024.05.13 @ 10:15`. |
| 19 | The BBNJ Agreement and its linkages with the Ocean Decade — 2024 Ocean Decade Conference satellite event<br>`6cf617b5-c01e-413b-8b6f-f019445380d0` | 2024-04-10 | null | **2024-04-12** | 08:30 | Wrong day and missing time. [Linked programme](https://www.un.org/depts/los/OceanDecadeConfBBNJSideEvent.pdf) specifies 12 April, 08:30–09:45. |
| 20 | Stepping Together Toward Ratification and Implementation of the BBNJ Agreement — UNEA-6 side event<br>`8b37afdb-1703-479c-b98f-46ace0260325` | 2024-02-26 | null | **2024-02-28** | 13:15 | Wrong day and missing time. [Linked image flyer](https://www.un.org/depts/los/UNEA-BBNJ-Landscape.jpg) specifies Wednesday 28 February, 13:15–14:45. |
| 21 | The BBNJ Agreement and its Linkages with the CMS — CMS COP14 side event<br>`bbba924c-9168-4432-b531-cb58fc6bcab6` | 2024-02-12 | null | **2024-02-15** | 12:45 | Wrong day and missing time. [Linked image flyer](https://www.un.org/Depts/los/CMSCOP14BBNJSideEvent.jpg) specifies 15 February, 12:45–13:30. Its fuller title is “Synergies between marine biodiversity and migratory species: Connecting the BBNJ Agreement and the CMS.” |
| 22 | Leveraging the BBNJ Agreement in support of resilient prosperity in SIDS — first SIDS4 Preparatory Committee side event<br>`09ff8220-fd0e-410f-9a04-09464d878f15` | 2024-01-22 | null | **2024-01-25** | 13:15 | Wrong day and missing time. The [linked image flyer](https://www.un.org/Depts/los/SIDS4PrepCommBBNJSideEvent.jpg) contradicts itself: its footer says Thursday 25 January, while its header says 25 June. Independently, the official [side-event programme](https://sdgs.un.org/sites/default/files/2024-01/First%20Preparatory%20Committee%20Meeting%20for%20the%20SIDS4%20Conference_SideEventProgramme_19v2.pdf) and [DOALOS event report](https://sdgs.un.org/sites/default/files/2024-02/Report-BBNJ_SideEventSIDS4_PrepMeeting_25%20January.pdf) both specify 25 January 2024, 13:15–14:30, Room E, UN Headquarters, New York. Those independent texts were available through the search index; direct PDF fetches were throttled / returned 404 during the follow-up. The date is supported by independent official documents, rather than by choosing one of the flyer's dates without corroboration. |

## Research scope

Investigate records 1–22 in this order, one at a time. Explain how the existing reader could recover each appropriate event date and time, including linked pages, PDF text, rendered PDF text and image text. Preserve the legitimate absence of a single start time for records 1, 10 and 13. Distinguish published opening times from doors opening, registration and separate ceremonies; preserve source conflicts rather than guessing.

The requested next step is a research-backed proposal, not implementation. Source bodies and model traffic must remain in memory and be discarded. Do not change production records, tracker state, code, schemas, schedules or notifications. Any model experiment must stay within actual provider allowances and clearly distinguish live results from mocked mechanics.

## Research findings

The worker reviewed all 22 records sequentially. The deployed `scout-reader` version 9 bundle contained exact local copies of the instructions, Gemini and OpenAI adapters, gateway, source reader, intake and findings files. The original model replies are unavailable, so these observations establish current mechanisms rather than reconstructing the original runs.

1. **The Gemini tool cannot perform the investigation requested by the prompt.** Ordinary web trackers provide one URL. `reader/models/gemini.js` enables URL Context without Search. Google's [URL Context documentation](https://ai.google.dev/gemini-api/docs/url-context) says nested links are not explored; directly supplied image and PDF URLs are supported. The existing instructions already ask for linked pages, images and each event's actual schedule. Repeating those instructions does not add a missing tool capability.
2. **A valid answer with missing facts ends the check.** The [gateway](../reader/models/gateway.js) tries OpenAI after eligible errors, not after an accepted answer containing null times or conference-level dates. One successful URL retrieval is enough for the Gemini adapter's retrieval check. It does not establish investigation of every listed event.
3. **Formatting can silently erase a supplied time.** [Finding normalization](../reader/findings.js) accepts `09:00`, but converts `9:00`, `9:00 AM` and a time range to null while retaining the record. This was reproduced without model or database calls. It is a possible additional loss mechanism; it is not proof of what the original models returned.
4. **CBD's raw HTML is an application shell.** Its `<ng-view>` is empty before JavaScript loads article data. A plain HTML fetch of the human-facing URL would not supply the agenda. CBD's own public `/api/v2017/articles` endpoint exposes the overview's actual article content and the 13 audited event links. The worker is investigating this source-native content route, including individual agendas, before proposing browser automation or broader retrieval machinery.
5. **Changing providers, prompting harder, or increasing reasoning did not establish full coverage.** The live checks below ruled out treating those changes alone as a complete solution.

## Live research checks

These are in-memory extraction experiments, with no database connection, no collection invocation and no saved source/model captures. Expected dates and times were not provided to the model. All used `gpt-6-luna` through the existing OpenAI adapter or an in-memory request variant. No repository code was edited for these experiments.

| Check | Observed result | Model requests | Input tokens | Output tokens | Elapsed | Web-tool items |
|---|---|---:|---:|---:|---:|---:|
| Focused record 2, starting at the CBD overview | Correct `2026-10-24`, `10:00`, `Asia/Yerevan`; preserved by normalization | 1 | 13,617 | 244 | 7.848 s | 2 |
| Focused record 16, starting at the visual programme PDF | Correct `2024-06-25`, `13:15`, `America/New_York`; preserved by normalization | 1 | 10,529 | 374 | 8.652 s | 3 |
| Complete CBD overview, unchanged instructions and low reasoning | Empty array despite a populated directory | 1 | 22,071 | 241 | 8.474 s | 3 |
| Complete CBD overview, explicit complete-directory instructions and low reasoning | Eight of the 13 audited entries, plus the pavilion; only five of the ten expected published starts | 1 | 38,881 | 1,139 | 21.995 s | 6 |
| Explicit list of all 13 CBD names and detail URLs, low reasoning | All 13 returned, but three dates null and only three of the ten published starts; names/URLs alone did not supply complete facts | 1 | 23,872 | 1,414 | 19.342 s | 3 |
| Complete CBD overview, complete-directory instructions and medium reasoning | Eight of the 13 audited entries, with different omissions; higher reasoning did not fix coverage | 1 | 47,644 | 2,188 | 41.925 s | 7 |

Measured totals so far: **six model requests, 156,614 input tokens, 5,600 output tokens, 162,214 total tokens and 24 web-tool items**. API usage includes caching/reasoning accounting. Web-tool items are not a verified count of billed search actions. Actual monetary charges and remaining shared account credits have not been verified; these results do not authorize unattended recurring use. Research SQL statements and row mutations: **zero**. Persisted source bodies or raw model traffic: **zero**.

The two focused successes prove that the existing model route can find scheduling facts for those two cases. They do not establish complete overview coverage, correct handling of every image, or successful persistence through the production workflow. Returned provider source lists can include search results as well as opened URLs; their presence alone does not prove a particular image was read.

## Proposed change — source content before extraction

**Recommendation under validation:** give the existing extractor the organizer's actual event content and preserve the source's complete event list in memory. Do not rely on a model's broad web investigation to enumerate and read the directory successfully. The next live check must establish whether the complete CBD agendas supplied together produce all 13 audited entries with their ten published start times and three legitimate null times. That check is pending command approval in the research worker; this proposal is not yet a verified complete fix.

The smallest implementation to investigate is at the existing source-reading boundary, [reader/sources.js](../reader/sources.js), using its established pattern of supplying content to intake:

1. **Read the real CBD article content.** Use the public article API used by CBD's own page to obtain the overview and the linked event articles. Select the actual directory article and its event links; do not substitute the conference menu, an upcoming-meetings page or unrelated articles sharing a tag. Pass the published agenda content and its original URLs to the model in memory, then discard the content. The concrete API response, article selection and request size must be verified before implementing this path.
2. **Keep directory coverage explicit.** Retain the discovered names and URLs only for the current check. Compare returned entries with that source inventory before marking the investigation successful. The existing valid-empty response is insufficient when the source contains known entries. A complete list with blank scheduling fields is also insufficient evidence that the agendas were read, as the fifth experiment demonstrates.
3. **Supply the particular session evidence for UN entries.** The relevant materials are identified in rows 15–22: programme PDFs, a CBD session page and JPG flyers. Read the date-bearing visual portions of PDFs and images. Use the existing focused OpenAI investigation capability for inaccessible or broken official links, with the original event name as the target. A parent conference span must not stand in for a session date. Independent official documents can resolve a contradictory flyer, as shown in row 22.
4. **Keep extraction focused on supported scheduling facts.** Associate an opening time with the first event day; distinguish doors, registration, field visits and separate ceremonies. Keep the three legitimate multi-day nulls. Revise the current supplied-content instruction so an organizer's article or directory is not treated as a single social-media post.
5. **Surface invalid non-null scheduling output.** If a model supplies a non-null time that cannot survive normalization, use the existing invalid-output failure path instead of silently replacing it with null. Reuse the existing finite retry/fallback behavior. A general natural-language time parser is not needed to require the model's agreed `HH:MM` format.

This introduces maintenance of the actual source-content mapping and completeness check. It does not require a new database table, durable work queue, record provenance system, capture store or background job. Existing record persistence can remain the owner of saving the final supported facts. Whether the model can extract all schedules in a single request from complete supplied content remains the pending validation question; do not assume that one model call per entry is necessary or that it fits the current 100-second check deadline.

### Simpler alternatives tested or considered

- **Provider swap only:** the unchanged full-overview OpenAI check returned no records. The two focused successes do not justify deploying that swap as the fix.
- **Stronger directory instructions:** returned eight of the 13 audited entries. This improves one result but still loses records.
- **More reasoning:** also returned eight audited entries, with different omissions, while using more tokens and time.
- **Explicit names and links:** preserved all 13 names but recovered only three of the ten starts. Supplying links does not establish that their agenda content was read.
- **Plain HTML fetching:** CBD's human-facing response is a JavaScript shell, so it would still omit the source content needed for extraction. The organizer's existing public content API is a smaller concrete path to investigate than adding browser automation.
- **Fallback whenever a time is null:** would retry the three legitimate nulls and would not detect a wrong but non-null parent-conference date. Source retrieval, coverage and malformed-output failures are different conditions from an unsupported optional time.
- **Manual detail-URL tracker changes:** can target individual known events, but do not establish correct reading of a directory's newly listed events. Do not turn the 22 audited records into permanent special cases.

### Validation required before recommending implementation

1. Finish the pending in-memory CBD content experiment. Require 13/13 audited entries, all 13 supported first days, the ten published opening times, and exactly the three justified null times for this fixture. Expected answers must not be supplied to the model. Record latency, provider usage and source request size.
2. Validate the UN cases against rows 15–22, including an image flyer, the visual PDF header, an official alternative to the broken programme link and corroboration of record 22's date. The two successful focused probes cover only two of these source shapes.
3. Design the smallest change around the successful evidence path. Then, if implementation is authorized, test one record through intake and an ephemeral database to measure actual SQL and saved fields. No production write is needed for this research task.
4. Measure actual account allowance consumption and full-source request duration before unattended use. The target is one extraction request from complete supplied content when feasible, with the existing optional fallback; this is a hypothesis to measure, not an established recurring cost. More source HTTP reads and input bytes are expected. Research to date made zero SQL statements or mutations and retained zero source/model captures.
5. Keep record repair separate from collection. The current prompt classifies these past gatherings as announcements, while the audited rows have type `event`; matching uses type. A collection rerun can therefore create different records instead of repairing these IDs. If repair is later authorized, use the reviewed IDs and final facts in this document. No repair is authorized or performed here.
