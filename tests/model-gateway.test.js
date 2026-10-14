import {test} from 'node:test';
import assert from 'node:assert/strict';
import {strictSchema,openai,modelGateway,trackerModel,OPENAI_MODEL} from '../collector/model-gateway.js';
import {INTAKE_INSTRUCTION,RESPONSE_SCHEMA} from '../collector/finding-contract.js';
import {MODEL,MODEL_LIMITS} from '../collector/model.js';

const url='https://example.org/source?query=%7B%22sideEvent.id%22%3A6915%7D';
const schema={type:'object',properties:{status:{type:'string'},records:{type:'array',items:{type:'object'}}},required:['status','records']};
const answer=()=>({status:'none',records:[],_usage:{input_tokens:100,output_tokens:10}});
const result=(text='{"status":"none","records":[]}',extra={})=>Response.json({model:OPENAI_MODEL,status:'completed',usage:{input_tokens:100,output_tokens:10},
  output:[{type:'message',content:[{type:'output_text',text}]}],...extra});
const page=(body='<p>Source text <a href="/register?token=whole">Register</a></p>',extra={})=>({status:200,url,headers:{'content-type':'text/html; charset=utf-8'},body,...extra});
function setup({task='url_intake',provider='openai',generate=async()=>answer(),routes,providers,budget,accounting,now=Date.now,deadline}={}){
  const time=now(),logs={reserved:[],settled:[]};
  const limits=model=>({verifiedAt:time,expiresAt:time+600000,accessVerified:true,model,remainingAttempts:3,remainingInputTokens:180000,
    inputTokens:60000,outputTokens:model===MODEL?MODEL_LIMITS.output:1500,inputUSDPerMillion:0.125,outputUSDPerMillion:0.5,cooldownUntil:0});
  const config={task,routes:routes??{[task]:{provider}},providers:providers??{[provider]:{model:provider==='openai'?OPENAI_MODEL:'gemini-3.5-flash-lite',generate}},
    budget:budget??{verifiedAt:time,expiresAt:time+600000,maxCostUSD:0.10,creditRemainingUSD:0.10,
      providers:{openai:limits(OPENAI_MODEL),gemini:limits('gemini-3.5-flash-lite')}},
    accounting:accounting??{reserve:async value=>{logs.reserved.push(value);return {allowed:true};},settle:async value=>{logs.settled.push(value);}},now,deadline:deadline??time+100000};
  return {config,logs,model:modelGateway(config)};
}
const retrievalFailure=(extra={})=>Object.assign(new Error('url_retrieval_failed'),{reason:'url_retrieval_failed',dispatched:true,
  usage:{input_tokens:701,output_tokens:41},diagnostics:{http_status:200,retrieval_metadata_present:true,
    retrieval:[{url,status:'URL_RETRIEVAL_STATUS_ERROR'}],model_status:'unreadable',...extra}});

test('strict schema keeps common schema untouched and closes nested nullable optional shapes',()=>{
  const original={type:'object',properties:{required:{type:'string'},optional:{type:'string',enum:['one']},
    nested:{type:'array',items:{type:'object',properties:{id:{type:'integer'},extra:{$ref:'#/$defs/text'}},required:['id']}},
    variant:{anyOf:[{type:'string'},{type:'integer'}]}},required:['required'],$defs:{text:{type:'object',properties:{value:{type:'string'}}}}};
  const before=structuredClone(original),next=strictSchema(original);
  assert.deepEqual(original,before);assert.deepEqual(next.required,['required','optional','nested','variant']);assert.equal(next.additionalProperties,false);
  assert.deepEqual(next.properties.optional.enum,['one',null]);assert.deepEqual(next.properties.optional.type,['string','null']);
  assert.deepEqual(next.properties.nested.type,['array','null']);assert.deepEqual(next.properties.nested.items.required,['id','extra']);
  assert.deepEqual(next.properties.nested.items.properties.extra.anyOf,[{$ref:'#/$defs/text'},{type:'null'}]);
  assert.deepEqual(next.properties.variant.anyOf.at(-1),{type:'null'});assert.equal(next.$defs.text.additionalProperties,false);
  assert.deepEqual(strictSchema(schema).properties.records.items,{type:'object',properties:{},required:[],additionalProperties:false});
  for(const invalid of [undefined,null,{type:'array'},{type:'object',anyOf:[]}])assert.throws(()=>strictSchema(invalid),{reason:'invalid_schema'});
});

