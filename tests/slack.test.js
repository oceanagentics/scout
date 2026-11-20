import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {CHANNEL,DM_CHANNEL,prepareMessages,sendMessages,botTransport,readPostedFindings} from '../slackbot/slack.js';
import {hostedNotify} from '../supabase/functions/scout-notify/index.ts';

const migration='20261120010000_scout_slack_channel_post.sql';
const ack=(channel=CHANNEL)=>({status:200,body:JSON.stringify({ok:true,channel,ts:'1234567890.123456'})});
async function database({before=false}={}){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create schema vault;create table vault.secrets(name text,secret text);
 create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');create table auth.identities(user_id uuid,provider text,identity_data jsonb);
 create function auth.uid() returns uuid language sql as $$select null::uuid$$;`);
 for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort()){
  if(before&&name===migration)break;
  await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 }
 return db;
}
async function seed(db){
 return (await db.query("insert into scout.records(type,description,priority,sources) values('announcement','Technical BBNJ ChM standards','high',jsonb_build_array(jsonb_build_object('url','https://example.org/standards','role','finding'))) returning id")).rows[0].id;
}

test('migration preserves existing findings as unconfirmed, starts new findings pending and rejects malformed receipts',async()=>{
 const db=await database({before:true});try{
  const id=await seed(db),before=(await db.query('select * from scout.records where id=$1',[id])).rows[0];
  await db.exec(await readFile(new URL('../supabase/migrations/'+migration,import.meta.url),'utf8'));
  const {slack_channel_post,...after}=(await db.query('select * from scout.records where id=$1',[id])).rows[0];
  assert.deepEqual(after,before);assert.deepEqual(slack_channel_post,{state:'uncertain'});
  const fresh=await seed(db);assert.equal((await db.query('select slack_channel_post from scout.records where id=$1',[fresh])).rows[0].slack_channel_post,null);
  for(const invalid of [{},{state:'posted'},{state:'posted',ts:123},{state:'posted',ts:'not-a-message'},
    {state:'posted',ts:'123.456',body:'No message bodies'},{state:'uncertain',ts:'123.456'},[]])
   await assert.rejects(db.query('update scout.records set slack_channel_post=$2::jsonb where id=$1',[fresh,JSON.stringify(invalid)]),{code:'23514'});
 }finally{await db.close();}
});

test('daily selection includes all pending and uncertain High findings without a date restriction or dev DMs',async()=>{
 const db=await database();try{
  for(const [description,type,priority,date,receipt]of [
   ['Undated','event','high',null,null],['Past event','event','high','2020-01-01',null],
   ['Announcement','announcement','high',null,null],['Uncertain','event','high',null,{state:'uncertain'}],
   ['Already posted','event','high',null,{state:'posted',ts:'123.456'}],
   ['Dev normal','event','normal',null,null],['Dev low','announcement','low',null,null],['Unassessed','event',null,null,null]])
   await db.query('insert into scout.records(description,type,priority,date,slack_channel_post) values($1,$2,$3,$4,$5::jsonb)',[description,type,priority,date,receipt?JSON.stringify(receipt):null]);
  const preview=await prepareMessages(db,{kind:'unposted'});
  assert.deepEqual(preview.records.map(r=>r.description).sort(),['Announcement','Past event','Uncertain','Undated']);
  assert.ok(preview.payloads.every(p=>p.channel===CHANNEL));
  await assert.rejects(prepareMessages(db,{kind:'weekly'}),/Unknown notification/);
 }finally{await db.close();}
});

test('central channel receipts prevent repeats after edits or Slack deletion without changing finding revisions',async()=>{
 const db=await database();try{
  const id=await seed(db),before=(await db.query('select * from scout.records where id=$1',[id])).rows[0];
  assert.equal((await sendMessages(db,await prepareMessages(db,{kind:'findings',ids:[id]}),async()=>ack())).communicated,1);
  const {slack_channel_post,...after}=(await db.query('select * from scout.records where id=$1',[id])).rows[0];
  const {slack_channel_post:old,...original}=before;
  assert.deepEqual(after,original);assert.deepEqual(slack_channel_post,{state:'posted',ts:'1234567890.123456'});
  await db.query("update scout.records set description='Corrected',modified=array_append(modified,clock_timestamp()) where id=$1",[id]);
  const repeat=await sendMessages(db,await prepareMessages(db,{kind:'findings',ids:[id]}),()=>assert.fail('Already posted, even if Slack deletes it'));
  assert.equal(repeat.status,'no_change');assert.equal(repeat.skipped,1);
 }finally{await db.close();}
});

test('dev DMs of High findings neither create nor consume channel receipts',async()=>{
 const db=await database();try{
  const id=await seed(db),dev=await prepareMessages(db,{kind:'findings',ids:[id]});dev.payloads[0].channel=DM_CHANNEL;
  assert.equal((await sendMessages(db,dev,async()=>ack(DM_CHANNEL))).communicated,1);
  assert.equal((await db.query('select slack_channel_post from scout.records where id=$1',[id])).rows[0].slack_channel_post,null);
  assert.equal((await sendMessages(db,await prepareMessages(db,{kind:'findings',ids:[id]}),async()=>ack())).communicated,1);
  assert.equal((await sendMessages(db,dev,async()=>ack(DM_CHANNEL))).communicated,1);
  assert.deepEqual((await db.query('select slack_channel_post from scout.records where id=$1',[id])).rows[0].slack_channel_post,{state:'posted',ts:'1234567890.123456'});
 }finally{await db.close();}
});

test('hosted delivery retains rejection reasons, permits safe retry and stops batches on uncertain sends',async()=>{
 const db=await database();try{
  await seed(db);await db.query("insert into scout.records(description,priority) values('Second finding','high')");
  const records=(await db.query('select * from scout.records order by id')).rows,trackers=(await db.query('select * from scout.trackers order by id')).rows;
  const secret='sb_secret_notify_test',env={url:'https://example.supabase.co',secretKeys:{default:secret},publishableKeys:{},jwks:null};
  const connect=()=>({reserve:async()=>({unsafe:async(q,p=[])=>{const r=await db.query(q,p);return Object.assign(r.rows,{count:r.affectedRows??r.rows.length});},release(){}}),end:async()=>{}});
  for(const [outcomes,status,count,error]of [
   [[{status:200,body:JSON.stringify({ok:false,error:'token_revoked'})}],'failed',0,'token_revoked'],
   [[ack(),{status:500,body:'Discard this response body'}],'unknown',1,'slack_http_500'],
   [[{status:200,body:JSON.stringify({ok:false,error:'internal_error'})}],'unknown',0,'internal_error'],
   [[ack(),new Error('Do not return raw errors')],'unknown',1,'slack_transport'],
   [[ack('OTHER')],'unknown',0,'slack_invalid_response'],[[ack(),ack()],'sent',2,undefined]]){
    await db.query('update scout.records set slack_channel_post=null');
    const remaining=[...outcomes],payloads=[];
    const response=await hostedNotify(new Request('https://example.test/notify?kind=findings&ids='+records.map(r=>r.id).join(','),{method:'POST',headers:{apikey:secret}}),{
     env,databaseURL:'unused',connect,post:async payload=>{payloads.push(payload);const outcome=remaining.shift();assert.ok(outcome,'Stop after an unsuccessful send');if(outcome instanceof Error)throw outcome;return outcome;}
    });
    const result=await response.json();assert.equal(response.status,status==='sent'?200:502);
    assert.equal(result.status,status);assert.equal(result.communicated,count);assert.equal(result.error,error);assert.equal(payloads.length,outcomes.length);
    const rows=(await db.query('select * from scout.records order by id')).rows;
    for(const r of rows){const old=records.find(o=>o.id===r.id);assert.deepEqual(r.modified,old.modified);assert.equal(r.description,old.description);}
    if(status==='sent')assert.equal(result.cost.mutations,4);
    if(error==='token_revoked')assert.ok(rows.every(r=>r.slack_channel_post===null));
    if(status==='unknown')assert.equal(rows.filter(r=>r.slack_channel_post?.state==='uncertain').length,1);
  }
  assert.deepEqual((await db.query('select * from scout.trackers order by id')).rows,trackers);
 }finally{await db.close();}
});

test('concurrent callers cannot both post the same finding',async()=>{
 const db=await database();try{
  const id=await seed(db),preview=await prepareMessages(db,{kind:'findings',ids:[id]});
  let started,release;const claimed=new Promise(resolve=>{started=resolve;}),finish=new Promise(resolve=>{release=resolve;});
  const first=sendMessages(db,preview,async()=>{started();await finish;return ack();});await claimed;
  const second=await sendMessages(db,preview,()=>assert.fail('Another sender owns the claim'));
  assert.equal(second.communicated,0);assert.equal(second.uncertain,1);release();assert.equal((await first).communicated,1);
  assert.equal((await sendMessages(db,preview,()=>assert.fail('Receipt prevents repost'))).skipped,1);
 }finally{await db.close();}
});

test('daily history repairs lost acknowledgements without resending and reports unresolved delivery',async t=>{
 const db=await database();try{
  const id=await seed(db),other=await seed(db);await db.query('update scout.records set slack_channel_post=$2::jsonb where id=$1',[other,JSON.stringify({state:'uncertain'})]);
  assert.equal((await sendMessages(db,await prepareMessages(db,{kind:'findings',ids:[id]}),async()=>{throw new Error('Response lost after Slack accepted');})).status,'unknown');
  const secret='sb_secret_notify_test',env={url:'https://example.supabase.co',secretKeys:{default:secret},publishableKeys:{},jwks:null};
  const connect=()=>({reserve:async()=>({unsafe:async(q,p=[])=>{const r=await db.query(q,p);return Object.assign(r.rows,{count:r.affectedRows??r.rows.length});},release(){}}),end:async()=>{}});
  let requests=0;
  const response=await hostedNotify(new Request('https://example.test/notify?kind=unposted',{method:'POST',headers:{apikey:secret}}),{
   env,databaseURL:'unused',connect,slackToken:'xoxb-test',post:()=>assert.fail('Known and uncertain posts cannot be resent'),
   slackFetch:async input=>{const url=new URL(input);assert.equal(url.searchParams.get('channel'),CHANNEL);assert.equal(url.searchParams.get('include_all_metadata'),'true');requests++;
    return Response.json(requests===1?{ok:true,messages:[],has_more:true,response_metadata:{next_cursor:'second'}}:{ok:true,messages:[
     {user:'OTHER',ts:'123.1',metadata:{event_type:'scout_finding',event_payload:{record_id:other}}},
     {user:'U0C6PNRPX4G',ts:'1234567890.123456',metadata:{event_type:'scout_finding',event_payload:{record_id:id}}}
    ]});}
  });
  const result=await response.json();assert.equal(response.status,502);assert.equal(result.communicated,0);assert.equal(result.reconciled,1);assert.equal(result.uncertain,1);assert.equal(requests,2);
  assert.deepEqual((await db.query('select slack_channel_post from scout.records where id=$1',[id])).rows[0].slack_channel_post,{state:'posted',ts:'1234567890.123456'});
  assert.deepEqual((await db.query('select slack_channel_post from scout.records where id=$1',[other])).rows[0].slack_channel_post,{state:'uncertain'});
  t.diagnostic(JSON.stringify({mocked_slack:true,history_requests:requests,model_calls:0,cost:result.cost}));
 }finally{await db.close();}
});

test('receipt-write failure after an acknowledgement stays uncertain instead of resending',async()=>{
 const db=await database();try{
  const id=await seed(db),preview=await prepareMessages(db,{kind:'findings',ids:[id]});
  const broken={query:(q,p)=>{if(q.includes('slack_channel_post=$2'))throw new Error('Write unavailable');return db.query(q,p);}};
  const result=await sendMessages(broken,preview,async()=>ack());assert.equal(result.communicated,1);assert.equal(result.error,'slack_receipt_failed');
  assert.equal((await sendMessages(db,preview,()=>assert.fail('Slack accepted this message'))).uncertain,1);
 }finally{await db.close();}
});

test('daily catch-up posts pending High findings once, repairs existing posts and leaves dev DMs untouched',async t=>{
 const db=await database();try{
  const known=await seed(db);await seed(db);await seed(db);
  const dev=(await db.query("insert into scout.records(description,priority) values('Dev review only','normal') returning id")).rows[0].id;
  const secret='sb_secret_notify_test',env={url:'https://example.supabase.co',secretKeys:{default:secret},publishableKeys:{},jwks:null};
  const connect=()=>({reserve:async()=>({unsafe:async(q,p=[])=>{const r=await db.query(q,p);return Object.assign(r.rows,{count:r.affectedRows??r.rows.length});},release(){}}),end:async()=>{}});
  let reads=0,posts=0;
  const run=()=>hostedNotify(new Request('https://example.test/notify?kind=unposted',{method:'POST',headers:{apikey:secret}}),{
   env,databaseURL:'unused',connect,slackToken:'xoxb-test',
   slackFetch:async()=>{reads++;return Response.json({ok:true,messages:[{user:'U0C6PNRPX4G',ts:'123.456',metadata:{event_type:'scout_finding',event_payload:{record_id:known}}}]});},
   post:async payload=>{assert.equal(payload.channel,CHANNEL);posts++;return {status:200,body:JSON.stringify({ok:true,channel:CHANNEL,ts:'1234567890.12345'+posts})};}
  });
  const response=await run(),first=await response.json();assert.equal(response.status,200);assert.equal(first.communicated,2);assert.equal(first.reconciled,1);
  assert.equal(first.cost.statements,7);assert.equal(first.cost.mutations,5);
  const repeat=await run(),second=await repeat.json();assert.equal(repeat.status,200);assert.equal(second.communicated,0);assert.equal(second.cost.statements,1);assert.equal(second.cost.mutations,0);
  assert.equal(reads,1);assert.equal(posts,2);
  assert.equal((await db.query('select slack_channel_post from scout.records where id=$1',[dev])).rows[0].slack_channel_post,null);
  const bytes=(await db.query("select pg_column_size(slack_channel_post) as bytes from scout.records where priority='high'")).rows.map(r=>r.bytes);
  t.diagnostic(JSON.stringify({mocked_slack:true,model_calls:0,history_reads:reads,first_cost:first.cost,idle_cost:second.cost,receipt_bytes:bytes}));
 }finally{await db.close();}
});

test('failed or incomplete history prevents posting pending findings',async()=>{
 const db=await database();try{
  const id=await seed(db),secret='sb_secret_notify_test',env={url:'https://example.supabase.co',secretKeys:{default:secret},publishableKeys:{},jwks:null};
  const connect=()=>({reserve:async()=>({unsafe:async(q,p=[])=>{const r=await db.query(q,p);return Object.assign(r.rows,{count:r.affectedRows??r.rows.length});},release(){}}),end:async()=>{}});
  for(const history of [{ok:false,error:'missing_scope'},{ok:true,messages:[],is_limited:true},{ok:true,messages:[],has_more:true}]){
   const response=await hostedNotify(new Request('https://example.test/notify?kind=unposted',{method:'POST',headers:{apikey:secret}}),{
    env,databaseURL:'unused',connect,slackToken:'xoxb-test',slackFetch:async()=>Response.json(history),post:()=>assert.fail('Incomplete posting evidence')
   });assert.equal(response.status,502);assert.equal((await db.query('select slack_channel_post from scout.records where id=$1',[id])).rows[0].slack_channel_post,null);
  }
  let pages=0;await assert.rejects(readPostedFindings('xoxb-test',{fetch:async()=>{pages++;return Response.json({ok:true,messages:[],has_more:true,response_metadata:{next_cursor:'same'}});}}),{reason:'slack_history_incomplete'});assert.equal(pages,2);
 }finally{await db.close();}
});

test('preview validation preserves microseconds and deadlines leave unattempted findings pending',async()=>{
 const db=await database();try{
  const id=await seed(db);await db.query("update scout.records set modified=array['2026-10-01T12:00:00.000001Z'::timestamptz] where id=$1",[id]);
  const preview=await prepareMessages(db,{kind:'findings',ids:[id]});
  await assert.rejects(sendMessages(db,preview,()=>assert.fail('Expired'),{now:()=>new Date(Date.parse(preview.prepared_at)+60001)}),/expired/);
  assert.equal((await sendMessages(db,preview,()=>assert.fail('Deadline passed'),{deadline:0})).error,'runtime_bound');
  assert.equal((await db.query('select slack_channel_post from scout.records where id=$1',[id])).rows[0].slack_channel_post,null);
  assert.equal((await sendMessages(db,preview,async()=>ack())).communicated,1);
  await db.query("update scout.records set modified=array['2026-10-01T12:00:00.000002Z'::timestamptz] where id=$1",[id]);
  await assert.rejects(sendMessages(db,preview,()=>assert.fail('Changed by one microsecond')),/changed/);
 }finally{await db.close();}
});

test('bot delivery keeps saved format and metadata, routes dev DMs and validates actual destinations',async()=>{
 const db=await database();try{
  assert.equal((await sendMessages(db,await prepareMessages(db),()=>assert.fail('Empty notification'))).status,'no_change');
  const ids=[];for(const priority of ['high','normal','low',null])ids.push((await db.query("insert into scout.records(description,priority,sources) values($1,$2,jsonb_build_array(jsonb_build_object('url','https://example.org/source','role','finding'))) returning id",[(priority??'Unassessed')+' finding',priority])).rows[0].id);
  const preview=await prepareMessages(db,{kind:'findings',ids}),sent=[];
  const post=botTransport('xoxb-test',async(url,options)=>{assert.equal(url,'https://slack.com/api/chat.postMessage');assert.equal(options.headers.Authorization,'Bearer xoxb-test');const payload=JSON.parse(options.body);sent.push(payload);return Response.json({ok:true,channel:payload.channel,ts:'1234567890.123456',message:{extra:'x'.repeat(5000)}});});
  assert.equal((await sendMessages(db,preview,post)).communicated,3);
  assert.deepEqual(sent.map(p=>[p.text,p.channel]).sort(),[['high finding · <https://example.org/source|Read more>',CHANNEL],['low finding · <https://example.org/source|Read more>',DM_CHANNEL],['normal finding · <https://example.org/source|Read more>',DM_CHANNEL]]);
  for(const payload of sent)assert.ok(ids.includes(payload.metadata.event_payload.record_id));
  const direct=await prepareMessages(db,{kind:'findings',ids:[ids[2]]});assert.equal((await sendMessages(db,direct,async()=>ack(CHANNEL))).status,'unknown');
  assert.equal((await db.query('select slack_channel_post from scout.records where id=$1',[ids[2]])).rows[0].slack_channel_post,null);
  assert.throws(()=>botTransport(undefined),{reason:'slack_configuration'});
 }finally{await db.close();}
});
