import {modelErrorReason} from './contract.js';

export const MODEL='gemini-3.5-flash-lite';

export function requestBody(instruction,input,schema){
  const body={systemInstruction:{parts:[{text:instruction}]},
    contents:[{role:'user',parts:[{text:JSON.stringify(input)}]}],
    tools:[{urlContext:{}}],store:false,
    generationConfig:{thinkingConfig:{thinkingLevel:'minimal'},responseMimeType:'application/json',responseJsonSchema:schema}};
  return JSON.stringify(body);
}

// All request/response material is invocation-local. No automatic provider retries.
export function gemini({apiKey,fetch:send=fetch}){
  return async(instruction,input,schema,{signal}={})=>{
    if(!apiKey)throw Object.assign(new Error('configuration'),{reason:'configuration',dispatched:false});
    let body;try{body=requestBody(instruction,input,schema);}catch(error){throw Object.assign(error,{dispatched:false});}
    const endpoint=`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}`;
    let dispatched=false,retryAt;
    const diagnostics={};
    const request=async(suffix,payload)=>{
      let response;
      try{response=await send(endpoint+suffix,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':apiKey},body:payload,
        signal});}
      catch{throw new Error(signal?.aborted?'runtime_bound':'provider_unknown');}
      diagnostics.http_status=response.status;
      const raw=await response.text();
      if(!response.ok){
        if(response.status===429||response.status>=500){
          const header=response.headers.get('retry-after'),seconds=Number(header)||Number(raw.match(/"retryDelay"\s*:\s*"([\d.]+)s"/)?.[1])||60;
          retryAt=new Date(Math.max(Date.now()+seconds*1000,Date.parse(header)||0)).toISOString();
        }
        const reason=response.status===401||response.status===403?'provider_auth':response.status===429?'provider_rate_limit':response.status>=500?'provider_unavailable':'provider_rejected';
        throw Object.assign(new Error(reason),{reason});
      }
      try{return JSON.parse(raw);}catch{throw new Error('invalid_output');}
    };
    try{
      dispatched=true;
      const result=await request(':generateContent',body);
      const choice=result.candidates?.[0],retrieval=choice?.urlContextMetadata?.urlMetadata??[];
      Object.assign(diagnostics,{response_id:result.responseId??null,model_version:result.modelVersion??null,
        finish_reason:choice?.finishReason??null,finish_message:choice?.finishMessage?.slice(0,512)??null,
        prompt_block_reason:result.promptFeedback?.blockReason??null,
        retrieval_metadata_present:choice?.urlContextMetadata!=null,
        retrieval:retrieval.map(r=>({url:r.retrievedUrl,status:r.urlRetrievalStatus}))});
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
      return {...answer,_retrieval:diagnostics.retrieval,_diagnostics:diagnostics};
    }catch(error){
      const reason=signal?.aborted?'runtime_bound':modelErrorReason(error);
      throw Object.assign(new Error(reason),{reason,dispatched,diagnostics,...(retryAt?{deferred:{retry_at:retryAt}}:{})});
    }
  };
}
