import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {database as adapter} from '../collector/hosted-hsa.js';
import {gemini,reservationSQL} from '../collector/model.js';

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
        assert.equal(counted.model,'models/gemini-3.5-flash-lite');assert.ok(counted.systemInstruction);assert.ok(counted.generationConfig.responseJsonSchema);
        return Response.json({totalTokens:3000});
      }
      assert.equal(JSON.parse(request.body).generationConfig.thinkingConfig.thinkingLevel,'minimal');
      assert.ok(Buffer.byteLength(request.body)>8000);return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'[]'}]}}]});
    }});
    await large('test','x'.repeat(8001),{});
    const attempt=(await db.query('select stats from scout.collection_runs where id=$1',[fresh])).rows[0].stats.model_attempts[0];
    assert.equal(attempt.input_tokens,3000);assert.equal(attempt.input_token_limit,1048576);assert.equal(attempt.output_bound,65536);assert.ok(attempt.input_bytes>8000);
    await hosted.query(reservationSQL(fresh,50));
    assert.equal((await db.query("select jsonb_array_length(stats->'model_attempts') n from scout.collection_runs where id=$1",[fresh])).rows[0].n,2);
    await assert.rejects(hosted.query(reservationSQL(fresh,50)),/quota/);
  }finally{await db.close();}
});
