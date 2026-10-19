import {MODEL,gemini} from './gemini.js';
import {OPENAI_MODEL,openai} from './openai.js';
import {normalizeFinding} from '../findings.js';
import {modelErrorReason} from './contract.js';

const fallbackReasons=new Set(['url_retrieval_failed','retrieval_metadata_missing','model_unreadable','invalid_json','invalid_output',
  'output_truncated','empty_findings','provider_rate_limit','provider_unavailable','provider_unknown']);
const fail=(reason,details={})=>Object.assign(new Error(reason),{reason,...details});

// One primary attempt and, for eligible failures, one fallback. No model ledger.
export function trackerModel({apiKey,openaiApiKey,source,provider,deadline,fetch:send=fetch}){
  if(provider!==undefined&&!['gemini','openai'].includes(provider))throw fail('configuration');
  const providers={gemini:{model:MODEL,generate:gemini({apiKey,fetch:send})},
    openai:{model:OPENAI_MODEL,generate:openai({apiKey:openaiApiKey,urls:[source.url],fetch:send})}};
  return async(instruction,input,schema)=>{
    const ends=deadline??Date.now()+100000,attempts=[];
    const call=async name=>{
      const config=providers[name],attempt={provider:name,model:config.model,dispatched:false,reason:null};
      attempts.push(attempt);
      try{
        const remaining=Math.min(name==='gemini'?45000:100000,ends-Date.now());
        if(remaining<=0)throw fail('runtime_bound',{dispatched:false});
        const answer=await config.generate(instruction,input,schema,{signal:AbortSignal.timeout(remaining)});
        attempt.dispatched=true;attempt.diagnostics=answer._diagnostics;
        if(!['found','none','unreadable'].includes(answer.status)||!Array.isArray(answer.records))throw fail('invalid_output');
        if(answer.status==='unreadable')throw fail('model_unreadable');
        if(answer.status==='found'&&!answer.records.some(r=>normalizeFinding(r,source.url)))throw fail('empty_findings');
        return answer;
      }catch(error){
        attempt.dispatched=error.dispatched!==false;attempt.reason=modelErrorReason(error);
        attempt.diagnostics=error.diagnostics??attempt.diagnostics;
        throw fail(attempt.reason,{dispatched:attempt.dispatched,...(error.deferred?{deferred:error.deferred}:{})});
      }
    };
    try{
      let answer;
      try{answer=await call(provider??'gemini');}catch(error){
        if(provider||!error.dispatched||!fallbackReasons.has(error.reason))throw error;
        answer=await call('openai');
      }
      return {...answer,_diagnostics:{provider:attempts.at(-1).provider,model:attempts.at(-1).model,attempts}};
    }catch(error){
      throw fail(error.reason,{diagnostics:{attempts},...(error.deferred?{deferred:error.deferred}:{})});
    }
  };
}
