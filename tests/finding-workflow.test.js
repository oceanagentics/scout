import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {processDocument} from '../collector/finding-jobs.js';
import {dateInterval,normalizeDate,findingInterval,dateLabel} from '../src/finding.js';
import {gemini} from '../collector/model.js';
import {database as boundary,hostedHSA} from '../collector/hosted-hsa.js';
import {correctFinding} from '../collector/corrections.js';
import {fieldLabel} from '../src/records.js';

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
const answer=(records=[event],follow_up_requests)=>({status:'found',records,follow_up_requests});
const due=db=>db.exec("update scout.source_state set due_at=clock_timestamp()-interval '1 second'");
const read=async()=>({status:200,body:'PRIVATE_SOURCE_BODY'});

test('one partial capture reads only through the model and completed work stays closed until explicitly reopened',async t=>{
 const raw=await setup();try{
  const tr=await tracker(raw);await enable(raw);const source=sourceFor(tr);let http=0;
  const db=boundary(driver(raw,(_q,p)=>assert.ok(!JSON.stringify(p).includes('PRIVATE_SOURCE_BODY'))));
  const model=gemini({apiKey:'test',ledger:db,fetch:async(url,options)=>{
   http++;assert.ok(url.endsWith(':generateContent'));
   const body=JSON.parse(options.body);assert.deepEqual(body.tools,[{urlContext:{}}]);assert.equal(body.store,false);
   assert.ok(body.contents[0].parts[0].text.includes('Technical ocean activity'));assert.ok(!options.body.includes('PRIVATE_SOURCE_BODY'));
   assert.ok(body.generationConfig.responseJsonSchema);
   return Response.json({usageMetadata:{promptTokenCount:400,toolUsePromptTokenCount:3500,candidatesTokenCount:500,totalTokenCount:4400},
    candidates:[{finishReason:'STOP',urlContextMetadata:{urlMetadata:[{retrievedUrl:source.url,urlRetrievalStatus:'URL_RETRIEVAL_STATUS_SUCCESS'}]},content:{parts:[{text:JSON.stringify(answer([{...event,organizations:[{name:'Institute B'},{name:'Institute A',role:'uncertain'}]}]))}]}}]});
  }});
  let reads=0;
  const options={source,read:async()=>{reads++;return read();},model};
  const first=await processDocument(db,options);assert.equal(first.state,'captured');assert.equal(first.created,1);assert.equal(http,1);assert.equal(reads,0);
  const record=(await raw.query('select * from scout.records')).rows[0];assert.equal(record.completeness.state,'provisional');
  assert.deepEqual(record.organizations,[{name:'Institute B'},{name:'Institute A'}]);
  assert.equal(fieldLabel(record,'organization'),'Institute B; Institute A');
  assert.equal((await raw.query(`select count(*)::int n from scout.records where organizations @> '[{"name":"Institute A"}]'`)).rows[0].n,1);
  assert.equal((await raw.query('select input_tokens from scout.quota_reservations')).rows[0].input_tokens,3900);
  const initial={...db.metrics};await due(raw);
  assert.deepEqual(await processDocument(db,options),{state:'complete',created:0,changed:0});
  assert.equal(http,1);assert.equal(db.metrics.mutations-initial.mutations,2);
  assert.equal((await raw.query('select version from scout.records')).rows[0].version,record.version);
  const retained=(await raw.query('select octet_length(research::text) research_bytes from scout.source_state')).rows[0];
  t.diagnostic(JSON.stringify({mocked:true,first:initial,repeat_mutations:2,...retained}));
 }finally{await raw.close();}
});

