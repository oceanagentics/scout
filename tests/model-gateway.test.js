import {test} from 'node:test';
import assert from 'node:assert/strict';
import {trackerModel} from '../reader/models/gateway.js';
import {strictSchema,createOpenAIAdapter,OPENAI_MODEL} from '../reader/models/openai.js';
import {gemini} from '../reader/models/gemini.js';
import {INTAKE_INSTRUCTION,RESPONSE_SCHEMA} from '../reader/instructions.js';

const url='https://example.org/source';

test('supplied posts work without retrieval metadata; both providers retain optional browsing',async()=>{
  const input={url,content:{post:{record:{text:'BBNJ workshop announcement'}}}};
  for(const provider of ['gemini','openai']){
    let calls=0;
    const model=trackerModel({provider,source:{url},apiKey:'test',openaiApiKey:'test',fetch:async(_url,options)=>{
      calls++;const body=JSON.parse(options.body);
      assert.ok(body.tools.length);
      if(provider==='openai'){
        assert.equal(body.tool_choice,'auto');assert.deepEqual(JSON.parse(body.input[0].content[0].text).input,input);
        return result([],[]);
      }
      assert.deepEqual(JSON.parse(body.contents[0].parts[0].text),input);
      return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"status":"none","records":[]}'}]}}]});
    }});
    const answer=await model(INTAKE_INSTRUCTION,input,RESPONSE_SCHEMA);
    assert.equal(answer.status,'none');assert.equal(calls,1);
  }
});
const result=(records=[],web=[{type:'web_search_call',status:'completed',action:{type:'open_page',url}}])=>Response.json({
  status:'completed',output:[...web,{type:'message',content:[{type:'output_text',text:JSON.stringify({status:records.length?'found':'none',records})}]}]});
const envelope=(text='[]',extra={})=>{try{const parsed=JSON.parse(text);if(Array.isArray(parsed))text=JSON.stringify({status:parsed.length?'found':'none',records:parsed});}catch{}return Response.json({candidates:[{finishReason:'STOP',
  urlContextMetadata:{urlMetadata:[{retrievedUrl:url,urlRetrievalStatus:'URL_RETRIEVAL_STATUS_SUCCESS'}]},
  content:{parts:[{text}]}}],...extra});};

test('explicit OpenAI models preserve reasoning and tool continuations without falling back',async()=>{
  for(const [model,effort] of [['gpt-6-luna','high'],['gpt-6.1-terra','none'],['gpt-5.6-terra','low'],['gpt-6.1-sol','xhigh']]){
    let calls=0,lookups=0;const signals=[];
    const generate=trackerModel({model,source:{url,source_kind:'post'},openaiApiKey:'test',functions:[{
      name:'lookup',description:'Look up a finding',parameters:{type:'object',properties:{},required:[],additionalProperties:false},
      run:async()=>{lookups++;return {records:[]};}
    }],fetch:async(target,options)=>{
      calls++;signals.push(options.signal);assert.equal(target,'https://api.openai.com/v1/responses');
      const body=JSON.parse(options.body);
      assert.equal(body.model,model);assert.deepEqual(body.reasoning,{effort});assert.equal(body.store,false);
      assert.equal(body.temperature,model==='gpt-6.1-terra'?0:undefined);
      if(calls===1)return Response.json({status:'completed',output:[{type:'function_call',name:'lookup',call_id:'lookup',arguments:'{}'}]});
      assert.ok(body.input.some(part=>part.type==='function_call_output'&&part.call_id==='lookup'));
      return result([],[]);
    }});
    const answer=await generate('Read',{content:{text:'Supplied post'}},RESPONSE_SCHEMA);
    assert.equal(calls,2);assert.equal(lookups,1);assert.equal(signals[0],signals[1]);
    assert.equal(answer._diagnostics.model,model);assert.equal(answer._diagnostics.provider,'openai');
    assert.equal(answer._diagnostics.attempts.length,1);

    let failures=0;
    const unavailable=trackerModel({model,source:{url,source_kind:'post'},openaiApiKey:'test',apiKey:'test',fetch:async()=>{
      failures++;return new Response('{}',{status:503});
    }});
    await assert.rejects(unavailable('Read',{content:{}},RESPONSE_SCHEMA),{reason:'provider_unavailable'});
    assert.equal(failures,1);
  }
  assert.throws(()=>trackerModel({model:'unsupported',source:{url}}),{reason:'model_configuration'});
  assert.throws(()=>trackerModel({model:'gpt-5.6-terra',provider:'gemini',source:{url,source_kind:'post'}}),{reason:'model_configuration'});
});

