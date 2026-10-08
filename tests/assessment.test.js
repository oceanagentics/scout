import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {database as adapter} from '../collector/hosted-hsa.js';
import {gemini,reservationSQL,modelBudgetSQL,modelLimits,MODEL} from '../collector/model.js';

async function database() {
  const db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');
    create table auth.identities(user_id uuid,provider text,identity_data jsonb);
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;`);
  for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort()) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8'));
  }
  await db.exec(await readFile(new URL('../supabase/seeds/trackers.sql',import.meta.url),'utf8'));
  return db;
}

test('actual hosted database adapter commits reservations before rollback and reset, enforcing shared caps',async()=>{
  const db=await database();
  try {
    const sql={unsafe:async(q,p=[]) => (await db.query(q,p)).rows};
    const hosted=adapter(sql);
    const run=(await db.query("insert into scout.collection_runs(tracker_id) select id from scout.trackers limit 1 returning id")).rows[0].id;
    let calls=0;
    const model=gemini({apiKey:'fixture-only',ledger:hosted,runId:run,fetch:async url=>{if(url.endsWith(':countTokens'))return Response.json({totalTokens:25});calls++;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'[]'}]}}]});}});
    await model('test',{},{});
    await assert.rejects(hosted.transaction(async tx=>{await tx.query("insert into scout.records(kind,title,identity_key) values('announcement','Rollback','rollback')");throw new Error('crash after external call');}));
    assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,0);
    assert.equal((await db.query("select jsonb_array_length(stats->'model_attempts') n from scout.collection_runs where id=$1",[run])).rows[0].n,1);
    await model('test',{},{});await assert.rejects(model('test',{},{}),/quota/);assert.equal(calls,2);
    await db.exec('begin;delete from scout.evidence;delete from scout.records;commit;');
    assert.equal((await db.query("select jsonb_array_length(stats->'model_attempts') n from scout.collection_runs where id=$1",[run])).rows[0].n,2);
    await assert.rejects(model('test','x'.repeat(8001),{}),/quota/);assert.equal(calls,2);
    // Earlier same-day work no longer blocks another run; rate/run caps remain.
    const seed={at:new Date(Date.now()-120000).toISOString()};
    await db.query("update scout.collection_runs set stats=jsonb_build_object('model_attempts',$1::jsonb) where id=$2",[JSON.stringify(Array(10).fill(seed)),run]);
    await assert.rejects(hosted.query(reservationSQL(run,50)),/quota/);
    const other=(await db.query("insert into scout.collection_runs(tracker_id,stats) select tracker_id,$2::jsonb from scout.collection_runs where id=$1 returning id",[run,JSON.stringify({model_attempts:Array(10).fill(seed)})])).rows[0].id;
    await db.query("insert into scout.collection_runs(tracker_id,stats) select tracker_id,$2::jsonb from scout.collection_runs where id=$1",[run,JSON.stringify({model_attempts:Array(5).fill(seed)})]);
    const fresh=(await db.query('insert into scout.collection_runs(tracker_id) select tracker_id from scout.collection_runs where id=$1 returning id',[other])).rows[0].id;
    const large=gemini({apiKey:'fixture-only',ledger:hosted,runId:fresh,fetch:async(url,request)=>{
      if(url.endsWith(':countTokens')){
        const counted=JSON.parse(request.body).generateContentRequest;
        assert.equal(counted.model,'models/'+MODEL);assert.ok(counted.systemInstruction);assert.ok(counted.generationConfig.responseJsonSchema);
        return Response.json({totalTokens:3000});
      }
      assert.equal(JSON.parse(request.body).generationConfig.thinkingConfig.thinkingLevel,'minimal');
      assert.ok(Buffer.byteLength(request.body)>8000);return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'[]'}]}}]});
    }});
    await large('test','x'.repeat(8001),{});
    const attempt=(await db.query('select stats from scout.collection_runs where id=$1',[fresh])).rows[0].stats.model_attempts[0];
    assert.equal(attempt.model,MODEL);assert.equal(attempt.input_tokens,3000);assert.equal(attempt.input_token_limit,1048576);assert.equal(attempt.output_bound,65536);assert.ok(attempt.input_bytes>8000);
    await hosted.query(reservationSQL(fresh,50));
    assert.equal((await db.query("select jsonb_array_length(stats->'model_attempts') n from scout.collection_runs where id=$1",[fresh])).rows[0].n,2);
    await assert.rejects(hosted.query(reservationSQL(fresh,50)),/quota/);
  }finally{await db.close();}
});

test('missing-field reviews use the stronger model while extraction and final audits share the same durable cap',async()=>{
  const db=await database();
  try{
    const runId=(await db.query('insert into scout.collection_runs(tracker_id) select id from scout.trackers limit 1 returning id')).rows[0].id;
    let sent=0;
    const model=gemini({apiKey:'fixture-only',ledger:db,runId,limits:{minute:3,day:3},fetch:async(url,request)=>{
      const expected=Math.floor(sent/2)===1?'gemini-3.5-flash':MODEL;assert.ok(url.includes('/models/'+expected+':'));sent++;
      if(url.endsWith(':countTokens')){assert.equal(JSON.parse(request.body).generateContentRequest.model,'models/'+expected);return Response.json({totalTokens:30});}
      return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'{}'}]}}]});
    }});
    for(const input of [[{stage:'extract'}],[{stage:'resolve',missing_fields:['organization']}],[{stage:'resolve'}]])await model('test',input,{});
    const attempts=(await db.query('select stats from scout.collection_runs where id=$1',[runId])).rows[0].stats.model_attempts;
    assert.deepEqual(attempts.map(a=>a.model),[MODEL,'gemini-3.5-flash',MODEL]);assert.equal(sent,6);
    await assert.rejects(model('test',[{stage:'resolve',missing_fields:['organization']}],{}),/quota/);assert.equal(sent,6);
    assert.throws(()=>reservationSQL(runId,50,10,modelLimits(),null,runId,"unsafe'model"),/Invalid model/);
  }finally{await db.close();}
});

test('shared token/day limits, paced calls and provider interruptions retain durable reservations',async()=>{
  const db=await database();
  try{
    const tracker=(await db.query('select id from scout.trackers limit 1')).rows[0].id;
    const run=async()=>(await db.query('insert into scout.collection_runs(tracker_id) values($1) returning id',[tracker])).rows[0].id;
    const old=await run(),fresh=await run(),limits=modelLimits({minute:2,tokens:100,day:3});
    const seeds=[{id:'00000000-0000-0000-0000-000000000001',at:new Date().toISOString(),input_tokens:80,model:'gemini-3.5-flash'}];
    await db.query("update scout.collection_runs set stats=jsonb_build_object('model_attempts',$2::jsonb) where id=$1",[old,JSON.stringify(seeds)]);
    assert.equal((await db.query(modelBudgetSQL(fresh,10,limits,30))).rows[0].reason,'tokens');
    let waits=0,counted=0,generated=0;
    const good=async url=>url.endsWith(':countTokens')?(counted++,Response.json({totalTokens:30})):
      (generated++,Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'[]'}]}}]}));
    const model=gemini({apiKey:'fixture-only',ledger:db,runId:fresh,limits,pace:true,fetch:good,sleep:async ms=>{
      waits++;assert.ok(ms>0&&ms<=60000);
      await db.query("update scout.collection_runs set stats=jsonb_set(stats,'{model_attempts}',(select jsonb_agg(a||jsonb_build_object('at',(a->>'at')::timestamptz-interval '61 seconds')) from jsonb_array_elements(stats->'model_attempts') a)) where stats ? 'model_attempts'");
    }});
    await model('test',[],{});assert.equal(waits,1);assert.equal(counted,1);assert.equal(generated,1);
    const attempts=(await db.query('select stats from scout.collection_runs where id=$1',[fresh])).rows[0].stats.model_attempts;
    assert.equal(attempts.length,1);assert.equal(attempts[0].input_tokens,30);
    await db.query(reservationSQL(fresh,50,10,limits));
    const daily=(await db.query(modelBudgetSQL(null,10,limits))).rows[0];
    assert.equal(daily.reason,'day');assert.ok(Date.parse(daily.retry_at)>Date.now());
    await db.query("update scout.collection_runs set stats=stats-'model_attempts'-'model_limits'");
    for(const endpoint of ['countTokens','generateContent']){
      const blocked=await run();let sent=0;
      const quota=gemini({apiKey:'fixture-only',ledger:db,runId:blocked,limits:{minute:10},fetch:async url=>{
        sent++;return url.endsWith(':'+endpoint)?new Response('{"retryDelay":"120s"}',{status:429}):Response.json({totalTokens:25});
      }});
      await assert.rejects(quota('test',[],{}),error=>error.deferred?.reason==='provider');
      assert.equal(sent,endpoint==='countTokens'?1:2);
      const other=await run();
      // A local caller without explicit config follows the hosted published limit/cooldown.
      await assert.rejects(gemini({apiKey:'fixture-only',ledger:db,runId:other,fetch:()=>{throw new Error('must not send');}})('test',[],{}),error=>error.deferred?.reason==='provider');
      assert.equal((await db.query('select stats from scout.collection_runs where id=$1',[blocked])).rows[0].stats.model_attempts.length,1);
      await db.query("update scout.collection_runs set stats=stats-'model_retry_at'-'model_attempts'");
    }
    const dailyRun=await run();
    await assert.rejects(gemini({apiKey:'fixture-only',ledger:db,runId:dailyRun,limits:{minute:10},fetch:async()=>
      new Response('{"quotaId":"GenerateRequestsPerDayPerProjectPerModel"}',{status:429})})('test',[],{}),error=>
      error.deferred?.reason==='day'&&Date.parse(error.deferred.retry_at)>Date.now());
    await db.query("update scout.collection_runs set stats=stats-'model_retry_at'-'model_attempts'");
    // A local caller cannot exceed a smaller centrally published turn allowance.
    const policy=await run();
    await gemini({apiKey:'fixture-only',ledger:db,runId:policy,limits:{minute:10,run:1},fetch:good})('test',[],{});
    const local=await run(),follower=gemini({apiKey:'fixture-only',ledger:db,runId:local,runLimit:10,fetch:good});
    await follower('test',[],{});await assert.rejects(follower('test',[],{}),error=>error.deferred?.reason==='turn');
    const generatedBefore=generated;
    const interrupted=await run();
    await assert.rejects(gemini({apiKey:'fixture-only',ledger:db,runId:interrupted,pace:true,fetch:async()=>{throw new TypeError('Network disconnected');}})('test',[],{}),error=>error.deferred?.reason==='network');
    assert.equal((await db.query('select stats from scout.collection_runs where id=$1',[interrupted])).rows[0].stats.model_attempts.length,1);
    const bound=await run();
    await assert.rejects(gemini({apiKey:'fixture-only',ledger:db,runId:bound,pace:true,deadline:Date.now(),fetch:good})('test',[],{}),error=>error.deferred?.reason==='runtime');
    assert.equal(generated,generatedBefore);
    assert.throws(()=>modelLimits({minute:0}));assert.throws(()=>modelLimits({day:-1}));
  }finally{await db.close();}
});
