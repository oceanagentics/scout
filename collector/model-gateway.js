import {randomUUID} from 'node:crypto';
import {sourceURL} from './octo-documents.js';
import {MODEL,MODEL_LIMITS,gemini} from './model.js';
import {normalizeFinding} from './finding-contract.js';

export const OPENAI_MODEL='gpt-6-luna';
// Published model capacity, not a Scout quota. OpenAI enforces account rates/spend.
export const OPENAI_LIMITS={inputTokens:1050000,outputTokens:128000};
export const OPENAI_WEB_CALLS=3,OPENAI_WEB_CALL_USD=0.01;
const dispatchPermit=Symbol('accounted_dispatch');
export function isAccounted(limits){return limits?.[dispatchPermit]===true;}
const fail=(reason,details={})=>Object.assign(new Error(reason),{reason,...details});
const finite=n=>Number.isFinite(n)&&n>=0;
const label=v=>typeof v==='string'&&/^[a-z0-9_.-]{1,80}$/i.test(v);
const reasons=new Set('configuration model_configuration invalid_schema accounting database_operation sql_bound attempt_bound provider_cooldown runtime_bound quota provider_spend_limit provider_context_limit search_configuration search_quota search_unavailable source_required source_read_failed source_bound source_json_invalid source_type_unsupported source_preparation_failed input_bound output_bound provider_unknown provider_auth provider_rate_limit provider_unavailable provider_rejected provider_safety invalid_output model_unreadable empty_findings output_incomplete provider_finish provider_refused unexpected_tool token_reservation_overrun invalid_json output_truncated retrieval_metadata_missing url_retrieval_failed invocation_busy'.split(' '));
const reason=error=>reasons.has(error?.reason??error?.message)?error.reason??error.message:'provider_unknown';

// Strict transport schema only; the shared finding schema remains unchanged.
export function strictSchema(schema){
  if(!schema||schema.type!=='object'||schema.anyOf)throw fail('invalid_schema');
  const visit=node=>{
    if(!node||typeof node!=='object')return node;
    const next=Array.isArray(node)?node.map(visit):Object.fromEntries(Object.entries(node).map(([key,value])=>[key,visit(value)]));
    if(node.properties||[].concat(node.type).includes('object')){
      next.properties??={};
      for(const key of Object.keys(next.properties))if(!node.required?.includes(key)){
        const value=next.properties[key];
        if(value.type){value.type=[...new Set([].concat(value.type,'null'))];if(value.enum&&!value.enum.includes(null))value.enum.push(null);}
        else next.properties[key]={anyOf:[value,{type:'null'}]};
      }
      next.required=Object.keys(next.properties);next.additionalProperties=false;
    }
    return next;
  };
  return visit(schema);
}