test('OpenAI transports the full rubric, partials, real links and exact native JSON URL without tools',async()=>{
  const requests=[],reads=[],native=JSON.stringify([{sideEvent:{id:6915},organizationIds:['CBD','DOALOS'],date:'2026-07-29'}]);
  const partial={records:[{title:'Existing title',organizations:[{name:'Confirmed organization'}]}],requested_links:[{url:'https://example.org/support?raw=%2B',question:'Which date?'}],native_identity:'cbd:side-event:6915'};
  const generate=openai({apiKey:'test-key',urls:[url],read:async target=>{reads.push(target);return page(target===url?native:'<p>July 29 <a href="/registration?a=%2B">Sign up</a></p>',
    {url:target,headers:{'content-type':target===url?'application/json':'text/html'}});},fetch:async(target,options)=>{requests.push({target,options});return result('{"records":[]}');}});
  const {model,logs}=setup({generate}),output=await model(INTAKE_INSTRUCTION,partial,RESPONSE_SCHEMA);
  const request=JSON.parse(requests[0].options.body),input=JSON.parse(request.input);
  assert.ok(request.instructions.startsWith(INTAKE_INSTRUCTION));assert.deepEqual(input.input,partial);assert.deepEqual(reads,[url,partial.requested_links[0].url]);
  assert.equal(input.sources[0].body,native);assert.equal(input.sources[0].requested_url,url);assert.equal(input.sources[0].coverage,'complete_json');
  assert.ok(input.sources[1].body.includes('https://example.org/registration?a=%2B'));assert.equal(input.sources[1].coverage,'html_text');
  assert.equal(request.model,OPENAI_MODEL);assert.equal(request.store,false);assert.equal(request.service_tier,'default');assert.equal(request.reasoning.effort,'none');
  assert.equal(request.tools,undefined);assert.equal(request.max_output_tokens,1500);assert.equal(request.text.format.strict,true);
  assert.deepEqual(request.text.format.schema.required,['records']);
  assert.deepEqual(Object.keys(request.text.format.schema.properties),['records']);
  const transportRecords=structuredClone(RESPONSE_SCHEMA);transportRecords.items.required.push('deadline');
  assert.deepEqual(request.text.format.schema.properties.records,transportRecords);
  assert.deepEqual(Object.keys(RESPONSE_SCHEMA.items.properties),['description','type','priority','organizations','date','starttime','timezone','deadline']);
  assert.equal(output.status,'none');assert.deepEqual(output.records,[]);
  assert.ok(requests[0].options.signal instanceof AbortSignal);assert.equal(output._usage.generations,1);
  assert.equal(output._diagnostics.model,OPENAI_MODEL);assert.equal(output._diagnostics.attempts[0].diagnostics.tool_calls,0);
  assert.equal(output._retrieval[0].method,'application_read');
  const retained=JSON.stringify(logs);assert.ok(!retained.includes('Confirmed organization'));assert.ok(!retained.includes('Which date?'));assert.ok(!retained.includes('test-key'));assert.ok(!retained.includes(url));
  assert.equal(logs.reserved[0].cost_usd,0.00825);assert.ok(output._usage.estimated_cost_usd<logs.reserved[0].cost_usd);
});

test('OpenAI reports observed redirects without replacing the complete requested URL',async()=>{
  const final='https://public.example.org/final';let request;
  const {model}=setup({generate:openai({apiKey:'test',urls:[url],read:async()=>page('<p>Real page</p>',{url:final}),fetch:async(_,options)=>{request=JSON.parse(options.body);return result();}})});
  const output=await model('Read this URL',[],schema),source=JSON.parse(request.input).sources[0];
  assert.equal(source.requested_url,url);assert.equal(source.final_url,final);assert.equal(output._retrieval[0].url,url);
});