test('provider calls accept large inputs and outputs without accounting or Scout content caps',async()=>{
  const records=Array.from({length:12},(_,i)=>({description:'Development '+i+' '+ 'x'.repeat(12000)}));
  for(const provider of ['gemini','openai']){
    const requests=[],model=trackerModel({provider,source:{url},apiKey:'test',openaiApiKey:'test',fetch:async(target,options)=>{
      requests.push({target,options});return provider==='gemini'?envelope(JSON.stringify(records)):
        result(records,Array.from({length:5},()=>({type:'web_search_call',status:'completed',action:{type:'open_page',url}})));
    }});
    const answer=await model(INTAKE_INSTRUCTION,{text:'x'.repeat(63000)},RESPONSE_SCHEMA);
    assert.deepEqual(answer.records,records);assert.equal(requests.length,1);
    assert.equal(Object.hasOwn(answer,'_usage'),false);
    const body=JSON.parse(requests[0].options.body);
    assert.equal(body.max_output_tokens,undefined);assert.equal(body.max_tool_calls,undefined);
    assert.equal(body.generationConfig?.maxOutputTokens,undefined);
    assert.ok(requests[0].options.signal instanceof AbortSignal);
    assert.equal(body.model??answer._diagnostics.model,provider==='openai'?OPENAI_MODEL:'gemini-3.5-flash-lite');
  }
  const urls=Array.from({length:6},(_,i)=>url+'/'+i);
  await createOpenAIAdapter({apiKey:'test',urls,fetch:async(_,options)=>{
    assert.deepEqual(JSON.parse(JSON.parse(options.body).input[0].content[0].text).urls,urls);return result();
  }})('Read',{},RESPONSE_SCHEMA);
});

test('fallback is one attempt and preserves provider diagnostics',async t=>{
  const cases=[['valid none',()=>envelope(),false],['retrieval error',()=>envelope('[]',{candidates:[{finishReason:'STOP',
    urlContextMetadata:{urlMetadata:[{retrievedUrl:url,urlRetrievalStatus:'ERROR'}]},content:{parts:[{text:'{"status":"none","records":[]}'}]}}]}),true],
    ['missing metadata',()=>envelope('[]',{candidates:[{finishReason:'STOP',content:{parts:[{text:'{"status":"none","records":[]}'}]}}]}),true],
    ['invalid JSON',()=>envelope('{'),true],['invalid output',()=>envelope('{}'),true],
    ['empty found',()=>envelope('[null,{}]'),true],['missing candidate',()=>envelope('[]',{candidates:[]}),true],
    ['truncated',()=>envelope('[]',{candidates:[{finishReason:'MAX_TOKENS'}]}),true],
    ['429',()=>new Response('{}',{status:429}),true],['503',()=>new Response('{}',{status:503}),true],
    ['network',()=>{throw Error('Private transport text');},true],
    ['auth',()=>new Response('{}',{status:401}),false],['rejected',()=>new Response('{}',{status:400}),false],
    ['safety',()=>envelope('[]',{promptFeedback:{blockReason:'SAFETY'}}),false]];
  for(const [name,response,recover] of cases)await t.test(name,async()=>{
    const calls=[];
    const model=trackerModel({source:{url,source_kind:'post'},apiKey:'test',openaiApiKey:'test',validate:answer=>{if(!['found','none'].includes(answer.status)||!Array.isArray(answer.records)||answer.records.some(r=>!r?.description))throw Object.assign(new Error('invalid_output'),{reason:'invalid_output'});},fetch:async target=>{
      calls.push(target);return target.includes('googleapis')?response():result();
    }});
    const answer=await model(INTAKE_INSTRUCTION,{url},RESPONSE_SCHEMA).catch(e=>e);
    assert.equal(calls.length,recover?2:1);
    assert.ok(!JSON.stringify(answer).includes('Private transport text'));
    if(recover)assert.deepEqual(answer._diagnostics.attempts.map(a=>a.provider),['gemini','openai']);
  });
  let calls=0;
  const model=trackerModel({source:{url,source_kind:'post'},apiKey:'test',openaiApiKey:'test',fetch:async()=>{calls++;return new Response('{}',{status:503});}});
  await assert.rejects(model('Read',{url},RESPONSE_SCHEMA),{reason:'provider_unavailable'});assert.equal(calls,2);
});

