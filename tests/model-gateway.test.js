import {test} from 'node:test';
import assert from 'node:assert/strict';
import {strictSchema,openai,modelGateway,OPENAI_MODEL} from '../collector/model-gateway.js';
import {INTAKE_INSTRUCTION,RESPONSE_SCHEMA} from '../collector/finding-contract.js';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {processDocument} from '../collector/finding-jobs.js';
import {correctFinding} from '../collector/corrections.js';
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
    inputTokens:60000,outputTokens:model===MODEL?MODEL_LIMITS.output:4096,inputUSDPerMillion:0.125,outputUSDPerMillion:0.5,cooldownUntil:0});
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
  const transport=strictSchema(RESPONSE_SCHEMA);
  assert.deepEqual(RESPONSE_SCHEMA.required,['status','records']);
  assert.deepEqual(RESPONSE_SCHEMA.properties.follow_up_requests.items.required,['question']);
  for(const key of ['further_research','follow_up_requests','note'])assert.ok(transport.properties[key].type.includes('null'));
  assert.deepEqual(transport.properties.records.items.properties.priority.enum,['high','normal','low',null]);
  assert.deepEqual(transport.properties.records.items.properties.dates.items.required,['meaning','date','time','timezone']);
  assert.deepEqual(strictSchema(schema).properties.records.items,{type:'object',properties:{},required:[],additionalProperties:false});
  for(const invalid of [undefined,null,{type:'array'},{type:'object',anyOf:[]}])assert.throws(()=>strictSchema(invalid),{reason:'invalid_schema'});
});

