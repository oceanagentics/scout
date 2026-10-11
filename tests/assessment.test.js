import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {gemini} from '../collector/model.js';
import {database} from '../collector/hosted-hsa.js';

async function setup(cutover=true){
 const raw=new PGlite();
 await raw.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');create table auth.identities(user_id uuid,provider text,identity_data jsonb);
 create function auth.uid() returns uuid language sql as $$select null::uuid$$;`);
 for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort().filter(n=>cutover||n!=='20261009190000_scout_findings.sql'))
  await raw.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 return raw;
}
const enable=db=>db.exec("update scout.quota_policy set enabled=true,verified_until=now()+interval '1 hour',verified_rpm=15,verified_rpd=500,verified_tpm=250000,database_bytes=10000000,database_verified_until=now()+interval '1 hour'");
const boundary=raw=>database({unsafe:async(q,p=[])=>{const r=await raw.query(q,p);r.rows.count=r.affectedRows??r.rows.length;return r.rows;}});
const reserve=(db,invocation=randomUUID(),id=randomUUID(),tokens=null)=>db.query('select * from scout.reserve_model($1,$2,$3,2)',[invocation,id,tokens]);

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
test('three durable quota mutations, exact preflight, streaming Unicode and max two generations',async()=>{
 const raw=await setup();try{
  await enable(raw);const db=boundary(raw),http={count:0,generation:0};
  const send=async url=>{
   if(url.endsWith(':countTokens')){http.count++;return Response.json({totalTokens:1234});}
   http.generation++;
   const body=JSON.stringify({usageMetadata:{promptTokenCount:1234,candidatesTokenCount:12},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({organization:'Océan 海洋'})}]}}]});
   const bytes=new TextEncoder().encode(body);
   return new Response(new ReadableStream({start(controller){for(const b of bytes)controller.enqueue(new Uint8Array([b]));controller.close();}}));
  };
  const model=gemini({apiKey:'test',ledger:db,fetch:send});
  assert.deepEqual(await model('Test',{}),{organization:'Océan 海洋'});assert.equal(db.metrics.mutations,3);
  await model('Test',{});assert.equal(db.metrics.mutations,6);
  await raw.exec("update scout.quota_reservations set reserved_at=now()-interval '61 seconds'");
  await assert.rejects(model('Test',{}),/quota/);assert.deepEqual(http,{count:2,generation:2});
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
  await assert.rejects(gemini({apiKey:'test',ledger:boundary(raw),fetch:async url=>{if(url.endsWith(':countTokens'))return Response.json({totalTokens:16001});generated++;}})('Test',{}),/input_bound/);
  assert.equal(generated,0);
  await assert.rejects(gemini({apiKey:'test',ledger:boundary(raw),fetch:async()=>new Response('{}',{status:429,headers:{'retry-after':'3600'}})})('Test',{}),/provider_unavailable/);
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
