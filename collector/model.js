import {Buffer} from 'node:buffer';
import {randomUUID} from 'node:crypto';

export const MODEL='gemini-3.5-flash-lite';
export const MODEL_LIMITS={minute:2,run:2,tokens:125000,day:250,input:60000,output:8192};

export function requestBody(instruction,input,schema){
  const body={contents:[{role:'user',parts:[{text:instruction},...(Array.isArray(input)&&!input.length?[]:[{text:JSON.stringify(input)}])]}],
    tools:[{urlContext:{}}],store:false,
    generationConfig:{maxOutputTokens:MODEL_LIMITS.output,thinkingConfig:{thinkingLevel:'minimal'},responseMimeType:'application/json',responseJsonSchema:schema}};
  if(Buffer.byteLength(JSON.stringify(body))>24000)throw new Error('input_bound');
  return JSON.stringify(body);
}

// All request/response material is invocation-local. No automatic provider retries.
export function gemini({apiKey,ledger,invocation=randomUUID(),maxCalls=2,fetch:send=fetch,deadline=Date.now()+100000}){
  if(!Number.isInteger(maxCalls)||maxCalls<1||maxCalls>2)throw new Error('invocation_bound');
  return async(instruction,input,schema)=>{
    if(!apiKey||!ledger)throw Object.assign(new Error('configuration'),{reason:'configuration'});
    if(Date.now()+5000>=deadline)throw Object.assign(new Error('runtime_bound'),{reason:'runtime_bound'});
    const body=requestBody(instruction,input,schema),id=randomUUID(),endpoint=`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}`;
    const reserve=async(tokens)=>{
      const result=(await ledger.query('select * from scout.reserve_model($1,$2,$3,$4)',[invocation,id,tokens,maxCalls])).rows[0];
      if(!result?.allowed)throw Object.assign(new Error('quota'),{reason:'quota',deferred:{reason:'quota',retry_at:result?.retry_at}});
    };
    await reserve(MODEL_LIMITS.input); // URL retrieval is unknown: reserve headroom before dispatch
    let tokens=MODEL_LIMITS.input,output=0,state='settled',reason=null,dispatched=false,retryAt;
    const request=async(suffix,payload)=>{
      let response;
      try{response=await send(endpoint+suffix,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':apiKey},body:payload,
        signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()-3000))});}
      catch{throw Object.assign(new Error('provider_unknown'),{reason:'provider_unknown'});}
      const reader=response.body?.getReader(),decoder=new TextDecoder();let raw='',bytes=0;
      try{for(;;){const part=await reader?.read();if(!part||part.done)break;bytes+=part.value.byteLength;if(bytes>131072)throw new Error('output_bound');raw+=decoder.decode(part.value,{stream:true});}raw+=decoder.decode();}
      finally{await reader?.cancel();}
      if(!response.ok){
        if(response.status===429||response.status>=500){
          const header=response.headers.get('retry-after'),seconds=Number(header)||Number(raw.match(/"retryDelay"\s*:\s*"([\d.]+)s"/)?.[1])||60;
          retryAt=new Date(Math.max(Date.now()+seconds*1000,Date.parse(header)||0)).toISOString();
          if(/PerDay|per[_ ]day/i.test(raw))retryAt=(await ledger.query("select ((date_trunc('day',clock_timestamp() at time zone 'America/Los_Angeles')+interval '1 day') at time zone 'America/Los_Angeles') retry_at")).rows[0].retry_at;
        }
        throw Object.assign(new Error('provider_unavailable'),{reason:'provider_unavailable'});
      }
      try{return JSON.parse(raw);}catch{throw new Error('invalid_output');}
    };
    try{
      if(Date.now()+5000>=deadline)throw new Error('runtime_bound');
      dispatched=true;
      const result=await request(':generateContent',body);
      const usage=result.usageMetadata;
      if(Number.isSafeInteger(usage?.promptTokenCount)&&Number.isSafeInteger(usage?.totalTokenCount)){
        tokens=usage.promptTokenCount+(usage.toolUsePromptTokenCount??0);
        output=(usage.candidatesTokenCount??0)+(usage.thoughtsTokenCount??0);
      }else state='unknown';
      if(tokens>MODEL_LIMITS.input){reason='token_reservation_overrun';retryAt=new Date(Date.now()+120000).toISOString();}
      const choice=result.candidates?.[0];
      if(choice?.finishReason!=='STOP')throw new Error(choice?.finishReason==='MAX_TOKENS'?'output_truncated':'provider_finish');
      let answer;
      try{answer=JSON.parse(choice.content.parts.filter(p=>!p.thought).map(p=>p.text??'').join(''));}
      catch{throw new Error('invalid_json');}
      const retrieval=choice.urlContextMetadata?.urlMetadata??[];
      if(!retrieval.some(r=>r.urlRetrievalStatus==='URL_RETRIEVAL_STATUS_SUCCESS'))throw new Error('url_unreadable');
      return {...answer,_retrieval:retrieval.map(r=>({url:r.retrievedUrl,status:r.urlRetrievalStatus})),
        _usage:{input_tokens:tokens,output_tokens:output,overrun:tokens>MODEL_LIMITS.input}};
    }catch(error){
      reason=['input_bound','output_bound','runtime_bound','invalid_json','output_truncated','provider_finish','url_unreadable','provider_unavailable','provider_unknown','quota'].includes(error.message)?error.message:'provider_unknown';
      if(dispatched&&['provider_unknown','output_bound','provider_unavailable','invalid_json'].includes(reason))state='unknown';
      throw Object.assign(new Error(reason),{reason,dispatched,usage:{input_tokens:tokens,output_tokens:output,uncertain:state==='unknown'},...(retryAt||error.deferred?{deferred:{reason,retry_at:retryAt??error.deferred.retry_at}}:{})});
    }finally{
      await ledger.query('update scout.quota_reservations set input_tokens=$2,output_tokens=$3,state=$4,reason=$5 where id=$1 returning id',[id,tokens,output,state,reason]);
      if(retryAt)await ledger.query('update scout.quota_policy set cooldown_until=greatest(cooldown_until,$1::timestamptz) where id returning id',[retryAt]);
    }
  };
}
