import {modelErrorReason} from './contract.js';

export const OPENAI_MODEL='gpt-6-luna';
export const OPENAI_MODELS={
  [OPENAI_MODEL]:'low',
  'gpt-6.1-terra':'none',
  'gpt-5.6-terra':'low',
  'gpt-6.1-sol':'xhigh'
};
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

// Retrieval, native inputs and continuations share one attempt and abort signal.
export function createOpenAIAdapter({apiKey,urls=[],readUrl,functions=[],model=OPENAI_MODEL,fetch:send=fetch,now=Date.now}){
  if(!Object.hasOwn(OPENAI_MODELS,model))throw fail('model_configuration');
  const effort=OPENAI_MODELS[model];
  const initial=urls;
  return async(instruction,input,schema,{signal}={})=>{
    const started=now(),diagnostics={provider:'openai',model,retrieval:[],tool_calls:0,requests:0,usage:{input_tokens:0,output_tokens:0,total_tokens:0}};
    let dispatched=false;
    try{
      const transportSchema=schema;
      const requested=initial;
      if(!apiKey)throw fail('configuration');
      const supplied=new Set(),failedFiles=new Set();let nativeBatch=[],hasEvidence=!!input.content&&!input.content.error;
      const partsFor=source=>{
        const parts=[{type:'input_text',text:JSON.stringify(source)}];
        if(!source.error&&(source.media_type==='application/pdf'||source.media_type?.startsWith('image/'))){
          if(failedFiles.has(source.url))return [{type:'input_text',text:JSON.stringify({url:source.url,error:'source_unavailable'})}];
          const index=parts.length;
          parts.push(source.media_type==='application/pdf'?{type:'input_file',file_url:source.url}:{type:'input_image',image_url:source.url,detail:'auto'});
          nativeBatch.push({parts,index,url:source.url});
        }
        return parts;
      };
      const {evidence=[],...initialInput}=input;
      const first=[{type:'input_text',text:JSON.stringify({input:initialInput,urls:requested})}];
      if(input.content&&input.content.url===input.url&&!input.content.error){
        supplied.add(input.url);
      }
      const history=[{role:'user',content:first}];
      if(input.content?.media_type&&!input.content.error&&!Object.hasOwn(input.content,'content'))history.push({role:'user',content:partsFor(input.content)});
      for(const source of evidence){
        history.push({role:'user',content:partsFor(source)});
        if(!source.error&&(Object.hasOwn(source,'content')||source.media_type==='application/pdf'||source.media_type?.startsWith('image/'))){
          supplied.add(source.url);hasEvidence=true;
        }
      }
      const tools=[
        ...functions.map(({name,description,parameters})=>({type:'function',name,description,parameters,strict:true})),
        ...(requested.length?[{type:'web_search',search_content_types:['text','image'],image_settings:{caption:true}}]:[]),
        ...(readUrl?[{type:'function',name:'read_url',description:'Read a relevant public page, JSON content, PDF or image URL. Failed reads return an error; continue with other evidence.',
          strict:true,parameters:{type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false}}]:[])];
      for(;;){
        if(signal?.aborted)throw fail('runtime_bound');
        const body=JSON.stringify({model,store:false,service_tier:'default',reasoning:{effort},...(model==='gpt-6.1-terra'?{temperature:0}:{}),
          instructions:instruction,
          input:history,...(tools.length?{tools,tool_choice:hasEvidence?'auto':'required'}:{}),
          include:['reasoning.encrypted_content',...(requested.length?['web_search_call.action.sources']:[])],
          text:{format:{type:'json_schema',name:'scout_result',schema:strictSchema(transportSchema),strict:true}}});
        dispatched=true;
        diagnostics.requests++;
        let response;
        try{response=await send('https://api.openai.com/v1/responses',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+apiKey},body,
          signal});}catch{throw fail(signal?.aborted?'runtime_bound':'provider_unknown');}
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
          if(response.status===400&&nativeBatch.length&&!context&&
            /(?:invalid_image|invalid_file|image_url|file_url|file_content|image.*(?:download|fetch|format|patch|pixel|dimension|size)|file.*(?:download|fetch|format)|(?:download|fetch).*(?:image|file|pdf))/i.test((error?.code??'')+' '+(error?.message??''))){
            for(const file of nativeBatch){
              failedFiles.add(file.url);
              file.parts[file.index]={type:'input_text',text:JSON.stringify({url:file.url,error:'source_unavailable'})};
              diagnostics.retrieval.push({url:file.url,status:'NATIVE_INPUT_FAILED',method:'provider_native'});
            }
            nativeBatch=[];continue;
          }
          if(spending)diagnostics.limit_category='spending';
          else if(context)diagnostics.limit_category='context';
          else if(response.status===429)diagnostics.limit_category=/token/i.test(error?.message??'')?'tokens':/request/i.test(error?.message??'')?'requests':'rate';
          const retry=response.headers.get('retry-after'),retryAt=Number(retry)>0?now()+Number(retry)*1000:Date.parse(retry);
          throw fail(spending?'provider_spend_limit':context?'provider_context_limit':response.status===401||response.status===403?'provider_auth':response.status===429?'provider_rate_limit':response.status>=500?'provider_unavailable':'provider_rejected',
            !spending&&(response.status===429||response.status>=500)?{deferred:{retry_at:new Date(retryAt>now()?retryAt:now()+60000).toISOString()}}:{});
        }
        let result;try{result=JSON.parse(raw);}catch{throw fail('invalid_output');}
        if(!result||typeof result!=='object'||Array.isArray(result))throw fail('invalid_output');
        for(const key of Object.keys(diagnostics.usage))diagnostics.usage[key]+=Number(result.usage?.[key])||0;
        for(const file of nativeBatch)diagnostics.retrieval.push({url:file.url,status:'NATIVE_INPUT_ACCEPTED',method:'provider_native'});
        nativeBatch=[];
        diagnostics.response_status=result.status??null;
        diagnostics.model_version=typeof result.model==='string'?result.model.slice(0,80):null;
        if(result.status!=='completed'){
          if(result.incomplete_details?.reason==='max_output_tokens')diagnostics.limit_category='output';
          throw fail(result.status==='incomplete'?'output_incomplete':'provider_finish');
        }
        if(!Array.isArray(result.output)||result.output.some(item=>!item||typeof item!=='object'||item.type==='message'&&
          (!Array.isArray(item.content)||item.content.some(part=>!part||typeof part!=='object'||part.type==='output_text'&&typeof part.text!=='string'))))throw fail('invalid_output');
        const web=result.output.filter(item=>item.type==='web_search_call');
        diagnostics.tool_calls+=web.length;
        const content=result.output.flatMap(item=>item.type==='message'?item.content:[]);
        const observed=web.filter(item=>item.status==='completed').flatMap(item=>[
          ...(item.action?.type==='open_page'?[item.action.url]:[]),...(item.action?.sources??[]).map(source=>source.url)]);
        observed.push(...content.flatMap(part=>(part.annotations??[]).filter(a=>a.type==='url_citation').map(a=>a.url)));
        diagnostics.retrieval.push(...[...new Set(observed)].filter(url=>typeof url==='string')
          .map(url=>({url,status:'PROVIDER_WEB_REFERENCE',method:'provider_web'})));
        if(web.some(item=>item.status==='completed'))hasEvidence=true;
        if(content.some(part=>part.type==='refusal'))throw fail('provider_refused');
        if(result.output.some(item=>!['message','reasoning','web_search_call','function_call'].includes(item.type)))throw fail('unexpected_tool');
        const calls=result.output.filter(item=>item.type==='function_call');
        if(calls.length){
          for(const call of calls){
            if(call.name==='read_url'?!readUrl:!functions.some(f=>f.name===call.name))throw fail('unexpected_tool');
            let args;try{args=JSON.parse(call.arguments);}catch{throw fail('invalid_output');}
            if(!args||typeof args!=='object'||typeof call.call_id!=='string'||call.name==='read_url'&&(typeof args.url!=='string'||Object.keys(args).length!==1))throw fail('invalid_output');
          }
          diagnostics.tool_calls+=calls.length;
          const outputs=await Promise.all(calls.map(async call=>{
            if(call.name!=='read_url'){const value=await functions.find(f=>f.name===call.name).run(JSON.parse(call.arguments));return {type:'function_call_output',call_id:call.call_id,output:JSON.stringify(value)};}
            const {url}=JSON.parse(call.arguments);
            if(failedFiles.has(url))return {type:'function_call_output',call_id:call.call_id,output:JSON.stringify({url,error:'source_unavailable'})};
            if(supplied.has(url))return {type:'function_call_output',call_id:call.call_id,output:JSON.stringify({url,status:'already_supplied'})};
            let source;
            try{source=await readUrl(url,{signal});}catch(error){
              if(signal?.aborted)throw fail('runtime_bound');
              diagnostics.retrieval.push({url,status:'URL_RETRIEVAL_FAILED',method:'scout_http'});
              return {type:'function_call_output',call_id:call.call_id,output:JSON.stringify({url,error:error.reason??'source_unavailable'})};
            }
            if(supplied.has(url))return {type:'function_call_output',call_id:call.call_id,output:JSON.stringify({url,status:'already_supplied'})};
            supplied.add(url);hasEvidence=true;
            diagnostics.retrieval.push({url:source.url,status:Object.hasOwn(source,'content')?'URL_RETRIEVAL_STATUS_SUCCESS':'HTTP_METADATA_SUCCESS',method:'scout_http'});
            return {type:'function_call_output',call_id:call.call_id,output:partsFor(source)};
          }));
          history.push(...result.output,...outputs);continue;
        }
        if(!hasEvidence&&requested.length)throw fail(diagnostics.retrieval.length?'url_retrieval_failed':'retrieval_metadata_missing');
        let answer;try{answer=JSON.parse(content.filter(part=>part.type==='output_text').map(part=>part.text).join(''));}catch{throw fail('invalid_output');}
        if(!answer||Array.isArray(answer)||typeof answer!=='object')throw fail('invalid_output');
        diagnostics.elapsed_ms=now()-started;
        return {...answer,_diagnostics:diagnostics,_retrieval:diagnostics.retrieval};
      }
    }catch(error){
      diagnostics.elapsed_ms=now()-started;
      throw fail(signal?.aborted?'runtime_bound':modelErrorReason(error),{dispatched,diagnostics,
        ...(error.deferred?{deferred:error.deferred}:{})});
    }
  };
}
