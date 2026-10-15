import {test} from 'node:test';
import assert from 'node:assert/strict';
import {modelGateway,trackerModel} from '../collector/model-gateway.js';
import {strictSchema,openai,OPENAI_MODEL} from '../collector/model-openai.js';
import {INTAKE_INSTRUCTION,RESPONSE_SCHEMA} from '../collector/finding-contract.js';
import {MODEL,gemini} from '../collector/model-gemini.js';

// Stub the authoritative SQL reply; real policy/concurrency is covered in assessment.test.js.
const OPENAI_LIMITS={inputTokens:1050000,outputTokens:128000};
const admitted=(provider,remaining=1)=>({allowed:true,remaining_attempts:remaining,cost_usd:provider==='openai'?0.3885:0,
  settings:{model:provider==='openai'?OPENAI_MODEL:MODEL,...provider==='openai'?{...OPENAI_LIMITS,maxToolCalls:3,maxUrls:4,maxFollowups:3}:
    {inputTokens:60000,outputTokens:8192,inputBytes:24000,outputBytes:131072,maxToolCalls:0},deadline:new Date(Date.now()+100000).toISOString()}});
const url='https://example.org/source?query=%7B%22sideEvent.id%22%3A6915%7D';
const schema={type:'object',properties:{status:{type:'string'},records:{type:'array',items:{type:'object'}}},required:['status','records']};
const answer=()=>({status:'none',records:[],_usage:{input_tokens:100,output_tokens:10}});
const result=(text='{"status":"none","records":[]}',extra={})=>Response.json({model:OPENAI_MODEL,status:'completed',usage:{input_tokens:100,output_tokens:10},
  output:[{type:'message',content:[{type:'output_text',text}]}],...extra});
const webResult=(text='{"status":"none","records":[]}',web=[{type:'web_search_call',status:'completed',action:{type:'open_page',url}}])=>
  result(text,{output:[...web,{type:'message',content:[{type:'output_text',text}]}]});
