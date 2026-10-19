import {test} from 'node:test';
import assert from 'node:assert/strict';
import {trackerModel} from '../reader/models/gateway.js';
import {strictSchema,openai,OPENAI_MODEL} from '../reader/models/openai.js';
import {gemini} from '../reader/models/gemini.js';
import {INTAKE_INSTRUCTION,RESPONSE_SCHEMA} from '../reader/instructions.js';

const url='https://example.org/source';
const result=(records=[],web=[{type:'web_search_call',status:'completed',action:{type:'open_page',url}}])=>Response.json({
  status:'completed',output:[...web,{type:'message',content:[{type:'output_text',text:JSON.stringify({records})}]}]});
const envelope=(text='[]',extra={})=>Response.json({candidates:[{finishReason:'STOP',
  urlContextMetadata:{urlMetadata:[{retrievedUrl:url,urlRetrievalStatus:'URL_RETRIEVAL_STATUS_SUCCESS'}]},
  content:{parts:[{text}]}}],...extra});

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
  await openai({apiKey:'test',urls,fetch:async(_,options)=>{
    assert.deepEqual(JSON.parse(JSON.parse(options.body).input).urls,urls);return result();
  }})('Read',{},RESPONSE_SCHEMA);
});

test('fallback is one attempt and preserves provider diagnostics',async t=>{
  const cases=[['valid none',()=>envelope(),false],['retrieval error',()=>envelope('[]',{candidates:[{finishReason:'STOP',
    urlContextMetadata:{urlMetadata:[{retrievedUrl:url,urlRetrievalStatus:'ERROR'}]},content:{parts:[{text:'[]'}]}}]}),true],
    ['missing metadata',()=>envelope('[]',{candidates:[{finishReason:'STOP',content:{parts:[{text:'[]'}]}}]}),true],
    ['invalid JSON',()=>envelope('{'),true],['invalid output',()=>envelope('{}'),true],
    ['empty found',()=>envelope('[null,{}]'),true],['missing candidate',()=>envelope('[]',{candidates:[]}),true],
    ['truncated',()=>envelope('[]',{candidates:[{finishReason:'MAX_TOKENS'}]}),true],
    ['429',()=>new Response('{}',{status:429}),true],['503',()=>new Response('{}',{status:503}),true],
    ['network',()=>{throw Error('Private transport text');},true],
    ['auth',()=>new Response('{}',{status:401}),false],['rejected',()=>new Response('{}',{status:400}),false],
    ['safety',()=>envelope('[]',{promptFeedback:{blockReason:'SAFETY'}}),false]];
  for(const [name,response,recover] of cases)await t.test(name,async()=>{
    const calls=[];
    const model=trackerModel({source:{url},apiKey:'test',openaiApiKey:'test',fetch:async target=>{
      calls.push(target);return target.includes('googleapis')?response():result();
    }});
    const answer=await model(INTAKE_INSTRUCTION,{url},RESPONSE_SCHEMA).catch(e=>e);
    assert.equal(calls.length,recover?2:1);
    assert.ok(!JSON.stringify(answer).includes('Private transport text'));
    if(recover)assert.deepEqual(answer._diagnostics.attempts.map(a=>a.provider),['gemini','openai']);
  });
  let calls=0;
  const model=trackerModel({source:{url},apiKey:'test',openaiApiKey:'test',fetch:async()=>{calls++;return new Response('{}',{status:503});}});
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
  for(const generate of [gemini,openai]){
    const controller=new AbortController();controller.abort();
    await assert.rejects(generate({apiKey:'test',fetch:async()=>{throw Error('aborted');}})('Read',{},RESPONSE_SCHEMA,{signal:controller.signal}),
      {reason:'runtime_bound'});
  }
});

test('provider errors retain actual account/context limits and redact credentials',async()=>{
  for(const [status,code,reason] of [[429,'rate_limit_exceeded','provider_rate_limit'],[429,'insufficient_quota','provider_spend_limit'],
    [400,'context_length_exceeded','provider_context_limit'],[401,'invalid_api_key','provider_auth']]){
    const generate=openai({apiKey:'private-key',fetch:async()=>Response.json({
      error:{code,message:'private-key sk-proj-masked***'}},{status})});
    await assert.rejects(generate('Read',{},RESPONSE_SCHEMA),error=>{
      assert.equal(error.reason,reason);assert.ok(!/private-key|sk-proj-/.test(JSON.stringify(error)));return true;
    });
  }
});

test('provider truncation and malformed replies fail instead of accepting partial output',async()=>{
  await assert.rejects(openai({apiKey:'test',fetch:async()=>Response.json({status:'incomplete',incomplete_details:{reason:'max_output_tokens'}})})
    ('Read',{},RESPONSE_SCHEMA),{reason:'output_incomplete'});
  await assert.rejects(gemini({apiKey:'test',fetch:async()=>envelope('[]',{candidates:[{finishReason:'MAX_TOKENS'}]})})
    ('Read',{},RESPONSE_SCHEMA),{reason:'output_truncated'});
  await assert.rejects(openai({apiKey:'test',urls:[url],fetch:async()=>result([] ,[])})('Read',{},RESPONSE_SCHEMA),
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