test('URL intake requires an explicit main source before dispatch; record answering can use its supplied snapshot',async()=>{
  let calls=0;
  const generate=openai({apiKey:'test',urls:[],fetch:async()=>{calls++;return result('{"status":"found","records":[{"title":"A guess"}]}');}});
  const intake=setup({generate});
  for(const input of [[],{requested_links:[{url:'https://example.org/support',question:'Find missing fields'}]}])
    await assert.rejects(intake.model('Read source',input,schema),{reason:'source_required',dispatched:false});
  assert.equal(calls,0);assert.ok(intake.logs.settled.every(value=>value.cost_usd===0));
  const records=setup({task:'answer_records',generate});
  const answer=await records.model('Answer using these authorized records',{records:[{title:'Authorized snapshot'}]},schema);
  assert.equal(calls,1);assert.equal(answer._usage.generations,1);assert.equal(answer._diagnostics.attempts[0].diagnostics.source_reads.length,0);
});

test('calling the OpenAI adapter directly cannot bypass gateway reservation with numeric limits',async()=>{
  let calls=0,reads=0;
  const generate=openai({apiKey:'test',urls:[url],read:async()=>{reads++;return page();},fetch:async()=>{calls++;return result();}});
  await assert.rejects(generate('Read',[],schema,{inputTokens:60000,outputTokens:1500,deadline:Date.now()+100000,task:'url_intake'}),
    {reason:'accounting',dispatched:false});
  assert.equal(calls,0);assert.equal(reads,0);
});

test('source failure is separate from provider output and never dispatches or saves response bodies',async()=>{
  let http=0;
  const sourceError=Object.assign(new Error('provider HTML includes secret'),{response:page('PRIVATE SOURCE BODY',{status:503,url:'https://example.org/final'})});
  const {model,logs}=setup({generate:openai({apiKey:'test',urls:[url],read:async()=>{throw sourceError;},fetch:async()=>{http++;return result();}})});
  await assert.rejects(model('Read',[],schema),error=>{
    assert.equal(error.reason,'source_read_failed');assert.equal(error.dispatched,false);assert.equal(error.usage.generations,0);
    assert.deepEqual(error.diagnostics.attempts[0].diagnostics.source_reads,[{requested_url:url,final_url:'https://example.org/final',status:503,coverage:'failed'}]);
    assert.ok(!JSON.stringify(error).includes('PRIVATE SOURCE BODY'));return true;
  });
  assert.equal(http,0);assert.equal(logs.settled[0].cost_usd,0);assert.equal(logs.settled[0].state,'settled');
});

test('source bounds refuse whole oversized JSON/HTML and unsupported or unobserved pages',async context=>{
  const variants=[['JSON too long',page(JSON.stringify({value:'x'.repeat(24001)}),{headers:{'content-type':'application/json'}}),'source_bound'],
    ['HTML too long',page('<p>'+('é'.repeat(12500))+'<a href="/must-remain-whole">Register</a></p>'),'source_bound'],
    ['truncated JSON',page('{"sideEvent":',{headers:{'content-type':'application/json'}}),'source_json_invalid'],
    ['PDF',page('bytes',{headers:{'content-type':'application/pdf'}}),'source_type_unsupported'],
    ['HTTP error',page('not read',{status:403}),'source_read_failed'],
    ['missing URL',page('text',{url:undefined}),'source_read_failed'],
    ['private final URL',page('text',{url:'https://127.0.0.1/'}),'source_read_failed']];
  for(const [name,value,reason] of variants)await context.test(name,async()=>{
    let http=0;const {model}=setup({generate:openai({apiKey:'test',urls:[url],read:async()=>value,fetch:async()=>{http++;return result();}})});
    await assert.rejects(model('Read',[],schema),{reason,dispatched:false});assert.equal(http,0);
  });
  assert.throws(()=>openai({apiKey:'test',urls:['https://127.0.0.1/']}));
  assert.throws(()=>openai({apiKey:'test',urls:Array.from({length:5},(_,i)=>`https://example.org/${i}`)}),{reason:'source_bound'});
});