function setup({task='url_intake',provider='openai',generate=async()=>answer(),routes,providers,accounting,now=Date.now,deadline}={}){
  const time=now(),logs={reserved:[],settled:[]};
  const config={task,routes:routes??{[task]:{provider}},providers:providers??{[provider]:{model:provider==='openai'?OPENAI_MODEL:'gemini-3.5-flash-lite',generate}},
    accounting:accounting??{reserve:async value=>{logs.reserved.push(value);return admitted(value.provider,2-logs.reserved.length);},settle:async value=>{logs.settled.push(value);}},now,deadline:deadline??time+100000};
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

test('OpenAI sends shared instructions, schema and URLs to provider web access without preparing source text',async()=>{
  const requests=[],partial={records:[{description:'Existing title'}],requested_links:[{url:'https://example.org/support?raw=%2B',question:'Which date?'}]};
  const {model,logs,config}=setup({generate:openai({apiKey:'test-key',urls:[url],read:()=>assert.fail('No local source reads'),
    fetch:async(target,options)=>{requests.push({target,options});return webResult('{"records":[]}');}})});
  const reserve=config.accounting.reserve;
  config.accounting.reserve=async value=>{const reply=await reserve(value);return {...reply,settings:{...reply.settings,outputTokens:512,maxToolCalls:1}};};
  const output=await model(INTAKE_INSTRUCTION,partial,RESPONSE_SCHEMA),request=JSON.parse(requests[0].options.body),input=JSON.parse(request.input);
  assert.equal(request.instructions,INTAKE_INSTRUCTION+'\nFor this API, return the array inside an object with the single key records.');
  assert.deepEqual(input,{input:partial,urls:[url,partial.requested_links[0].url]});
  assert.deepEqual(request.tools,[{type:'web_search',search_content_types:['text','image'],image_settings:{caption:true}}]);assert.equal(request.tool_choice,'required');assert.equal(request.max_tool_calls,1);
  assert.deepEqual(request.include,['web_search_call.action.sources']);assert.equal(request.store,false);assert.equal(request.reasoning.effort,'low');
  assert.deepEqual(request.text.format.schema.properties.records,strictSchema({type:'object',properties:{records:RESPONSE_SCHEMA},required:['records']}).properties.records);
  assert.equal(output.status,'none');assert.deepEqual(output.records,[]);assert.equal(output._retrieval[0].url,url);
  assert.equal(output._retrieval[0].method,'provider_web');assert.equal(output._diagnostics.attempts[0].diagnostics.tool_calls,1);
  assert.equal(request.max_output_tokens,512);assert.ok(requests[0].options.signal instanceof AbortSignal);
  assert.equal(logs.settled[0].cost_usd,0.0000175);
  assert.equal(logs.reserved[0].input_tokens,undefined); // The client does not set admission limits.
  assert.ok(!JSON.stringify(logs).includes('Which date?'));assert.ok(!JSON.stringify(logs).includes('test-key'));
});

test('provider web metadata supplies support URLs and accounts for search fees even when the final JSON fails',async()=>{
  const support='https://example.org/register',web=[{type:'web_search_call',status:'completed',action:{type:'search',sources:[{type:'url',url:support}]}}];
  const {model,logs}=setup({generate:openai({apiKey:'test',urls:[url],fetch:async()=>webResult('{',web)})});
  await assert.rejects(model('Read',[],schema),error=>{
    assert.equal(error.reason,'invalid_output');assert.equal(error.diagnostics.attempts[0].diagnostics.retrieval[0].url,support);return true;
  });
  assert.equal(logs.settled[0].state,'settled');assert.equal(logs.settled[0].cost_usd,0.0100175);
});

test('URL requests cannot claim retrieval when the provider returns no web results',async()=>{
  for(const [response,reason] of [[result(),'retrieval_metadata_missing'],[webResult(undefined,[{type:'web_search_call',status:'failed',action:{type:'open_page',url}}]),'url_retrieval_failed']]){
    const {model}=setup({generate:openai({apiKey:'test',urls:[url],fetch:async()=>response})});
    await assert.rejects(model('Read',[],schema),{reason});
  }
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
  assert.equal(calls,1);assert.equal(answer._usage.generations,1);assert.equal(answer._diagnostics.attempts[0].diagnostics.retrieval.length,0);
});

test('neither provider adapter can bypass gateway reservation with numeric limits',async()=>{
  let calls=0,reads=0;
  const generate=openai({apiKey:'test',urls:[url],read:async()=>{reads++;assert.fail('No local reader');},fetch:async()=>{calls++;return result();}});
  await assert.rejects(generate('Read',[],schema,{inputTokens:60000,outputTokens:1500,deadline:Date.now()+100000,task:'url_intake'}),
    {reason:'accounting',dispatched:false});
  await assert.rejects(gemini({apiKey:'test',ledger:{query:()=>assert.fail('No standalone reservation')},fetch:()=>{calls++;}})
    ('Read',[],schema,{inputTokens:60000,outputTokens:8192}),{reason:'accounting',dispatched:false});
  assert.equal(calls,0);assert.equal(reads,0);
});

test('source URL bounds remain enforced before provider dispatch',async()=>{
  assert.throws(()=>openai({apiKey:'test',urls:['https://127.0.0.1/']}));
  const {model}=setup({generate:openai({apiKey:'test',urls:Array.from({length:5},(_,i)=>`https://example.org/${i}`),fetch:()=>assert.fail('No dispatch')})});
  await assert.rejects(model('Read',[],schema),{reason:'source_bound',dispatched:false});
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
    ...['provider_auth','provider_safety','quota','provider_cooldown','runtime_bound','provider_spend_limit','accounting'].map(reason=>[reason,Object.assign(new Error(reason),{reason,dispatched:true}),true])];
  for(const [name,error,optIn] of cases)await context.test(name,async()=>{
    let fallback=0;const {model}=setup({routes:{url_intake:{provider:'gemini',fallback:'openai',fallbackReasons:optIn?['url_retrieval_failed']:undefined}},
      providers:{gemini:{model:'gemini-3.5-flash-lite',generate:async()=>{throw error;}},openai:{model:OPENAI_MODEL,generate:async()=>{fallback++;return answer();}}}});
    await assert.rejects(model('Read',[],schema));assert.equal(fallback,0);
  });
});

test('accounting and exact model configuration remain required',async()=>{
  for(const change of [c=>delete c.accounting.reserve,c=>delete c.accounting.settle,c=>c.providers.openai.model='other']){
    let calls=0;const {config,logs}=setup({generate:async()=>{calls++;return answer();}});change(config);
    await assert.rejects(modelGateway(config)('Read',[],schema));assert.equal(calls,0);assert.equal(logs.reserved.length,0);
  }
});

