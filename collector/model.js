import {Buffer} from 'node:buffer';
import {isAccounted} from './model-gateway.js';

export const MODEL='gemini-3.5-flash-lite';

export function requestBody(instruction,input,schema,limits){
  const body={systemInstruction:{parts:[{text:instruction}]},
    contents:[{role:'user',parts:[{text:JSON.stringify(input)}]}],
    tools:[{urlContext:{}},{googleSearch:{}}],store:false,
    generationConfig:{maxOutputTokens:limits.outputTokens,thinkingConfig:{thinkingLevel:'minimal'},responseMimeType:'application/json',responseJsonSchema:schema}};
  if(Buffer.byteLength(JSON.stringify(body))>limits.inputBytes)throw new Error('input_bound');
  return JSON.stringify(body);
}

// All request/response material is invocation-local. No automatic provider retries.
export function gemini({apiKey,ledger,fetch:send=fetch}){
  return async(instruction,input,schema,limits)=>{
    if(!isAccounted(limits))throw Object.assign(new Error('accounting'),{reason:'accounting',dispatched:false});
    if(!apiKey)throw Object.assign(new Error('configuration'),{reason:'configuration',dispatched:false});
    let body;try{body=requestBody(instruction,input,schema,limits);}catch(error){throw Object.assign(error,{dispatched:false});}
    const endpoint=`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}`;
    let tokens=limits.inputTokens,output=0,state='unknown',reason=null,dispatched=false,retryAt;
    const diagnostics={};
    const request=async(suffix,payload)=>{
      let response;
      try{response=await send(endpoint+suffix,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':apiKey},body:payload,
        signal:limits.signal});}
      catch{throw Object.assign(new Error('provider_unknown'),{reason:'provider_unknown'});}
      diagnostics.http_status=response.status;
      const reader=response.body?.getReader(),decoder=new TextDecoder();let raw='',bytes=0;
      try{for(;;){const part=await reader?.read();if(!part||part.done)break;bytes+=part.value.byteLength;if(bytes>limits.outputBytes)throw new Error('output_bound');raw+=decoder.decode(part.value,{stream:true});}raw+=decoder.decode();}
      finally{await reader?.cancel();}
      if(!response.ok){
        if(response.status===429||response.status>=500){
          const header=response.headers.get('retry-after'),seconds=Number(header)||Number(raw.match(/"retryDelay"\s*:\s*"([\d.]+)s"/)?.[1])||60;
          retryAt=new Date(Math.max(Date.now()+seconds*1000,Date.parse(header)||0)).toISOString();
          if(ledger&&/PerDay|per[_ ]day/i.test(raw))retryAt=(await ledger.query("select ((date_trunc('day',clock_timestamp() at time zone 'America/Los_Angeles')+interval '1 day') at time zone 'America/Los_Angeles') retry_at")).rows[0].retry_at;
        }
        const reason=response.status===401||response.status===403?'provider_auth':response.status===429?'provider_rate_limit':response.status>=500?'provider_unavailable':'provider_rejected';
        throw Object.assign(new Error(reason),{reason});
      }
      try{return JSON.parse(raw);}catch{throw new Error('invalid_output');}
    };
    try{
      dispatched=true;
      const result=await request(':generateContent',body);
      const usage=result.usageMetadata;
      const choice=result.candidates?.[0],retrieval=choice?.urlContextMetadata?.urlMetadata??[];
      Object.assign(diagnostics,{response_id:result.responseId??null,model_version:result.modelVersion??null,
        finish_reason:choice?.finishReason??null,finish_message:choice?.finishMessage?.slice(0,512)??null,
        prompt_block_reason:result.promptFeedback?.blockReason??null,
        retrieval_metadata_present:choice?.urlContextMetadata!=null,
        retrieval:retrieval.slice(0,20).map(r=>({url:r.retrievedUrl,status:r.urlRetrievalStatus})),
        tokens:{prompt:usage?.promptTokenCount??null,tool:usage?.toolUsePromptTokenCount??null,
          output:usage?.candidatesTokenCount??null,thinking:usage?.thoughtsTokenCount??null,total:usage?.totalTokenCount??null}});
      if([usage?.promptTokenCount,usage?.totalTokenCount,usage?.toolUsePromptTokenCount??0,usage?.candidatesTokenCount??0,usage?.thoughtsTokenCount??0].every(n=>Number.isSafeInteger(n)&&n>=0)){
        tokens=usage.promptTokenCount+(usage.toolUsePromptTokenCount??0);
        output=(usage.candidatesTokenCount??0)+(usage.thoughtsTokenCount??0);state='settled';
      }
      if(result.promptFeedback?.blockReason)throw new Error('provider_safety');
      if(!choice?.finishReason||choice.finishReason==='FINISH_REASON_UNSPECIFIED')throw new Error('invalid_output');
      if(choice.finishReason!=='STOP')throw new Error(choice.finishReason==='MAX_TOKENS'?'output_truncated':
        ['SAFETY','RECITATION','BLOCKLIST','PROHIBITED_CONTENT','SPII','IMAGE_SAFETY','IMAGE_PROHIBITED_CONTENT'].includes(choice.finishReason)?'provider_safety':'provider_finish');
      let answer;
      try{answer=JSON.parse(choice.content.parts.filter(p=>!p.thought).map(p=>p.text??'').join(''));}
      catch{throw new Error('invalid_json');}
      if(schema?.type==='array'){
        if(!Array.isArray(answer))throw new Error('invalid_output');
        answer={status:answer.length?'found':'none',records:answer};
      }
      if(!answer||typeof answer!=='object'||Array.isArray(answer))throw new Error('invalid_output');
      diagnostics.model_status=['found','none','unreadable'].includes(answer.status)?answer.status:null;
      diagnostics.record_count=Array.isArray(answer.records)?answer.records.length:null;
      if(!retrieval.length)throw new Error('retrieval_metadata_missing');
      if(!retrieval.some(r=>r.urlRetrievalStatus==='URL_RETRIEVAL_STATUS_SUCCESS'))throw new Error('url_retrieval_failed');
      return {...answer,_retrieval:diagnostics.retrieval,_diagnostics:diagnostics,
        _usage:{input_tokens:tokens,output_tokens:output,uncertain:state==='unknown'}};
    }catch(error){
      reason=['input_bound','output_bound','runtime_bound','invalid_json','invalid_output','output_truncated','provider_safety','provider_finish','provider_auth','provider_rate_limit','provider_rejected','retrieval_metadata_missing','url_retrieval_failed','provider_unavailable','provider_unknown','quota','database_operation','sql_bound'].includes(error.message)?error.message:'provider_unknown';
      if(!dispatched){tokens=output=0;state='settled';}
      throw Object.assign(new Error(reason),{reason,dispatched,diagnostics,usage:{input_tokens:tokens,output_tokens:output,uncertain:state==='unknown'},...(retryAt||error.deferred?{deferred:{reason,retry_at:retryAt??error.deferred.retry_at}}:{})});
    }
  };
}
