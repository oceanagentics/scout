import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {readRecords,eligibleRecords,prepareMessage,sendMessage,webhookTransport} from '../slackbot/slack.js';

async function database(){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');create table auth.identities(user_id uuid,provider text,identity_data jsonb);
 create function auth.uid() returns uuid language sql as $$select null::uuid$$;`);
 for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/seeds/trackers.sql',import.meta.url),'utf8'));return db;
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

test('deterministic previews and two durable delivery markers; confirmed and uncertain sends never repeat',async()=>{
 const db=await database();try{
  const id=await seed(db);let calls=0;
  const preview=await prepareMessage(db,{model:()=>assert.fail('No notification model')});
  assert.equal(preview.records.length,1);assert.ok(preview.payload.text.includes('Technical BBNJ ChM standards'));
  const result=await sendMessage(db,preview,async()=>{calls++;return {status:200,body:'ok'};});
  assert.equal(result.status,'sent');assert.equal(calls,1);
  assert.equal((await db.query('select status from scout.delivery_state')).rows[0].status,'sent');
  assert.equal((await prepareMessage(db)).payload,null);
  await assert.rejects(sendMessage(db,preview,async()=>{calls++;}),/reserved/);assert.equal(calls,1);
  const other=await seed(db);
  const pending=await prepareMessage(db);
  assert.equal((await sendMessage(db,pending,async()=>{throw new Error('Unknown remote outcome');})).status,'unknown');
  await db.query('update scout.records set modified=array_append(modified,clock_timestamp()) where id=$1',[other]);
  assert.equal((await prepareMessage(db)).payload,null);
  assert.equal((await db.query('select cardinality(modified) n from scout.records where id=$1',[id])).rows[0].n,1,'Delivery does not change the record.');
 }finally{await db.close();}
});
test('a changed record timestamp invalidates a prepared notification before network dispatch',async()=>{
 const db=await database();try{
  const id=await seed(db),preview=await prepareMessage(db);
  await db.query('update scout.records set modified=array_append(modified,clock_timestamp()) where id=$1',[id]);
  await assert.rejects(sendMessage(db,preview,()=>assert.fail('Stale message')),/changed/);
  assert.equal((await db.query('select count(*)::int n from scout.delivery_state')).rows[0].n,0);
 }finally{await db.close();}
});
test('webhooks require the confirmed Scout binding',()=>{
 for(const url of ['https://hooks.slack.com/services/OTHER/B0C5TEK4R38/token','http://hooks.slack.com/services/TFZ8FRLBV/B0C5TEK4R38/token','https://user:secret@hooks.slack.com/services/TFZ8FRLBV/B0C5TEK4R38/token'])assert.throws(()=>webhookTransport(url));
 assert.equal(typeof webhookTransport('https://hooks.slack.com/services/TFZ8FRLBV/B0C5TEK4R38/fixture'),'function');
});