test('uncertain calls preserve full charges, consume the shared attempt allowance and expose no error text',async()=>{
  const {model,logs}=setup({task:'answer_records',generate:openai({apiKey:'secret-key',fetch:async()=>{throw new Error('secret-key source text response body');}})});
  for(let i=0;i<2;i++)await assert.rejects(model('Sensitive prompt',{private:'partial'},schema),error=>{
    assert.equal(error.reason,'provider_unknown');assert.equal(error.usage.generations,1);assert.equal(error.usage.uncertain,true);
    assert.equal(error.usage.input_tokens,OPENAI_LIMITS.inputTokens);assert.equal(error.usage.output_tokens,OPENAI_LIMITS.outputTokens);assert.ok(!JSON.stringify(error).includes('secret-key'));return true;
  });
  await assert.rejects(model('Third',[],schema),{reason:'attempt_bound'});
  assert.equal(logs.settled.length,2);assert.ok(logs.settled.every(r=>r.state==='unknown'&&r.cost_usd===0.3885));
  assert.ok(!JSON.stringify(logs).includes('Sensitive prompt'));assert.ok(!JSON.stringify(logs).includes('partial'));
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
      assert.deepEqual(error.diagnostics.attempts[0].diagnostics,{provider:'openai',model:OPENAI_MODEL,retrieval:[],tool_calls:0,
        http_status:status,request_id:'req_auth_check',...details});
      assert.ok(!/test-private-key|sk-proj-|RAW_RESPONSE_BODY/.test(JSON.stringify(error)));return true;
    });
    assert.equal(logs.settled[0].state,'unknown');assert.equal(logs.settled[0].cost_usd,0.3885);
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
    ['broken JSON',()=>result('{'),'invalid_output',false],['array root',()=>result('[]'),'invalid_output',false],
    ['refusal',()=>result('',{output:[{type:'message',content:[{type:'refusal',refusal:'hidden private text'}]}]}),'provider_refused',false],
    ['incomplete',()=>result('',{status:'incomplete'}),'output_incomplete',false],
    ['tool output',()=>result('',{output:[{type:'function_call'}]}),'unexpected_tool',false]];
  for(const [name,response,reason,unknown] of cases)await context.test(name,async()=>{
    const {model,logs}=setup({task:'answer_records',generate:openai({apiKey:'test',fetch:async()=>response()})});
    await assert.rejects(model('Read',[],schema),error=>{assert.equal(error.reason,reason);assert.equal(error.dispatched,true);return true;});
    assert.equal(logs.settled[0].state,unknown?'unknown':'settled');assert.ok(!JSON.stringify(logs).includes('hidden private text'));
  });
});

test('OpenAI limit categories distinguish temporary rates from spending and model capacity',async()=>{
  const time=Date.now();
  for(const [status,code,message,category,reason] of [
    [429,'rate_limit_exceeded','Requests per minute','requests','provider_rate_limit'],
    [429,'rate_limit_exceeded','Tokens per minute','tokens','provider_rate_limit'],
    [429,'project_spend_limit_exceeded','Monthly limit','spending','provider_spend_limit'],
    [429,'credit_balance_exhausted','No credits','spending','provider_spend_limit'],
    [400,'context_length_exceeded','Context too long','context','provider_context_limit']]){
    const {model,logs}=setup({task:'answer_records',now:()=>time,generate:openai({apiKey:'test',now:()=>time,fetch:async()=>
      Response.json({error:{code,message}},{status,headers:{'retry-after':'5'}})})});
    await assert.rejects(model('Read',[],schema),error=>{
      assert.equal(error.reason,reason);assert.equal(error.diagnostics.attempts[0].diagnostics.limit_category,category);
      assert.equal(error.deferred?.retry_at,reason==='provider_rate_limit'?new Date(time+5000).toISOString():undefined);return true;
    });
    assert.equal(logs.settled[0].cooldown_until,reason==='provider_rate_limit'?new Date(time+5000).toISOString():null);
  }
});

test('OpenAI accepts responses beyond the old Scout token and byte caps without blocking improvement',async()=>{
  const partial={status:'found',records:[{title:'Useful partial',description:'x'.repeat(132000)}]};
  const {model,logs}=setup({task:'answer_records',generate:openai({apiKey:'test',fetch:async()=>result(JSON.stringify(partial),{usage:{input_tokens:60001,output_tokens:40000}})})});
  const output=await model('x'.repeat(60001),[],schema);assert.deepEqual(output.records,partial.records);
  assert.equal(logs.settled[0].input_tokens,60001);assert.equal(logs.settled[0].output_tokens,40000);
  await model('Improve',[],schema);assert.equal(logs.settled.length,2);
});