test('manual URL intake preserves an existing source and uses Gemini-requested links without local source reads',async()=>{
 const rotation=false;
  const raw=await setup();try{
   const tr=await tracker(raw);await enable(raw);
   await raw.query('update scout.trackers set enabled=true where id=$1',[tr.id]);
   await raw.query("insert into scout.source_state(tracker_id,identity,url) values($1,'tracker',$2)",[tr.id,tr.url]);
   const secret='sb_secret_url_intake_test',support='https://example.org/registration';let calls=0,reads=0;
   const session={...driver(raw),release(){}},options={databaseURL:'unused',apiKey:'test',
    env:{url:'https://example.supabase.co',secretKeys:{default:secret},publishableKeys:{default:'sb_publishable_test'},jwks:null},
    connect:()=>({reserve:async()=>session,end:async()=>{}}),read:async()=>{reads++;return read();},
    modelFetch:async(_url,request)=>{
     calls++;const body=JSON.parse(request.body);assert.deepEqual(body.tools,[{urlContext:{}}]);
     const parts=body.contents[0].parts;assert.ok(parts[0].text.includes(tr.url));
     if(calls===1)assert.equal(parts.length,1);
     else assert.deepEqual(JSON.parse(parts[1].text).requested_links,[{url:support,question:'When is the workshop?'}]);
     const output=calls===1?answer([event],[{url:support,question:'When is the workshop?'}]):
      answer([{...event,dates:[{meaning:'event_start',date:'2026-10-29'}]}]);
     return Response.json({usageMetadata:{promptTokenCount:400,toolUsePromptTokenCount:1000,candidatesTokenCount:300,totalTokenCount:1700},
      candidates:[{finishReason:'STOP',urlContextMetadata:{urlMetadata:[{retrievedUrl:calls===1?tr.url:support,urlRetrievalStatus:'URL_RETRIEVAL_STATUS_SUCCESS'}]},content:{parts:[{text:JSON.stringify(output)}]}}]});
    }};
   const query=rotation?'next=true':new URLSearchParams({tracker_id:tr.id,source_url:tr.url});
   const result=await hostedHSA(new Request('https://example.org?'+query,{method:'POST',headers:{apikey:secret}}),options);
   assert.equal(result.status,200);const output=await result.json();assert.equal(output.state,'captured');assert.equal(output.created,1);assert.equal(output.changed,1);
   assert.equal(calls,2);assert.equal(reads,0);
   const records=(await raw.query('select * from scout.records')).rows;assert.equal(records.length,1);assert.equal(records[0].details.start.value,'2026-10-29');
   const state=(await raw.query("select * from scout.source_state where tracker_id=$1 and identity='tracker'",[tr.id])).rows[0];
   assert.equal(state.processed_hash,null);assert.equal(state.observed_hash,null);assert.equal(state.research.main,undefined);
   assert.deepEqual(state.research.supports,[{url:support,question:'When is the workshop?'}]);
  }finally{await raw.close();}
});

