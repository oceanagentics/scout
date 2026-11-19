import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {CHANNEL,prepareMessages,sendMessages,botTransport} from '../slackbot/slack.js';
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
 return (await db.query("insert into scout.records(type,description,priority,sources) values('announcement','Technical BBNJ ChM standards','high',jsonb_build_array(jsonb_build_object('url','https://example.org/standards','role','finding'))) returning id")).rows[0].id;
}
test('morning posts high-priority events individually on the New York day, using source dates without a known instant',async()=>{
 const db=await database();try{
  for(const [description,date,starttime,timezone,priority] of [
    ['Tomorrow in Asia, today in New York','2026-11-09','00:30','+08:00','high'],
    ['Today in Asia, yesterday in New York','2026-11-08','01:00','+08:00','high'],
    ['Date only','2026-11-08',null,null,'high'],
    ['Unknown timezone','2026-11-08','09:00',null,'high'],
    ['Normal event','2026-11-08',null,null,'normal'],
    ['Low event','2026-11-08',null,null,'low'],
    ['Unassessed event','2026-11-08',null,null,null],
    ['Month only','2026-11',null,null,'high']])
   await db.query("insert into scout.records(type,description,date,starttime,timezone,priority,sources) values('event',$1,$2,$3,$4,$5,jsonb_build_array(jsonb_build_object('url','https://example.org/event','role','finding')))",[description,date,starttime,timezone,priority]);
  const preview=await prepareMessages(db,{kind:'morning',now:new Date('2026-11-08T13:00:00Z')});
  assert.deepEqual(preview.records.map(r=>r.description).sort(),['Date only','Tomorrow in Asia, today in New York','Unknown timezone']);
  assert.deepEqual(preview.payloads.map(p=>p.text).sort(),[
   'Date only [he] · <https://example.org/event|Read more>',
   'Tomorrow in Asia, today in New York [he] · <https://example.org/event|Read more>',
   'Unknown timezone [he] · <https://example.org/event|Read more>'
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
    ['Treaty update','announcement','high',null,'2026-11-01T12:00:00Z']])
   await db.query("insert into scout.records(description,type,priority,date,modified,sources) values($1,$2,$3,$4,array[$5::timestamptz],jsonb_build_array(jsonb_build_object('url','https://example.org/source','role','finding')))",[description,type,priority,date,created]);
  const preview=await prepareMessages(db,{kind:'weekly',now});
  assert.deepEqual(preview.records.map(r=>r.description).sort(),['Exactly seven local days','Far future','Partially dated future','Treaty update','Undated','Within seven New York days']);
  assert.deepEqual(preview.payloads.map(p=>p.text).sort(),[
   'Exactly seven local days [ha] · <https://example.org/source|Read more>',
   'Far future [he] · <https://example.org/source|Read more>',
   'Partially dated future [he] · <https://example.org/source|Read more>',
   'Treaty update [ha] · <https://example.org/source|Read more>',
   'Undated [he] · <https://example.org/source|Read more>',
   'Within seven New York days [ha] · <https://example.org/source|Read more>'
  ]);
 }finally{await db.close();}
});

