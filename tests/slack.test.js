import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {readRecords,eligibleRecords,prepareMessage,sendMessage,webhookTransport} from '../notifications/slack.js';

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
const select=async (_question,input)=>input.candidates.slice(0,input.kind==='digest'?5:1)
  .map(r=>({id:r.id,summary:'New BBNJ Clearing-House data standards are available.',relevance:'These standards inform Ocean Agentics’ ChM implementation.'}));

test('discoveries are fresh and announced once; digests contain only dated upcoming events',()=>{
 const records=Array.from({length:8},(_,i)=>({id:String(i),kind:'event',priority:i===7?'high':'normal',starts_at:'2026-10-03T12:00:00Z',updated_at:'2026-10-01T00:00:00Z',discovered_at:'2026-10-01T00:00:00Z'}));
 assert.equal(eligibleRecords(records,{kind:'digest',from:'2026-10-01',through:'2026-10-08',now})[0].id,'7');
 assert.deepEqual(eligibleRecords(records,{now}).map(r=>r.id),['7']);
 const correction={...records[0],priority:'low',status:'cancelled',last_communicated_at:'2026-09-01T00:00:00Z'};
 assert.equal(eligibleRecords([correction],{now}).length,0);
 assert.equal(eligibleRecords([correction],{kind:'digest',from:'2026-10-01',through:'2026-10-08',now}).length,0);
 assert.equal(eligibleRecords([{...records[0],priority:null}],{now}).length,0);
 const reminder={...records[7],last_communicated_at:'2026-09-30T00:00:00Z',updated_at:'2026-09-29T00:00:00Z'};
 for(const record of [reminder,{...records[7],discovered_at:'2026-09-29T00:00:00Z',updated_at:now.toISOString()},
   {...records[7],discovered_at:undefined},{...records[7],discovered_at:'2026-10-02T00:00:00Z'},
   {...records[7],starts_at:'2026-09-30T12:00:00Z'}])assert.equal(eligibleRecords([record],{now}).length,0);
 for(const record of [{...records[7],starts_at:null},{...records[7],starts_at:'2026-09-30T12:00:00Z',ends_at:'2026-10-03T12:00:00Z'},
   correction,{...records[7],starts_at:'2026-11-01T00:00:00Z'}])
   assert.equal(eligibleRecords([record],{kind:'digest',from:'2026-10-01',through:'2026-10-08',now}).length,0);
});

test('ephemeral previews use agent recency judgment, stamp only confirmed included versions, and never retry uncertainty',async()=>{
 const db=await database();
 try {
  const tracker=(await db.query('select id from scout.trackers limit 1')).rows[0].id;
  for(let i=0;i<7;i++){
   const row=(await db.query("insert into scout.records(kind,title,identity_key,priority) values('announcement',$1,$1,'high') returning id",[`Technical standards update ${i}`])).rows[0];
   await db.query("insert into scout.evidence(record_id,tracker_id,url,content_hash,content,last_seen_at,parsed) values($1,$2,$3,$3,'Public evidence',clock_timestamp(),jsonb_build_object('assessment',jsonb_build_object('state','complete','priority','high','priority_accepted',true,'reason','New BBNJ ChM data standards','accepted_at',clock_timestamp())))",[row.id,tracker,`https://example.org/${i}`]);
  }
  const asOf=new Date(Date.now()+1000);
  const preview=await prepareMessage(db,{model:select,now:asOf});
  assert.equal(preview.records.length,1);assert.match(preview.payload.text,/inform Ocean Agentics/);
  assert.doesNotMatch(preview.payload.text,/Unknown|Not applicable|Priority:|Organization:|Updated:|Status:/);
  assert.match(JSON.stringify(preview.payload),/bbnj-scout.web.app\/\?record=/);
  let posts=0;
  const unknown=await sendMessage(db,preview,async()=>{posts++;throw new Error('timeout');},{now:()=>asOf});
  assert.equal(unknown.status,'unknown');assert.equal(posts,1);
  assert.equal((await db.query('select count(*)::int n from scout.records where last_communicated_at is not null')).rows[0].n,0);
  const before=(await db.query('select id,updated_at from scout.records order by id')).rows;
  const sent=await sendMessage(db,preview,async()=>({status:200,body:'ok'}),{now:()=>asOf});
  assert.equal(sent.communicated,1);
  assert.deepEqual((await db.query('select id,updated_at from scout.records order by id')).rows,before);
  const next=await prepareMessage(db,{model:select,now:asOf});assert.equal(next.records.length,1);assert.notEqual(next.records[0].id,preview.records[0].id);
  await assert.rejects(sendMessage(db,preview,async()=>{throw new Error('must not send');},{now:()=>asOf}),/changed/);
  await db.query("update scout.records set title='Material correction' where id=$1",[next.records[0].id]);
  await assert.rejects(sendMessage(db,next,async()=>{throw new Error('must not send');},{now:()=>asOf}),/changed/);
  const skipped=await prepareMessage(db,{model:async()=>[],now:asOf});assert.equal(skipped.payload,null);
  for(const invalid of [[{id:'invented',summary:'Update',relevance:'Relevant'}],[{id:next.records[0].id,summary:'',relevance:'Relevant'}],
    [{id:next.records[0].id,summary:'a'.repeat(281),relevance:'Relevant'}],[{id:next.records[0].id,summary:'Read https://example.org',relevance:'Relevant'}],
    [null],await select('',{kind:'digest',candidates:next.records.concat(preview.records)})])
    await assert.rejects(prepareMessage(db,{model:async()=>invalid,now:asOf}),/selection/);
 }finally{await db.close();}
});