test('requested improvement updates the saved partial, while failed improvement leaves its record intact',async t=>{
 for(const outcome of ['improved','failed','unresolved']){
  const db=await setup();try{
   const tr=await tracker(db),source=sourceFor(tr),support='https://example.org/programme',measured=boundary(driver(db));let calls=0,firstId;
   const model=async(prompt,input)=>{
    calls++;
    if(calls===1)return answer([event],[null,{url:support,question:'Who hosts the workshop and when does it start?'}]);
    const first=(await db.query('select * from scout.records')).rows;assert.equal(first.length,1);firstId=first[0].id;
    await correctFinding(db,{record_id:firstId,version:first[0].version,field:'organizations',value:[{name:'Human institute'}],url:source.url});
    assert.deepEqual(input.requested_links,[{url:support,question:'Who hosts the workshop and when does it start?'}]);
    assert.ok(!JSON.stringify(input).includes('PRIVATE_SOURCE_BODY'));
    if(outcome==='failed')throw Object.assign(new Error('provider_unavailable'),{reason:'provider_unavailable',dispatched:true});
    return answer([{...event,organizations:[{name:'Institute A'}],dates:[{meaning:'event_start',date:'2026-10-22',time:'13:30',timezone:'UTC'}]}],
     outcome==='unresolved'?[{url:null,question:'Can non-members attend?'}]:[]);
   };
   const result=await processDocument(measured,{source,read,model});assert.equal(calls,2);assert.equal(result.state,'captured');assert.equal(result.created,1);
   const rows=(await db.query('select * from scout.records')).rows;assert.equal(rows.length,1);assert.equal(rows[0].id,firstId);
   assert.deepEqual(rows[0].organizations,[{name:'Human institute'}]);
   assert.equal(result.improvement,outcome==='improved'?'improved':'exhausted');
   if(outcome==='failed')assert.equal(rows[0].details.start,undefined);
   else assert.equal(rows[0].details.start.utc,'2026-10-22T13:30:00.000Z');
   if(outcome==='unresolved'){assert.equal(result.reason,'research_exhausted');assert.match(result.research.note,/non-members/);}
   t.diagnostic(JSON.stringify({mocked:true,improvement:result.improvement,collector:measured.metrics,research_bytes:(await db.query('select octet_length(research::text) n from scout.source_state')).rows[0].n}));
   await due(db);
   assert.equal((await processDocument(db,{source,read,model})).state,outcome==='improved'?'complete':'parked');assert.equal(calls,2);
   if(outcome==='failed'){
    await db.exec("update scout.source_state set attempts=0,state='due',due_at=clock_timestamp()");
    const reopened=await processDocument(db,{source,model:async()=>{calls++;return answer();}});
    assert.equal(reopened.state,'captured');assert.equal(reopened.created,0);assert.equal(calls,3);
   }
  }finally{await db.close();}
 }
});

test('absent, declined, or malformed optional research completes a partial without more calls or pending work',async()=>{
 for(const fields of [{},{further_research:false},{further_research:null,follow_up_requests:null,note:null},
  {further_research:'unknown',follow_up_requests:[null,{url:'https://example.org/programme',question:null}],note:42}]){
  const db=await setup();try{
   const source=sourceFor(await tracker(db));let calls=0,reads=0;
   const model=async()=>{calls++;return {...answer(),...fields};},reader=async()=>{reads++;return read();};
   const result=await processDocument(db,{source,read:reader,model});
   assert.equal(result.state,'captured');assert.equal(result.created,1);assert.equal(result.reason,undefined);assert.equal(result.improvement,'not_requested');
   const state=(await db.query('select state,reason from scout.source_state')).rows[0];assert.deepEqual(state,{state:'complete',reason:null});
   const before=(await db.query('select id,version from scout.records')).rows;
   await due(db);assert.deepEqual(await processDocument(db,{source,read:reader,model}),{state:'complete',created:0,changed:0});
   assert.equal(calls,1);assert.equal(reads,0);assert.deepEqual((await db.query('select id,version from scout.records')).rows,before);
  }finally{await db.close();}
 }
});

test('a research question without a URL preserves the partial, exposes pending work, and requires reconsideration',async()=>{
 for(const url of [undefined,null]){
  const db=await setup();try{
   const source=sourceFor(await tracker(db));let calls=0,reads=0;
   const model=async()=>{calls++;return answer([event],[{url,question:'What does participation in this workshop involve?'}]);},reader=async()=>{reads++;return read();};
   const result=await processDocument(db,{source,read:reader,model});assert.equal(result.state,'captured');assert.equal(result.reason,'research_source_missing');assert.equal(calls,1);assert.equal(reads,0);
   const before=(await db.query('select id,version from scout.records')).rows;
   for(let i=0;i<4;i++){await due(db);assert.equal((await processDocument(db,{source,read:reader,model})).state,'parked');}
   assert.equal(calls,1);assert.deepEqual((await db.query('select id,version from scout.records')).rows,before);
   assert.equal((await db.query('select * from scout.finding_jobs()')).rows.length,0);
   await db.query('insert into auth.users(id) values($1)',[source.tracker_id]);
   await db.query("insert into auth.identities values($1,'google',$2)",[source.tracker_id,{iss:'https://accounts.google.com',email_verified:true,custom_claims:{hd:'oceanagentics.com'}}]);
   await db.query("select set_config('request.jwt.claim.sub',$1,false)",[source.tracker_id]);
   await db.exec('set role authenticated');const jobs=(await db.query('select * from scout.finding_jobs()')).rows;await db.exec('reset role');
   assert.equal(jobs.length,1);assert.match(jobs[0].reopen_when,/explicitly/);
   assert.match(jobs[0].explanation,/participation.*No useful linked source/);
   // Existing administrative/correction reset deliberately reconsiders unchanged input.
   await db.exec("update scout.source_state set processed_hash=null,attempts=0,state='due',due_at=clock_timestamp()");
   assert.equal((await processDocument(db,{source,read:reader,model:async()=>{calls++;return answer();}})).state,'captured');assert.equal(calls,2);
   assert.deepEqual((await db.query('select id,version from scout.records')).rows,before);
  }finally{await db.close();}
 }
});

