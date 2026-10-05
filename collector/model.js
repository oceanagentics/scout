import { Buffer } from 'node:buffer';

export const MODEL = 'gemini-3.5-flash-lite';
export const MODEL_LIMITS = { minute: 2, run: 10, input: 1048576, output: 65536, retries: 1 };

export const requestBody = (instruction,input,schema) => JSON.stringify({systemInstruction:{parts:[{text:instruction}]},
  contents:[{role:'user',parts:[{text:JSON.stringify(input)}]}],generationConfig:{maxOutputTokens:MODEL_LIMITS.output,
    thinkingConfig:{thinkingLevel:Array.isArray(input)&&input.length&&input.every(i=>['extract','resolve'].includes(i.stage))?'medium':'minimal'},responseMimeType:'application/json',responseJsonSchema:schema}});

// One autocommitted statement. Never call this inside a collection transaction.
// The same hosted collection_runs ledger is required for local and hosted calls.
export function reservationSQL(runId, inputBytes, runLimit = MODEL_LIMITS.run) {
  if (!/^[a-f0-9-]{36}$/i.test(runId) || !Number.isSafeInteger(inputBytes) || inputBytes < 1) throw new Error('Invalid model reservation');
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
      jsonb_build_array(jsonb_build_object('at',moment,'input_bytes',${inputBytes},'input_token_limit',${MODEL_LIMITS.input},'output_bound',${MODEL_LIMITS.output},'model','${MODEL}')))
      where id='${runId}';
  end $budget$;`;
}

export function gemini({ apiKey, ledger, runId, runLimit = MODEL_LIMITS.run, fetch: send = fetch, deadline = Date.now() + 100000, trace }) {
  return async (instruction, input, schema) => {
    if (!apiKey || !ledger) throw new Error('Model and shared hosted budget ledger are required');
    const body = requestBody(instruction,input,schema);
    const inputBytes = Buffer.byteLength(body),endpoint=`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}`;
    const requestArtifact = await trace?.artifact('model_request', 'Exact Gemini request body (no headers)', { model: MODEL, body: body.replaceAll(apiKey,'[REDACTED]'), input_bytes: inputBytes, credential_redacted: body.includes(apiKey) });
    let inputTokens;
    for (let attempt = 0; ; attempt++) {
      if (Date.now() + 5000 >= deadline) throw new Error('Model time limit reached');
      await ledger.query(reservationSQL(runId, inputBytes, runLimit)); // durable BEFORE token counting or generation
      const op = await trace?.start('generate', { source_ids: input.map(i=>i.source_id), artifacts: [requestArtifact], attempt: attempt+1, note: 'Attempt reserved; token preflight precedes generation.' });
      try {
      if(inputTokens===undefined){
        const counted=await send(endpoint+':countTokens',{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':apiKey},
          body:JSON.stringify({generateContentRequest:{model:'models/'+MODEL,...JSON.parse(body)}}),signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()-5000))});
        const raw=await counted.text(),artifact=await trace?.artifact('token_count','Provider token count for exact request',{request_artifact:requestArtifact,http_status:counted.status,body:raw.replaceAll(apiKey,'[REDACTED]')});
        await trace?.finish(op,'running',{artifacts:[requestArtifact,artifact],note:'Token-count response retained; generation has not been sent.'});
        if(!counted.ok)throw new Error('Model token count returned HTTP '+counted.status);
        inputTokens=JSON.parse(raw).totalTokens;
        if(!Number.isSafeInteger(inputTokens)||inputTokens<0)throw new Error('Provider token count unavailable');
      }
      await ledger.query("update scout.collection_runs set stats=jsonb_set(stats,array['model_attempts',(jsonb_array_length(stats->'model_attempts')-1)::text,'input_tokens'],to_jsonb($2::int)) where id=$1",[runId,inputTokens]);
      if(inputTokens>MODEL_LIMITS.input)throw Object.assign(new Error('Provider input capacity exceeded: '+inputTokens+' tokens'),{capacity:'input'});
      if(Date.now()+5000>=deadline)throw new Error('Model time limit reached before generation');
      let response;
      try {
        response = await send(endpoint+':generateContent', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body,
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now() - 5000)),
        });
      } catch(error) { throw Object.assign(new Error('Model transport failed; reserved attempt remains counted'),['TimeoutError','AbortError'].includes(error.name)?{capacity:'runtime'}:{}); }
      let raw,readError;
      try { raw = await response.text(); } catch(error) { readError=error; }
      const outputArtifact = await trace?.artifact('model_response','Returned Gemini response body (no headers)',{
        http_status:response.status,...(raw===undefined?{unavailable:'Response body could not be read.'}:{body:raw.replaceAll(apiKey,'[REDACTED]'),credential_redacted:raw.includes(apiKey)}),
      });
      if (trace) await trace.finish(op,'running',{artifacts:[...trace.report.operations[op].artifacts,outputArtifact],http_status:response.status,note:'Response evidence persisted; parsing/completeness checks in progress.'});
      if (!response.ok) {
        await trace?.finish(op,'fail',{note:'Provider error retained without headers. Existing transient-5xx retry policy only.'});
        if ([500, 502, 503, 504].includes(response.status) && attempt < MODEL_LIMITS.retries) continue;
        throw new Error(`Model returned HTTP ${response.status}; candidate remains pending`);
      }
      if (raw===undefined) throw Object.assign(new Error('Model response body unavailable; candidate remains pending'),['TimeoutError','AbortError'].includes(readError?.name)?{capacity:'runtime'}:{});
      let result;
      try { result = JSON.parse(raw); } catch { throw new Error('Invalid model response JSON; candidate remains pending'); }
      await ledger.query(`update scout.collection_runs set stats=jsonb_set(stats,'{model_usage}',
        coalesce(stats->'model_usage','[]'::jsonb)||$2::jsonb) where id=$1`,[runId,JSON.stringify([{...result.usageMetadata,finishReason:result.candidates?.[0]?.finishReason??null}])]);
      const choice = result.candidates?.[0];
      const text = choice?.content?.parts?.filter(part => !part.thought).map(part => part.text ?? '').join('');
      if(choice?.finishReason==='MAX_TOKENS')throw Object.assign(new Error('Model output truncated at token ceiling; source subdivision required'),{capacity:'output'});
      if (choice?.finishReason !== 'STOP') throw Object.assign(new Error('Incomplete model result; candidate remains pending'),{rejected:(text??raw).replaceAll(apiKey,'[REDACTED]')});
      let decisions;
      try { decisions = JSON.parse(text?.replaceAll(apiKey,'[REDACTED]')); } catch { throw Object.assign(new Error('Invalid model JSON; candidate remains pending'),{rejected:text?.replaceAll(apiKey,'[REDACTED]')??'No model text returned'}); }
      await trace?.finish(op,'pass',{finish_reason:choice.finishReason,input_tokens:inputTokens,note:'Complete JSON response parsed. Proposal validation and rating review are separate.'});
      return decisions;
      } catch(error) {
        if (trace?.report.operations[op].state!=='fail') await trace?.finish(op,'fail',{note:'Model transport, response parsing or completion failed; available artifacts are retained.'});
        throw error;
      }
    }
  };
}
