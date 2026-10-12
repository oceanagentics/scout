import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {gemini} from '../collector/model.js';
import {database,hostedHSA} from '../collector/hosted-hsa.js';
import {OPENAI_MODEL,trackerModel} from '../collector/model-gateway.js';

async function setup(cutover=true){
 const raw=new PGlite();
 await raw.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');create table auth.identities(user_id uuid,provider text,identity_data jsonb);
 create function auth.uid() returns uuid language sql as $$select null::uuid$$;`);
 for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort().filter(n=>cutover||n<'20261009190000_scout_findings.sql'))
  await raw.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 return raw;
}
const enable=db=>db.exec("update scout.quota_policy set enabled=true,verified_until=now()+interval '1 hour',verified_rpm=15,verified_rpd=500,verified_tpm=250000,database_bytes=10000000,database_verified_until=now()+interval '1 hour'");
const boundary=raw=>database({unsafe:async(q,p=[])=>{const r=await raw.query(q,p);r.rows.count=r.affectedRows??r.rows.length;return r.rows;}});
const reserve=(db,invocation=randomUUID(),id=randomUUID(),tokens=null)=>db.query('select * from scout.reserve_model($1,$2,$3,2)',[invocation,id,tokens]);
const manual=()=>{const until=new Date(Date.now()+1800000).toISOString();return {enabled:true,mode:'manual',model:OPENAI_MODEL,expires_at:until,access_until:until,quota_until:until,
 verified_rpm:100,verified_rpd:100,verified_tpm:250000,rpm:2,rpd:10,tpm:125000,allocation_usd:0.10,invocation_usd:0.01,daily_usd:0.05};};
const provider=(db,kind,invocation=randomUUID(),id=randomUUID(),max=2)=>db.query('select * from scout.reserve_provider($1,$2,$3,$4)',[invocation,id,kind,max]);

test('URL diagnostics distinguish absent metadata, provider failure and a model unreadable answer without persisting traffic',async()=>{
 for(const retrieval of [undefined,[],[{retrievedUrl:'https://example.org',urlRetrievalStatus:'URL_RETRIEVAL_STATUS_ERROR'}],
  [{retrievedUrl:'https://example.org',urlRetrievalStatus:'URL_RETRIEVAL_STATUS_SUCCESS'}]]){
  const writes=[],ledger={query:async(q,p)=>{writes.push([q,p]);return {rows:[{allowed:true}]};}};
  const model=gemini({apiKey:'test',ledger,fetch:async()=>Response.json({responseId:'test-response',modelVersion:'test-version',
   usageMetadata:{promptTokenCount:10,toolUsePromptTokenCount:20,candidatesTokenCount:5,totalTokenCount:35},
   candidates:[{finishReason:'STOP',...retrieval===undefined?{}:{urlContextMetadata:{urlMetadata:retrieval}},
    content:{parts:[{text:JSON.stringify({status:'unreadable',records:[],note:'PRIVATE_MODEL_ANSWER'})}]}}]})});
  const result=await model('PRIVATE_PROMPT',[]).catch(e=>e),d=result._diagnostics??result.diagnostics;
  assert.equal(d.retrieval_metadata_present,retrieval!==undefined);assert.equal(d.model_status,'unreadable');
  assert.deepEqual(d.tokens,{prompt:10,tool:20,output:5,thinking:null,total:35});
  if(!retrieval?.length)assert.equal(result.reason,'retrieval_metadata_missing');
  else if(retrieval[0].urlRetrievalStatus.endsWith('_ERROR'))assert.equal(result.reason,'url_retrieval_failed');
  else assert.equal(result.status,'unreadable');
  assert.ok(!JSON.stringify(writes).includes('PRIVATE_'));assert.ok(!JSON.stringify(writes).includes('test-response'));
 }
});

test('fresh finite shared headroom and database size are required before any model HTTP',async()=>{
 const raw=await setup();try{
  let http=0;
  const db=boundary(raw),model=gemini({apiKey:'test',ledger:db,fetch:()=>{http++;throw new Error('must not dispatch');}});
  await assert.rejects(model('Test',{}),/quota/);assert.equal(http,0);
  for(const update of ["verified_until=now()-interval '1 second'","verified_rpd=null","verified_tpm=0","database_bytes=400000000","database_verified_until=null"]){
   await enable(raw);await raw.exec('update scout.quota_policy set '+update);
   await assert.rejects(model('Test',{}),/quota/);
  }
  assert.equal(http,0);assert.equal((await raw.query('select count(*)::int n from scout.quota_reservations')).rows[0].n,0);
 }finally{await raw.close();}
});
test('two durable quota mutations, URL retrieval accounting, streaming Unicode and max two generations',async()=>{
 const raw=await setup();try{
  await enable(raw);const db=boundary(raw),http={count:0,generation:0};
  const send=async url=>{
   if(url.endsWith(':countTokens')){http.count++;return Response.json({totalTokens:1234});}
   http.generation++;
   const body=JSON.stringify({usageMetadata:{promptTokenCount:234,toolUsePromptTokenCount:1000,candidatesTokenCount:12,totalTokenCount:1246},candidates:[{finishReason:'STOP',urlContextMetadata:{urlMetadata:[{retrievedUrl:'https://example.org',urlRetrievalStatus:'URL_RETRIEVAL_STATUS_SUCCESS'}]},content:{parts:[{text:JSON.stringify({organization:'Océan 海洋'})}]}}]});
   const bytes=new TextEncoder().encode(body);
   return new Response(new ReadableStream({start(controller){for(const b of bytes)controller.enqueue(new Uint8Array([b]));controller.close();}}));
  };
  const model=gemini({apiKey:'test',ledger:db,fetch:send});
  assert.equal((await model('Test',{})).organization,'Océan 海洋');assert.equal(db.metrics.mutations,2);
  await model('Test',{});assert.equal(db.metrics.mutations,4);
  await raw.exec("update scout.quota_reservations set reserved_at=now()-interval '61 seconds'");
  await assert.rejects(model('Test',{}),/quota/);assert.deepEqual(http,{count:0,generation:2});
  const rows=(await raw.query('select * from scout.quota_reservations')).rows;assert.equal(rows.length,2);
  assert.ok(rows.every(r=>r.state==='settled'&&r.input_tokens===1234));
 }finally{await raw.close();}
});
test('two uncertain requests remain charged until their windows expire; expiry carries numeric uncertainty',async()=>{
 const raw=await setup();try{
  await enable(raw);const db=boundary(raw),send=async url=>{if(url.endsWith(':countTokens'))return Response.json({totalTokens:50});throw new Error('PRIVATE TRANSPORT PAYLOAD');};
  for(let i=0;i<2;i++)await assert.rejects(gemini({apiKey:'test',ledger:db,fetch:send})('Test',{}),/provider_unknown/);
  assert.equal((await raw.query("select count(*)::int n from scout.quota_reservations where state='unknown'")).rows[0].n,2);
  assert.equal((await reserve(raw)).rows[0].allowed,false);
  await raw.exec("update scout.quota_reservations set reserved_at=now()-interval '121 seconds'");
  assert.equal((await reserve(raw)).rows[0].allowed,true);
  await raw.exec("update scout.quota_reservations set reserved_at=now()-interval '2 days'");
  await raw.query('select * from scout.expire_quota()');
  assert.equal((await raw.query('select count(*)::int n from scout.quota_reservations')).rows[0].n,0);
  assert.equal((await raw.query('select uncertain_calls from scout.quota_policy')).rows[0].uncertain_calls,3);
  assert.equal((await reserve(raw)).rows[0].allowed,true);
 }finally{await raw.close();}
});
test('daily denial returns Pacific reset, token oversize never generates and provider cooldown survives',async()=>{
 const raw=await setup();try{
  await enable(raw);await raw.exec('update scout.quota_policy set rpd=1');
  await reserve(raw);const denied=(await reserve(raw)).rows[0],reset=(await raw.query("select ((date_trunc('day',clock_timestamp() at time zone 'America/Los_Angeles')+interval '1 day') at time zone 'America/Los_Angeles') at")).rows[0].at;
  assert.deepEqual(denied.retry_at,reset);
  await raw.exec("update scout.quota_reservations set reserved_at=now()-interval '2 days';update scout.quota_policy set rpd=250");
  let generated=0;
  await assert.rejects(gemini({apiKey:'test',ledger:boundary(raw),fetch:async()=>{generated++;}})('Test',{oversize:'x'.repeat(24001)}),/input_bound/);
  assert.equal(generated,0);
  await assert.rejects(gemini({apiKey:'test',ledger:boundary(raw),fetch:async()=>new Response('{}',{status:429,headers:{'retry-after':'3600'}})})('Test',{}),/provider_rate_limit/);
  const cooldown=(await raw.query('select cooldown_until from scout.quota_policy')).rows[0].cooldown_until;
  assert.ok(Date.parse(cooldown)>Date.now()+3500000);assert.deepEqual((await reserve(raw)).rows[0].retry_at,cooldown);
 }finally{await raw.close();}
});
test('legacy active charges and future provider retry migrate without carrying expired history into future windows',async()=>{
 const raw=await setup(false);try{
  const tr=(await raw.query("insert into scout.trackers(name,url,collector,cadence) values('Quota','https://example.org','web','6 hours') returning id")).rows[0];
  const stats={model_attempts:[{at:new Date(Date.now()-864000000).toISOString(),input_tokens:5000},{at:new Date().toISOString(),input_tokens:1500,state:'reserved'},{at:new Date().toISOString(),input_token_limit:16000,state:'unknown'}],model_retry_at:new Date(Date.now()+3600000).toISOString()};
  await raw.query('insert into scout.collection_runs(tracker_id,stats) values($1,$2)',[tr.id,stats]);
  await raw.exec(await readFile(new URL('../supabase/migrations/20261009190000_scout_findings.sql',import.meta.url),'utf8'));
  assert.equal((await raw.query("select to_regclass('scout.collection_runs') name")).rows[0].name,null);
  assert.equal((await raw.query('select count(*)::int n from scout.quota_reservations')).rows[0].n,2);
  await enable(raw);assert.equal((await reserve(raw)).rows[0].allowed,false);
  assert.equal(new Date((await raw.query('select cooldown_until from scout.quota_policy')).rows[0].cooldown_until).getTime(),Date.parse(stats.model_retry_at));
 }finally{await raw.close();}
});

test('provider reservations serialize shared attempts, keep independent cooldowns and retain uncertain spending across expiry/policy refresh',async()=>{
 const raw=await setup();try{
  await enable(raw);await raw.query('update scout.quota_policy set openai=$1',[manual()]);
  const invocation=randomUUID(),first=randomUUID(),second=randomUUID();
  const concurrent=await Promise.all([provider(raw,'gemini',invocation,first,1),provider(raw,'openai',invocation,second,1)]);
  assert.equal(concurrent.filter(r=>r.rows[0].allowed).length,1);assert.equal((await raw.query('select count(*)::int n from scout.quota_reservations')).rows[0].n,1);
  const oa=randomUUID();assert.equal((await provider(raw,'openai',randomUUID(),oa)).rows[0].allowed,true);
  const settle=(state,input=60000,output=1500)=>raw.query('select * from scout.settle_provider($1,$2,$3,$4,$5,$6,$7)',[oa,input,output,state,'provider_unknown',new Date(Date.now()+60000).toISOString(),0.00825]);
  assert.equal((await settle('unknown')).rows[0].settled,true);assert.equal((await settle('unknown')).rows[0].mutations,0);
  assert.equal((await settle('settled',10,5)).rows[0].settled,false);
  assert.equal((await provider(raw,'openai')).rows[0].reason,'provider_cooldown');
  assert.equal((await provider(raw,'gemini')).rows[0].allowed,true);
  const spent=(await raw.query('select openai_spent_usd from scout.quota_policy')).rows[0].openai_spent_usd;
  await raw.exec("update scout.quota_reservations set reserved_at=now()-interval '2 days'");await raw.query('select * from scout.expire_quota()');
  await raw.query('update scout.quota_policy set openai=$1',[manual()]);
  const policy=(await raw.query('select * from scout.quota_policy')).rows[0];assert.equal(policy.openai_spent_usd,spent);assert.equal(policy.openai_uncertain_calls,1);assert.equal(policy.openai_uncertain_tokens,60000);
  const cap={...manual(),allocation_usd:Number(spent)};await raw.query('update scout.quota_policy set openai=$1',[cap]);assert.equal((await provider(raw,'openai')).rows[0].reason,'spending_bound');
  await raw.query('update scout.quota_policy set openai=$1',[{...manual(),mode:'credit'}]);assert.equal((await provider(raw,'openai')).rows[0].reason,'provider_budget');
  for(const role of ['anon','authenticated']){
   await raw.exec('set role '+role);await assert.rejects(provider(raw,'openai'),{code:'42501'});
   await assert.rejects(raw.query('select * from scout.settle_provider($1,1,1,$2,null,null,0)',[oa,'settled']),{code:'42501'});await raw.exec('reset role');
  }
  await assert.rejects(provider(raw,'gemini',randomUUID(),randomUUID(),null));
  await assert.rejects(raw.query('select * from scout.settle_provider($1,null,1,$2,null,null,0)',[oa,'settled']));
  await raw.query('update scout.quota_policy set openai=$1',[manual()]);
  let calls=0;const noKey=trackerModel({apiKey:'test',ledger:boundary(raw),source:{url:'https://example.org/a'},fetch:async()=>{calls++;throw Error('Network');}});
  await assert.rejects(noKey('Read',[],{type:'object',properties:{}}),error=>error.reason==='configuration'&&error.usage.generations===1);
  assert.equal(calls,1);assert.equal(Number((await raw.query('select openai_spent_usd from scout.quota_policy')).rows[0].openai_spent_usd),Number(spent));
  const last=(await raw.query("select input_tokens,output_tokens,state from scout.quota_reservations where provider='openai' order by reserved_at desc limit 1")).rows[0];
  assert.deepEqual(last,{input_tokens:0,output_tokens:0,state:'settled'});
 }finally{await raw.close();}
});

test('hosted selected/direct sources save a bounded fallback once, preserve native identity and skip complete/parked work (mock providers/PGlite)',async t=>{
 const raw=await setup();try{
  await enable(raw);await raw.query('update scout.quota_policy set openai=$1',[manual()]);
  const tracker=(await raw.query("insert into scout.trackers(name,url,collector,cadence,enabled) values('Gateway','https://example.org/list','web','6 hours',true) returning *")).rows[0];
  const url='https://example.org/6915';await raw.query("insert into scout.source_state(tracker_id,identity,url,native_id,native_ref,due_at) values($1,'cbd:side-event:6915',$2,'6915',$3,now()-interval '1 second')",[tracker.id,url,{api_url:url}]);
  const counts={gemini:0,openai:0,read:0},secret='sb_secret_scout_test_only',env={url:'https://example.supabase.co',secretKeys:{default:secret},publishableKeys:{},jwks:null};
  const connect=()=>({reserve:async()=>({unsafe:async(q,p=[])=>{const r=await raw.query(q,p);r.rows.count=r.affectedRows??r.rows.length;return r.rows;},release(){}}),end:async()=>{}});
  const record={type:'event',title:'BBNJ Clearing-House workshop',summary:'Technical BBNJ design discussion.',organizations:[],dates:[{meaning:'event_start',date:'2026-10-15',time:'15:00',timezone:'+02:00'}]};
  const options={databaseURL:'mock',env,connect,apiKey:'test',openaiApiKey:'test',read:async()=>{counts.read++;return {url,status:200,headers:{'content-type':'text/html'},body:'<p>PRIVATE SOURCE BODY</p>'};},modelFetch:async(target,options)=>{
   if(target.includes('googleapis')){counts.gemini++;return Response.json({usageMetadata:{promptTokenCount:100,candidatesTokenCount:10,totalTokenCount:110},
    candidates:[{finishReason:'STOP',urlContextMetadata:{urlMetadata:[{retrievedUrl:url,urlRetrievalStatus:'URL_RETRIEVAL_STATUS_ERROR'}]},content:{parts:[{text:'{"status":"unreadable","records":[]}'}]}}]});}
   counts.openai++;const body=JSON.parse(options.body);assert.equal(body.max_output_tokens,1500);assert.equal(JSON.parse(body.input).source.identity,'cbd:side-event:6915');
   return Response.json({status:'completed',model:OPENAI_MODEL,usage:{input_tokens:100,output_tokens:10},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({status:'found',records:[record],follow_up_requests:[{url:'https://example.org/support',question:'Who is associated?'}]})}]}]});
  }};
  const run=async(query='next=true')=>(await hostedHSA(new Request('https://example.test/collect?'+query,{method:'POST',headers:{apikey:secret}}),options)).json();
  const first=await run();assert.equal(first.state,'captured');assert.equal(first.reason,'generation_bound');assert.equal(first.improvement,'pending');assert.equal(first.usage.generations,2);assert.deepEqual(counts,{gemini:1,openai:1,read:1});
  const saved=(await raw.query('select * from scout.records')).rows[0];assert.equal(saved.details.start.utc,'2026-10-15T13:00:00.000Z');assert.ok(!JSON.stringify(saved).includes('PRIVATE SOURCE'));
  assert.deepEqual((await raw.query('select provider from scout.quota_reservations order by reserved_at')).rows.map(r=>r.provider),['gemini','openai']);
  await raw.exec("update scout.source_state set state='complete',due_at=now()-interval '1 second'");assert.equal((await run('tracker_id='+tracker.id+'&source_url='+encodeURIComponent(url))).state,'complete');
  await raw.exec("update scout.source_state set state='parked',reason='research_exhausted',due_at=now()-interval '1 second'");assert.equal((await run()).state,'parked');
  assert.deepEqual(counts,{gemini:1,openai:1,read:1});assert.equal((await raw.query('select count(*)::int n from scout.source_state')).rows[0].n,1);assert.equal((await raw.query('select version from scout.records')).rows[0].version,saved.version);
  t.diagnostic(JSON.stringify({mocked:true,calls:counts,cost:first.cost,estimated_spent_usd:(await raw.query('select openai_spent_usd from scout.quota_policy')).rows[0].openai_spent_usd}));
 }finally{await raw.close();}
});
