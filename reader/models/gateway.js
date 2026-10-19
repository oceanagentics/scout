import {randomUUID} from 'node:crypto';
import {MODEL,gemini} from './gemini.js';
import {OPENAI_MODEL,openai} from './openai.js';
import {normalizeFinding} from '../findings.js';
import {dispatchPermit,reasons,modelErrorReason} from './contract.js';

const OPENAI_WEB_CALL_USD=0.01;
const fail=(reason,details={})=>Object.assign(new Error(reason),{reason,...details});
const label=v=>typeof v==='string'&&/^[a-z0-9_.-]{1,80}$/i.test(v);
// Invocation-local dispatch; reserve/settle must enforce shared current-account
// usage atomically. They receive only numbers and short labels, never traffic.
export function modelGateway({task,routes,providers,accounting,invocation=randomUUID(),deadline,now=Date.now}){
  const attempts=[],counts={};let busy=false,halted=false,remainingAttempts;
  const usage=rows=>({generations:rows.filter(a=>a.dispatched).length,input_tokens:rows.reduce((n,a)=>n+a.input_tokens,0),output_tokens:rows.reduce((n,a)=>n+a.output_tokens,0),
    estimated_cost_usd:rows.reduce((n,a)=>n+a.cost_usd,0),uncertain:rows.some(a=>a.state==='unknown')});
  const call=async(provider,instruction,input,schema)=>{
    const config=providers?.[provider];
    if(!label(task)||!label(provider)||!label(config?.model)||typeof config?.generate!=='function'||
      provider==='openai'&&config.model!==OPENAI_MODEL||provider==='gemini'&&config.model!==MODEL)throw fail('configuration');
    if(typeof accounting?.reserve!=='function'||typeof accounting?.settle!=='function')throw fail('accounting');
    // Cache the allowance issued by SQL; do not define a second local policy.
    if(halted||remainingAttempts===0)throw fail('attempt_bound');
    const receipt={invocation,id:randomUUID(),task,provider,model:config.model};
    let reserved;try{reserved=await accounting.reserve({...receipt,deadline});}catch{halted=true;throw fail('accounting');}
    if(reserved?.allowed!==true)throw fail(reasons.has(reserved?.reason)?reserved.reason:'quota',reserved?.retry_at?{deferred:{retry_at:reserved.retry_at}}:{});
    const limit=reserved.settings,cost=Number(reserved.cost_usd);
    if(!limit||limit.model!==config.model||!Number.isSafeInteger(limit.inputTokens)||!Number.isSafeInteger(limit.outputTokens)||
      !Number.isFinite(Date.parse(limit.deadline))||!Number.isFinite(cost)||cost<0||!Number.isInteger(reserved.remaining_attempts)){
      halted=true;throw fail('accounting');
    }
    remainingAttempts=reserved.remaining_attempts;
    Object.assign(receipt,{input_tokens:limit.inputTokens,output_tokens:limit.outputTokens,cost_usd:cost});
    const webCost=provider==='openai'?limit.maxToolCalls*OPENAI_WEB_CALL_USD:0;
    const attempt={provider,model:config.model,dispatched:false,state:'unknown',reason:null,input_tokens:limit.inputTokens,output_tokens:limit.outputTokens,cost_usd:cost};
    attempts.push(attempt);counts[provider]=(counts[provider]??0)+1;
    let answer,error;
    try{
      const remaining=Date.parse(limit.deadline)-now();
      if(remaining<=0)throw fail('runtime_bound',{dispatched:false});
      answer=await config.generate(instruction,input,schema,{...limit,signal:AbortSignal.timeout(remaining),task,[dispatchPermit]:true});attempt.dispatched=true;
      if(!answer||typeof answer!=='object'||Array.isArray(answer))throw fail('invalid_output');
      routes[task].validate?.(answer);
    }
    catch(cause){error=cause;attempt.dispatched=cause.dispatched!==false;attempt.reason=modelErrorReason(cause);}
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
        if(halted||remainingAttempts===0||!route?.fallbackReasons?.includes(error.reason)||!route.fallback||first?.provider!=='gemini'||!first.dispatched||counts[route.fallback])throw error;
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
    reserve:async r=>(await ledger.query('select * from scout.reserve_provider($1,$2,$3,$4::timestamptz)',[r.invocation,r.id,r.provider,r.deadline==null?null:new Date(r.deadline).toISOString()])).rows[0],
    settle:async r=>{const result=(await ledger.query('select * from scout.settle_provider($1,$2,$3,$4,$5,$6,$7)',
      [r.id,r.input_tokens,r.output_tokens,r.state,r.reason,r.cooldown_until,r.cost_usd])).rows[0];if(!result?.settled)throw fail('accounting');}};
}

export function trackerModel({apiKey,openaiApiKey,ledger,source,provider,invocation=randomUUID(),deadline,fetch:send=fetch}){
  if(provider!==undefined&&!['gemini','openai'].includes(provider))throw fail('configuration');
  return modelGateway({task:'url_intake',accounting:modelAccounting(ledger),invocation,deadline,
    routes:{url_intake:{provider:provider??'gemini',fallback:provider?undefined:'openai',fallbackReasons:['url_retrieval_failed','retrieval_metadata_missing','model_unreadable','invalid_json','invalid_output','output_truncated','output_bound','empty_findings','provider_rate_limit','provider_unavailable','provider_unknown'],
      validate:answer=>{
        if(!['found','none','unreadable'].includes(answer.status)||!Array.isArray(answer.records))throw fail('invalid_output');
        if(answer.status==='unreadable')throw fail('model_unreadable');
        if(answer.status==='found'&&!answer.records.slice(0,8).some(r=>normalizeFinding(r,source.url)))throw fail('empty_findings');
      }}},
    providers:{gemini:{model:MODEL,generate:gemini({apiKey,ledger,fetch:send})},
      openai:{model:OPENAI_MODEL,generate:openai({apiKey:openaiApiKey,urls:[source.url],fetch:send})}}});
}
