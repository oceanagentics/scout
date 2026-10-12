import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {processDocument} from '../collector/finding-jobs.js';
import {dateInterval,normalizeDate,findingInterval,dateLabel} from '../src/finding.js';
import {gemini} from '../collector/model.js';
import {database as boundary,hostedHSA} from '../collector/hosted-hsa.js';
import {correctFinding} from '../collector/corrections.js';

async function setup(cutover=true){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');create table auth.identities(user_id uuid,provider text,identity_data jsonb);
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;`);
 for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort().filter(n=>cutover||n<'20261009190000_scout_findings.sql'))
  await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 return db;
}
async function tracker(db){
 return (await db.query("insert into scout.trackers(name,url,collector,cadence) values('Fixture','https://example.org/list','web','6 hours') returning *")).rows[0];
}
async function enable(db){
 await db.exec("update scout.quota_policy set enabled=true,verified_until=now()+interval '1 hour',verified_rpm=15,verified_rpd=500,verified_tpm=250000,database_bytes=10000000,database_verified_until=now()+interval '1 hour'");
}
function driver(raw,inspect=()=>{}){
 return {unsafe:async(q,p=[])=>{inspect(q,p);const r=await raw.query(q,p);r.rows.count=r.affectedRows??r.rows.length;return r.rows;}};
}

const sourceFor=tr=>({tracker_id:tr.id,identity:'https://example.org/a',url:'https://example.org/a'});
const event={type:'event',title:'BBNJ implementation workshop',summary:'Discussion of the Clearing-House Mechanism.',priority:'high',relevance_reason:'Technical BBNJ Clearing-House design workshop (https://example.org/a).',organizations:[],dates:[],missing_information:[]};
const answer=(records=[event],follow_up_requests=[])=>({status:'found',records,follow_up_requests});
const due=db=>db.exec("update scout.source_state set due_at=clock_timestamp()-interval '1 second'");
const read=async()=>({status:200,body:'PRIVATE_SOURCE_BODY'});

test('one partial capture uses one generation, stores no traffic, and unchanged input uses no generation or finding write',async t=>{
 const raw=await setup();try{
  const tr=await tracker(raw);await enable(raw);const source=sourceFor(tr);let http=0;
  const db=boundary(driver(raw,(_q,p)=>assert.ok(!JSON.stringify(p).includes('PRIVATE_SOURCE_BODY'))));
  const model=gemini({apiKey:'test',ledger:db,fetch:async(url,options)=>{
   http++;assert.ok(url.endsWith(':generateContent'));
   const body=JSON.parse(options.body);assert.deepEqual(body.tools,[{urlContext:{}}]);assert.equal(body.store,false);
   assert.ok(body.contents[0].parts[0].text.includes('Technical ocean activity'));assert.ok(!options.body.includes('PRIVATE_SOURCE_BODY'));
   assert.ok(body.generationConfig.responseJsonSchema);
   return Response.json({usageMetadata:{promptTokenCount:400,toolUsePromptTokenCount:3500,candidatesTokenCount:500,totalTokenCount:4400},
    candidates:[{finishReason:'STOP',urlContextMetadata:{urlMetadata:[{retrievedUrl:source.url,urlRetrievalStatus:'URL_RETRIEVAL_STATUS_SUCCESS'}]},content:{parts:[{text:JSON.stringify(answer())}]}}]});
  }});
  const first=await processDocument(db,{source,read,model});assert.equal(first.state,'captured');assert.equal(first.created,1);assert.equal(http,1);
  const record=(await raw.query('select * from scout.records')).rows[0];assert.equal(record.completeness.state,'provisional');
  assert.equal((await raw.query('select input_tokens from scout.quota_reservations')).rows[0].input_tokens,3900);
  const initial={...db.metrics};await due(raw);
  assert.deepEqual(await processDocument(db,{source,read,model}),{state:'unchanged',created:0,changed:0});
  assert.equal(http,1);assert.equal(db.metrics.mutations-initial.mutations,2);
  assert.equal((await raw.query('select version from scout.records')).rows[0].version,record.version);
  t.diagnostic(JSON.stringify({mocked:true,first:initial,unchanged_mutations:2}));
 }finally{await raw.close();}
});

test('requested improvement updates the saved partial, while failed improvement leaves its record intact',async()=>{
 for(const broken of [false,true]){
  const db=await setup();try{
   const tr=await tracker(db),source=sourceFor(tr),support='https://example.org/programme';let calls=0;
   const model=async(prompt,input)=>{
    calls++;
    if(calls===1)return answer([event],[{url:support,question:'Who hosts the workshop and when does it start?'}]);
    assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,1);
    assert.deepEqual(input.requested_links,[{url:support,question:'Who hosts the workshop and when does it start?'}]);
    assert.ok(!JSON.stringify(input).includes('PRIVATE_SOURCE_BODY'));
    if(broken)throw Object.assign(new Error('provider_unavailable'),{reason:'provider_unavailable'});
    return answer([{...event,organizations:[{name:'Institute A',role:'host'}],dates:[{meaning:'event_start',date:'2026-10-22',time:'13:30',timezone:'UTC'}]}]);
   };
   const result=await processDocument(db,{source,read,model});assert.equal(calls,2);assert.equal(result.state,'captured');assert.equal(result.created,1);
   const rows=(await db.query('select * from scout.records')).rows;assert.equal(rows.length,1);
   if(broken){assert.equal(result.improvement,'pending');assert.deepEqual(rows[0].organizations,[]);}
   else{assert.equal(result.improvement,'improved');assert.equal(rows[0].details.start.utc,'2026-10-22T13:30:00.000Z');}
  }finally{await db.close();}
 }
});

test('source-side fetch failure does not block URL Context; malformed siblings and optional fields do not discard useful partials',async()=>{
 const db=await setup();try{
  const tr=await tracker(db),source=sourceFor(tr);
  const result=await processDocument(db,{source,read:async()=>{throw Error('reader blocked');},model:async()=>answer([
   null,{...event,title:'Long '.repeat(150),summary:'Description '.repeat(100),dates:[{meaning:'event_start',date:'2026-02-30'}]},
   {...event,type:'announcement',title:'Publication',organizations:[null,{name:'Institute A',role:null}]}])});
  assert.equal(result.captured,2);
  const rows=(await db.query('select * from scout.records')).rows;assert.equal(rows.length,2);
  assert.ok(rows.every(r=>r.title.length<=300&&r.description.length<=280));
  assert.equal(rows.find(r=>r.kind==='event').details.start,undefined);
 }finally{await db.close();}
});

test('refresh repairs model fields, preserves human corrections, and does not duplicate the source record',async()=>{
 const db=await setup();try{
  const tr=await tracker(db),source=sourceFor(tr);
  await processDocument(db,{source,read,model:async()=>answer()});
  let record=(await db.query('select * from scout.records')).rows[0];
  await correctFinding(db,{record_id:record.id,version:record.version,field:'organizations',value:[{name:'Human host',role:'host'}],url:source.url});
  await due(db);
  const result=await processDocument(db,{source,read:async()=>({body:'Updated page'}),model:async()=>answer([{...event,title:'Rephrased BBNJ workshop',organizations:[{name:'Wrong override',role:'host'}],dates:[{meaning:'event_start',date:'2026-10-22'}]}])});
  assert.equal(result.changed,1);assert.equal(result.created,0);
  record=(await db.query('select * from scout.records')).rows[0];assert.equal(record.organizations[0].name,'Human host');assert.equal(record.details.start.value,'2026-10-22');
 }finally{await db.close();}
});

test('failed inputs retry finitely, parked sources reopen on changes, and quota denial does not consume an attempt',async()=>{
 const db=await setup();try{
  const tr=await tracker(db),source=sourceFor(tr);let calls=0;
  const unavailable=()=>{calls++;throw Object.assign(new Error('url_unreadable'),{reason:'url_unreadable'});};
  for(let i=0;i<3;i++){await due(db);await processDocument(db,{source,read,model:unavailable});}
  await due(db);assert.equal((await processDocument(db,{source,read,model:unavailable})).state,'parked');assert.equal(calls,3);
  await due(db);assert.equal((await processDocument(db,{source,read:async()=>({body:'Changed page'}),model:async()=>answer()})).state,'captured');
  const next={...source,url:'https://example.org/b',identity:'b'};
  await processDocument(db,{source:next,read,model:()=>{throw Object.assign(new Error('quota'),{reason:'quota'});}});
  assert.equal((await db.query("select attempts from scout.source_state where identity='b'")).rows[0].attempts,0);
 }finally{await db.close();}
});

test('multiple same-kind developments save separately and repeated input preserves their IDs',async()=>{
 const db=await setup();try{
  const tr=await tracker(db),source=sourceFor(tr);
  const records=[event,{...event,title:'A different BBNJ workshop',dates:[{meaning:'event_start',date:'2026-12-01'}]}];
  assert.equal((await processDocument(db,{source,read,model:async()=>answer(records)})).created,2);
  const before=(await db.query('select id from scout.records order by id')).rows;
  await due(db);
  assert.equal((await processDocument(db,{source,read:async()=>({body:'Changed'}),model:async()=>answer(records)})).created,0);
  assert.deepEqual((await db.query('select id from scout.records order by id')).rows,before);
 }finally{await db.close();}
});

test('stale source lease prevents writes',async()=>{
 const db=await setup();try{
  const tr=await tracker(db),source=sourceFor(tr);
  const result=await processDocument(db,{source,read,model:async()=>{await db.exec('update scout.source_state set lease_id=gen_random_uuid()');return answer();}});
  assert.equal(result.reason,'stale_lease');assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,0);
 }finally{await db.close();}
});

test('typed dates preserve calendar precision, unknown zones and DST ambiguity',()=>{
  assert.deepEqual(dateInterval({value:'2024-02',precision:'month'}),['2024-02-01','2024-02-29']);
  assert.equal(dateInterval({value:'2026-02-30',precision:'day'}),null);
  assert.deepEqual(normalizeDate({value:'2026-10-15',precision:'day',time:'00:30',zone:'+08:00'}),
    {value:'2026-10-15',precision:'day',time:'00:30',zone:'+08:00',utc:'2026-10-14T16:30:00.000Z'});
  assert.equal(normalizeDate({value:'2026-11-01',precision:'day',time:'01:30',zone:'America/New_York'}).utc,undefined);
  assert.equal(normalizeDate({value:'2026-03-08',precision:'day',time:'02:30',zone:'America/New_York'}).utc,undefined);
  assert.equal(normalizeDate({value:'2026-10-15',precision:'day',time:'15:00',zone:'Europe/Paris'}).utc,'2026-10-15T13:00:00.000Z');
  assert.equal(normalizeDate({value:'2026-10-15',precision:'day',time:'15:00'}).utc,undefined);
  assert.throws(()=>normalizeDate({value:'2026-10',precision:'month',time:'12:00'}));
  for(const [zone,utc] of [['UTC','2028-02-29T23:59:59.000Z'],['Z','2028-02-29T23:59:59.000Z'],['+14:00','2028-02-29T09:59:59.000Z'],['-14:00','2028-03-01T13:59:59.000Z']])
    assert.equal(normalizeDate({value:'2028-02-29',precision:'day',time:'23:59:59',zone}).utc,utc);
  for(const time of ['3PM','15:0','24:00','23:59:60'])assert.throws(()=>normalizeDate({value:'2028-02-29',precision:'day',time}));
  for(const zone of ['CEST','UTC+02:00','+24:00'])assert.throws(()=>normalizeDate({value:'2028-02-29',precision:'day',time:'15:00',zone}));
  for(const date of [{value:'0000',precision:'year'},{value:'2028-13',precision:'month'},{value:'2028-02',precision:'day'}])assert.throws(()=>normalizeDate(date));
  assert.deepEqual(findingInterval({kind:'announcement',details:{published:{value:'2026-03',precision:'month'},effective:{value:'2027',precision:'year'}}}),['2026-03-01','2026-03-31']);
  assert.equal(dateLabel({value:'2026-03',precision:'month'}),'2026-03 · month precision');
});