test('malformed siblings and optional fields do not discard useful URL findings',async()=>{
 const db=await setup();try{
  const tr=await tracker(db),source=sourceFor(tr);
  const result=await processDocument(db,{source,model:async()=>answer([
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
  await correctFinding(db,{record_id:record.id,version:record.version,field:'organizations',value:[{name:'Human institute'},{name:'Second institute'}],url:source.url});
  await due(db);
  const result=await processDocument(db,{source,model:async()=>answer([{...event,title:'Rephrased BBNJ workshop',organizations:[{name:'Wrong override'}],dates:[{meaning:'event_start',date:'2026-10-22'}]}])});
  assert.equal(result.changed,1);assert.equal(result.created,0);
  record=(await db.query('select * from scout.records')).rows[0];assert.deepEqual(record.organizations,[{name:'Human institute'},{name:'Second institute'}]);assert.equal(record.details.start.value,'2026-10-22');
 }finally{await db.close();}
});

test('failed inputs retry finitely, parked sources require an explicit reset, and quota denial does not consume an attempt',async()=>{
 const db=await setup();try{
  const tr=await tracker(db),source=sourceFor(tr);let calls=0;
  const unavailable=()=>{calls++;return {...answer([]),status:'unreadable',_diagnostics:{model_status:'unreadable'}};};
  for(let i=0;i<3;i++){await due(db);await processDocument(db,{source,read,model:unavailable});}
  await due(db);const parked=await processDocument(db,{source,read,model:unavailable});assert.equal(parked.state,'parked');assert.equal(parked.reason,'model_unreadable');assert.equal(calls,3);
  await due(db);assert.equal((await processDocument(db,{source,read:async()=>({body:'Changed page'}),model:unavailable})).state,'parked');assert.equal(calls,3);
  await db.exec("update scout.source_state set attempts=0,state='due',due_at=clock_timestamp()");
  assert.equal((await processDocument(db,{source,model:async()=>answer()})).state,'captured');
  const next={...source,url:'https://example.org/b',identity:'b'};
  await processDocument(db,{source:next,read,model:()=>{throw Object.assign(new Error('quota'),{reason:'quota'});}});
  assert.equal((await db.query("select attempts from scout.source_state where identity='b'")).rows[0].attempts,0);
 }finally{await db.close();}
});

test('multiple same-kind developments save separately and repeated input preserves their IDs',async()=>{
 const db=await setup();try{
  const tr=await tracker(db),source=sourceFor(tr);
  const records=[event,{...event,title:'A different BBNJ workshop',dates:[{meaning:'event_start',date:'2026-12-01'}]},event];
  assert.equal((await processDocument(db,{source,read,model:async()=>answer(records)})).created,2);
  const before=(await db.query('select id from scout.records order by id')).rows;
  await db.exec("update scout.source_state set attempts=0,state='due',due_at=clock_timestamp()");
  assert.equal((await processDocument(db,{source,model:async()=>answer(records)})).created,0);
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
