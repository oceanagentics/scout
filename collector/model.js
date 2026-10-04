import { Buffer } from 'node:buffer';

export const MODEL = 'gemini-3.5-flash-lite';
export const MODEL_LIMITS = { minute: 2, run: 10, input: 8000, output: 1024, retries: 1 };

// One autocommitted statement. Never call this inside a collection transaction.
// The same hosted collection_runs ledger is required for local and hosted calls.
export function reservationSQL(runId, inputBytes, runLimit = MODEL_LIMITS.run) {
  if (!/^[a-f0-9-]{36}$/i.test(runId) || !Number.isInteger(inputBytes) || inputBytes < 1 || inputBytes > MODEL_LIMITS.input) throw new Error('Model input limit reached');
  if (!Number.isInteger(runLimit)||runLimit<1||runLimit>MODEL_LIMITS.run) throw new Error('Invalid run attempt limit');
  return `do $budget$
  declare attempts jsonb; moment timestamptz := clock_timestamp();
  begin
    perform pg_advisory_xact_lock(hashtextextended('scout:model-budget',0));
    select coalesce(stats->'model_attempts','[]'::jsonb) into attempts
      from scout.collection_runs where id='${runId}' and outcome='running' for update;
    if attempts is null then raise exception 'Model run unavailable'; end if;
    if jsonb_array_length(attempts) >= ${runLimit} or
      (select count(*) from scout.collection_runs r cross join lateral
        jsonb_array_elements(coalesce(r.stats->'model_attempts','[]'::jsonb)) a
        where (a->>'at')::timestamptz > moment-interval '60 seconds') >= ${MODEL_LIMITS.minute}
    then raise exception 'Model quota reached'; end if;
    update scout.collection_runs set stats=jsonb_set(stats,'{model_attempts}',attempts ||
      jsonb_build_array(jsonb_build_object('at',moment,'input_bound',${inputBytes},'output_bound',1024,'model','${MODEL}')))
      where id='${runId}';
  end $budget$;`;
}

export function gemini({ apiKey, ledger, runId, runLimit = MODEL_LIMITS.run, fetch: send = fetch, deadline = Date.now() + 100000, trace }) {
  return async (instruction, input, schema) => {
    if (!apiKey || !ledger) throw new Error('Model and shared hosted budget ledger are required');
    const body = JSON.stringify({ systemInstruction: { parts: [{ text: instruction }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(input) }] }],
      generationConfig: { maxOutputTokens: MODEL_LIMITS.output, thinkingConfig: { thinkingLevel: 'minimal' },
        responseMimeType: 'application/json', responseJsonSchema: schema } });
    // UTF-8 bytes conservatively bound text tokens, including instructions/schema.
    const inputBound = Buffer.byteLength(body);
    const requestArtifact = await trace?.artifact('model_request', 'Exact Gemini request body (no headers)', { model: MODEL, body: body.replaceAll(apiKey,'[REDACTED]'), input_bytes: inputBound, credential_redacted: body.includes(apiKey) });
    if (inputBound > MODEL_LIMITS.input) throw new Error('Model input limit reached; candidate remains pending');
    for (let attempt = 0; ; attempt++) {
      if (Date.now() + 1000 >= deadline) throw new Error('Model time limit reached');
      await ledger.query(reservationSQL(runId, inputBound, runLimit)); // durable BEFORE the external side effect
      const op = await trace?.start('generate', { source_ids: input.map(i=>i.source_id), artifacts: [requestArtifact], attempt: attempt+1, note: 'Attempt reserved; delivery unknown until a response is captured.' });
      try {
      let response;
      try {
        response = await send(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body,
          signal: AbortSignal.timeout(Math.max(1, Math.min(20000, deadline - Date.now()))),
        });
      } catch { throw new Error('Model transport failed; reserved attempt remains counted'); }
      let raw;
      try { raw = await response.text(); } catch { /* Preserve status and missing-body evidence even if the stream fails. */ }
      const outputArtifact = await trace?.artifact('model_response','Returned Gemini response body (no headers)',{
        http_status:response.status,...(raw===undefined?{unavailable:'Response body could not be read.'}:{body:raw.replaceAll(apiKey,'[REDACTED]'),credential_redacted:raw.includes(apiKey)}),
      });
      if (trace) await trace.finish(op,'running',{artifacts:[requestArtifact,outputArtifact],http_status:response.status,note:'Response evidence persisted; parsing/completeness checks in progress.'});
      if (!response.ok) {
        await trace?.finish(op,'fail',{note:'Provider error retained without headers. Existing transient-5xx retry policy only.'});
        if ([500, 502, 503, 504].includes(response.status) && attempt < MODEL_LIMITS.retries) continue;
        throw new Error(`Model returned HTTP ${response.status}; candidate remains pending`);
      }
      if (raw===undefined) throw new Error('Model response body unavailable; candidate remains pending');
      let result;
      try { result = JSON.parse(raw); } catch { throw new Error('Invalid model response JSON; candidate remains pending'); }
      if (result.usageMetadata) await ledger.query(`update scout.collection_runs set stats=jsonb_set(stats,'{model_usage}',
        coalesce(stats->'model_usage','[]'::jsonb)||$2::jsonb) where id=$1`,[runId,JSON.stringify([result.usageMetadata])]);
      const choice = result.candidates?.[0];
      if (choice?.finishReason !== 'STOP') throw new Error('Incomplete model result; candidate remains pending');
      const text = choice.content?.parts?.filter(part => !part.thought).map(part => part.text ?? '').join('');
      let decisions;
      try { decisions = JSON.parse(text); } catch { throw new Error('Invalid model JSON; candidate remains pending'); }
      await trace?.finish(op,'pass',{note:'Complete JSON response parsed. Proposal validation and rating review are separate.'});
      return decisions;
      } catch(error) {
        if (trace?.report.operations[op].state!=='fail') await trace?.finish(op,'fail',{note:'Model transport, response parsing or completion failed; available artifacts are retained.'});
        throw error;
      }
    }
  };
}
