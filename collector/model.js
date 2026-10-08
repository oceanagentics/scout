import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

export const MODEL = 'gemini-3.5-flash-lite';
export const MODEL_LIMITS = { minute: 2, run: 10, tokens: 0, day: 0, input: 1048576, output: 65536, retries: 1 };

export function modelLimits(settings = {}) {
  const limits = {...MODEL_LIMITS,...settings};
  for (const key of ['minute','run','tokens','day'])
    if (!Number.isSafeInteger(limits[key]) || limits[key] < (['tokens','day'].includes(key)?0:1)) throw new Error('Invalid model limit: '+key);
  return limits;
}

// Read-only scheduling hint. The reservation repeats this check under its lock.
export function modelBudgetSQL(runId = null, runLimit = MODEL_LIMITS.run, limits = MODEL_LIMITS, tokens = 0, exclude = '') {
  if (runId!==null&&!/^[a-f0-9-]{36}$/i.test(runId) || !Number.isSafeInteger(tokens)||tokens<0 || exclude&&!/^[a-f0-9-]{36}$/i.test(exclude)) throw new Error('Invalid model budget');
  limits=modelLimits(limits);
  if(!Number.isSafeInteger(runLimit)||runLimit<1||runLimit>limits.run)throw new Error('Invalid run attempt limit');
  return `with moment as (select clock_timestamp() now), recent as (
    select r.id,r.stats from scout.collection_runs r,moment m
    where r.outcome='running' or r.finished_at >= (date_trunc('day',m.now at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles')
      or (r.stats->>'model_retry_at')::timestamptz > m.now
  ), attempts as (
    select (a->>'at')::timestamptz at,coalesce((a->>'input_tokens')::bigint,0) tokens
    from recent r cross join lateral jsonb_array_elements(coalesce(r.stats->'model_attempts','[]'::jsonb)) a
    where coalesce(a->>'id','')<>'${exclude || 'none'}'
  ), usage as (
    select m.now,count(*) filter(where a.at>m.now-interval '60 seconds') rpm,
      coalesce(sum(a.tokens) filter(where a.at>m.now-interval '60 seconds'),0) tpm,
      min(a.at) filter(where a.at>m.now-interval '60 seconds')+interval '60 seconds' minute_retry,
      count(*) filter(where (a.at at time zone 'America/Los_Angeles')::date=(m.now at time zone 'America/Los_Angeles')::date) rpd,
      (select max((stats->>'model_retry_at')::timestamptz) from recent) provider_retry
    from moment m left join attempts a on true group by m.now
  ), budget as (
    select *,case
      ${runId ? `when (select outcome from scout.collection_runs where id='${runId}') is distinct from 'running' then 'unavailable'
      when (select jsonb_array_length(coalesce(stats->'model_attempts','[]'::jsonb)) from scout.collection_runs where id='${runId}')-${exclude?1:0}>=${runLimit} then 'turn'` : ''}
      when provider_retry>now then 'provider'
      when ${limits.day}>0 and rpd>=${limits.day} then 'day'
      when rpm>=${limits.minute} then 'minute'
      when ${limits.tokens}>0 and tpm+${tokens}>${limits.tokens} then 'tokens' end reason from usage
  ) select reason,case when reason='provider' then provider_retry when reason='day' then
    ((date_trunc('day',now at time zone 'America/Los_Angeles')+interval '1 day') at time zone 'America/Los_Angeles')
    when reason in ('minute','tokens') then coalesce(minute_retry,now+interval '60 seconds') else now end retry_at from budget`;
}

export const requestBody = (instruction,input,schema) => JSON.stringify({systemInstruction:{parts:[{text:instruction}]},
  contents:[{role:'user',parts:[{text:JSON.stringify(input)}]}],generationConfig:{maxOutputTokens:MODEL_LIMITS.output,
    thinkingConfig:{thinkingLevel:Array.isArray(input)&&input.length&&input.every(i=>['extract','resolve'].includes(i.stage))?'medium':'minimal'},responseMimeType:'application/json',responseJsonSchema:schema}});