test('only the confirmed Scout webhook binding is accepted',()=>{
 for(const url of ['https://hooks.slack.com/services/OTHER/B0C5TEK4R38/token','https://hooks.slack.com/services/TFZ8FRLBV/OTHER/token','http://hooks.slack.com/services/TFZ8FRLBV/B0C5TEK4R38/token','https://user:secret@hooks.slack.com/services/TFZ8FRLBV/B0C5TEK4R38/token']) assert.throws(()=>webhookTransport(url));
 assert.equal(typeof webhookTransport('https://hooks.slack.com/services/TFZ8FRLBV/B0C5TEK4R38/fixture'),'function');
});

test('source evidence grounds copy; corroboration cannot refresh discoveries and empty digests remain silent',async()=>{
 const db=await database();try{
  const tracker=(await db.query('select id from scout.trackers limit 1')).rows[0].id;
  const event=(await db.query("insert into scout.records(kind,title,description,priority,starts_at,registration_url) values('event','BBNJ ChM implementation workshop','A workshop on BBNJ ChM data standards.','high',$1,'https://example.org/register') returning id",[new Date(Date.now()+86400000).toISOString()])).rows[0].id;
  const capture=(await db.query("insert into scout.evidence(tracker_id,url,content_hash,content,last_seen_at,published_on) values($1,'https://example.org/workshop','capture','Source',clock_timestamp(),'2026-09-01') returning id",[tracker])).rows[0].id;
  const parsed={assessment:{state:'complete',priority:'high',priority_accepted:true,reason:'Technical BBNJ ChM implementation.',accepted_at:new Date().toISOString()},
    document:{capture_id:capture},finding:{citations:[{doc:'P',quote:'A workshop on BBNJ ChM data standards.'}]}};
  await db.query("insert into scout.evidence(record_id,tracker_id,url,content_hash,content,last_seen_at,collected_at,parsed) values($1,$2,'https://example.org/workshop','first','Source',clock_timestamp(),clock_timestamp()-interval '3 days',$3)",[event,tracker,JSON.stringify(parsed)]);
  const asOf=new Date(Date.now()+1000),before=(await readRecords(db))[0].discovered_at;
  await db.query("insert into scout.evidence(record_id,tracker_id,url,content_hash,content,last_seen_at,parsed) values($1,$2,'https://example.org/repost','second','Source',clock_timestamp(),$3)",[event,tracker,JSON.stringify(parsed)]);
  assert.equal((await readRecords(db))[0].discovered_at,before);
  assert.equal((await prepareMessage(db,{now:asOf,model:()=>{throw Error('Old finding must not reach model');}})).payload,null);
  const from=asOf.toISOString().slice(0,10),through=new Date(asOf.getTime()+7*86400000).toISOString().slice(0,10);
  const preview=await prepareMessage(db,{kind:'digest',from,through,now:asOf,model:async(_instruction,input,schema)=>{
    assert.equal(schema.maxItems,5);assert.equal(input.candidates.length,1);
    assert.deepEqual(input.candidates[0].sources[0].finding.citations,parsed.finding.citations);
    assert.equal(input.candidates[0].sources[0].published_on,'2026-09-01');
    return [{id:event,summary:'A workshop on BBNJ ChM data standards.',relevance:'It addresses technical ChM implementation.'}];
  }});
  assert.match(preview.payload.text,/Upcoming events/);assert.match(preview.payload.text,/Register/);
  assert.match(preview.payload.text,/Source/);assert.doesNotMatch(preview.payload.text,/Unknown|Priority:|Updated:/);
  const declined=await prepareMessage(db,{kind:'digest',from,through,now:asOf,model:async()=>[]});
  assert.equal(declined.payload,null);assert.equal((await sendMessage(db,declined,()=>{throw Error('Empty digest must not post');})).status,'no_change');
  await db.query("update scout.records set starts_at=null where id=$1",[event]);
  assert.equal((await prepareMessage(db,{kind:'digest',from,through,now:asOf,model:()=>{throw Error('Undated event must not reach model');}})).payload,null);
 }finally{await db.close();}
});