test('OpenAI transports the full rubric, partials, real links and exact native JSON URL without tools',async()=>{
  const requests=[],reads=[],native=JSON.stringify([{sideEvent:{id:6915},organizationIds:['CBD','DOALOS'],date:'2026-07-29'}]);
  const partial={records:[{title:'Existing title',organizations:[{name:'Confirmed organization'}]}],requested_links:[{url:'https://example.org/support?raw=%2B',question:'Which date?'}],native_identity:'cbd:side-event:6915'};
  const generate=openai({apiKey:'test-key',urls:[url],read:async target=>{reads.push(target);return page(target===url?native:'<p>July 29 <a href="/registration?a=%2B">Sign up</a></p>',
    {url:target,headers:{'content-type':target===url?'application/json':'text/html'}});},fetch:async(target,options)=>{requests.push({target,options});return result();}});
  const {model,logs}=setup({generate}),output=await model(INTAKE_INSTRUCTION,partial,RESPONSE_SCHEMA);
  const request=JSON.parse(requests[0].options.body),input=JSON.parse(request.input);
  assert.ok(request.instructions.startsWith(INTAKE_INSTRUCTION));assert.deepEqual(input.input,partial);assert.deepEqual(reads,[url,partial.requested_links[0].url]);
  assert.equal(input.sources[0].body,native);assert.equal(input.sources[0].requested_url,url);assert.equal(input.sources[0].coverage,'complete_json');
  assert.ok(input.sources[1].body.includes('https://example.org/registration?a=%2B'));assert.equal(input.sources[1].coverage,'html_text');
  assert.equal(request.model,OPENAI_MODEL);assert.equal(request.store,false);assert.equal(request.service_tier,'default');assert.equal(request.reasoning.effort,'none');
  assert.equal(request.tools,undefined);assert.equal(request.max_output_tokens,4096);assert.equal(request.text.format.strict,true);
  assert.ok(requests[0].options.signal instanceof AbortSignal);assert.equal(output._usage.generations,1);
  assert.equal(output._diagnostics.model,OPENAI_MODEL);assert.equal(output._diagnostics.attempts[0].diagnostics.tool_calls,0);
  assert.equal(output._retrieval[0].method,'application_read');
  const retained=JSON.stringify(logs);assert.ok(!retained.includes('Confirmed organization'));assert.ok(!retained.includes('Which date?'));assert.ok(!retained.includes('test-key'));assert.ok(!retained.includes(url));
  assert.equal(logs.reserved[0].cost_usd,0.009548);assert.ok(output._usage.estimated_cost_usd<logs.reserved[0].cost_usd);
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
  await assert.rejects(generate('Read',[],schema,{inputTokens:60000,outputTokens:4096,deadline:Date.now()+100000,task:'url_intake'}),
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
  const {model,logs}=setup({providers,routes:{url_intake:{provider:'gemini',fallback:'openai',recoverURLRetrieval:true}}});
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

test('non-retrieval errors, missing or successful metadata and default routes never fall back',async context=>{
  const cases=[['opt-in absent',retrievalFailure(),false],['missing metadata',retrievalFailure({retrieval_metadata_present:false}),true],
    ['empty retrieval',retrievalFailure({retrieval:[]}),true],['one successful URL',retrievalFailure({retrieval:[{url,status:'URL_RETRIEVAL_STATUS_SUCCESS'}]}),true],
    ['model unreadable',Object.assign(new Error('model_unreadable'),{dispatched:true}),true],
    ...['retrieval_metadata_missing','provider_auth','provider_rate_limit','provider_unknown','invalid_json','output_truncated'].map(reason=>[reason,Object.assign(new Error(reason),{reason,dispatched:true}),true])];
  for(const [name,error,optIn] of cases)await context.test(name,async()=>{
    let fallback=0;const {model}=setup({routes:{url_intake:{provider:'gemini',fallback:'openai',recoverURLRetrieval:optIn}},
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
    assert.equal(error.usage.input_tokens,60000);assert.equal(error.usage.output_tokens,4096);assert.ok(!JSON.stringify(error).includes('secret-key'));return true;
  });
  await assert.rejects(model('Third',[],schema),{reason:'attempt_bound'});
  assert.equal(logs.settled.length,2);assert.ok(logs.settled.every(r=>r.state==='unknown'&&r.cost_usd===0.009548));
  assert.ok(!JSON.stringify(logs).includes('Sensitive prompt'));assert.ok(!JSON.stringify(logs).includes('partial'));
});

test('uncertain charge can exhaust credit before the second allowed generation',async()=>{
  const {config,logs}=setup({generate:async()=>{throw new Error('provider_unknown');}});config.budget.maxCostUSD=0.01;
  const model=modelGateway(config);await assert.rejects(model('Read',[],schema),{reason:'provider_unknown'});
  await assert.rejects(model('Again',[],schema),{reason:'spending_bound'});assert.equal(logs.reserved.length,1);
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
  const {model,logs}=setup({task:'answer_records',generate:openai({apiKey:'test',fetch:async()=>{calls++;return result(JSON.stringify(partial),{usage:{input_tokens:60001,output_tokens:4097}});}})});
  const output=await model('Read',[],schema);assert.deepEqual(output.records,partial.records);assert.equal(output._usage.overrun,true);
  assert.equal(logs.settled[0].reason,'token_reservation_overrun');assert.equal(logs.settled[0].input_tokens,60001);assert.equal(logs.settled[0].output_tokens,4097);
  await assert.rejects(model('Improve',[],schema),{reason:'attempt_bound'});assert.equal(calls,1);
});

test('failed overrun preserves original retrieval failure and cannot trigger fallback or another generation',async()=>{
  let fallback=0;const error=retrievalFailure();error.usage={input_tokens:60001,output_tokens:41};
  const {model,logs}=setup({routes:{url_intake:{provider:'gemini',fallback:'openai',recoverURLRetrieval:true}},providers:{
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

test('gateway intake saves a partial, skips unchanged input and preserves a human correction on changed input (mock model/PGlite)',async()=>{
  const db=new PGlite();
  try{
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
      create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');create table auth.identities(user_id uuid,provider text,identity_data jsonb);
      create function auth.uid() returns uuid language sql as $$select null::uuid$$;`);
    for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
    const tracker=(await db.query("insert into scout.trackers(name,url,collector,cadence) values('Gateway fixture','https://example.org/list','web','6 hours') returning *")).rows[0];
    const source={tracker_id:tracker.id,identity:'cbd:side-event:6915',native_id:'6915',url};
    const partial={type:'event',title:'BBNJ implementation workshop',summary:'Technical Clearing-House discussion.',priority:'high',
      relevance_reason:'Technical BBNJ Clearing-House workshop.',organizations:[],dates:[],missing_information:['Event time']};
    let generations=0,body='<p>Original source body (discard me)</p>';
    const read=async()=>page(body);
    const generate=openai({apiKey:'test',urls:[url],read,fetch:async()=>{
      generations++;const record=generations===1?partial:{...partial,organizations:[{name:'Model organization'}],dates:[{meaning:'event_start',date:'2026-10-15'}]};
      return result(JSON.stringify({status:'found',records:[record]}));
    }});
    const {model,logs}=setup({generate});
    const first=await processDocument(db,{source,read,model});assert.equal(first.created,1);assert.equal(first.state,'captured');
    let record=(await db.query('select * from scout.records')).rows[0];assert.equal(record.completeness.state,'provisional');
    const originalID=record.id,version=record.version;
    await db.exec("update scout.source_state set due_at=clock_timestamp()-interval '1 second'");
    assert.deepEqual(await processDocument(db,{source,read,model}),{state:'unchanged',created:0,changed:0});
    assert.equal(generations,1);assert.equal(logs.reserved.length,1);assert.equal((await db.query('select version from scout.records')).rows[0].version,version);
    await correctFinding(db,{record_id:record.id,version:record.version,field:'organizations',value:[{name:'Human organization'}],url});
    body='<p>Changed source body (discard me too)</p>';await db.exec("update scout.source_state set due_at=clock_timestamp()-interval '1 second'");
    const changed=await processDocument(db,{source,read,model});assert.equal(changed.changed,1);assert.equal(changed.created,0);assert.equal(generations,2);
    record=(await db.query('select * from scout.records')).rows[0];assert.equal(record.id,originalID);assert.deepEqual(record.organizations,[{name:'Human organization'}]);
    assert.equal(record.details.start.value,'2026-10-15');assert.ok(!JSON.stringify(record).includes('discard me'));
    const sourceState=(await db.query('select * from scout.source_state')).rows[0];assert.equal(sourceState.identity,'cbd:side-event:6915');assert.ok(!JSON.stringify(sourceState).includes('discard me'));
  }finally{await db.close();}
});