// The provider investigates URLs; Scout does not fetch or prepare their bodies.
export function openai({apiKey,urls=[],source,model=OPENAI_MODEL,fetch:send=fetch,deadline=Date.now()+100000,now=Date.now}){
  if(model!==OPENAI_MODEL)throw fail('model_configuration');
  const initial=urls.map(url=>{sourceURL(url);return url;});
  if(initial.length>4||new Set(initial).size!==initial.length)throw fail('source_bound');
  return async(instruction,input,schema,limits)=>{
    const diagnostics={provider:'openai',model,retrieval:[],tool_calls:0};
    let dispatched=false,usage;
    try{
      if(limits?.[dispatchPermit]!==true)throw fail('accounting');
      // OpenAI requires an object at the root; keep the list wrapper in this adapter.
      if(schema?.type==='array'&&schema.items?.type!=='object')throw fail('invalid_schema');
      const transportSchema=schema?.type==='array'?{type:'object',properties:{records:schema},required:['records'],additionalProperties:false}:schema;
      const followups=input?.requested_links??[];
      if(!Array.isArray(followups)||followups.length>3)throw fail('source_bound');
      const requested=[...new Set([...initial,...followups.map(link=>{sourceURL(link.url);return link.url;})])];
      if(requested.length>4)throw fail('source_bound');
      if(limits?.task==='url_intake'&&!initial.length)throw fail('source_required');
      if(!apiKey)throw fail('configuration');
      const end=Math.min(deadline,limits.deadline??deadline);
      const body=JSON.stringify({model,store:false,service_tier:'default',reasoning:{effort:'low'},max_output_tokens:limits.outputTokens,
        instructions:instruction+(schema?.type==='array'?'\nFor this API, return the array inside an object with the single key records.':''),
        input:JSON.stringify({input,urls:requested,source}),
        ...(requested.length?{tools:[{type:'web_search',search_content_types:['text','image']}],tool_choice:'required',max_tool_calls:OPENAI_WEB_CALLS,include:['web_search_call.action.sources']}:{}),
        text:{format:{type:'json_schema',name:'scout_result',schema:strictSchema(transportSchema),strict:true}}});
      if(now()+5000>=end)throw fail('runtime_bound');
      dispatched=true;
      let response;
      try{response=await send('https://api.openai.com/v1/responses',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+apiKey},body,
        signal:AbortSignal.timeout(Math.max(1,end-now()-3000))});}catch{throw fail('provider_unknown');}
      diagnostics.http_status=response.status;
      const raw=await response.text();
      if(!response.ok){
        let error;try{error=JSON.parse(raw)?.error;}catch{}
        // Return bounded diagnostics only; OpenAI messages can echo full or masked keys.
        for(const [name,value] of Object.entries({request_id:response.headers.get('x-request-id'),
          error_code:error?.code,error_type:error?.type,error_param:error?.param,error_message:error?.message})){
          if(typeof value==='string')diagnostics[name]=value.replaceAll(apiKey,'[REDACTED]')
            .replace(/\bsk-[a-z0-9_.*-]+/gi,'[REDACTED]').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,name==='error_message'?512:128);
        }
        const spending=['organization_spend_limit_exceeded','project_spend_limit_exceeded','organization_usage_limit_exceeded','credit_balance_exhausted','insufficient_quota'].includes(error?.code);
        const context=error?.code==='context_length_exceeded';
        if(spending)diagnostics.limit_category='spending';
        else if(context)diagnostics.limit_category='context';
        else if(response.status===429)diagnostics.limit_category=/token/i.test(error?.message??'')?'tokens':/request/i.test(error?.message??'')?'requests':'rate';
        const retry=response.headers.get('retry-after'),retryAt=Number(retry)>0?now()+Number(retry)*1000:Date.parse(retry);
        throw fail(spending?'provider_spend_limit':context?'provider_context_limit':response.status===401||response.status===403?'provider_auth':response.status===429?'provider_rate_limit':response.status>=500?'provider_unavailable':'provider_rejected',
          !spending&&(response.status===429||response.status>=500)?{deferred:{retry_at:new Date(retryAt>now()?retryAt:now()+60000).toISOString()}}:{});
      }
      let result;try{result=JSON.parse(raw);}catch{throw fail('invalid_output');}
      if(!result||typeof result!=='object'||Array.isArray(result))throw fail('invalid_output');
      if(Number.isSafeInteger(result.usage?.input_tokens)&&Number.isSafeInteger(result.usage?.output_tokens)&&result.usage.input_tokens>=0&&result.usage.output_tokens>=0)
        usage={input_tokens:result.usage.input_tokens,output_tokens:result.usage.output_tokens,web_search_calls:OPENAI_WEB_CALLS};
      diagnostics.response_status=result.status??null;
      diagnostics.model_version=typeof result.model==='string'?result.model.slice(0,80):null;
      if(result.status!=='completed'){
        if(result.incomplete_details?.reason==='max_output_tokens')diagnostics.limit_category='output';
        throw fail(result.status==='incomplete'?'output_incomplete':'provider_finish');
      }
      if(!Array.isArray(result.output)||result.output.some(item=>!item||typeof item!=='object'||item.type==='message'&&
        (!Array.isArray(item.content)||item.content.some(part=>!part||typeof part!=='object'||part.type==='output_text'&&typeof part.text!=='string'))))throw fail('invalid_output');
      const web=result.output.filter(item=>item.type==='web_search_call');
      diagnostics.tool_calls=web.length;
      if(usage)usage.web_search_calls=web.filter(item=>item.action?.type==='search'||!['open_page','find_in_page'].includes(item.action?.type)).length;
      if(web.length>OPENAI_WEB_CALLS)throw fail('output_bound');
      const content=result.output.flatMap(item=>item.type==='message'?item.content:[]);
      const observed=web.filter(item=>item.status==='completed').flatMap(item=>[
        ...(item.action?.type==='open_page'?[item.action.url]:[]),...(item.action?.sources??[]).map(source=>source.url)]);
      observed.push(...content.flatMap(part=>(part.annotations??[]).filter(a=>a.type==='url_citation').map(a=>a.url)));
      diagnostics.retrieval=[...new Set(observed)].flatMap(url=>{
        try{return [{url:sourceURL(url),status:'URL_RETRIEVAL_STATUS_SUCCESS',method:'provider_web'}];}catch{return [];}
      }).slice(0,20);
      if(content.some(part=>part.type==='refusal'))throw fail('provider_refused');
      if(result.output.some(item=>!['message','reasoning','web_search_call'].includes(item.type)))throw fail('unexpected_tool');
      if(requested.length&&!web.length)throw fail('retrieval_metadata_missing');
      if(requested.length&&!diagnostics.retrieval.length)throw fail('url_retrieval_failed');
      let answer;try{answer=JSON.parse(content.filter(part=>part.type==='output_text').map(part=>part.text).join(''));}catch{throw fail('invalid_output');}
      if(!answer||Array.isArray(answer)||typeof answer!=='object')throw fail('invalid_output');
      if(schema?.type==='array'){
        if(!Array.isArray(answer.records))throw fail('invalid_output');
        answer={status:answer.records.length?'found':'none',records:answer.records};
      }
      return {...answer,_diagnostics:diagnostics,_retrieval:diagnostics.retrieval,
        _usage:usage??{input_tokens:limits.inputTokens,output_tokens:limits.outputTokens,uncertain:true}};
    }catch(error){
      throw fail(reason(error),{dispatched,diagnostics,usage:usage??{input_tokens:limits?.inputTokens??0,output_tokens:limits?.outputTokens??0,uncertain:dispatched},
        ...(error.deferred?{deferred:error.deferred}:{})});
    }
  };
}