test('explicit Gemini retrieval gap falls back once and returns both usage and original diagnostics',async()=>{
  const received=[],providers={gemini:{model:'gemini-3.5-flash-lite',generate:async(...args)=>{received.push(args);throw retrievalFailure();}},
    openai:{model:OPENAI_MODEL,generate:async(...args)=>{received.push(args);return answer();}}};
  const {model,logs}=setup({providers,routes:{url_intake:{provider:'gemini',fallback:'openai',fallbackReasons:["url_retrieval_failed"]}}});
  const input={records:[{title:'Partial'}]},output=await model(INTAKE_INSTRUCTION,input,RESPONSE_SCHEMA);
  assert.equal(output._usage.generations,2);assert.equal(output._usage.input_tokens,801);assert.equal(output._usage.output_tokens,51);
  assert.deepEqual(output._diagnostics.attempts.map(a=>a.provider),['gemini','openai']);
  assert.equal(output._diagnostics.attempts[0].diagnostics.retrieval[0].status,'URL_RETRIEVAL_STATUS_ERROR');
  assert.equal(output._diagnostics.attempts[0].diagnostics.http_status,200);assert.equal(output._diagnostics.attempts[0].reason,'url_retrieval_failed');
  assert.strictEqual(received[0][0],received[1][0]);assert.strictEqual(received[0][1],received[1][1]);assert.strictEqual(received[0][2],received[1][2]);
  assert.equal(logs.reserved.length,2);assert.equal(logs.settled.length,2);
  await assert.rejects(model('Improve',input,schema),error=>{assert.equal(error.reason,'attempt_bound');assert.equal(error.usage.generations,0);return true;});
  assert.equal(received.length,2);
});

test('default routes and noneligible failures never fall back',async context=>{
  const cases=[['opt-in absent',retrievalFailure(),false],
    ...['provider_auth','provider_safety','quota','provider_cooldown','runtime_bound','spending_bound','accounting'].map(reason=>[reason,Object.assign(new Error(reason),{reason,dispatched:true}),true])];
  for(const [name,error,optIn] of cases)await context.test(name,async()=>{
    let fallback=0;const {model}=setup({routes:{url_intake:{provider:'gemini',fallback:'openai',fallbackReasons:optIn?['url_retrieval_failed']:undefined}},
      providers:{gemini:{model:'gemini-3.5-flash-lite',generate:async()=>{throw error;}},openai:{model:OPENAI_MODEL,generate:async()=>{fallback++;return answer();}}}});
    await assert.rejects(model('Read',[],schema));assert.equal(fallback,0);
  });
});

test('missing/stale account or provider budgets and missing accounting fail closed before any adapter',async context=>{
  const mutations=[['missing budget',c=>delete c.budget],['missing reserve',c=>delete c.accounting.reserve],['missing settle',c=>delete c.accounting.settle],
    ['expired budget',c=>c.budget.expiresAt=0],['stale evidence',c=>c.budget.verifiedAt-=900001],['future evidence',c=>c.budget.verifiedAt+=10000],
    ['no credit',c=>c.budget.creditRemainingUSD=0],['unlimited cap',c=>c.budget.maxCostUSD=Infinity],
    ['unverified model',c=>c.budget.providers.openai.accessVerified=false],['different model',c=>c.budget.providers.openai.model='another-model'],
    ['expired provider',c=>c.budget.providers.openai.expiresAt=0],['missing token allowance',c=>delete c.budget.providers.openai.remainingInputTokens],
    ['no finite output',c=>c.budget.providers.openai.outputTokens=Infinity],['cache underreservation',c=>c.budget.providers.openai.inputUSDPerMillion=0.1]];
  for(const [name,change] of mutations)await context.test(name,async()=>{
    let calls=0;const {config,logs}=setup({generate:async()=>{calls++;return answer();}});change(config);
    await assert.rejects(modelGateway(config)('Read',[],schema));assert.equal(calls,0);assert.equal(logs.reserved.length,0);
  });
  const {config}=setup();config.providers.openai.model='gpt-6-astra';config.budget.providers.openai.model='gpt-6-astra';
  await assert.rejects(modelGateway(config)('Read',[],schema),{reason:'configuration'});
  for(const field of ['inputTokens','outputTokens']){
    const {config}=setup({provider:'gemini'});config.budget.providers.gemini[field]--;
    await assert.rejects(modelGateway(config)('Read',[],schema),{reason:'budget'});
  }
});