// One autocommitted statement. Never call this inside a collection transaction.
// The same hosted collection_runs ledger is required for local and hosted calls.
export function reservationSQL(runId, inputBytes, runLimit = MODEL_LIMITS.run, limits = MODEL_LIMITS, tokens = null, attemptId = randomUUID(), model = MODEL) {
  if (!/^[a-f0-9-]{36}$/i.test(runId) || !Number.isSafeInteger(inputBytes) || inputBytes < 1) throw new Error('Invalid model reservation');
  if (!/^[a-f0-9-]{36}$/i.test(attemptId)) throw new Error('Invalid model attempt');
  if (![MODEL,'gemini-3.5-flash'].includes(model)) throw new Error('Invalid model');
  const budget=modelBudgetSQL(runId,runLimit,limits,tokens??0,tokens===null?'':attemptId);
  return `do $budget$
  declare attempts jsonb; allowance record; moment timestamptz;
  begin
    perform pg_advisory_xact_lock(hashtextextended('scout:model-budget',0));
    moment := clock_timestamp();
    select coalesce(stats->'model_attempts','[]'::jsonb) into attempts
      from scout.collection_runs where id='${runId}' and outcome='running' for update;
    if attempts is null then raise exception 'Model run unavailable'; end if;
    select * into allowance from (${budget}) available;
    if allowance.reason='unavailable' then raise exception 'Model run unavailable'; end if;
    if allowance.reason is not null then raise exception 'Model quota reached'; end if;
    ${tokens===null ? `attempts := attempts || jsonb_build_array(jsonb_build_object('id','${attemptId}','at',moment,'reserved_at',moment,'input_bytes',${inputBytes},'input_token_limit',${MODEL_LIMITS.input},'output_bound',${MODEL_LIMITS.output},'model','${model}'));`
      : `if not exists(select 1 from jsonb_array_elements(attempts) a where a->>'id'='${attemptId}') then raise exception 'Model attempt unavailable'; end if;
    select jsonb_agg(case when a->>'id'='${attemptId}' then a||jsonb_build_object('at',moment,'input_tokens',${tokens}) else a end order by n) into attempts from jsonb_array_elements(attempts) with ordinality v(a,n);`}
    update scout.collection_runs set stats=jsonb_set(stats,'{model_attempts}',attempts)
      where id='${runId}';
  end $budget$;`;
}

