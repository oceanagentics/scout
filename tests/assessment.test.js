import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {MODEL,gemini} from '../reader/models/gemini.js';
import {database} from '../reader/database.js';
import {modelGateway,modelAccounting} from '../reader/models/gateway.js';

const OPENAI_LIMITS={inputTokens:1050000,outputTokens:128000};
const geminiModel=options=>modelGateway({task:'diagnostic',routes:{diagnostic:{provider:'gemini'}},
 providers:{gemini:{model:MODEL,generate:gemini(options)}},accounting:modelAccounting(options.ledger)});
async function setup(cutover=true){
 const raw=new PGlite();
 await raw.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');create table auth.identities(user_id uuid,provider text,identity_data jsonb);
 create function auth.uid() returns uuid language sql as $$select null::uuid$$;`);
 for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort().filter(n=>cutover||n<'20261009190000_scout_findings.sql'))
  await raw.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 return raw;
}
const boundary=raw=>database({unsafe:async(q,p=[])=>{const r=await raw.query(q,p);r.rows.count=r.affectedRows??r.rows.length;return r.rows;}});
const provider=(db,kind,invocation=randomUUID(),id=randomUUID(),deadline=null)=>db.query('select * from scout.reserve_provider($1,$2,$3,$4::timestamptz)',[invocation,id,kind,deadline]);

test('URL diagnostics distinguish absent metadata, provider failure and a model unreadable answer without persisting traffic',async()=>{
 for(const retrieval of [undefined,[],[{retrievedUrl:'https://example.org',urlRetrievalStatus:'URL_RETRIEVAL_STATUS_ERROR'}],
  [{retrievedUrl:'https://example.org',urlRetrievalStatus:'URL_RETRIEVAL_STATUS_SUCCESS'}]]){
  const writes=[],ledger={query:async(q,p)=>{writes.push([q,p]);return {rows:[q.includes('reserve_provider')?{allowed:true,remaining_attempts:1,cost_usd:0,settings:{model:MODEL,inputTokens:60000,outputTokens:8192,inputBytes:24000,outputBytes:131072,maxToolCalls:0,deadline:new Date(Date.now()+40000).toISOString()}}:{settled:true}]};}};
  const model=geminiModel({apiKey:'test',ledger,fetch:async()=>Response.json({responseId:'test-response',modelVersion:'test-version',
   usageMetadata:{promptTokenCount:10,toolUsePromptTokenCount:20,candidatesTokenCount:5,totalTokenCount:35},
   candidates:[{finishReason:'STOP',...retrieval===undefined?{}:{urlContextMetadata:{urlMetadata:retrieval}},
    content:{parts:[{text:JSON.stringify({status:'unreadable',records:[],note:'PRIVATE_MODEL_ANSWER'})}]}}]})});
  const result=await model('PRIVATE_PROMPT',[]).catch(e=>e),d=(result._diagnostics??result.diagnostics).attempts[0].diagnostics;
  assert.equal(d.retrieval_metadata_present,retrieval!==undefined);assert.equal(d.model_status,'unreadable');
  assert.deepEqual(d.tokens,{prompt:10,tool:20,output:5,thinking:null,total:35});
  if(!retrieval?.length)assert.equal(result.reason,'retrieval_metadata_missing');
  else if(retrieval[0].urlRetrievalStatus.endsWith('_ERROR'))assert.equal(result.reason,'url_retrieval_failed');
  else assert.equal(result.status,'unreadable');
  assert.ok(!JSON.stringify(writes).includes('PRIVATE_'));assert.ok(!JSON.stringify(writes).includes('test-response'));
 }
});

test('two durable quota mutations, URL retrieval accounting, streaming Unicode and max two generations',async()=>{
 const raw=await setup();try{
  const db=boundary(raw),http={count:0,generation:0};
  const send=async url=>{
   if(url.endsWith(':countTokens')){http.count++;return Response.json({totalTokens:1234});}
   http.generation++;
   const body=JSON.stringify({usageMetadata:{promptTokenCount:234,toolUsePromptTokenCount:1000,candidatesTokenCount:12,totalTokenCount:1246},candidates:[{finishReason:'STOP',urlContextMetadata:{urlMetadata:[{retrievedUrl:'https://example.org',urlRetrievalStatus:'URL_RETRIEVAL_STATUS_SUCCESS'}]},content:{parts:[{text:JSON.stringify({organization:'Océan 海洋'})}]}}]});
   const bytes=new TextEncoder().encode(body);
   return new Response(new ReadableStream({start(controller){for(const b of bytes)controller.enqueue(new Uint8Array([b]));controller.close();}}));
  };
  const model=geminiModel({apiKey:'test',ledger:db,fetch:send});
  assert.equal((await model('Test',{})).organization,'Océan 海洋');assert.equal(db.metrics.mutations,2);
  await model('Test',{});assert.equal(db.metrics.mutations,4);
  await raw.exec("update scout.quota_reservations set reserved_at=now()-interval '61 seconds'");
  await assert.rejects(model('Test',{}),/attempt_bound/);assert.deepEqual(http,{count:0,generation:2});
  const rows=(await raw.query('select * from scout.quota_reservations')).rows;assert.equal(rows.length,2);
  assert.ok(rows.every(r=>r.state==='settled'&&r.input_tokens===1234));
 }finally{await raw.close();}
});

test('policy removal preserves current findings and per-call charges, and leaves no policy-dependent functions',async()=>{
 const raw=await setup(false);try{
  for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort()
    .filter(n=>n>='20261009190000_scout_findings.sql'&&n<'20261019210000_scout_remove_quota_policy.sql'))
    await raw.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
  await raw.exec(`insert into scout.records(kind,description) values('announcement','Keep finding');
    insert into scout.quota_reservations(id,invocation,reserved_at,input_tokens,output_tokens,state,provider,model,cost_usd)
      values(gen_random_uuid(),gen_random_uuid(),now()-interval '5 minutes',1050000,128000,'unknown','openai','gpt-6-luna',0.3885);`);
  const records=(await raw.query('select * from scout.records')).rows,charges=(await raw.query('select * from scout.quota_reservations')).rows;
  const sql=await readFile(new URL('../supabase/migrations/20261019210000_scout_remove_quota_policy.sql',import.meta.url),'utf8');
  await raw.query("update scout.quota_reservations set state='dispatched',reserved_at=clock_timestamp()");
  await assert.rejects(raw.exec(sql),/Pause in-flight/);await raw.exec('rollback');
  await raw.query("update scout.quota_reservations set state='unknown',reserved_at=$1",[charges[0].reserved_at]);
  await raw.exec(sql);
  assert.equal((await raw.query("select to_regclass('scout.quota_policy') name")).rows[0].name,null);
  assert.deepEqual((await raw.query('select * from scout.records')).rows,records);
  assert.deepEqual((await raw.query('select * from scout.quota_reservations')).rows,charges);
  assert.equal((await raw.query("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='scout' and p.prosrc ilike '%quota_policy%'")).rows.length,0);
 }finally{await raw.close();}
});

test('reservations serialize two attempts and enforce deadlines without verification dates or policy switches',async()=>{
 const raw=await setup();try{
  const invocation=randomUUID();
  const results=await Promise.all([provider(raw,'gemini',invocation),provider(raw,'openai',invocation),provider(raw,'gemini',invocation)]);
  assert.equal(results.filter(r=>r.rows[0].allowed).length,2);
  assert.equal(results[2].rows[0].reason,'attempt_bound');
  const settings=results.filter(r=>r.rows[0].allowed).map(r=>r.rows[0].settings);
  assert.equal(settings[0].outputTokens,8192);assert.equal(settings[1].outputTokens,OPENAI_LIMITS.outputTokens);
  assert.ok(Date.parse(settings[0].deadline)<=Date.now()+45000);
  assert.equal((await provider(raw,'gemini',randomUUID(),randomUUID(),new Date(Date.now()+1000).toISOString())).rows[0].reason,'runtime_bound');
  const expired=randomUUID();await provider(raw,'gemini',expired);
  await raw.query("update scout.quota_reservations set reserved_at=now()-interval '101 seconds' where invocation=$1",[expired]);
  assert.equal((await provider(raw,'openai',expired)).rows[0].reason,'runtime_bound');
  for(const role of ['anon','authenticated']){
   await raw.exec('set role '+role);await assert.rejects(provider(raw,'openai'),{code:'42501'});await raw.exec('reset role');
  }
 }finally{await raw.close();}
});

test('known usage settles once; uncertain calls retain estimates and cleanup stays bounded',async()=>{
 const raw=await setup();try{
  const known=randomUUID(),unknown=randomUUID();
  await provider(raw,'openai',randomUUID(),known);await provider(raw,'openai',randomUUID(),unknown);
  const settle=(id,state,input,output,cost)=>raw.query('select * from scout.settle_provider($1,$2,$3,$4,null,null,$5)',[id,input,output,state,cost]);
  assert.equal((await settle(known,'settled',100,10,0.0100175)).rows[0].mutations,1);
  assert.equal((await settle(known,'settled',100,10,0.0100175)).rows[0].mutations,0);
  assert.equal((await settle(unknown,'unknown',0,0,0)).rows[0].settled,true);
  assert.equal((await settle(unknown,'settled',10,5,0)).rows[0].settled,false);
  const retained=(await raw.query('select input_tokens,output_tokens,cost_usd from scout.quota_reservations where id=$1',[unknown])).rows[0];
  assert.equal(retained.input_tokens,OPENAI_LIMITS.inputTokens);assert.equal(retained.output_tokens,OPENAI_LIMITS.outputTokens);assert.equal(Number(retained.cost_usd),0.3885);
  await raw.query('select * from scout.expire_quota()');assert.equal((await raw.query('select count(*)::int n from scout.quota_reservations')).rows[0].n,2);
  await raw.exec(`insert into scout.quota_reservations(id,invocation,reserved_at,input_tokens,state)
    select gen_random_uuid(),gen_random_uuid(),now()-interval '2 days',100,'unknown' from generate_series(1,40)`);
  assert.equal((await raw.query('select * from scout.expire_quota()')).rows[0].mutations,32);
  assert.equal((await raw.query('select count(*)::int n from scout.quota_reservations')).rows[0].n,10);
  await raw.exec('set role authenticated');
  await assert.rejects(settle(known,'settled',100,10,0.0100175),{code:'42501'});
 }finally{await raw.close();}
});
