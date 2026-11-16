# Local model diagnostics

Scout's normal diagnostics return provider/HTTP status, sanitized errors,
retrieval URLs and search counts. They do not retain raw model replies.

To inspect one tracker investigation locally:

```sh
npm run reader -- --diagnostic --tracker=UUID
```

Add `--provider=gemini` or `--provider=openai` to test one model without fallback.
Web investigations use OpenAI's linked-read/native-document loop; Gemini cannot
be selected for that input. Supplied Bluesky posts retain the Gemini-to-OpenAI
route. Omit the option to use the input's normal route. To retain separate captures when
comparing runs, call `diagnoseTracker({tracker, env, provider, output})` with a
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
optional scheduling fields. Continuation requests share the check's 100-second
deadline; a model attempt can contain several HTTP requests. Broken documents,
incomplete coverage and conflicting saved dates do not block other findings or
progress. There is no cleanup or scheduling follow-up. Provider retrieval metadata
may omit the page body and image alt text. Successful retrieval alone does not
prove which content the model saw, even with the full provider reply captured.