export function gemini({ apiKey, ledger, runId, runLimit, limits, pace = false, wait:waitForQuota = pace, fetch: send = fetch, deadline = Date.now() + 100000, trace,
  sleep = ms => new Promise(resolve=>setTimeout(resolve,ms)) }) {
  const configured=limits!==undefined,allocated=runLimit;
  limits=modelLimits(limits??{});runLimit??=limits.run;
  return async (instruction, input, schema) => {
    if (!apiKey || !ledger) {
      if(pace&&ledger){
        const deferred={reason:'configuration',retry_at:new Date(Date.now()+300000).toISOString()};
        await ledger.query("update scout.collection_runs set stats=stats||jsonb_build_object('model_retry_at',$2::text,'model_blocker','configuration') where id=$1",[runId,deferred.retry_at]);
        throw Object.assign(new Error('Model configuration unavailable; fetching continues'),{deferred});
      }
      throw new Error('Model and shared hosted budget ledger are required');
    }
    // Hosted settings are published on real run rows. Local assessment and
    // notification callers follow the latest published policy in the same DB.
    if(configured)await ledger.query("update scout.collection_runs set stats=stats||jsonb_build_object('model_limits',$2::jsonb) where id=$1",[runId,JSON.stringify(limits)]);
    else{
      const stored=(await ledger.query("select stats->'model_limits' limits from scout.collection_runs where stats ? 'model_limits' order by started_at desc,id desc limit 1")).rows[0]?.limits;
      if(stored)limits=modelLimits(stored);runLimit=Math.min(allocated??limits.run,limits.run);
    }
    const body = requestBody(instruction,input,schema);
    const model=Array.isArray(input)&&input.every(i=>i.stage==='resolve')&&input.some(i=>i.missing_fields?.length)?'gemini-3.5-flash':MODEL;
    const inputBytes = Buffer.byteLength(body),endpoint=`https://generativelanguage.googleapis.com/v1beta/models/${model}`;
    const requestArtifact = await trace?.artifact('model_request', 'Exact Gemini request body (no headers)', { model, body: body.replaceAll(apiKey,'[REDACTED]'), input_bytes: inputBytes, credential_redacted: body.includes(apiKey) });
    let inputTokens;
    for (let attempt = 0; ; attempt++) {
      if (Date.now() + 5000 >= deadline) throw Object.assign(new Error('Model time limit reached'),pace?{deferred:{reason:'runtime',retry_at:new Date().toISOString()}}:{});
      const attemptId=randomUUID();
      const reserve=async tokens=>{
        for(;;){
          try {await ledger.query(reservationSQL(runId,inputBytes,runLimit,limits,tokens,attemptId,model));return;}
          catch(error){
            if(!/Model quota reached/.test(error.message))throw error;
            const allowance=(await ledger.query(modelBudgetSQL(runId,runLimit,limits,tokens??0,tokens===null?'':attemptId))).rows[0];
            // Another caller may have finished between the denied reservation and hint.
            if(!allowance.reason)continue;
            const wait=Math.max(1,Date.parse(allowance.retry_at)-Date.now()+100);
            if(pace&&waitForQuota&&['minute','tokens','provider'].includes(allowance.reason)&&wait<=60000&&Date.now()+wait+15000<deadline){await sleep(wait);continue;}
            const deferred={reason:allowance.reason,retry_at:allowance.retry_at};
            await ledger.query("update scout.collection_runs set stats=stats||jsonb_build_object('model_deferred',$2::jsonb) where id=$1",[runId,JSON.stringify(deferred)]);
            throw Object.assign(new Error('Model quota deferred: '+allowance.reason),{deferred});
          }
        }
      };
      await reserve(null); // durable BEFORE token counting or generation
      const op = await trace?.start('generate', { source_ids: input.map(i=>i.source_id), artifacts: [requestArtifact], attempt: attempt+1, note: 'Attempt reserved; token preflight precedes generation.' });
      try {
      if(inputTokens===undefined){
        let counted;
        try {counted=await send(endpoint+':countTokens',{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':apiKey},
          body:JSON.stringify({generateContentRequest:{model:'models/'+model,...JSON.parse(body)}}),signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()-5000))});}
        catch(error){throw Object.assign(new Error('Model token count transport failed; reserved attempt remains counted'),pace?{deferred:{reason:'network',retry_at:new Date(Date.now()+60000).toISOString()}}:{});}
        const raw=await counted.text(),artifact=await trace?.artifact('token_count','Provider token count for exact request',{request_artifact:requestArtifact,http_status:counted.status,body:raw.replaceAll(apiKey,'[REDACTED]')});
        await trace?.finish(op,'running',{artifacts:[requestArtifact,artifact],note:'Token-count response retained; generation has not been sent.'});
        if(!counted.ok)throw Object.assign(new Error('Model token count returned HTTP '+counted.status),counted.status===429?{quotaResponse:{response:counted,raw}}:{});
        inputTokens=JSON.parse(raw).totalTokens;
        if(!Number.isSafeInteger(inputTokens)||inputTokens<0)throw new Error('Provider token count unavailable');
      }
      if(inputTokens>MODEL_LIMITS.input)throw Object.assign(new Error('Provider input capacity exceeded: '+inputTokens+' tokens'),{capacity:'input'});
      if(limits.tokens&&inputTokens>limits.tokens)throw Object.assign(new Error('Request exceeds configured provider input TPM capacity'),{capacity:'input'});
      await reserve(inputTokens);
      if(Date.now()+5000>=deadline)throw Object.assign(new Error('Model time limit reached before generation'),pace?{deferred:{reason:'runtime',retry_at:new Date().toISOString()}}:{});
      let response;
      try {
        response = await send(endpoint+':generateContent', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body,
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now() - 5000)),
        });
      } catch(error) { throw Object.assign(new Error('Model transport failed; reserved attempt remains counted'),pace?{deferred:{reason:'network',retry_at:new Date(Date.now()+60000).toISOString()}}:['TimeoutError','AbortError'].includes(error.name)?{capacity:'runtime'}:{}); }
      let raw,readError;
      try { raw = await response.text(); } catch(error) { readError=error; }
      const outputArtifact = await trace?.artifact('model_response','Returned Gemini response body (no headers)',{
        http_status:response.status,...(raw===undefined?{unavailable:'Response body could not be read.'}:{body:raw.replaceAll(apiKey,'[REDACTED]'),credential_redacted:raw.includes(apiKey)}),
      });
      if (trace) await trace.finish(op,'running',{artifacts:[...trace.report.operations[op].artifacts,outputArtifact],http_status:response.status,note:'Response evidence persisted; parsing/completeness checks in progress.'});
      if (!response.ok) {
        await trace?.finish(op,'fail',{note:'Provider error retained without headers. Existing transient-5xx retry policy only.'});
        if(response.status===429)throw Object.assign(new Error('Provider model quota deferred'),{quotaResponse:{response,raw}});
        if ([500, 502, 503, 504].includes(response.status) && attempt < MODEL_LIMITS.retries) continue;
        if(pace&&response.status>=500)throw Object.assign(new Error('Provider temporarily unavailable'),{deferred:{reason:'network',retry_at:new Date(Date.now()+60000).toISOString()}});
        throw new Error(`Model returned HTTP ${response.status}; candidate remains pending`);
      }
      if (raw===undefined) throw Object.assign(new Error('Model response body unavailable; candidate remains pending'),pace?{deferred:{reason:'network',retry_at:new Date(Date.now()+60000).toISOString()}}:['TimeoutError','AbortError'].includes(readError?.name)?{capacity:'runtime'}:{});
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
        if(error.quotaResponse){
          const {response,raw}=error.quotaResponse,daily=/PerDay|per[_ ]day/i.test(raw??'');
          const header=response.headers.get('retry-after'),seconds=Number(header)||Number((raw??'').match(/"retryDelay"\s*:\s*"([\d.]+)s"/)?.[1])||60;
          const retry_at=daily?(await ledger.query("select ((date_trunc('day',clock_timestamp() at time zone 'America/Los_Angeles')+interval '1 day') at time zone 'America/Los_Angeles') retry_at")).rows[0].retry_at
            :new Date(Math.max(Date.now()+seconds*1000,Date.parse(header)||0)).toISOString();
          await ledger.query("update scout.collection_runs set stats=stats||jsonb_build_object('model_retry_at',$2::text) where id=$1",[runId,retry_at]);
          error.deferred={reason:daily?'day':'provider',retry_at};delete error.quotaResponse;
        }
        if(pace&&!error.deferred&&!error.capacity&&(['TimeoutError','AbortError'].includes(error.name)||/Model token count returned HTTP 5\d\d/.test(error.message)))
          error.deferred={reason:'network',retry_at:new Date(Date.now()+60000).toISOString()};
        if(pace&&/HTTP (401|403|404)/.test(error.message))error.deferred={reason:'configuration',retry_at:new Date(Date.now()+300000).toISOString()};
        if(['network','configuration'].includes(error.deferred?.reason))
          await ledger.query("update scout.collection_runs set stats=stats||jsonb_build_object('model_retry_at',$2::text,'model_blocker',$3::text) where id=$1",[runId,error.deferred.retry_at,error.deferred.reason]);
        if (trace?.report.operations[op].state!=='fail') await trace?.finish(op,error.deferred&&error.deferred.reason!=='network'?'skipped':'fail',{note:'Model transport, response parsing or completion deferred/failed; available artifacts are retained.'});
        throw error;
      }
    }
  };
}