test('isolated providers do not fall back, expired and aborted requests stop',async()=>{
  for(const provider of ['gemini','openai']){
    let calls=0;
    const model=trackerModel({provider,source:{url},apiKey:'test',openaiApiKey:'test',fetch:async()=>{
      calls++;return new Response('{}',{status:503});
    }});
    await assert.rejects(model('Read',{},RESPONSE_SCHEMA),{reason:'provider_unavailable'});assert.equal(calls,1);
  }
  const expired=trackerModel({source:{url},apiKey:'test',deadline:Date.now()-1,fetch:()=>assert.fail('Expired')});
  await assert.rejects(expired('Read',{},RESPONSE_SCHEMA),{reason:'runtime_bound'});
  for(const generate of [gemini,createOpenAIAdapter]){
    const controller=new AbortController();controller.abort();
    await assert.rejects(generate({apiKey:'test',fetch:async()=>{throw Error('aborted');}})('Read',{},RESPONSE_SCHEMA,{signal:controller.signal}),
      {reason:'runtime_bound'});
  }
});

test('provider errors retain actual account/context limits and redact credentials',async()=>{
  for(const [status,code,reason] of [[429,'rate_limit_exceeded','provider_rate_limit'],[429,'insufficient_quota','provider_spend_limit'],
    [400,'context_length_exceeded','provider_context_limit'],[401,'invalid_api_key','provider_auth']]){
    const generate=createOpenAIAdapter({apiKey:'private-key',fetch:async()=>Response.json({
      error:{code,message:'private-key sk-proj-masked***'}},{status})});
    await assert.rejects(generate('Read',{},RESPONSE_SCHEMA),error=>{
      assert.equal(error.reason,reason);assert.ok(!/private-key|sk-proj-/.test(JSON.stringify(error)));return true;
    });
  }
});

test('provider truncation and malformed replies fail instead of accepting partial output',async()=>{
  await assert.rejects(createOpenAIAdapter({apiKey:'test',fetch:async()=>Response.json({status:'incomplete',incomplete_details:{reason:'max_output_tokens'}})})
    ('Read',{},RESPONSE_SCHEMA),{reason:'output_incomplete'});
  await assert.rejects(gemini({apiKey:'test',fetch:async()=>envelope('[]',{candidates:[{finishReason:'MAX_TOKENS'}]})})
    ('Read',{},RESPONSE_SCHEMA),{reason:'output_truncated'});
  await assert.rejects(createOpenAIAdapter({apiKey:'test',urls:[url],fetch:async()=>result([] ,[])})('Read',{},RESPONSE_SCHEMA),
    {reason:'retrieval_metadata_missing'});
});

test('strict schema preserves input and closes optional nested objects',()=>{
  const original={type:'object',properties:{optional:{type:'string'},nested:{type:'array',items:{type:'object',
    properties:{id:{type:'integer'}},required:['id']}}}},before=structuredClone(original),next=strictSchema(original);
  assert.deepEqual(original,before);assert.equal(next.additionalProperties,false);
  assert.deepEqual(next.required,['optional','nested']);assert.deepEqual(next.properties.optional.type,['string','null']);
  assert.equal(next.properties.nested.items.additionalProperties,false);
  assert.equal(RESPONSE_SCHEMA.maxItems,undefined);
});

