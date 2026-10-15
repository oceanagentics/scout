import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {processDocument} from '../collector/finding-jobs.js';
import {dateInterval,normalizeDate,findingInterval,dateLabel} from '../src/finding.js';
import {trackerModel} from '../collector/model-gateway.js';
import {database as boundary,hostedHSA} from '../collector/hosted-hsa.js';
import {correctFinding} from '../collector/corrections.js';

async function setup(){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');create table auth.identities(user_id uuid,provider text,identity_data jsonb);
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;`);
 for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())
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
const event={description:'BBNJ implementation workshop',type:'event',priority:'high',organizations:[],date:'2026',starttime:null,timezone:null};
const answer=(records=[event])=>({status:'found',records});
const due=db=>db.exec("update scout.source_state set due_at=clock_timestamp()-interval '1 second'");
const read=async()=>({status:200,body:'PRIVATE_SOURCE_BODY'});

test('new events without starts prompt the model directly, enrich saved IDs, and preserve corrections',async t=>{
 const raw=await setup();try{
  const tr=await tracker(raw);await enable(raw);const source=sourceFor(tr),support='https://example.org/programme';let http=0,ids;
  const db=boundary(driver(raw,(_q,p)=>assert.ok(!JSON.stringify(p).includes('PRIVATE_SOURCE_BODY'))));
  const model=trackerModel({apiKey:'test',ledger:db,source,fetch:async(url,options)=>{
   http++;assert.ok(url.endsWith(':generateContent'));
   const body=JSON.parse(options.body);assert.deepEqual(body.tools,[{urlContext:{}}]);assert.equal(body.store,false);
   let output=answer(['First workshop','Second workshop'].map(description=>({...event,description,date:null,deadline:'2026-10-01'})));
   if(http===2){
    const saved=(await raw.query('select * from scout.records order by title')).rows;ids=saved.map(r=>r.id);
    assert.ok(saved.every(r=>!r.details.start));assert.match(body.contents[0].parts[0].text,/When is this event scheduled\?/);
    await correctFinding(raw,{record_id:ids[0],version:saved[0].version,field:'details.start',value:{value:'2026-10-23',precision:'day'},url:source.url});
    const input=JSON.parse(body.contents[0].parts[1].text);assert.equal(input.records.length,2);assert.equal(input.search_results,undefined);assert.equal(input.requested_links[0].url,source.url);
    output=answer(input.records.map(r=>({...event,description:'Unwanted description change',record_id:r.record_id,date_source_url:support,date:'2026-10-22'})));
   }
   return Response.json({usageMetadata:{promptTokenCount:400,toolUsePromptTokenCount:3500,candidatesTokenCount:500,totalTokenCount:4400},
    candidates:[{finishReason:'STOP',urlContextMetadata:{urlMetadata:[{retrievedUrl:http===1?source.url:support,urlRetrievalStatus:'URL_RETRIEVAL_STATUS_SUCCESS'}]},content:{parts:[{text:JSON.stringify(output.records)}]}}]});
  }});
  let reads=0;
  const options={source,read:async()=>{reads++;return read();},model};
  const first=await processDocument(db,options);assert.equal(first.created,2);assert.equal(first.changed,1);assert.equal(first.improvement,'improved');assert.equal(http,2);assert.equal(reads,0);
  const records=(await raw.query('select * from scout.records order by title')).rows;
  assert.deepEqual(records.map(r=>r.id),ids);assert.deepEqual(records.map(r=>r.details.start.value),['2026-10-23','2026-10-22']);
  assert.ok(records.every(r=>r.details.response_due.value==='2026-10-01'));
  assert.ok(records.every(r=>r.sources.some(s=>s.url===support)));assert.equal(records[0].title,'First workshop');
  const initial={...db.metrics};await due(raw);
  assert.deepEqual(await processDocument(db,options),{state:'complete',created:0,changed:0});
  assert.equal(http,2);assert.equal(db.metrics.mutations-initial.mutations,2);
  assert.deepEqual((await raw.query('select id,version from scout.records order by title')).rows,records.map(({id,version})=>({id,version})));
  const retained=(await raw.query('select octet_length(research::text) research_bytes from scout.source_state')).rows[0];
  t.diagnostic(JSON.stringify({mocked:true,first:initial,repeat_mutations:2,...retained}));
 }finally{await raw.close();}
});

test('manual URL intake maps a flat record and preserves the existing source without local reads',async()=>{
 const raw=await setup();try{
  const tr=await tracker(raw);await enable(raw);
  await raw.query('update scout.trackers set enabled=true where id=$1',[tr.id]);
  await raw.query("insert into scout.source_state(tracker_id,identity,url) values($1,'tracker',$2)",[tr.id,tr.url]);
  const secret='sb_secret_url_intake_test';let calls=0,reads=0;
  const session={...driver(raw),release(){}},options={databaseURL:'unused',apiKey:'test',
   env:{url:'https://example.supabase.co',secretKeys:{default:secret},publishableKeys:{default:'sb_publishable_test'},jwks:null},
   connect:()=>({reserve:async()=>session,end:async()=>{}}),read:async()=>{reads++;return read();},
   modelFetch:async(_url,request)=>{
    calls++;const body=JSON.parse(request.body);assert.deepEqual(body.tools,[{urlContext:{}}]);
    assert.ok(body.contents[0].parts[0].text.includes(tr.url));assert.equal(body.contents[0].parts.length,1);
    assert.ok(body.contents[0].parts[0].text.includes('Current date (UTC): '+new Date().toISOString().slice(0,10)+'.'));
    assert.match(body.contents[0].parts[0].text,/Inspect every image on the page/);
    assert.match(body.contents[0].parts[0].text,/description \(alt text\), and caption/);
    return Response.json({usageMetadata:{promptTokenCount:400,toolUsePromptTokenCount:1000,candidatesTokenCount:300,totalTokenCount:1700},
     candidates:[{finishReason:'STOP',urlContextMetadata:{urlMetadata:[{retrievedUrl:tr.url,urlRetrievalStatus:'URL_RETRIEVAL_STATUS_SUCCESS'}]},
      content:{parts:[{text:JSON.stringify([{...event,organizations:['Institute A'],date:'2026-10-29',starttime:'13:30',timezone:'UTC'}])}]}}]});
   }};
  const query=new URLSearchParams({tracker_id:tr.id,source_url:tr.url});
  const response=await hostedHSA(new Request('https://example.org?'+query,{method:'POST',headers:{apikey:secret}}),options);
  assert.equal(response.status,200);const output=await response.json();assert.equal(output.state,'captured');assert.equal(output.created,1);
  assert.equal(calls,1);assert.equal(reads,0);
  const records=(await raw.query('select * from scout.records')).rows;assert.equal(records.length,1);
  assert.equal(records[0].title,event.description);assert.equal(records[0].description,event.description);
  assert.equal(records[0].priority,'high');assert.deepEqual(records[0].organizations,[{name:'Institute A'}]);
  assert.equal(records[0].details.start.utc,'2026-10-29T13:30:00.000Z');assert.ok(records[0].sources.some(s=>s.url===tr.url));
  const state=(await raw.query("select * from scout.source_state where tracker_id=$1 and identity='tracker'",[tr.id])).rows[0];
  assert.equal(state.processed_hash,null);assert.equal(state.observed_hash,null);assert.deepEqual(state.research.supports,[]);
 }finally{await raw.close();}
});

test('any missing date, time or timezone triggers one follow-up; complete events and announcements do not',async()=>{
 for(const missing of ['date','starttime','timezone',null,'announcement']){
  const db=await setup();try{
   const source=sourceFor(await tracker(db)),complete={...event,date:'2026-10-22',starttime:'13:30',timezone:'UTC'};
   const record=missing==='announcement'?{...event,type:'announcement',date:null}:missing?{...complete,[missing]:null}:complete;
   const needsResearch=missing!==null&&missing!=='announcement';let calls=0,savedId;
   const model=async(prompt,input)=>{
    if(++calls===1)return answer([record]);
    savedId=(await db.query('select id from scout.records')).rows[0].id;
    assert.match(prompt,/missing date, time or timezone/);assert.equal(input.records[0].record_id,savedId);
    return {...answer([{...complete,record_id:savedId,date_source_url:source.url}]),
     _retrieval:[{url:source.url,status:'URL_RETRIEVAL_STATUS_SUCCESS'}]};
   };
   const result=await processDocument(db,{source,model});
   assert.equal(result.state,'captured');assert.equal(result.created,1);assert.equal(result.improvement,needsResearch?'improved':'not_requested');
   const saved=(await db.query('select * from scout.records')).rows[0];
   if(needsResearch){assert.equal(saved.id,savedId);assert.equal(saved.details.start.utc,'2026-10-22T13:30:00.000Z');}
   const before=(await db.query('select id,version from scout.records')).rows;
   await due(db);assert.deepEqual(await processDocument(db,{source,model}),{state:'complete',created:0,changed:0});
   assert.equal(calls,needsResearch?2:1);assert.deepEqual((await db.query('select id,version from scout.records')).rows,before);
  }finally{await db.close();}
 }
});

test('failed, unknown, uncited and foreign-record scheduling results preserve the partial without repeating research',async()=>{
 for(const outcome of ['failed','unknown','uncited','foreign']){
  const db=await setup();try{
   const source=sourceFor(await tracker(db));let calls=0,id;
   const model=async(_prompt,input)=>{
    if(++calls===1)return answer([{...event,date:null}]);
    id=(await db.query('select id from scout.records')).rows[0].id;
    if(outcome==='failed')throw Object.assign(new Error('provider_unavailable'),{dispatched:true});
    return {...answer([{...event,record_id:outcome==='foreign'?'another-record':id,date_source_url:'https://example.org/schedule',date:outcome==='unknown'?null:event.date}]),
     _retrieval:outcome==='uncited'?[]:[{url:'https://example.org/schedule',status:'URL_RETRIEVAL_STATUS_SUCCESS'}]};
   };
   const result=await processDocument(db,{source,model});assert.equal(result.created,1);assert.equal(result.improvement,'exhausted');assert.equal(calls,2);
   const before=(await db.query('select id,version,details from scout.records')).rows;assert.equal(before[0].id,id);assert.equal(before[0].details.start,undefined);
   await due(db);assert.equal((await processDocument(db,{source,model})).state,'parked');assert.equal(calls,2);
   await db.exec("update scout.source_state set state='due',attempts=0,due_at=clock_timestamp()");
   const reopened=await processDocument(db,{source,model:async()=>{calls++;return answer([{...event,date:null}]);}});
   assert.equal(reopened.improvement,'not_requested');assert.equal(calls,3);assert.deepEqual((await db.query('select id,version,details from scout.records')).rows,before);
  }finally{await db.close();}
 }
});

test('malformed siblings and optional fields do not discard useful URL findings',async()=>{
 const db=await setup();try{
  const tr=await tracker(db),source=sourceFor(tr);
  const result=await processDocument(db,{source,model:async()=>answer([
   null,{...event,description:'Long '.repeat(150),date:'2026-02-30'},
   {...event,type:'announcement',description:'Publication',organizations:[null,'Institute A']}])});
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
  const result=await processDocument(db,{source,model:async()=>answer([{...event,description:'Rephrased BBNJ workshop',organizations:['Wrong override'],date:'2026-10-22'}])});
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
  const records=[event,{...event,description:'A different BBNJ workshop',date:'2026-12-01'},event];
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