test('spending, token allowance, provider cooldown, deadline and reservations stop dispatch',async context=>{
  const cases=[['spending',c=>{c.budget.maxCostUSD=0.001;},'spending_bound'],['tokens',c=>{c.budget.providers.openai.remainingInputTokens=1;},'budget'],
    ['cooldown',c=>{c.budget.providers.openai.cooldownUntil=Date.now()+60000;},'provider_cooldown'],['deadline',c=>{c.deadline=Date.now()+1000;},'runtime_bound'],
    ['unbounded deadline',c=>{c.deadline=Date.now()+200000;},'runtime_bound'],['quota',c=>{c.accounting.reserve=async()=>({allowed:false});},'quota']];
  for(const [name,change,reason] of cases)await context.test(name,async()=>{
    let calls=0;const {config}=setup({generate:async()=>{calls++;return answer();}});change(config);
    await assert.rejects(modelGateway(config)('Read',[],schema),{reason});assert.equal(calls,0);
  });
});

test('uncertain calls preserve full charges, consume the shared attempt allowance and expose no error text',async()=>{
  const {model,logs}=setup({task:'answer_records',generate:openai({apiKey:'secret-key',fetch:async()=>{throw new Error('secret-key source text response body');}})});
  for(let i=0;i<2;i++)await assert.rejects(model('Sensitive prompt',{private:'partial'},schema),error=>{
    assert.equal(error.reason,'provider_unknown');assert.equal(error.usage.generations,1);assert.equal(error.usage.uncertain,true);
    assert.equal(error.usage.input_tokens,60000);assert.equal(error.usage.output_tokens,1500);assert.ok(!JSON.stringify(error).includes('secret-key'));return true;
  });
  await assert.rejects(model('Third',[],schema),{reason:'attempt_bound'});
  assert.equal(logs.settled.length,2);assert.ok(logs.settled.every(r=>r.state==='unknown'&&r.cost_usd===0.00825));
  assert.ok(!JSON.stringify(logs).includes('Sensitive prompt'));assert.ok(!JSON.stringify(logs).includes('partial'));
});

test('uncertain charge can exhaust credit before the second allowed generation',async()=>{
  const {config,logs}=setup({generate:async()=>{throw new Error('provider_unknown');}});config.budget.maxCostUSD=0.01;
  const model=modelGateway(config);await assert.rejects(model('Read',[],schema),{reason:'provider_unknown'});
  await assert.rejects(model('Again',[],schema),{reason:'spending_bound'});assert.equal(logs.reserved.length,1);
});

test('OpenAI HTTP errors reach the caller with bounded redacted details, never the accounting ledger',async context=>{
  const cases=[
    ['invalid key',401,{error:{code:'invalid_api_key',type:'invalid_request_error',param:null,
      message:'Incorrect API key: test-private-key or sk-proj-masked***suffix.\nCheck your key.'},private:'RAW_RESPONSE_BODY'},
      {error_code:'invalid_api_key',error_type:'invalid_request_error',error_message:'Incorrect API key: [REDACTED] or [REDACTED] Check your key.'}],
    ['missing permission',403,{error:{code:null,type:'invalid_request_error',param:'model',message:'Missing scopes: api.responses.write.'}},
      {error_type:'invalid_request_error',error_param:'model',error_message:'Missing scopes: api.responses.write.'}],
    ['malformed response',401,'<html>RAW_RESPONSE_BODY test-private-key</html>',{}],
    ['bounded details',401,{error:{code:'x'.repeat(200),type:[],param:{private:'RAW_RESPONSE_BODY'},message:'test-private-key '.repeat(100)}},
      {error_code:'x'.repeat(128),error_message:'[REDACTED] '.repeat(100).slice(0,512)}]
  ];
  for(const [name,status,body,details] of cases)await context.test(name,async()=>{
    const {model,logs}=setup({task:'answer_records',generate:openai({apiKey:'test-private-key',fetch:async()=>new Response(
      typeof body==='string'?body:JSON.stringify(body),{status,headers:{'x-request-id':'req_auth_check'}})})});
    await assert.rejects(model('Read',[],schema),error=>{
      assert.equal(error.reason,'provider_auth');assert.equal(error.dispatched,true);
      assert.deepEqual(error.diagnostics.attempts[0].diagnostics,{provider:'openai',model:OPENAI_MODEL,source_reads:[],tool_calls:0,
        http_status:status,request_id:'req_auth_check',...details});
      assert.ok(!/test-private-key|sk-proj-|RAW_RESPONSE_BODY/.test(JSON.stringify(error)));return true;
    });
    assert.equal(logs.settled[0].state,'unknown');assert.equal(logs.settled[0].cost_usd,logs.reserved[0].cost_usd);
    assert.ok(!/req_auth_check|error_message|test-private-key|RAW_RESPONSE_BODY/.test(JSON.stringify(logs)));
  });
});