test('web investigations use OpenAI directly and preserve batched linked/native reads through continuation',async()=>{
  let requests=0;const signals=[],seen=[];
  const model=trackerModel({source:{url,source_kind:'web'},openaiApiKey:'test',readUrl:async target=>{
    seen.push(target);return target.endsWith('.pdf')?{url:target,media_type:'application/pdf'}:{url:target,media_type:'text/html',content:'Programme opens at 09:30 UTC'};
  },fetch:async(target,options)=>{
    assert.equal(target,'https://api.openai.com/v1/responses');signals.push(options.signal);
    const body=JSON.parse(options.body);assert.equal(body.store,false);assert.equal(body.previous_response_id,undefined);
    if(++requests===1)return Response.json({status:'completed',usage:{input_tokens:100,output_tokens:20,total_tokens:120},output:[
      {type:'reasoning',id:'r',encrypted_content:'opaque',summary:[]},
      {type:'function_call',name:'read_url',call_id:'page',arguments:JSON.stringify({url:url+'/agenda'})},
      {type:'function_call',name:'read_url',call_id:'pdf',arguments:JSON.stringify({url:url+'/programme.pdf'})}]});
    assert.ok(body.input.some(i=>i.type==='reasoning'&&i.encrypted_content==='opaque'));
    const outputs=body.input.filter(i=>i.type==='function_call_output');assert.deepEqual(outputs.map(i=>i.call_id),['page','pdf']);
    assert.match(outputs[0].output[0].text,/09:30 UTC/);assert.deepEqual(outputs[1].output[1],{type:'input_file',file_url:url+'/programme.pdf'});
    return result([{description:'Workshop',date:'2026-10-24',starttime:'09:30',timezone:'UTC'}],[]);
  }});
  const answer=await model('Read',{url,source_kind:'web',content:{url,media_type:'text/html',content:'Directory'}},RESPONSE_SCHEMA);
  assert.equal(answer.status,'found');assert.equal(requests,2);assert.deepEqual(seen,[url+'/agenda',url+'/programme.pdf']);
  assert.equal(signals[0],signals[1]);assert.equal(answer._diagnostics.attempts.length,1);
  assert.equal(answer._diagnostics.attempts[0].diagnostics.usage.input_tokens,100);
  assert.throws(()=>trackerModel({provider:'gemini',source:{url,source_kind:'web'}}),{reason:'model_configuration'});
});

test('Terra receives complete prepared evidence once, native documents and readable provider references',async()=>{
 const page=url+'/programme',pdf=page+'.pdf',image=page+'.png',reference=url+'/reference';
 const proof='Full programme evidence '.repeat(4000)+'Decisive fact at the end.';
 let calls=0;const reads=[];
 const generate=createOpenAIAdapter({apiKey:'test',model:'gpt-6.1-terra',urls:[url],readUrl:async target=>{
  reads.push(target);assert.equal(target,reference);return {url:reference,media_type:'text/html',content:'Reference opened by Terra'};
 },fetch:async(_url,options)=>{
  calls++;const body=JSON.parse(options.body),parts=body.input.flatMap(i=>i.content??[]);
  assert.equal(body.reasoning.effort,'none');assert.equal(body.temperature,0);
  assert.equal(JSON.parse(parts[0].text).input.evidence,undefined);
  assert.equal(parts.filter(p=>p.text?.includes(proof)).length,1);
  assert.ok(parts.some(p=>p.type==='input_file'&&p.file_url===pdf));
  assert.ok(parts.some(p=>p.type==='input_image'&&p.image_url===image));
  if(calls===1)return Response.json({status:'completed',output:[page,reference].map((target,i)=>({type:'function_call',name:'read_url',call_id:String(i),arguments:JSON.stringify({url:target})}))});
  const outputs=body.input.filter(i=>i.type==='function_call_output');
  assert.equal(JSON.parse(outputs[0].output).status,'already_supplied');
  assert.match(outputs[1].output[0].text,/Reference opened by Terra/);
  return result([],[]);
 }});
 await generate(INTAKE_INSTRUCTION,{url,content:{url,media_type:'text/html',content:'Original source'},evidence:[
  {url:page,media_type:'text/html',content:proof},{url:pdf,media_type:'application/pdf'},
  {url:image,media_type:'image/png'},{url:reference,status:'PROVIDER_WEB_REFERENCE',method:'provider_web'}
 ]},RESPONSE_SCHEMA);
 assert.equal(calls,2);assert.deepEqual(reads,[reference]);
});