test('scheduled delivery persists ambiguous intent and excludes the same version across later invocations',async()=>{
 const {hostedHSA}=await import('../collector/hosted-hsa.js'),db=await database();
 try{
  const tracker=(await db.query('select id from scout.trackers limit 1')).rows[0].id;
  const record=(await db.query("insert into scout.records(kind,title,priority) values('announcement','New technical ocean data standard','high') returning id")).rows[0].id;
  await db.query("insert into scout.evidence(record_id,tracker_id,url,content_hash,content,last_seen_at,parsed) values($1,$2,'https://example.org/source','fixture','Public evidence',clock_timestamp(),jsonb_build_object('assessment',jsonb_build_object('state','complete','accepted_at',clock_timestamp())))",[record,tracker]);
  const secret='sb_secret_scout_test_only',env={url:'https://example.supabase.co',secretKeys:{default:secret},publishableKeys:{default:'sb_publishable_test_only'},jwks:null};
  const connect=()=>({reserve:async()=>({unsafe:async(q,p=[])=>/pg_try_advisory_lock|pg_advisory_unlock/.test(q)?[{acquired:true}]:(await db.query(q,p)).rows,release(){}}),end:async()=>{}});
  let posts=0,calls=0;
  const invoke=()=>hostedHSA(new Request('https://example.test?notify=true',{method:'POST',headers:{apikey:secret}}),{
    env,databaseURL:'unused',apiKey:'fixture',connect,post:async()=>{posts++;throw new Error('Lost response');},
    modelFetch:async url=>{
      if(url.endsWith(':countTokens'))return Response.json({totalTokens:100});
      calls++;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify([{id:record,summary:'New BBNJ ChM data standards.',relevance:'These inform Ocean Agentics’ implementation.'}])}]}}]});
    }});
  const first=await (await invoke()).json();
  assert.equal(first.status,'unknown',JSON.stringify({first,calls,runs:(await db.query('select stats from scout.collection_runs')).rows}));
  const delivery=(await db.query("select stats->'delivery' delivery from scout.collection_runs where stats->>'purpose'='notification'")).rows[0].delivery;
  assert.equal(delivery.status,'unknown');assert.equal(delivery.records[0].id,record);
  assert.equal((await (await invoke()).json()).status,'no_change');assert.equal(posts,1);assert.equal(calls,1);
  assert.equal((await db.query('select last_communicated_at from scout.records where id=$1',[record])).rows[0].last_communicated_at,null);
  await db.query("update scout.collection_runs set stats=jsonb_set(stats,'{delivery,status}','\"sent\"') where stats#>>'{delivery,status}'='unknown'");
  assert.equal((await (await invoke()).json()).status,'no_change');assert.equal(posts,1);assert.equal(calls,1);
 }finally{await db.close();}
});