test('provider errors/failed outputs settle known usage or retain uncertain reservations',async context=>{
  const cases=[['401',()=>new Response('body',{status:401}),'provider_auth',true],['429',()=>new Response('{}',{status:429,headers:{'retry-after':'300'}}),'provider_rate_limit',true],
    ['503',()=>new Response('{}',{status:503}),'provider_unavailable',true],['broken envelope',()=>new Response('{broken'),'invalid_output',true],
    ['null envelope',()=>Response.json(null),'invalid_output',true],['array envelope',()=>Response.json([]),'invalid_output',true],
    ['invalid output envelope',()=>result(undefined,{output:{text:'Wrong'}}),'invalid_output',false],
    ['null output item',()=>result(undefined,{output:[null]}),'invalid_output',false],
    ['invalid content',()=>result(undefined,{output:[{type:'message',content:{text:'Wrong'}}]}),'invalid_output',false],
    ['oversized response',()=>new Response('x'.repeat(131073)),'output_bound',true],
    ['broken JSON',()=>result('{'),'invalid_output',false],['array root',()=>result('[]'),'invalid_output',false],
    ['refusal',()=>result('',{output:[{type:'message',content:[{type:'refusal',refusal:'hidden private text'}]}]}),'provider_refused',false],
    ['incomplete',()=>result('',{status:'incomplete'}),'output_incomplete',false],
    ['tool output',()=>result('',{output:[{type:'web_search_call'}]}),'unexpected_tool',false]];
  for(const [name,response,reason,unknown] of cases)await context.test(name,async()=>{
    const {model,logs}=setup({task:'answer_records',generate:openai({apiKey:'test',fetch:async()=>response()})});
    await assert.rejects(model('Read',[],schema),error=>{assert.equal(error.reason,reason);assert.equal(error.dispatched,true);return true;});
    assert.equal(logs.settled[0].state,unknown?'unknown':'settled');assert.ok(!JSON.stringify(logs).includes('hidden private text'));
    if(reason==='provider_rate_limit')await assert.rejects(model('Retry',[],schema),{reason:'provider_cooldown'});
  });
});

test('valid partial remains available after actual token overrun, with charge settled and improvement blocked',async()=>{
  const partial={status:'found',records:[{title:'Useful partial',dates:[]}]};let calls=0;
  const {model,logs}=setup({task:'answer_records',generate:openai({apiKey:'test',fetch:async()=>{calls++;return result(JSON.stringify(partial),{usage:{input_tokens:60001,output_tokens:1501}});}})});
  const output=await model('Read',[],schema);assert.deepEqual(output.records,partial.records);assert.equal(output._usage.overrun,true);
  assert.equal(logs.settled[0].reason,'token_reservation_overrun');assert.equal(logs.settled[0].input_tokens,60001);assert.equal(logs.settled[0].output_tokens,1501);
  await assert.rejects(model('Improve',[],schema),{reason:'attempt_bound'});assert.equal(calls,1);
});

test('failed overrun preserves original retrieval failure and cannot trigger fallback or another generation',async()=>{
  let fallback=0;const error=retrievalFailure();error.usage={input_tokens:60001,output_tokens:41};
  const {model,logs}=setup({routes:{url_intake:{provider:'gemini',fallback:'openai',fallbackReasons:["url_retrieval_failed"]}},providers:{
    gemini:{model:MODEL,generate:async()=>{throw error;}},openai:{model:OPENAI_MODEL,generate:async()=>{fallback++;return answer();}}}});
  await assert.rejects(model('Read',[],schema),error=>{assert.equal(error.reason,'url_retrieval_failed');assert.equal(error.usage.overrun,true);return true;});
  assert.equal(fallback,0);assert.equal(logs.settled[0].reason,'url_retrieval_failed');assert.equal(logs.settled[0].input_tokens,60001);
  await assert.rejects(model('Improve',[],schema),{reason:'attempt_bound'});
});

