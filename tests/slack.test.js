import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {eligibleRecords,prepareMessage,sendMessage,webhookTransport} from '../notifications/slack.js';

async function database() {
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');
 create table auth.identities(user_id uuid,provider text,identity_data jsonb);
 create function auth.uid() returns uuid language sql as $$select null::uuid$$;`);
 for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort()) await db.exec(await readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/seeds/trackers.sql',import.meta.url),'utf8'));
 return db;
}
const now=new Date('2026-10-01T12:00:00Z');
const select=async (_question,input)=>input.candidates.slice(0,5).map(r=>r.id);

test('priority ordering precedes limits; digests and correction eligibility share accepted record priority',()=>{
 const records=Array.from({length:8},(_,i)=>({id:String(i),kind:'event',priority:i===7?'high':'normal',starts_at:'2026-10-03T12:00:00Z',updated_at:'2026-10-01T00:00:00Z'}));
 assert.equal(eligibleRecords(records,{kind:'digest',from:'2026-10-01',through:'2026-10-08',now})[0].id,'7');
 assert.deepEqual(eligibleRecords(records).map(r=>r.id),['7']);
 const correction={...records[0],priority:'low',status:'cancelled',last_communicated_at:'2026-09-01T00:00:00Z'};
 assert.equal(eligibleRecords([correction]).length,1);
 assert.equal(eligibleRecords([{...correction,last_communicated_at:'2026-10-02T00:00:00Z'}]).length,0);
 assert.equal(eligibleRecords([correction],{kind:'digest',from:'2026-10-01',through:'2026-10-08',now}).length,0);
 assert.equal(eligibleRecords([{...records[0],priority:null}]).length,0);
 const reminder={...records[7],last_communicated_at:'2026-09-30T00:00:00Z',updated_at:'2026-09-29T00:00:00Z'};
 assert.equal(eligibleRecords([reminder],{now}).length,1);
 assert.equal(eligibleRecords([{...reminder,last_communicated_at:'2026-10-01T11:00:00Z'}],{now}).length,0);
 assert.equal(eligibleRecords([{...reminder,starts_at:'2026-11-01T00:00:00Z'}],{now}).length,0);
});

test('ephemeral previews use agent recency judgment, stamp only confirmed included versions, and never retry uncertainty',async()=>{
 const db=await database();
 try {
  const tracker=(await db.query('select id from scout.trackers limit 1')).rows[0].id;
  for(let i=0;i<7;i++){
   const row=(await db.query("insert into scout.records(kind,title,identity_key,priority) values('announcement',$1,$1,'high') returning id",[`Technical standards update ${i}`])).rows[0];
   await db.query("insert into scout.evidence(record_id,tracker_id,url,content_hash,content,last_seen_at) values($1,$2,$3,$3,'Public evidence',clock_timestamp())",[row.id,tracker,`https://example.org/${i}`]);
  }
  const asOf=new Date(Date.now()+1000);
  const preview=await prepareMessage(db,{model:select,now:asOf});
  assert.equal(preview.records.length,5);assert.match(preview.payload.text,/Organization: Unknown/);assert.match(preview.payload.text,/Event date: Not applicable/);
  assert.match(JSON.stringify(preview.payload),/bbnj-scout.web.app\/\?record=/);
  let posts=0;
  const unknown=await sendMessage(db,preview,async()=>{posts++;throw new Error('timeout');},{now:()=>asOf});
  assert.equal(unknown.status,'unknown');assert.equal(posts,1);
  assert.equal((await db.query('select count(*)::int n from scout.records where last_communicated_at is not null')).rows[0].n,0);
  const before=(await db.query('select id,updated_at from scout.records order by id')).rows;
  const sent=await sendMessage(db,preview,async()=>({status:200,body:'ok'}),{now:()=>asOf});
  assert.equal(sent.communicated,5);
  assert.deepEqual((await db.query('select id,updated_at from scout.records order by id')).rows,before);
  const next=await prepareMessage(db,{model:select,now:asOf});assert.equal(next.records.length,2);
  await assert.rejects(sendMessage(db,preview,async()=>{throw new Error('must not send');},{now:()=>asOf}),/changed/);
  await db.query("update scout.records set title='Material correction' where id=$1",[next.records[0].id]);
  await assert.rejects(sendMessage(db,next,async()=>{throw new Error('must not send');},{now:()=>asOf}),/changed/);
  const skipped=await prepareMessage(db,{model:async()=>[],now:asOf});assert.equal(skipped.payload,null);
  await assert.rejects(prepareMessage(db,{model:async()=>['invented'],now:asOf}),/selection/);
 }finally{await db.close();}
});

test('only the confirmed Scout webhook binding is accepted',()=>{
 for(const url of ['https://hooks.slack.com/services/OTHER/B0C5TEK4R38/token','https://hooks.slack.com/services/TFZ8FRLBV/OTHER/token','http://hooks.slack.com/services/TFZ8FRLBV/B0C5TEK4R38/token','https://user:secret@hooks.slack.com/services/TFZ8FRLBV/B0C5TEK4R38/token']) assert.throws(()=>webhookTransport(url));
 assert.equal(typeof webhookTransport('https://hooks.slack.com/services/TFZ8FRLBV/B0C5TEK4R38/fixture'),'function');
});
