import {MODEL,gemini} from './gemini.js';
import {OPENAI_MODEL,openai} from './models.js';
import {modelErrorReason} from './contract.js';

const fallbackReasons=new Set(['url_retrieval_failed','retrieval_metadata_missing','model_unreadable','invalid_json','invalid_output',
  'output_truncated','empty_findings','provider_rate_limit','provider_unavailable','provider_unknown']);
const fail=(reason,details={})=>Object.assign(new Error(reason),{reason,...details});

// One primary attempt and, for eligible failures, one fallback. No model ledger.
export function trackerModel({apiKey,openaiApiKey,source,provider,model,deadline,readUrl,functions=[],validate,fetch:send=fetch}){
  if(provider!==undefined&&!['gemini','openai'].includes(provider))throw fail('configuration');
  if(model!==undefined&&provider==='gemini')throw fail('model_configuration');
  if(provider==='gemini'&&source.source_kind==='web')throw fail('model_configuration');
  const primary=provider??(model!==undefined?'openai':source.source_kind==='post'?'gemini':'openai');
  const openaiModel=model===undefined?OPENAI_MODEL:model;
  const providers={gemini:{model:MODEL,generate:gemini({apiKey,readUrl,functions,fetch:send})},
    openai:{model:openaiModel,generate:openai({apiKey:openaiApiKey,model:openaiModel,urls:[source.url],readUrl,functions,fetch:send})}};
  return async(instruction,input,schema)=>{
    const ends=deadline??Date.now()+100000,attempts=[];
    const call=async name=>{
      const config=providers[name],attempt={provider:name,model:config.model,dispatched:false,reason:null};
      attempts.push(attempt);
      try{
        const remaining=Math.min(name==='gemini'?45000:Infinity,ends-Date.now());
        if(remaining<=0)throw fail('runtime_bound',{dispatched:false});
        const answer=await config.generate(instruction,input,schema,{signal:AbortSignal.timeout(remaining)});
        attempt.dispatched=true;attempt.diagnostics=answer._diagnostics;
        if(validate)validate(answer);
        return answer;
      }catch(error){
        attempt.dispatched=error.dispatched!==false;attempt.reason=modelErrorReason(error);
        attempt.diagnostics=error.diagnostics??attempt.diagnostics;
        throw fail(attempt.reason,{dispatched:attempt.dispatched,...(error.deferred?{deferred:error.deferred}:{})});
      }
    };
    try{
      let answer;
      try{answer=await call(primary);}catch(error){
        if(provider||model!==undefined||primary!=='gemini'||!error.dispatched||!fallbackReasons.has(error.reason))throw error;
        answer=await call('openai');
      }
      return {...answer,_diagnostics:{provider:attempts.at(-1).provider,model:attempts.at(-1).model,attempts}};
    }catch(error){
      throw fail(error.reason,{diagnostics:{attempts},...(error.deferred?{deferred:error.deferred}:{})});
    }
  };
}