test('input bound and a deadline expired by reservation create no generation',async()=>{
  let calls=0;const {model,logs}=setup({task:'answer_records',generate:openai({apiKey:'test',fetch:async()=>{calls++;return result();}})});
  await assert.rejects(model('x'.repeat(60000),[],schema),{reason:'input_bound',dispatched:false});assert.equal(calls,0);assert.equal(logs.settled[0].input_tokens,0);
  await assert.rejects(model('Read',[],{type:'array'}),{reason:'invalid_schema',dispatched:false});assert.equal(calls,0);
  let time=Date.now();const {config,logs:after}=setup({now:()=>time,generate:async()=>{calls++;return answer();}});
  config.accounting.reserve=async()=>{time+=99000;return {allowed:true};};
  await assert.rejects(modelGateway(config)('Read',[],schema),{reason:'runtime_bound',dispatched:false});assert.equal(calls,0);assert.equal(after.settled[0].cost_usd,0);
});

test('settlement failure halts the invocation and never refunds an uncertain charge',async()=>{
  let calls=0;const {config,logs}=setup({generate:async()=>{calls++;throw new Error('provider_unknown');}});
  config.accounting.settle=async value=>{logs.settled.push(value);throw new Error('Database secret');};const model=modelGateway(config);
  await assert.rejects(model('Read',[],schema),{reason:'accounting'});await assert.rejects(model('Retry',[],schema),{reason:'attempt_bound'});
  assert.equal(calls,1);assert.equal(logs.settled[0].state,'unknown');assert.equal(logs.settled[0].cost_usd,logs.reserved[0].cost_usd);
});

test('second configured task uses the same dispatcher and cannot overlap invocation calls',async()=>{
  let finish,calls=0;const {config}=setup({routes:{url_intake:{provider:'openai'},answer_records:{provider:'openai'}},
    generate:async(instruction,input)=>{calls++;assert.equal(instruction,'Record instruction');assert.deepEqual(input,{records:[{title:'Authorized snapshot'}]});await new Promise(resolve=>{finish=resolve;});return answer();}});
  const model=modelGateway({...config,task:'answer_records'}),pending=model('Record instruction',{records:[{title:'Authorized snapshot'}]},schema);
  await new Promise(resolve=>setImmediate(resolve));await assert.rejects(model('Overlap',[],schema),{reason:'invocation_busy'});
  finish();const output=await pending;assert.equal(calls,1);assert.equal(output._diagnostics.model,OPENAI_MODEL);
});

