import {Buffer} from 'node:buffer';
import {randomUUID} from 'node:crypto';

export const MODEL='gemini-3.5-flash-lite';
export const MODEL_LIMITS={minute:2,run:2,tokens:125000,day:250,input:16000,output:8192};

export function requestBody(instruction,input,schema){
  const attachments=[];
  const text=JSON.stringify(input,(key,value)=>{
    if(key!=='inline_data')return value;
    if(value?.mime_type!=='application/pdf'||typeof value.data!=='string'||Buffer.byteLength(value.data,'base64')>2097152)throw new Error('input_bound');
    attachments.push({inlineData:{mimeType:value.mime_type,data:value.data}});
    return {attachment:attachments.length,mime_type:value.mime_type};
  });
  if(Buffer.byteLength(text)>96000||attachments.length>1)throw new Error('input_bound');
  return JSON.stringify({systemInstruction:{parts:[{text:instruction}]},contents:[{role:'user',parts:[{text},...attachments]}],
    generationConfig:{maxOutputTokens:MODEL_LIMITS.output,thinkingConfig:{thinkingLevel:'minimal'},responseMimeType:'application/json',responseJsonSchema:schema}});
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
    await reserve(null); // durable before even the countTokens request
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
      const counted=await request(':countTokens',JSON.stringify({generateContentRequest:{model:'models/'+MODEL,...JSON.parse(body)}}));
      if(!Number.isSafeInteger(counted.totalTokens)||counted.totalTokens<0||counted.totalTokens>MODEL_LIMITS.input)throw new Error('input_bound');
      tokens=counted.totalTokens;
      await reserve(tokens); // exact token preflight immediately before dispatch
      if(Date.now()+5000>=deadline)throw new Error('runtime_bound');
      dispatched=true;
      const result=await request(':generateContent',body);
      if(Number.isSafeInteger(result.usageMetadata?.promptTokenCount))tokens=Math.max(tokens,result.usageMetadata.promptTokenCount);
      if(Number.isSafeInteger(result.usageMetadata?.candidatesTokenCount))output=Math.max(0,result.usageMetadata.candidatesTokenCount);
      const choice=result.candidates?.[0];
      if(choice?.finishReason!=='STOP')throw new Error('invalid_output');
      try{return JSON.parse(choice.content.parts.filter(p=>!p.thought).map(p=>p.text??'').join(''));}
      catch{throw new Error('invalid_output');}
    }catch(error){
      reason=['input_bound','output_bound','runtime_bound','invalid_output','provider_unavailable','provider_unknown','quota'].includes(error.message)?error.message:'provider_unknown';
      if(dispatched&&['provider_unknown','output_bound'].includes(reason))state='unknown';
      throw Object.assign(new Error(reason),{reason,dispatched,...(retryAt||error.deferred?{deferred:{reason,retry_at:retryAt??error.deferred.retry_at}}:{})});
    }finally{
      await ledger.query('update scout.quota_reservations set input_tokens=$2,output_tokens=$3,state=$4,reason=$5 where id=$1 returning id',[id,tokens,output,state,reason]);
      if(retryAt)await ledger.query('update scout.quota_policy set cooldown_until=greatest(cooldown_until,$1::timestamptz) where id returning id',[retryAt]);
    }
  };
}
