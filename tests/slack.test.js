import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {eligibleRecords,prepareMessage,sendMessage,webhookTransport} from '../slackbot/slack.js';
import {hostedNotify} from '../supabase/functions/scout-notify/index.ts';

async function database(){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create schema vault;create table vault.secrets(name text,secret text);
 create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');create table auth.identities(user_id uuid,provider text,identity_data jsonb);
 create function auth.uid() returns uuid language sql as $$select null::uuid$$;`);
 for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 return db;
}
async function seed(db){
 return (await db.query("insert into scout.records(type,description,priority,sources) values('announcement','Technical BBNJ ChM standards','high',array['https://example.org/standards']) returning id")).rows[0].id;
}
const now=new Date('2026-10-01T12:00:00Z');

test('eligibility uses priority, creation time and upcoming dates',()=>{
 const base={id:'event',type:'event',priority:'high',date:'2026-10-03',modified:['2026-10-01T00:00:00Z']};
 assert.equal(eligibleRecords([base],{now}).length,1);assert.equal(eligibleRecords([base],{kind:'digest',from:'2026-10-01',through:'2026-10-08',now}).length,1);
 for(const change of [{priority:'low'},{priority:null},{modified:['2026-09-29']},{modified:['2026-10-02']},{date:'2026-09-30'}])
   assert.equal(eligibleRecords([{...base,...change}],{now}).length,0);
 for(const date of [null,'2026-09-30','2026-11-01'])
   assert.equal(eligibleRecords([{...base,date}],{kind:'digest',from:'2026-10-01',through:'2026-10-08',now}).length,0);
 assert.equal(eligibleRecords([{...base,date:null}],{now}).length,1);
});

test('hosted explicit sends can repeat after every outcome and make no database writes',async()=>{
 const db=await database();try{
  await seed(db);const records=(await db.query('select * from scout.records')).rows;
  const trackers=(await db.query('select * from scout.trackers order by id')).rows;
  const secret='sb_secret_notify_test',env={url:'https://example.supabase.co',secretKeys:{default:secret},publishableKeys:{},jwks:null};
  const connect=()=>({reserve:async()=>({unsafe:async(q,p=[])=>{
    const result=await db.query(q,p);return Object.assign(result.rows,{count:result.affectedRows??result.rows.length});
  },release(){}}),end:async()=>{}});
  const payloads=[];
  for(const [outcome,status] of [[{status:200,body:'ok'},'sent'],[{status:200,body:'ok'},'sent'],
    [{status:400,body:'invalid_payload'},'failed'],[{status:500,body:'upstream'},'unknown'],[new Error('Unknown remote outcome'),'unknown']]){
    const response=await hostedNotify(new Request('https://example.test/notify',{method:'POST',headers:{apikey:secret}}),{
      env,databaseURL:'unused',connect,post:async payload=>{payloads.push(payload);if(outcome instanceof Error)throw outcome;return outcome;}});
    assert.equal(response.status,200);const result=await response.json();
    assert.equal(result.status,status);assert.equal(result.communicated,status==='sent'?1:0);
    assert.equal(result.cost.statements,2);assert.equal(result.cost.mutations,0);
  }
  assert.equal(payloads.length,5);assert.match(payloads[0].text,/Technical BBNJ ChM standards/);
  for(const payload of payloads)assert.deepEqual(payload,payloads[0]);
  assert.deepEqual((await db.query('select * from scout.records')).rows,records);
  assert.deepEqual((await db.query('select * from scout.trackers order by id')).rows,trackers);
 }finally{await db.close();}
});
test('a changed record timestamp invalidates a prepared notification before network dispatch',async()=>{
 const db=await database();try{
  const id=await seed(db),preview=await prepareMessage(db);
  await assert.rejects(sendMessage(db,preview,()=>assert.fail('Expired message'),{now:()=>new Date(Date.parse(preview.prepared_at)+60001)}),/expired/);
  await db.query('update scout.records set modified=array_append(modified,clock_timestamp()) where id=$1',[id]);
  await assert.rejects(sendMessage(db,preview,()=>assert.fail('Stale message')),/changed/);
 }finally{await db.close();}
});
test('webhooks require the confirmed Scout binding',()=>{
 for(const url of ['https://hooks.slack.com/services/OTHER/B0C5TEK4R38/token','http://hooks.slack.com/services/TFZ8FRLBV/B0C5TEK4R38/token','https://user:secret@hooks.slack.com/services/TFZ8FRLBV/B0C5TEK4R38/token'])assert.throws(()=>webhookTransport(url));
 assert.equal(typeof webhookTransport('https://hooks.slack.com/services/TFZ8FRLBV/B0C5TEK4R38/fixture'),'function');
});
