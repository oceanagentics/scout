import {sourceURL} from './octo-documents.js';
import {isAccounted,modelErrorReason} from './model-gateway.js';

export const OPENAI_MODEL='gpt-6-luna';
const fail=(reason,details={})=>Object.assign(new Error(reason),{reason,...details});

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
export function openai({apiKey,urls=[],source,model=OPENAI_MODEL,fetch:send=fetch,now=Date.now}){
  if(model!==OPENAI_MODEL)throw fail('model_configuration');
  const initial=urls.map(url=>{sourceURL(url);return url;});
  if(new Set(initial).size!==initial.length)throw fail('source_bound');
  return async(instruction,input,schema,limits)=>{
    const diagnostics={provider:'openai',model,retrieval:[],tool_calls:0};
    let dispatched=false,usage;
    try{
      if(!isAccounted(limits))throw fail('accounting');
      // OpenAI requires an object at the root; keep the list wrapper in this adapter.
      if(schema?.type==='array'&&schema.items?.type!=='object')throw fail('invalid_schema');
      const transportSchema=schema?.type==='array'?{type:'object',properties:{records:schema},required:['records'],additionalProperties:false}:schema;
      const followups=input?.requested_links??[];
      if(!Array.isArray(followups)||followups.length>limits.maxFollowups)throw fail('source_bound');
      const requested=[...new Set([...initial,...followups.map(link=>{sourceURL(link.url);return link.url;})])];
      if(requested.length>limits.maxUrls)throw fail('source_bound');
      if(limits?.task==='url_intake'&&!initial.length)throw fail('source_required');
      if(!apiKey)throw fail('configuration');
      const body=JSON.stringify({model,store:false,service_tier:'default',reasoning:{effort:'low'},max_output_tokens:limits.outputTokens,
        instructions:instruction+(schema?.type==='array'?'\nFor this API, return the array inside an object with the single key records.':''),
        input:JSON.stringify({input,urls:requested,source}),
        ...(requested.length?{tools:[{type:'web_search',search_content_types:['text','image'],image_settings:{caption:true}}],tool_choice:'required',max_tool_calls:limits.maxToolCalls,include:['web_search_call.action.sources']}:{}),
        text:{format:{type:'json_schema',name:'scout_result',schema:strictSchema(transportSchema),strict:true}}});
      dispatched=true;
      let response;
      try{response=await send('https://api.openai.com/v1/responses',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+apiKey},body,
        signal:limits.signal});}catch{throw fail('provider_unknown');}
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
        usage={input_tokens:result.usage.input_tokens,output_tokens:result.usage.output_tokens,web_search_calls:limits.maxToolCalls};
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
      if(web.length>limits.maxToolCalls)throw fail('output_bound');
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
      throw fail(modelErrorReason(error),{dispatched,diagnostics,usage:usage??{input_tokens:limits?.inputTokens??0,output_tokens:limits?.outputTokens??0,uncertain:dispatched},
        ...(error.deferred?{deferred:error.deferred}:{})});
    }
  };
}