test('tracker route falls back only for approved unusable Gemini results, accounting each provider once',async context=>{
  const partial={status:'found',records:[null,{type:'event',description:'Useful partial',organizations:[null],date:'bad'}]};
  const envelope=(text='[]',extra={})=>Response.json({usageMetadata:{promptTokenCount:100,toolUsePromptTokenCount:20,candidatesTokenCount:10,totalTokenCount:130},
    candidates:[{finishReason:'STOP',urlContextMetadata:{urlMetadata:[{retrievedUrl:url,urlRetrievalStatus:'URL_RETRIEVAL_STATUS_SUCCESS'}]},content:{parts:[{text}]}}],...extra});
  const cases=[['valid none',()=>envelope(),false],['useful malformed-optional partial',()=>envelope(JSON.stringify(partial.records)),false],
    ['retrieval error',()=>envelope('[]',{candidates:[{finishReason:'STOP',urlContextMetadata:{urlMetadata:[{retrievedUrl:url,urlRetrievalStatus:'URL_RETRIEVAL_STATUS_ERROR'}]},content:{parts:[{text:'[]'}]}}]}),true],
    ['missing retrieval metadata',()=>envelope(undefined,{candidates:[{finishReason:'STOP',content:{parts:[{text:'[]'}]}}]}),true],
    ['invalid JSON',()=>envelope('{'),true],
    ['invalid output',()=>envelope('{"status":"wrong","records":[]}'),true],['empty found',()=>envelope('[null,{}]'),true],
    ['missing candidate',()=>envelope(undefined,{candidates:[]}),true],['missing finish',()=>envelope(undefined,{candidates:[{content:{parts:[{text:'{}'}]}}]}),true],
    ['truncated',()=>envelope(undefined,{candidates:[{finishReason:'MAX_TOKENS'}]}),true],
    ['429',()=>new Response('{}',{status:429}),true],['503',()=>new Response('{}',{status:503}),true],['network',()=>{throw Error('Private transport text');},true],
    ['auth',()=>new Response('{}',{status:401}),false],['request rejected',()=>new Response('{}',{status:400}),false],
    ['safety',()=>envelope(undefined,{promptFeedback:{blockReason:'SAFETY'}}),false],['explicit safety finish',()=>envelope(undefined,{candidates:[{finishReason:'SAFETY'}]}),false],
    ['other terminal finish',()=>envelope(undefined,{candidates:[{finishReason:'OTHER'}]}),false]];
  for(const [name,response,recover] of cases)await context.test(name,async()=>{
    const sql=[],calls={gemini:0,openai:0};let reads=0;
    const ledger={query:async(q,p)=>{sql.push({q,p});return {rows:[q.includes('reserve_provider')?{allowed:true}:{settled:true}]};}};
    const model=trackerModel({apiKey:'test',openaiApiKey:'test',ledger,source:{url,identity:'native:6915'},read:async()=>{reads++;return page();},fetch:async(target,options)=>{
      if(target.includes('googleapis')){calls.gemini++;return response();}calls.openai++;
      assert.equal(JSON.parse(options.body).max_output_tokens,1500);return result('{"records":[]}');
    }});
    const output=await model(INTAKE_INSTRUCTION,[],RESPONSE_SCHEMA).catch(error=>error);
    assert.equal(calls.openai,recover?1:0);assert.equal(reads,recover?1:0);assert.equal(calls.gemini,1);
    assert.equal(sql.filter(item=>item.q.includes('reserve_provider')).length,recover?2:1);assert.equal(sql.filter(item=>item.q.includes('settle_provider')).length,recover?2:1);
    assert.ok(sql.every(item=>!item.q.includes('reserve_model')));assert.ok(!JSON.stringify(sql).includes('Private transport text'));
    if(name==='invalid JSON'||name==='missing candidate'||name==='missing finish'){
      const settlement=sql.find(item=>item.q.includes('settle_provider'));assert.deepEqual(settlement.p.slice(1,4),[120,10,'settled']);
    }
    if(recover)assert.equal(output._usage.generations,2);if(name==='useful malformed-optional partial')assert.deepEqual(output.records,partial.records);
  });
});

test('tracker second generation has no fallback; missing usage remains uncertain and missing backup budget stops before OpenAI',async()=>{
  const sql=[],ledger={query:async(q,p)=>{sql.push({q,p});return {rows:[q.includes('reserve_provider')?{allowed:true}:{settled:true}]};}};
  let calls=0;const model=trackerModel({apiKey:'test',openaiApiKey:'test',ledger,source:{url},read:async()=>assert.fail('No fallback'),fetch:async()=>{
    calls++;return Response.json({candidates:[{finishReason:'STOP',urlContextMetadata:{urlMetadata:[{retrievedUrl:url,urlRetrievalStatus:'URL_RETRIEVAL_STATUS_SUCCESS'}]},
      content:{parts:[{text:calls===1?'[]':'{'}]}}]});}});
  assert.equal((await model('Read',[],RESPONSE_SCHEMA))._usage.uncertain,true);
  await assert.rejects(model('Improve',[],RESPONSE_SCHEMA),{reason:'invalid_json'});assert.equal(calls,2);assert.equal(sql.length,4);
  let dispatched=0;const guarded=trackerModel({apiKey:'test',openaiApiKey:'test',source:{url},ledger:{query:async(q,p)=>({rows:[q.includes('reserve_provider')?
    {allowed:p[2]==='gemini',reason:'provider_budget'}:{settled:true}]})},fetch:async()=>{dispatched++;throw Error('Network');}});
  await assert.rejects(guarded('Read',[],RESPONSE_SCHEMA),{reason:'provider_budget'});assert.equal(dispatched,1);
});
