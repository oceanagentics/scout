import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {prepareMessage,sendMessage,webhookTransport} from '../slackbot/slack.js';
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
test('morning includes all priorities on the New York day and preserves source dates without a known instant',async()=>{
 const db=await database();try{
  for(const [description,date,starttime,timezone,priority] of [
    ['Tomorrow in Asia, today in New York','2026-11-09','00:30','+08:00','low'],
    ['Today in Asia, yesterday in New York','2026-11-08','01:00','+08:00','high'],
    ['Date only','2026-11-08',null,null,'normal'],
    ['Unknown timezone','2026-11-08','09:00',null,null],
    ['Month only','2026-11',null,null,'high']])
   await db.query("insert into scout.records(type,description,date,starttime,timezone,priority,sources) values('event',$1,$2,$3,$4,$5,array['https://example.org/event'])",[description,date,starttime,timezone,priority]);
  const preview=await prepareMessage(db,{kind:'morning',now:new Date('2026-11-08T13:00:00Z')});
  assert.deepEqual(preview.records.map(r=>r.description).sort(),['Date only','Tomorrow in Asia, today in New York','Unknown timezone']);
  const [heading,...entries]=preview.payload.text.split('\n');
  assert.equal(heading,'Today’s events · 2026-11-08 · New York');
  assert.deepEqual(entries.sort(),[
   'Date only [ne] · <https://example.org/event|Read more>',
   'Tomorrow in Asia, today in New York [le] · <https://example.org/event|Read more>',
   'Unknown timezone [ue] · <https://example.org/event|Read more>'
  ]);
 }finally{await db.close();}
});

test('weekly includes all pending high events and seven local days of newly saved high announcements across DST',async()=>{
 const db=await database();try{
  const now=new Date('2026-11-02T14:00:00Z'); // Monday 9 a.m. EST; prior Monday was EDT.
  for(const [description,type,priority,date,created] of [
    ['Undated','event','high',null,'2026-01-01'],
    ['Far future','event','high','2028-01-01','2026-01-01'],
    ['Partially dated future','event','high','2027-03','2026-01-01'],
    ['Past','event','high','2026-10-01','2026-01-01'],
    ['Normal event','event','normal','2027-01-01','2026-01-01'],
    ['Within seven New York days','announcement','high','2020-01-01','2026-10-26T13:30:00Z'],
    ['Exactly seven local days','announcement','high',null,'2026-10-26T13:00:00Z'],
    ['Older','announcement','high',null,'2026-10-26T12:59:59Z'],
    ['Normal news','announcement','normal',null,'2026-11-01T12:00:00Z'],
    ['Treaty update','treaty_status','high',null,'2026-11-01T12:00:00Z']])
   await db.query("insert into scout.records(description,type,priority,date,modified,sources) values($1,$2,$3,$4,array[$5::timestamptz],array['https://example.org/source'])",[description,type,priority,date,created]);
  const preview=await prepareMessage(db,{kind:'weekly',now});
  assert.deepEqual(preview.records.map(r=>r.description).sort(),['Exactly seven local days','Far future','Partially dated future','Undated','Within seven New York days']);
  assert.match(preview.payload.text,/Pending high-priority events/);assert.match(preview.payload.text,/High-priority events · date unknown/);assert.match(preview.payload.text,/High-priority announcements/);
 }finally{await db.close();}
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
    const response=await hostedNotify(new Request('https://example.test/notify?kind=findings&ids='+records[0].id,{method:'POST',headers:{apikey:secret}}),{
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
  const id=await seed(db),preview=await prepareMessage(db,{kind:'findings',ids:[id]});
  await assert.rejects(sendMessage(db,preview,()=>assert.fail('Expired message'),{now:()=>new Date(Date.parse(preview.prepared_at)+60001)}),/expired/);
  await db.query('update scout.records set modified=array_append(modified,clock_timestamp()) where id=$1',[id]);
  await assert.rejects(sendMessage(db,preview,()=>assert.fail('Stale message')),/changed/);
 }finally{await db.close();}
});
test('preview validation preserves PostgreSQL microseconds in older findings',async()=>{
 const db=await database();try{
  const id=await seed(db);
  await db.query("update scout.records set modified=array['2026-10-01T12:00:00.000001Z'::timestamptz] where id=$1",[id]);
  const preview=await prepareMessage(db,{kind:'findings',ids:[id]});
  assert.equal((await sendMessage(db,preview,async()=>({status:200,body:'ok'}))).status,'sent');
  await db.query("update scout.records set modified=array['2026-10-01T12:00:00.000002Z'::timestamptz] where id=$1",[id]);
  await assert.rejects(sendMessage(db,preview,()=>assert.fail('Changed by one microsecond')),/changed/);
 }finally{await db.close();}
});
test('webhooks require the confirmed Scout binding',()=>{
 for(const url of ['https://hooks.slack.com/services/OTHER/B0C5TEK4R38/token','http://hooks.slack.com/services/TFZ8FRLBV/B0C5TEK4R38/token','https://user:secret@hooks.slack.com/services/TFZ8FRLBV/B0C5TEK4R38/token'])assert.throws(()=>webhookTransport(url));
 assert.equal(typeof webhookTransport('https://hooks.slack.com/services/TFZ8FRLBV/B0C5TEK4R38/fixture'),'function');
});

test('new-finding batches include every requested priority and skip empty digests',async()=>{
 const db=await database();try{
  const empty=await prepareMessage(db,{kind:'morning'});
  assert.equal((await sendMessage(db,empty,()=>assert.fail('Empty digest'))).status,'no_change');
  const ids=[];
  for(let i=0;i<12;i++)ids.push((await db.query("insert into scout.records(description,priority,sources) values($1,$2,array['https://example.org/source']) returning id",['Finding '+i,i%2?'low':'normal'])).rows[0].id);
  const preview=await prepareMessage(db,{kind:'findings',ids});assert.equal(preview.records.length,12);
  assert.equal((await sendMessage(db,preview,async()=>({status:200,body:'ok'}))).communicated,12);
 }finally{await db.close();}
});
