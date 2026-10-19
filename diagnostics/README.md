# Local model diagnostics

Scout's normal diagnostics return provider/HTTP status, sanitized errors, token
counts, retrieval URLs and search counts. They do not retain raw model replies.

To inspect one tracker investigation locally:

```sh
npm run reader -- --diagnostic --tracker=UUID
```

Add `--provider=gemini` or `--provider=openai` to test one model without fallback.
Omit it to use the normal Gemini-to-OpenAI route. To retain separate captures when
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
after the result is printed. Shared production quota reservations/settlements
still account for actual calls. Provider account limits apply; this command
never starts scheduled collection or notifications.
It retains the existing two-generation limit and provider tool limits.
Capture adds no model calls or SQL writes. Only the local traffic file persists.

The capture exception was explicitly requested for local diagnosis. Keep this
module outside hosted/browser import graphs; do not add a production capture flag
or deploy this diagnostic. No production database receives traffic.

The CLI prints normalized records and workflow diagnostics separately from the
raw traffic. There is no separate scheduling follow-up. Provider retrieval metadata
may omit the page body and image alt text. Successful retrieval alone does not
prove which content the model saw, even with the full provider reply captured.

Bluesky author-feed checks now supply one post directly to the model. A diagnostic
starts at the oldest post in the configured initial window; its in-memory progress
is discarded with the diagnostic database. Use a specific API cursor/window when
comparing a particular post, verifying the returned post URI before calling models.
Production checks retain only their last processed feed-entry URI and save it with
findings. An unchanged production feed makes no model call. Local workflow tests
exercise pagination, unchanged checks, new arrivals, retries and atomic progress;
mocked transport tests do not establish live extraction accuracy.