test('hosted sends post one high-priority finding at a time, stop on errors, and make no database writes',async()=>{
 const db=await database();try{
  await seed(db);
  await db.query("insert into scout.records(description,priority,sources) values('Second high finding','high',jsonb_build_array(jsonb_build_object('url','https://example.org/second','role','finding'))),('Normal finding','normal',jsonb_build_array(jsonb_build_object('url','https://example.org/normal','role','finding')))");
  const records=(await db.query('select * from scout.records')).rows;
  const trackers=(await db.query('select * from scout.trackers order by id')).rows;
  const secret='sb_secret_notify_test',env={url:'https://example.supabase.co',secretKeys:{default:secret},publishableKeys:{},jwks:null};
  const connect=()=>({reserve:async()=>({unsafe:async(q,p=[])=>{
    const result=await db.query(q,p);return Object.assign(result.rows,{count:result.affectedRows??result.rows.length});
  },release(){}}),end:async()=>{}});
  const ok={status:200,body:JSON.stringify({ok:true,channel:CHANNEL,ts:'1234567890.123456'})},
    failed={status:200,body:JSON.stringify({ok:false,error:'not_in_channel'})},unknown={status:500,body:'upstream'};
  let successfulPayloads;
  for(const [outcomes,status,communicated] of [[[ok,ok],'sent',2],[[ok,ok],'sent',2],[[failed],'failed',0],
    [[ok,failed],'failed',1],[[ok,unknown],'unknown',1],[[ok,new Error('Unknown remote outcome')],'unknown',1],
    [[{status:200,body:JSON.stringify({ok:false,error:'internal_error'})}],'unknown',0],
    [[{status:200,body:JSON.stringify({ok:true,channel:'OTHER',ts:'1234567890.123456'})}],'unknown',0]]){
    const payloads=[],remaining=[...outcomes];
    const response=await hostedNotify(new Request('https://example.test/notify?kind=findings&ids='+records.map(r=>r.id).join(','),{method:'POST',headers:{apikey:secret}}),{
      env,databaseURL:'unused',connect,post:async payload=>{
        payloads.push(payload);const outcome=remaining.shift();assert.ok(outcome,'Must stop after an unsuccessful send');
        if(outcome instanceof Error)throw outcome;return outcome;
      }});
    assert.equal(response.status,200);const result=await response.json();
    assert.equal(result.status,status);assert.equal(result.communicated,communicated);
    assert.equal(result.cost.statements,2);assert.equal(result.cost.mutations,0);
    assert.equal(payloads.length,outcomes.length);
    if(status==='sent'){
      assert.deepEqual(payloads.map(p=>p.text).sort(),[
        'Second high finding [hf] · <https://example.org/second|Read more>',
        'Technical BBNJ ChM standards [ha] · <https://example.org/standards|Read more>'
      ]);
      for(const payload of payloads){
        const record=records.find(r=>payload.text.startsWith(r.description));
        assert.deepEqual(payload.metadata,{event_type:'scout_finding',event_payload:{record_id:record.id}});
      }
      if(successfulPayloads)assert.deepEqual(payloads,successfulPayloads);
      successfulPayloads=payloads;
    }
  }
  assert.deepEqual((await db.query('select * from scout.records')).rows,records);
  assert.deepEqual((await db.query('select * from scout.trackers order by id')).rows,trackers);
 }finally{await db.close();}
});
test('a changed record timestamp invalidates a prepared notification before network dispatch',async()=>{
 const db=await database();try{
  const id=await seed(db),preview=await prepareMessages(db,{kind:'findings',ids:[id]});
  await assert.rejects(sendMessages(db,preview,()=>assert.fail('Expired message'),{now:()=>new Date(Date.parse(preview.prepared_at)+60001)}),/expired/);
  await db.query('update scout.records set modified=array_append(modified,clock_timestamp()) where id=$1',[id]);
  await assert.rejects(sendMessages(db,preview,()=>assert.fail('Stale message')),/changed/);
 }finally{await db.close();}
});
test('preview validation preserves PostgreSQL microseconds in older findings',async()=>{
 const db=await database();try{
  const id=await seed(db);
  await db.query("update scout.records set modified=array['2026-10-01T12:00:00.000001Z'::timestamptz] where id=$1",[id]);
  const preview=await prepareMessages(db,{kind:'findings',ids:[id]});
  const response={status:200,body:JSON.stringify({ok:true,channel:CHANNEL,ts:'1234567890.123456'})};
  assert.equal((await sendMessages(db,preview,async()=>response)).status,'sent');
  await db.query("update scout.records set modified=array['2026-10-01T12:00:00.000002Z'::timestamptz] where id=$1",[id]);
  await assert.rejects(sendMessages(db,preview,()=>assert.fail('Changed by one microsecond')),/changed/);
 }finally{await db.close();}
});
test('bot delivery keeps the saved link and record ID, uses the bot identity and reads the full Slack acknowledgement',async()=>{
 const db=await database();try{
  const id=await seed(db),preview=await prepareMessages(db,{kind:'findings',ids:[id]});
  const post=botTransport('xoxb-test',async(url,options)=>{
   assert.equal(url,'https://slack.com/api/chat.postMessage');
   assert.equal(options.headers.Authorization,'Bearer xoxb-test');
   const payload=JSON.parse(options.body);
   assert.equal(payload.channel,CHANNEL);
   assert.equal(payload.metadata.event_payload.record_id,id);
   assert.match(payload.text,/<https:\/\/example.org\/standards\|Read more>/);
   return Response.json({ok:true,channel:CHANNEL,ts:'1234567890.123456',message:{...payload,extra:'x'.repeat(5000)}});
  });
  assert.deepEqual(await sendMessages(db,preview,post),{status:'sent',communicated:1});
  assert.throws(()=>botTransport(undefined),/bot token/);
 }finally{await db.close();}
});

test('new findings exclude normal, low and unassessed records and skip empty notifications',async()=>{
 const db=await database();try{
  const empty=await prepareMessages(db,{kind:'morning'});
  assert.equal((await sendMessages(db,empty,()=>assert.fail('Empty digest'))).status,'no_change');
  const ids=[];
  for(const priority of ['normal','low',null])ids.push((await db.query("insert into scout.records(description,priority,sources) values('Finding',$1,jsonb_build_array(jsonb_build_object('url','https://example.org/source','role','finding'))) returning id",[priority])).rows[0].id);
  const preview=await prepareMessages(db,{kind:'findings',ids});assert.equal(preview.records.length,0);
  assert.equal((await sendMessages(db,preview,()=>assert.fail('No high-priority findings'))).status,'no_change');
 }finally{await db.close();}
});