test('broken linked reads return errors while other findings survive, without provider fallback',async()=>{
  let requests=0;
  const generate=createOpenAIAdapter({apiKey:'test',urls:[url],readUrl:async()=>{throw Object.assign(new Error('Not found'),{reason:'source_unavailable'});},fetch:async(_target,options)=>{
    if(++requests===1)return Response.json({status:'completed',output:[{type:'function_call',name:'read_url',call_id:'broken',arguments:JSON.stringify({url:url+'/404.pdf'})}]});
    const output=JSON.parse(options.body).input.find(i=>i.type==='function_call_output');assert.equal(JSON.parse(output.output).error,'source_unavailable');
    return result([{description:'Useful event with unknown time',date:'2026-10-24',starttime:null}],[]);
  }});
  const answer=await generate('Read',{content:{content:'Directory'}},RESPONSE_SCHEMA);
  assert.equal(answer.records.length,1);assert.equal(answer.records[0].starttime,null);assert.equal(requests,2);
});

test('rejected and oversized native images are removed from replay and become failed reads',async t=>{
  for(const error of [{code:'invalid_image_url',message:'Could not download image'},
    {code:'invalid_value',message:'The image you provided requires 33383 patches after processing, exceeding the limit of 30000. Please resize the image and try again.'}])await t.test(error.code,async()=>{
  let requests=0;
  const generate=createOpenAIAdapter({apiKey:'test',urls:[url],fetch:async(_target,options)=>{
    const parts=JSON.parse(options.body).input.flatMap(i=>i.content??[]);
    if(++requests===1){assert.ok(parts.some(p=>p.type==='input_image'));return Response.json({error},{status:400});}
    assert.ok(!parts.some(p=>p.type==='input_image'));assert.ok(parts.some(p=>p.text?.includes('source_unavailable')));
    return result([{description:'Event retained from the source label'}],[]);
  }});
  const answer=await generate('Read',{url,source_kind:'web',content:{url,media_type:'image/jpeg'}},RESPONSE_SCHEMA);
  assert.equal(answer.status,'found');assert.equal(requests,2);assert.equal(answer._diagnostics.retrieval[0].status,'NATIVE_INPUT_FAILED');
  });
});

test('continuations honor cancellation and unknown or malformed read operations fail',async()=>{
  for(const call of [{name:'other',call_id:'x',arguments:'{}'},{name:'read_url',call_id:'x',arguments:'{"url":3}'}]){
    const generate=createOpenAIAdapter({apiKey:'test',readUrl:()=>assert.fail('Invalid operation'),fetch:async()=>Response.json({status:'completed',output:[{type:'function_call',...call}]})});
    await assert.rejects(generate('Read',{content:{}},RESPONSE_SCHEMA),{reason:call.name==='other'?'unexpected_tool':'invalid_output'});
  }
  const controller=new AbortController();let requests=0;
  const generate=createOpenAIAdapter({apiKey:'test',readUrl:async()=>{controller.abort();throw new Error('aborted');},fetch:async()=>{
    requests++;return Response.json({status:'completed',output:[{type:'function_call',name:'read_url',call_id:'x',arguments:JSON.stringify({url})}]});
  }});
  await assert.rejects(generate('Read',{content:{}},RESPONSE_SCHEMA,{signal:controller.signal}),{reason:'runtime_bound'});assert.equal(requests,1);
});
