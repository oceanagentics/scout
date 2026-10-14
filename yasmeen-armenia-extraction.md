# Yasmeen: complete development capture and correct ratings

Handoff requested 14 October 2026. Implementation is not included in this handoff.

## Goal

Make Scout find **all distinct developments—events and announcements—on the three sources below**, save them as accurate records, and rate each using the same shared Low/Medium/High rubric used across Scout searches. Recovering Ocean Agentics' workshop alone does not satisfy this requirement.

| Source | URL | Observed problem in the 12 October tests |
| --- | --- | --- |
| ICRI — COP17 coral reef and ocean events | https://icriforum.org/meetings/cop17-events/ | The page contained 110 event entries. Gemini returned the first 90, then reproduced a cut-off title from entry 91. OA's workshop was entry 100. Retrieval could report success despite incomplete content. |
| GEO — CBD COP17 pavilion schedule | https://earthobservations.org/about-us/events/cop17/schedule | Gemini reported successful retrieval but received website routing code instead of the programme. Independent reading found 15 scheduled sessions and three other highlighted events. |
| Ocean Pavilion — Luma calendar | https://luma.com/COP17OceanPavilion | Seven event occurrences were visible. The ordinary prompt returned one; an explicit capture-all instruction returned seven, but introduced a timezone error. This URL was not a Scout tracker or queued source when checked. |

These are historical observations, not fixed current totals. Re-read the sources. The earlier counts covered events; **announcement coverage has not been established**.

## Required behavior

- Capture every distinct event and announcement represented by the source, including developments in later programme sections or dynamic content. Do not treat navigation, boilerplate or repeated mentions as new developments.
- Apply the existing shared rubric to each captured development. Lower relevance must not silently remove it before the user can filter. Preserve uncertainty when the evidence does not support a rating; missing dates or organizers must not lower priority. The current rubric is in `collector/finding-contract.js`; its middle priority value is `normal`.
- Preserve distinct scheduled occurrences and avoid duplicating the same development across sources. The four dated Daily Ocean Huddle sessions are separate occurrences.
- Preserve supported dates, times, organizations and source/registration URLs. Keep unknown facts unknown. [OA's workshop](https://luma.com/i6zdidgj) is 29 October 2026, **12:00–13:15 UTC / 16:00–17:15 Yerevan**; labelling 12:00 as UTC+4 is incorrect.
- Do not equate HTTP success, valid JSON or some saved records with complete source coverage. Unreadable or unfinished content must remain explicitly unresolved.

## Investigation starting points

Review `collector/model.js`, `collector/model-gateway.js`, `collector/finding-contract.js` and `collector/finding-jobs.js`. The inspected code caps results at eight and can close a source after a partial result. Its source/title identity also collapses repeated event names within one source. Confirm current behavior before editing; the checkout contains concurrent work.

Choose the smallest shared solution. No tracker-specific prompts or extraction logic. An earlier proposal was to supply page content directly to Gemini; that approach is **unproven**, not a prescribed architecture. Simply stripping scripts would lose ICRI's embedded programme.

## Proof of completion

Independently identify the developments on each source, then compare them with **actual saved Scout records**, checking both completeness and the source-supported ratings. Include announcements, later programme entries, repeated occurrences and basic factual accuracy. A model's claim that it found everything is not independent verification.

Prove one correct saved record first, then the small Pavilion programme, then GEO and ICRI. Account for every remaining omission or incorrect rating; unresolved gaps mean the requirement is not complete. Preserve existing records and human corrections.

Follow `AGENTS.md`: keep changes minimal, source bodies and model traffic in memory, attempts finite, and recurring collection/notifications paused. Measure model and database costs before expanding the live test. Do not broaden this into a general Scout refactor.
