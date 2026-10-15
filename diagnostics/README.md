# Local model diagnostics

Scout's normal diagnostics return provider/HTTP status, sanitized errors, token
counts, retrieval URLs and search counts. They do not retain raw model replies.

To inspect intake and scheduling follow-up traffic locally:

```sh
npm run collect:hsa -- --diagnostic --tracker=UUID --source=https://example.org/event
```

This runs the current checkout's workflow, not the deployed function. It saves
request and response bodies (including errors) in
`.cache/model-traffic/latest.jsonl`. Each request/response pair shares an `id`.
The file is overwritten each run, ignored by Git and readable only by its owner.
Headers and endpoint query parameters are excluded; configured API credentials
are redacted. Bodies are capped at 128 KiB with an explicit `truncated` marker.

```sh
jq 'select(.direction == "response") | {id, status, body: (.body | fromjson? // .)}' .cache/model-traffic/latest.jsonl
```

Findings and source state exist only in an in-memory database and are discarded
after the result is printed. Shared production quota reservations/settlements
still account for actual calls. Existing verified allowances must already be
open; this command never enables them or starts scheduled collection/notifications.
It retains the existing two-generation limit and at most eight follow-up searches.
Capture adds no model calls or SQL writes. Only the local traffic file persists.

The capture exception was explicitly requested for local diagnosis. Keep this
module outside hosted/browser import graphs; do not add a production capture flag
or deploy this diagnostic. No production database receives traffic.

The CLI prints normalized records and workflow diagnostics separately from the
raw traffic. Identify intake versus follow-up from the captured instructions and
the follow-up input's `research: "event_schedule"`. Provider retrieval metadata
may omit the page body and image alt text. Successful retrieval alone does not
prove which content the model saw, even with the full provider reply captured.