// Invocation-local dispatch; reserve/settle must enforce shared current-account
// usage atomically. They receive only numbers and short labels, never traffic.
export function modelGateway({task,routes,providers,accounting,invocation=randomUUID(),deadline=Date.now()+100000,now=Date.now}){
  const attempts=[],counts={};let busy=false,halted=false;
  const usage=rows=>({generations:rows.filter(a=>a.dispatched).length,input_tokens:rows.reduce((n,a)=>n+a.input_tokens,0),output_tokens:rows.reduce((n,a)=>n+a.output_tokens,0),
    estimated_cost_usd:rows.reduce((n,a)=>n+a.cost_usd,0),uncertain:rows.some(a=>a.state==='unknown'),overrun:rows.some(a=>a.overrun)});
  const call=async(provider,instruction,input,schema)=>{
    const config=providers?.[provider];
    const limit=provider==='gemini'?{inputTokens:MODEL_LIMITS.input,outputTokens:MODEL_LIMITS.output}:OPENAI_LIMITS;
    if(!label(task)||!label(provider)||!label(config?.model)||typeof config?.generate!=='function'||
      provider==='openai'&&config.model!==OPENAI_MODEL||provider==='gemini'&&config.model!==MODEL)throw fail('configuration');
    if(typeof accounting?.reserve!=='function'||typeof accounting?.settle!=='function')throw fail('accounting');
    if(halted||attempts.length>=2)throw fail('attempt_bound');
    const cooldown=Math.max(0,...attempts.filter(a=>a.provider===provider).map(a=>Date.parse(a.deferred?.retry_at)||0));
    if(cooldown>now())throw fail('provider_cooldown',{deferred:{retry_at:new Date(cooldown).toISOString()}});
    if(!finite(deadline)||deadline-now()>100000||now()+5000>=deadline)throw fail('runtime_bound');
    const webCost=provider==='openai'?OPENAI_WEB_CALLS*OPENAI_WEB_CALL_USD:0;
    // Unknown calls retain a conservative maximum estimate; this does not gate work.
    const cost=provider==='openai'?(limit.inputTokens*0.25+limit.outputTokens*0.75+OPENAI_WEB_CALLS*OPENAI_WEB_CALL_USD*1e6)/1e6:0;
    const receipt={invocation,id:randomUUID(),task,provider,model:config.model,input_tokens:limit.inputTokens,output_tokens:limit.outputTokens,cost_usd:cost};
    let reserved;try{reserved=await accounting.reserve({...receipt,max_attempts:2,deadline});}catch{halted=true;throw fail('accounting');}
    if(reserved?.allowed!==true)throw fail(reasons.has(reserved?.reason)?reserved.reason:'quota',reserved?.retry_at?{deferred:{retry_at:reserved.retry_at}}:{});
    const attempt={provider,model:config.model,dispatched:false,state:'unknown',reason:null,input_tokens:limit.inputTokens,output_tokens:limit.outputTokens,cost_usd:cost};
    attempts.push(attempt);counts[provider]=(counts[provider]??0)+1;
    let answer,error;
    try{
      if(now()+5000>=deadline)throw fail('runtime_bound',{dispatched:false});
      answer=await config.generate(instruction,input,schema,{...limit,deadline:provider==='gemini'?Math.min(deadline,now()+45000):deadline,task,[dispatchPermit]:true});attempt.dispatched=true;
      if(!answer||typeof answer!=='object'||Array.isArray(answer))throw fail('invalid_output');
      routes[task].validate?.(answer);
    }
    catch(cause){error=cause;attempt.dispatched=cause.dispatched!==false;attempt.reason=reason(cause);}
    const reported=answer?._usage??error?.usage;
    attempt.diagnostics=answer?._diagnostics??error?.diagnostics??{};
    if(!attempt.dispatched){attempt.input_tokens=attempt.output_tokens=attempt.cost_usd=0;attempt.state='settled';}
    else if(reported&&Number.isSafeInteger(reported.input_tokens)&&reported.input_tokens>=0&&Number.isSafeInteger(reported.output_tokens)&&reported.output_tokens>=0){
      attempt.input_tokens=reported.uncertain?Math.max(limit.inputTokens,reported.input_tokens):reported.input_tokens;
      attempt.output_tokens=reported.uncertain?Math.max(limit.outputTokens,reported.output_tokens):reported.output_tokens;
      attempt.state=reported.uncertain?'unknown':'settled';
      const long=attempt.input_tokens>272000;
      attempt.cost_usd=provider==='openai'?reported.uncertain?cost:
        (attempt.input_tokens*(long?0.25:0.125)+attempt.output_tokens*(long?0.75:0.5))/1e6+
        (Number.isInteger(reported.web_search_calls)&&reported.web_search_calls>=0?reported.web_search_calls*OPENAI_WEB_CALL_USD:webCost):0;
      attempt.overrun=provider==='gemini'&&(!!reported.overrun||reported.input_tokens>limit.inputTokens||reported.output_tokens>limit.outputTokens);
      if(attempt.overrun){halted=true;if(!error)attempt.reason='token_reservation_overrun';}
    }
    if(error?.deferred)attempt.deferred=error.deferred;
    try{await accounting.settle({...receipt,input_tokens:attempt.input_tokens,output_tokens:attempt.output_tokens,cost_usd:attempt.cost_usd,state:attempt.state,reason:attempt.reason,
      cooldown_until:error?.deferred?.retry_at??null});}catch{halted=true;throw fail('accounting',{dispatched:attempt.dispatched});}
    if(error)throw fail(attempt.reason,{dispatched:attempt.dispatched,...(error.deferred?{deferred:error.deferred}:{})});
    return answer;
  };
  return async(instruction,input,schema)=>{
    if(busy)throw fail('invocation_busy');busy=true;
    const start=attempts.length,route=routes?.[task];
    try{
      let answer;
      try{answer=await call(route?.provider,instruction,input,schema);}catch(error){
        const first=attempts.at(-1);
        if(halted||attempts.length>=2||!route?.fallbackReasons?.includes(error.reason)||!route.fallback||first?.provider!=='gemini'||!first.dispatched||counts[route.fallback])throw error;
        answer=await call(route.fallback,instruction,input,schema);
      }
      const current=attempts.slice(start);
      return {...answer,_usage:usage(current),
        _diagnostics:{provider:current.at(-1).provider,model:current.at(-1).model,attempts:current}};
    }catch(error){throw fail(error.reason??'provider_unknown',{dispatched:attempts.slice(start).some(a=>a.dispatched),usage:usage(attempts.slice(start)),diagnostics:{attempts:attempts.slice(start)},...(error.deferred?{deferred:error.deferred}:{})});}
    finally{busy=false;}
  };
}

