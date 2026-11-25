# Local model diagnostics

Scout's normal diagnostics return provider/HTTP status, sanitized errors,
retrieval URLs and search counts. They do not retain raw model replies.

To inspect one tracker investigation locally:

```sh
npm run reader -- --diagnostic --tracker=UUID
```

Add `--provider=gemini` or `--provider=openai` to test one model without fallback.
Use `--model` to select an OpenAI model explicitly, also without fallback:

```sh
npm run reader -- --diagnostic --tracker=UUID --model=gpt-5.6-terra
npm run reader -- --diagnostic --tracker=UUID --model=gpt-6.1-sol
```

The supported OpenAI selections are `gpt-6-luna` with high reasoning,
`gpt-6.1-terra` with none reasoning and temperature zero,
`gpt-5.6-terra` with low reasoning and `gpt-6.1-sol` with xhigh reasoning.
`--model` selects OpenAI and cannot be combined with `--provider=gemini`.
Web investigations use OpenAI's linked-read/native-document loop; Gemini cannot
be selected for that input. Without an override, both web items and supplied
Bluesky posts first use Luna high. Accepted positive findings promote the whole
source item to a full Terra 6.1 none/temperature-zero investigation, using the
same instruction and schema. Zero/null-only items bypass Terra; mixed items
retain zero/null findings as pending candidates. The second pass receives full
prepared evidence and native PDFs/images in memory. Terra failures leave progress
pending through the existing finite retries.

An explicit `--model` overrides both passes; a promising item still runs twice.
`--provider=gemini` uses Gemini for both passes on supported post inputs.
`--provider=openai` preserves the requested Luna/Terra models. These overrides
are diagnostic experiments, not the normal production route. To retain separate captures when
comparing runs, call `diagnoseTracker({tracker, env, provider, model, output})` with a
different local output path for each run.

This runs the current checkout's workflow, not the deployed function. It saves
request and response bodies (including errors) in
`.cache/model-traffic/latest.jsonl`. Each request/response pair shares an `id`.
The file is overwritten each run, ignored by Git and readable only by its owner.
Headers and endpoint query parameters are excluded; configured API credentials
are redacted. Bodies are capped at 128 KiB with an explicit `truncated` marker.

```sh
jq 'select(.direction == "response") | {id, status, body: (.body | fromjson? // .)}' .cache/model-traffic/latest.jsonl
```

The URL comes from the tracker row. Findings and tracker checking state exist only in an in-memory database and are discarded
after the result is printed. The shared database receives only the tracker read; model calls make no SQL writes.
Actual provider limits, request timeouts and one optional fallback apply. This
command never starts scheduled collection or notifications. Only the local
traffic file persists.

The capture exception was explicitly requested for local diagnosis. Keep this
module outside hosted/browser import graphs; do not add a production capture flag
or deploy this diagnostic. No production database receives traffic.

The CLI prints normalized records and workflow diagnostics separately from the
raw traffic, including request/token totals, source body bytes and any malformed
optional scheduling fields. Continuation requests share the check's 120-second
deadline; a model attempt can contain several HTTP requests. Broken documents,
incomplete coverage and conflicting saved dates do not block other findings or
progress. There is no cleanup or scheduling follow-up. Provider retrieval metadata
may omit the page body and image alt text. Successful retrieval alone does not
prove which content the model saw, even with the full provider reply captured.