test('invalid schema and a deadline expired by reservation create no generation',async()=>{
  let calls=0;const {model}=setup({task:'answer_records',generate:openai({apiKey:'test',fetch:async()=>{calls++;return result();}})});
  await assert.rejects(model('Read',[],{type:'array'}),{reason:'invalid_schema',dispatched:false});assert.equal(calls,0);
  let time=Date.now();const {config,logs:after}=setup({now:()=>time,generate:async()=>{calls++;return answer();}});
  config.accounting.reserve=async()=>{const reply=admitted('openai');time=Date.parse(reply.settings.deadline)+1;return reply;};
  await assert.rejects(modelGateway(config)('Read',[],schema),{reason:'runtime_bound',dispatched:false});assert.equal(calls,0);assert.equal(after.settled[0].cost_usd,0);
});

test('settlement failure halts the invocation and never refunds an uncertain charge',async()=>{
  let calls=0;const {config,logs}=setup({generate:async()=>{calls++;throw new Error('provider_unknown');}});
  config.accounting.settle=async value=>{logs.settled.push(value);throw new Error('Database secret');};const model=modelGateway(config);
  await assert.rejects(model('Read',[],schema),{reason:'accounting'});await assert.rejects(model('Retry',[],schema),{reason:'attempt_bound'});
  assert.equal(calls,1);assert.equal(logs.settled[0].state,'unknown');assert.equal(logs.settled[0].cost_usd,0.3885);
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
    const ledger={query:async(q,p)=>{sql.push({q,p});return {rows:[q.includes('reserve_provider')?admitted(p[2],2-sql.filter(v=>v.q.includes('reserve_provider')).length):{settled:true}]};}};
    const model=trackerModel({apiKey:'test',openaiApiKey:'test',ledger,source:{url,identity:'native:6915'},read:async()=>{reads++;assert.fail('No local reader');},fetch:async(target,options)=>{
      if(target.includes('googleapis')){calls.gemini++;return response();}calls.openai++;
      assert.equal(JSON.parse(options.body).max_output_tokens,OPENAI_LIMITS.outputTokens);return webResult('{"records":[]}');
    }});
    const output=await model(INTAKE_INSTRUCTION,[],RESPONSE_SCHEMA).catch(error=>error);
    assert.equal(calls.openai,recover?1:0);assert.equal(reads,0);assert.equal(calls.gemini,1);
    assert.equal(sql.filter(item=>item.q.includes('reserve_provider')).length,recover?2:1);assert.equal(sql.filter(item=>item.q.includes('settle_provider')).length,recover?2:1);
    assert.ok(sql.every(item=>!item.q.includes('reserve_model')));assert.ok(!JSON.stringify(sql).includes('Private transport text'));
    if(name==='invalid JSON'||name==='missing candidate'||name==='missing finish'){
      const settlement=sql.find(item=>item.q.includes('settle_provider'));assert.deepEqual(settlement.p.slice(1,4),[120,10,'settled']);
    }
    if(recover)assert.equal(output._usage.generations,2);if(name==='useful malformed-optional partial')assert.deepEqual(output.records,partial.records);
  });
});

test('tracker second generation has no fallback; missing usage remains uncertain and disabled backup stops before OpenAI',async()=>{
  const sql=[],ledger={query:async(q,p)=>{sql.push({q,p});return {rows:[q.includes('reserve_provider')?admitted(p[2],2-sql.filter(v=>v.q.includes('reserve_provider')).length):{settled:true}]};}};
  let calls=0;const model=trackerModel({apiKey:'test',openaiApiKey:'test',ledger,source:{url},read:async()=>assert.fail('No fallback'),fetch:async()=>{
    calls++;return Response.json({candidates:[{finishReason:'STOP',urlContextMetadata:{urlMetadata:[{retrievedUrl:url,urlRetrievalStatus:'URL_RETRIEVAL_STATUS_SUCCESS'}]},
      content:{parts:[{text:calls===1?'[]':'{'}]}}]});}});
  assert.equal((await model('Read',[],RESPONSE_SCHEMA))._usage.uncertain,true);
  await assert.rejects(model('Improve',[],RESPONSE_SCHEMA),{reason:'invalid_json'});assert.equal(calls,2);assert.equal(sql.length,4);
  let dispatched=0;const guarded=trackerModel({apiKey:'test',openaiApiKey:'test',source:{url},ledger:{query:async(q,p)=>({rows:[q.includes('reserve_provider')?
    p[2]==='gemini'?admitted('gemini'):{allowed:false,reason:'quota'}:{settled:true}]})},fetch:async()=>{dispatched++;throw Error('Network');}});
  await assert.rejects(guarded('Read',[],RESPONSE_SCHEMA),{reason:'quota'});assert.equal(dispatched,1);
});