export function modelAccounting(ledger){
  return {
    reserve:async r=>(await ledger.query('select * from scout.reserve_provider($1,$2,$3,$4,$5)',[r.invocation,r.id,r.provider,r.max_attempts,r.provider==='openai'?OPENAI_WEB_CALLS:0])).rows[0],
    settle:async r=>{const result=(await ledger.query('select * from scout.settle_provider($1,$2,$3,$4,$5,$6,$7)',
      [r.id,r.input_tokens,r.output_tokens,r.state,r.reason,r.cooldown_until,r.cost_usd])).rows[0];if(!result?.settled)throw fail('accounting');}};
}

export function trackerModel({apiKey,tavilyApiKey,openaiApiKey,ledger,source,invocation=randomUUID(),deadline=Date.now()+100000,fetch:send=fetch}){
  return modelGateway({task:'url_intake',accounting:modelAccounting(ledger),invocation,deadline,
    routes:{url_intake:{provider:'gemini',fallback:'openai',fallbackReasons:['url_retrieval_failed','retrieval_metadata_missing','model_unreadable','invalid_json','invalid_output','output_truncated','output_bound','empty_findings','provider_rate_limit','provider_unavailable','provider_unknown'],
      validate:answer=>{
        if(!['found','none','unreadable'].includes(answer.status)||!Array.isArray(answer.records))throw fail('invalid_output');
        if(answer.status==='unreadable')throw fail('model_unreadable');
        if(answer.status==='found'&&!answer.records.slice(0,8).some(r=>normalizeFinding(r,source.url)))throw fail('empty_findings');
      }}},
    providers:{gemini:{model:MODEL,generate:gemini({apiKey,tavilyApiKey,ledger,deadline,fetch:send})},
      openai:{model:OPENAI_MODEL,generate:openai({apiKey:openaiApiKey,urls:[source.url],source:{identity:source.identity,native_id:source.native_id,native_ref:source.native_ref},deadline,fetch:send})}}});
}
