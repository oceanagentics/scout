import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {PGlite} from '@electric-sql/pglite';
import {collectHSA,HSA,UNTC} from '../collector/hsa.js';
import {CONTENT_FIELDS,validateDecision,observe,assessmentInput,INSTRUCTION,SCHEMA,normalize} from '../collector/assessment.js';
import {database as adapter} from '../collector/hosted-hsa.js';
import {gemini,reservationSQL} from '../collector/model.js';
import {fieldLabel,filterRecords,orderRecords} from '../src/records.js';

async function database({last=true}={}) {
  const db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');
    create table auth.identities(user_id uuid,provider text,identity_data jsonb);
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;`);
  for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort()) {
    if(!last&&name.startsWith('20261001190000'))continue;
    await db.exec(await readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8'));
  }
  await db.exec(await readFile(new URL('../supabase/seeds/trackers.sql',import.meta.url),'utf8'));
  return db;
}
const full=(values={})=>({...Object.fromEntries(CONTENT_FIELDS.map(f=>[f,null])),kind:'announcement',title:'Interoperability consultation',...values});
const input={source_id:'source',url:'https://highseasalliance.org/consultation',text:'Interoperability consultation. Data standards workshop. Workshop cancelled.',scripted:{},candidates:[],exact_ids:[]};
const result={source_id:'source',action:'new',record_id:null,candidate:full(),priority:'high',reason:'Technical implementation consultation',quotes:['Interoperability consultation'],clear_fields:[]};

test('complete extraction, supported facts, nulls, identity boundaries and rendering',()=>{
  assert.deepEqual(validateDecision(result,input),result);
  for(const field of CONTENT_FIELDS) {const bad=structuredClone(result);delete bad.candidate[field];assert.throws(()=>validateDecision(bad,input),/complete/);}
  for(const value of ['',42,false]) assert.throws(()=>validateDecision({...result,candidate:full({organization:value})},input));
  assert.throws(()=>validateDecision({...result,candidate:full({event_url:'https://invented.org/'})},input),/unsupported/);
  assert.throws(()=>validateDecision({...result,record_id:'outside'},input),/shortlist/);
  assert.throws(()=>validateDecision({...result,priority:'urgent'},input),/priority/);
  assert.throws(()=>validateDecision({...result,quotes:['invented quote']},input),/quote/);
  assert.throws(()=>validateDecision({...result,candidate:full({kind:'treaty_status'})},input),/official/);
  assert.equal(fieldLabel(full(),'starts_at'),'Not applicable');
  assert.equal(fieldLabel(full({kind:'event'}),'starts_at'),'Unknown');
  assert.equal(fieldLabel(full(),'priority'),'Not yet assessed');
  const records=[{id:'a',priority:null},{id:'b',priority:'normal'},{id:'c',priority:'high'}];
  assert.deepEqual(orderRecords(records).map(r=>r.id),['c','b','a']);
  assert.equal(filterRecords(records,{priority:'unassessed'})[0].id,'a');
});

test('migration is additive for records, keeps unknown priorities, and removes only delivery machinery',async()=>{
  const db=await database({last:false});
  try {
    const original=(await db.query("insert into scout.records(kind,title,identity_key) values('announcement','Existing','old') returning *")).rows[0];
    await db.exec(await readFile(new URL('../supabase/migrations/20261001190000_assessment_and_communication.sql',import.meta.url),'utf8'));
    const row=(await db.query('select * from scout.records')).rows[0];
    assert.equal(row.priority,null);assert.equal(row.last_communicated_at,null);assert.deepEqual(row.updated_at,original.updated_at);
    await assert.rejects(db.query("update scout.records set priority='urgent'"),{code:'23514'});
    await db.query("update scout.records set priority='high'");const assessed=(await db.query('select updated_at from scout.records')).rows[0].updated_at;
    await db.query("update scout.records set priority='high',last_communicated_at=clock_timestamp()");
    assert.deepEqual((await db.query('select updated_at from scout.records')).rows[0].updated_at,assessed);
    assert.equal((await db.query("select to_regclass('scout.deliveries') as name")).rows[0].name,null);
    await db.exec('set role authenticated');await assert.rejects(db.query('select * from scout.evidence'),{code:'42501'});
    assert.equal((await db.query('select * from scout.source_details')).rows.length,0);
  }finally{await db.close();}
});

test('actual hosted database adapter commits reservations before rollback and reset, enforcing shared caps',async()=>{
  const db=await database();
  try {
    const sql={unsafe:async(q,p=[]) => (await db.query(q,p)).rows};
    const hosted=adapter(sql);
    const run=(await db.query("insert into scout.collection_runs(tracker_id) select id from scout.trackers limit 1 returning id")).rows[0].id;
    let calls=0;
    const model=gemini({apiKey:'fixture-only',ledger:hosted,runId:run,fetch:async()=>{calls++;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'[]'}]}}]});}});
    await model('test',{},{});
    await assert.rejects(hosted.transaction(async tx=>{await tx.query("insert into scout.records(kind,title,identity_key) values('announcement','Rollback','rollback')");throw new Error('crash after external call');}));
    assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,0);
    assert.equal((await db.query("select jsonb_array_length(stats->'model_attempts') n from scout.collection_runs where id=$1",[run])).rows[0].n,1);
    await model('test',{},{});await assert.rejects(model('test',{},{}),/quota/);assert.equal(calls,2);
    await db.exec('begin;delete from scout.evidence;delete from scout.records;commit;');
    assert.equal((await db.query("select jsonb_array_length(stats->'model_attempts') n from scout.collection_runs where id=$1",[run])).rows[0].n,2);
    await assert.rejects(model('test','x'.repeat(8001),{}),/input limit/);assert.equal(calls,2);
    // Age attempts within today to exercise independent run and daily ceilings.
    const seed={at:new Date(Date.now()-120000).toISOString()};
    await db.query("update scout.collection_runs set stats=jsonb_build_object('model_attempts',$1::jsonb) where id=$2",[JSON.stringify(Array(10).fill(seed)),run]);
    await assert.rejects(hosted.query(reservationSQL(run,50)),/quota/);
    const other=(await db.query("insert into scout.collection_runs(tracker_id,stats) select tracker_id,$2::jsonb from scout.collection_runs where id=$1 returning id",[run,JSON.stringify({model_attempts:Array(10).fill(seed)})])).rows[0].id;
    const fresh=(await db.query('insert into scout.collection_runs(tracker_id) select tracker_id from scout.collection_runs where id=$1 returning id',[other])).rows[0].id;
    await assert.rejects(hosted.query(reservationSQL(fresh,50)),/quota/);
  }finally{await db.close();}
});

test('source A→B→A reuses content and preserves added, removed and changed fields',async()=>{
  const db=await database();
  try{
    const tracker=(await db.query('select id from scout.trackers limit 1')).rows[0].id;
    const a=await observe(db,tracker,input.url,'A',null,{}, {text:'A',link:'https://example.org'}, {},'2026-10-01T00:00:00Z');
    await observe(db,tracker,input.url,'B',null,{}, {text:'B',title:'New'}, {},'2026-10-01T01:00:00Z');
    const again=await observe(db,tracker,input.url,'A',null,{}, {text:'A',link:'https://example.org'}, {},'2026-10-01T02:00:00Z');
    assert.equal(again.id,a.id);assert.equal(again.changed,true);assert.deepEqual(new Set(again.parsed.source.changed),new Set(['text','link','title']));
    assert.equal((await db.query('select count(*)::int n from scout.evidence')).rows[0].n,2);
  }finally{await db.close();}
});

test('first-batch cross-URL duplicates remain pending until the new finding is in the shortlist',async()=>{
  const db=await database();let calls=0;
  const candidate=full({kind:'event',title:'Marine data standards workshop',organization:'High Seas Alliance'});
  const feed={feed:['first','second'].map(key=>({post:{uri:`at://did:plc:test/app.bsky.feed.post/${key}`,author:{handle:HSA},indexedAt:'2026-10-01T00:00:00Z',record:{text:'Marine data standards workshop',createdAt:'2026-10-01T00:00:00Z'}}}))};
  const read=async(url,budget)=>{budget.requests++;return{url,headers:{},body:JSON.stringify(feed)};};
  const model=async(_instruction,inputs)=>{calls++;return inputs.map(i=>({...result,source_id:i.source_id,candidate,
    action:i.candidates.length?'supporting_evidence':'new',record_id:i.candidates[0]?.id??null,quotes:['Marine data standards workshop']}));};
  try{
    const first=await collectHSA(db,{since:'2026-09-01',read,model});
    assert.equal(first.created,1);assert.equal(first.outcome,'partial');assert.equal(calls,1);
    const original=(await db.query('select * from scout.records')).rows[0];
    assert.equal((await db.query("select count(*)::int n from scout.evidence where parsed#>>'{assessment,state}'='uncertain'")).rows[0].n,1);
    await collectHSA(db,{since:'2026-09-01',read,model});assert.equal(calls,2);
    assert.deepEqual((await db.query('select * from scout.records')).rows,[original]);
    assert.equal((await db.query('select count(*)::int n from scout.current_evidence')).rows[0].n,2);
    await collectHSA(db,{since:'2026-09-01',read,model});assert.equal(calls,2);
  }finally{await db.close();}
});

test('technical no-keyword source gates cosmetic repeats and resumes failed assessment once; local reset repulls with accounting preserved',async()=>{
  const db=await database();let calls=0,fail=true,text='Interoperability consultation. Data standards workshop.';
  const feed=()=>({feed:[{post:{uri:'at://did:plc:test/app.bsky.feed.post/technical',author:{handle:HSA},indexedAt:'2026-10-01T00:00:00Z',record:{text,createdAt:'2026-10-01T00:00:00Z'}}}]});
  const read=async(url,budget)=>{budget.requests++;return {url,headers:{},body:JSON.stringify(feed())};};
  const model=async(_instruction,inputs)=>{calls++;if(fail)throw new Error('Fixture outage');return inputs.map(i=>({...result,source_id:i.source_id,candidate:full(),quotes:['Interoperability consultation']}));};
  try{
    const options={since:'2026-09-01',read,model};
    assert.equal((await collectHSA(db,options)).outcome,'partial');
    assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,0);
    fail=false;assert.equal((await collectHSA(db,options)).created,1);assert.equal(calls,2);
    const record=(await db.query('select * from scout.records')).rows[0];assert.equal(record.priority,'high');
    text='Interoperability  consultation.\nData standards workshop.';
    assert.equal((await collectHSA(db,options)).outcome,'no_change');assert.equal(calls,2);
    assert.equal((await db.query('select count(*)::int n from scout.evidence')).rows[0].n,1);
    assert.deepEqual((await db.query('select * from scout.records')).rows[0],record);
    const trackers=(await db.query('select * from scout.trackers order by id')).rows;
    const runs=(await db.query('select * from scout.collection_runs order by id')).rows;
    await db.exec('begin;delete from scout.evidence;delete from scout.records;commit;');
    assert.deepEqual((await db.query('select * from scout.trackers order by id')).rows,trackers);
    assert.deepEqual((await db.query('select * from scout.collection_runs order by id')).rows,runs);
    assert.equal((await collectHSA(db,options)).created,1);assert.equal(calls,3);
  }finally{await db.close();}
});

test('recorded ChM policy brief and expression of interest stay distinct after shortlist review',async()=>{
 const db=await database();
 const examples=JSON.parse(await readFile(new URL('./fixtures/hsa-chm-distinct.json',import.meta.url),'utf8'));
 let current=examples[0],suffix='',calls=0,policyId;
 const read=async(url,budget)=>{budget.requests++;return {url,headers:{},body:JSON.stringify({feed:[{post:{
   uri:`at://did:plc:mj2ygegzodk3fdjdgihjko23/app.bsky.feed.post/${current.url.split('/').at(-1)}`,
   author:{handle:HSA,displayName:'High Seas Alliance'},indexedAt:current.createdAt,
   record:{createdAt:current.createdAt,text:[current.title,current.description,suffix].filter(Boolean).join('\n\n')}
 }}]})};};
 const model=async(_instruction,inputs)=>{calls++;if(policyId)assert.ok(inputs[0].candidates.some(c=>c.id===policyId));
   return inputs.map(i=>({...result,source_id:i.source_id,candidate:full({title:current.title,description:current.description,organization:'High Seas Alliance'}),quotes:[current.title]}));};
 try{
  assert.equal((await collectHSA(db,{read,model,since:'2026-09-01'})).created,1);
  policyId=(await db.query('select id from scout.records')).rows[0].id;
  current=examples[1];const second=await collectHSA(db,{read,model,since:'2026-09-01'});
  assert.equal(second.created,1);assert.equal(second.pending,0);
  const records=(await db.query('select * from scout.records order by id')).rows;
  assert.equal(records.length,2);assert.ok(records.every(r=>r.priority==='high'));
  await collectHSA(db,{read,model,since:'2026-09-01'});assert.equal(calls,2);
  suffix='Additional detail.';const mistakenNew=await collectHSA(db,{read,model,since:'2026-09-01'});
  assert.equal(mistakenNew.created,0);assert.equal(mistakenNew.pending,1);
  assert.deepEqual((await db.query('select * from scout.records order by id')).rows,records);
 }finally{await db.close();}
});

test('recorded oversized HSA context fits the unchanged model cap without duplicate shortlist prose',async()=>{
 const db=await database();
 const recorded=JSON.parse(await readFile(new URL('./fixtures/hsa-assessment-context.json',import.meta.url),'utf8'));
 let requests=0;
 const model=gemini({apiKey:'fixture-only',runId:'00000000-0000-4000-8000-000000000001',ledger:{query:async()=>({rows:[]})},
   fetch:async(_url,options)=>{requests++;assert.ok(Buffer.byteLength(options.body)<=8000);
     return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'[]'}]}}]});}});
 try{
  await assert.rejects(model(INSTRUCTION,[recorded.input],SCHEMA),/input limit/);assert.equal(requests,0);
  const tracker=(await db.query("select * from scout.trackers where seed_key='bbnj-trackers-2026-10-01:17'")).rows[0];
  for(const c of recorded.input.candidates){
   await db.query('insert into scout.records(id,identity_key,kind,title,organization,description,event_url,starts_at,ends_at,status,priority) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [c.id,c.identity_key,c.kind,c.title,c.organization,c.description,c.event_url,c.starts_at,c.ends_at,c.status,c.priority]);
   for(const e of c.evidence)await db.query('insert into scout.evidence(tracker_id,record_id,url,content,content_hash,last_seen_at) values($1,$2,$3,$4,$5,clock_timestamp())',[tracker.id,c.id,e.url,e.text,e.url]);
  }
  const compact=await assessmentInput(db,recorded.capture,{...tracker,coverage:recorded.coverage});
  assert.ok(compact.text.includes(normalize(JSON.parse(recorded.capture.content).text)));
  assert.deepEqual(compact.exact_ids,recorded.input.exact_ids);
  for(const c of compact.candidates){const original=recorded.input.candidates.find(r=>r.id===c.id);
   for(const key of ['id','identity_key','title','organization','starts_at','ends_at','event_url'])assert.deepEqual(c[key],original[key]);
   assert.equal(typeof c.evidence,'string');assert.ok(!Object.hasOwn(c,'description'));
  }
  await model(INSTRUCTION,[compact],SCHEMA);assert.equal(requests,1);
 }finally{await db.close();}
});

test('unchanged evaluated uncertainty stays visible without repeat calls; new, failed and changed-context work resumes',async()=>{
 const db=await database();let calls=0,newSource=false,failNew=true;
 const posts=()=>[{key:'claim',text:'Treaty ratification reported; official verification unavailable.'},...(newSource?[{key:'technical',text:'Interoperability consultation'}]:[])];
 const read=async(url,budget)=>{budget.requests++;return {url,headers:{},body:JSON.stringify({feed:posts().map(p=>({post:{uri:`at://did:plc:test/app.bsky.feed.post/${p.key}`,
   author:{handle:HSA},indexedAt:'2026-10-01T00:00:00Z',record:{text:p.text,createdAt:'2026-10-01T00:00:00Z'}}}))})};};
 const seen=[];
 const model=async(_instruction,inputs)=>{calls++;seen.push(inputs.map(i=>i.url));return inputs.map(i=>{
   if(i.url.endsWith('/technical')){if(failNew)throw new Error('Transient fixture failure');return {...result,source_id:i.source_id,candidate:full({organization:'High Seas Alliance'})};}
   return {...result,source_id:i.source_id,action:'uncertain',candidate:null,priority:null,reason:'Official verification unavailable',quotes:['Treaty ratification reported']};
 });};
 try{
  const options={read,model,since:'2026-09-01'};
  assert.equal((await collectHSA(db,options)).pending,1);assert.equal(calls,1);
  let run=await collectHSA(db,options);assert.equal(run.reused_uncertain,1);assert.equal(run.pending,1);assert.equal(run.outcome,'partial');assert.equal(calls,1);assert.ok(run.warnings.includes('Official verification unavailable'));
  newSource=true;run=await collectHSA(db,options);assert.equal(calls,2);assert.equal(run.pending,2);assert.ok(seen.at(-1).every(url=>url.endsWith('/technical')));
  failNew=false;run=await collectHSA(db,options);assert.equal(run.created,1);assert.equal(run.pending,1);assert.equal(calls,3);
  await collectHSA(db,options);assert.equal(calls,4); // New finding changes the identity shortlist.
  run=await collectHSA(db,options);assert.equal(calls,4);assert.equal(run.reused_uncertain,1);
  await db.query("insert into scout.evidence(tracker_id,record_id,url,content,content_hash,last_seen_at) select tracker_id,record_id,url||'/supporting',content||' Supporting facts changed.',content_hash||':new',clock_timestamp() from scout.evidence where record_id is not null limit 1");
  await collectHSA(db,options);assert.equal(calls,5); // Supporting evidence changed without a record version bump.
  await db.query("update scout.evidence set parsed=jsonb_set(parsed,'{assessment,state}','\"pending\"') where parsed#>>'{assessment,state}'='uncertain'");
  await collectHSA(db,options);assert.equal(calls,6); // Explicit reprocessing remains available.
  assert.equal((await db.query("select parsed#>>'{assessment,reason}' reason from scout.evidence where parsed#>>'{assessment,state}'='uncertain'")).rows[0].reason,'Official verification unavailable');
 }finally{await db.close();}
});

test('targeted resume assesses only selected pending evidence and retains all pending coverage',async()=>{
 const db=await database();
 try{
  const tracker=(await db.query("select id from scout.trackers where seed_key='bbnj-trackers-2026-10-01:17'")).rows[0].id;
  const docs=[];
  for(const key of ['one','two'])docs.push(await observe(db,tracker,`https://example.org/${key}`,'Interoperability consultation',null,{}, {text:key},{identity:key,rank:2},'2026-10-01T00:00:00Z'));
  const options={sourceId:docs[1].id,read:async()=>({body:'{"feed":[]}'}),model:async(_instruction,inputs)=>{
   assert.deepEqual(inputs.map(i=>i.source_id),[docs[1].id]);return [{...result,source_id:docs[1].id}];}};
  const first=await collectHSA(db,options);assert.equal(first.assessed,1);assert.equal(first.created,1);assert.equal(first.pending,1);assert.equal(first.outcome,'partial');
  const repeat=await collectHSA(db,{...options,model:async()=>{assert.fail('completed source reassessed');}});assert.equal(repeat.assessed,0);assert.equal(repeat.pending,1);
  const untouched=(await db.query('select * from scout.evidence where id=$1',[docs[0].id])).rows[0];
  assert.deepEqual(untouched.parsed,docs[0].parsed);assert.deepEqual(untouched.collected_at,docs[0].collected_at);
 }finally{await db.close();}
});

test('explicit validation persists disabled source receipt and quota evidence without promoting proof',async()=>{
 const db=await database();let reads=0,calls=0,factories=0;
 const feed={feed:[{post:{uri:'at://did:plc:test/app.bsky.feed.post/validation',author:{handle:HSA},indexedAt:'2026-10-01T00:00:00Z',
  record:{text:'Interoperability consultation',createdAt:'2026-10-01T00:00:00Z'}}}]};
 const read=async(url,budget)=>{reads++;budget.requests++;assert.equal(new URL(url).searchParams.get('actor'),HSA);return{url,body:JSON.stringify(feed)};};
 const makeModel=runId=>{factories++;return gemini({apiKey:'fixture-only',ledger:db,runId,fetch:async(_url,request)=>{
  calls++;const inputs=JSON.parse(JSON.parse(request.body).contents[0].parts[0].text);
  const run=(await db.query('select stats from scout.collection_runs where id=$1',[runId])).rows[0];
  assert.equal(run.stats.validation,true);assert.equal(run.stats.model_attempts.length,1);
  return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(inputs.map(i=>({...result,source_id:i.source_id})))}]}}],
   usageMetadata:{promptTokenCount:100,candidatesTokenCount:50}});
 }});};
 try{
  const tracker=(await db.query("update scout.trackers set enabled=false where seed_key='bbnj-trackers-2026-10-01:17' returning *")).rows[0];
  const unsupported=(await db.query("select id from scout.trackers where collector='web' and url<>$1 limit 1",[UNTC])).rows[0].id;
  const options={since:'2026-09-01',read,makeModel};
  for(const selection of [{},{trackerId:tracker.id},{validate:true},{validate:true,trackerId:'all'},
   {validate:true,trackerId:'00000000-0000-0000-0000-000000000000'},{validate:true,trackerId:unsupported}]) {
   await assert.rejects(collectHSA(db,{...options,...selection}),error=>error.status===400);
  }
  assert.equal(reads,0);assert.equal(calls,0);assert.equal(factories,0);
  assert.equal((await db.query('select count(*)::int n from scout.collection_runs')).rows[0].n,0);
  const first=await collectHSA(db,{...options,trackerId:tracker.id,validate:true});
  assert.equal(first.outcome,'success');assert.equal(first.created,1);assert.equal(first.assessed,1);assert.equal(calls,1);
  const record=(await db.query('select * from scout.records')).rows[0];
  const captures=(await db.query('select * from scout.evidence')).rows;
  assert.equal(captures.length,1);assert.equal(captures[0].tracker_id,tracker.id);assert.equal(captures[0].record_id,record.id);
  assert.deepEqual((await db.query('select * from scout.trackers where id=$1',[tracker.id])).rows[0],tracker);
  const completed=(await db.query('select * from scout.collection_runs where id=$1',[first.run_id])).rows[0];
  assert.deepEqual(completed.stats.model_usage,[{promptTokenCount:100,candidatesTokenCount:50}]);
  assert.deepEqual((await db.query('select last_success_at from scout.tracker_status where id=$1',[tracker.id])).rows[0].last_success_at,completed.finished_at);
  const repeat=await collectHSA(db,{...options,trackerId:tracker.id,validate:true});
  assert.equal(repeat.outcome,'no_change');assert.equal(repeat.candidates,0);assert.equal(calls,1);
  assert.equal((await db.query('select count(*)::int n from scout.evidence')).rows[0].n,1);
  // A shared cap from another run still blocks validation before model transport.
  await db.query("update scout.collection_runs set stats=stats||jsonb_build_object('model_attempts',$1::jsonb) where id=$2",
   [JSON.stringify(Array(20).fill({at:new Date().toISOString()})),first.run_id]);
  feed.feed[0].post.record.text+=' Updated technical guidance';
  const limited=await collectHSA(db,{...options,trackerId:tracker.id,validate:true});
  assert.equal(limited.outcome,'quota');assert.equal(limited.pending,1);assert.equal(calls,1);
  assert.deepEqual((await db.query('select * from scout.records')).rows[0],record);
  const beforeNormal=(await db.query('select * from scout.collection_runs order by id')).rows,readCount=reads,factoryCount=factories;
  await assert.rejects(collectHSA(db,{...options,trackerId:tracker.id}),/not yet proven/);
  assert.equal(reads,readCount);assert.equal(factories,factoryCount);
  assert.deepEqual((await db.query('select * from scout.collection_runs order by id')).rows,beforeNormal);
  await db.exec('set role service_role');
  await db.query('update scout.trackers set enabled=true where id=$1',[tracker.id]);
  await db.exec('reset role');
  assert.equal((await db.query('select enabled from scout.trackers where id=$1',[tracker.id])).rows[0].enabled,true);
 }finally{await db.close();}
});

test('configured Bluesky feeds retain separate health, skip repeats and recover one failed feed',async()=>{
 const db=await database(),feeds=JSON.parse(await readFile(new URL('./fixtures/expansion-feeds.json',import.meta.url),'utf8'));
 const dosi=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/dosi-roundup-captures.json.gz',import.meta.url))));
 const trackers=(await db.query("select * from scout.trackers where seed_key in ('bbnj-trackers-2026-10-01:18','bbnj-trackers-2026-10-01:19','bbnj-trackers-2026-10-01:20') order by seed_key")).rows;
 let calls=0,fail=null;
 const read=async(url,budget)=>{budget.requests++;const actor=new URL(url).searchParams.get('actor');if(actor && actor===fail)throw new Error('Recorded source unavailable');
  return {url,headers:{'content-type':'text/html'},body:actor?JSON.stringify(feeds[actor]):url.includes('dosi-deep-sea-round-up')?dosi[0].content:'<p>Supporting context</p>'};};
 const model=async(_instruction,inputs)=>{calls++;return inputs.map(i=>({...result,source_id:i.source_id,action:'no_substantive_change',candidate:null,priority:'low',quotes:[],reason:'Injected no-finding decision for transport verification'}));};
 try{
  for(const tracker of trackers){const first=await collectHSA(db,{trackerId:tracker.id,since:'2026-09-01',read,model});assert.ok(first.assessed>0);assert.equal(first.pending,0);
   const before=calls;const repeat=await collectHSA(db,{trackerId:tracker.id,since:'2026-09-01',read,model});assert.equal(repeat.outcome,tracker.seed_key.endsWith(':18')?'partial':'no_change');assert.equal(calls,before);assert.equal(repeat.candidates,0);
   if(tracker.seed_key.endsWith(':18'))assert.ok(repeat.warnings.some(w=>w.includes('newsletter item layout unavailable')));}
  fail='deepstewardship.bsky.social';assert.equal((await collectHSA(db,{trackerId:trackers[0].id,since:'2026-09-01',read,model})).outcome,'failed');
  assert.equal((await collectHSA(db,{trackerId:trackers[1].id,since:'2026-09-01',read,model})).outcome,'no_change');
  fail=null;assert.equal((await collectHSA(db,{trackerId:trackers[0].id,since:'2026-09-01',read,model})).outcome,'partial');
  assert.equal((await db.query('select count(distinct tracker_id)::int n from scout.collection_runs')).rows[0].n,3);
  for(const tracker of trackers)assert.deepEqual((await db.query('select * from scout.trackers where id=$1',[tracker.id])).rows[0],tracker);
 }finally{await db.close();}
});

test('actual DOSI captures gate rotating related posts while article, date and newsletter-link changes resume',async()=>{
 const db=await database(),captures=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/dosi-roundup-captures.json.gz',import.meta.url))));
 const feeds=JSON.parse(await readFile(new URL('./fixtures/expansion-feeds.json',import.meta.url),'utf8'));
 let html=captures[0].content,calls=0;
 const url='https://www.dosi-project.org/dosi-deep-sea-round-up-110/';
 const read=async(source,budget)=>{budget.requests++;return {url:source,headers:{'content-type':'text/html'},body:source.includes('getAuthorFeed')?JSON.stringify(feeds['deepstewardship.bsky.social']):html};};
 const model=async(_instruction,inputs)=>{calls+=inputs.length;return inputs.map(i=>({...result,source_id:i.source_id,action:i.url===url?'uncertain':'no_substantive_change',candidate:null,priority:null,quotes:[],reason:'Newsletter details require another hop'}));};
 try{
  const tracker=(await db.query("select * from scout.trackers where seed_key='bbnj-trackers-2026-10-01:18'")).rows[0];
  const options={trackerId:tracker.id,since:'2026-09-24',read,model};
  await collectHSA(db,options);const baseline=calls;
  html=captures[1].content;assert.notEqual(html,captures[0].content);
  const repeat=await collectHSA(db,options);assert.equal(repeat.candidates,0);assert.equal(repeat.skipped,2);assert.equal(repeat.reused_uncertain,1);assert.equal(calls,baseline);
  assert.equal((await db.query('select content from scout.evidence where url=$1',[url])).rows[0].content,captures[0].content);
  html=html.replaceAll('This week: Discover new research connecting ocean, climate and biodiversity governance','This week: New technical implementation workshop connecting ocean, climate and biodiversity governance');
  assert.equal((await collectHSA(db,options)).candidates,1);assert.equal(calls,baseline+1);
  html=html.replaceAll('https://mailchi.mp/soton.ac.uk/dosi-deep-sea-roundup-01-10-2026','https://mailchi.mp/soton.ac.uk/dosi-deep-sea-roundup-08-10-2026');
  assert.equal((await collectHSA(db,options)).candidates,1);assert.equal(calls,baseline+2);
  html=html.replaceAll('1 October 2026','8 October 2026');
  assert.equal((await collectHSA(db,options)).candidates,1);assert.equal(calls,baseline+3);
  html=html.replace('id="trx_addons_emotions"','id="layout-changed"');
  const failed=await collectHSA(db,options);assert.equal(failed.outcome,'partial');assert.equal(failed.candidates,0);assert.equal(calls,baseline+3);assert.ok(failed.warnings.some(w=>w.includes('DOSI article layout unavailable')));
 }finally{await db.close();}
});

test('recorded HSA registration resolves a retained post identity using compatible captured clock evidence',async()=>{
 const f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/scout16-gaps.json.gz',import.meta.url))));
 for(const year of [2026,2025]) {
  const db=await database();let calls=0;
  try {
   const tracker=(await db.query("select id from scout.trackers where seed_key='bbnj-trackers-2026-10-01:17'")).rows[0].id;
   for(const [table,rows] of [['records',[f.mgr]],['evidence',f.evidence.map(e=>({...e,tracker_id:tracker}))]])for(const row of rows){
    const keys=Object.keys(row);await db.query(`insert into scout.${table} (${keys.join(',')}) values (${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row));
   }
   await db.exec("insert into scout.records(kind,title,organization,identity_key) values('announcement','Unrelated EOI','High Seas Alliance','eoi'),('announcement','Ocean Protection Gap','High Seas Alliance','gap')");
   const earlier=structuredClone(f.hsaTime);earlier.record.createdAt=earlier.record.createdAt.replace('2026',String(year));
   const read=async(url,budget)=>{budget.requests++;return url.includes('/xrpc/')?{url,body:JSON.stringify({feed:[{post:f.hsaPost},{post:earlier}]})}:f.zoom;};
   const zoom=f.evidence.find(e=>e.url===f.zoom.url);
   const options={trackerId:tracker,sourceId:zoom.id,since:'2026-09-01',read,model:async(_instruction,inputs)=>{
    calls++;assert.equal(inputs.length,1);const i=inputs[0];assert.equal(i.source_id,zoom.id);
    assert.deepEqual(i.candidates.map(c=>c.id),[f.mgr.id]);assert.equal(i.candidates[0].registration_link,true);assert.deepEqual(i.links,[f.zoom.url]);
    await gemini({apiKey:'injected-only',ledger:{query:async()=>({rows:[]})},runId:f.mgr.id,fetch:async(_url,request)=>{
     assert.ok(Buffer.byteLength(request.body)<=8000);
     return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'[]'}]}}]});
    }})(INSTRUCTION,inputs,SCHEMA);
    return [structuredClone(f.hsaDecision)];
   }};
   const first=await collectHSA(db,options);assert.equal(first.created,0);assert.equal(first.changed,1,first.warnings.join('; '));assert.equal(calls,1);
   const record=(await db.query('select * from scout.records where id=$1',[f.mgr.id])).rows[0];
   assert.equal(record.id,f.mgr.id);assert.equal(record.identity_key,f.mgr.identity_key);
   assert.equal(record.registration_url,f.zoom.url);assert.equal(record.starts_at?.toISOString()??null,year===2026?'2026-09-29T11:30:00.000Z':null);
   const resolved=(await db.query('select parsed from scout.evidence where id=$1',[zoom.id])).rows[0].parsed.assessment;
   assert.equal(resolved.action,'update');assert.equal(resolved.model_decision.action,'new');
   assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,3);
   if(year===2026){const timing=(await db.query('select * from scout.evidence where id=$1',[record.date_evidence.zone_source])).rows[0];
    assert.equal(timing.record_id,record.id);assert.equal(timing.parsed.assessment.state,'pending');assert.equal(timing.parsed.date_parts.zone,'EDT');
    assert.equal(record.date_evidence.schedule_source,zoom.id);
   } else assert.ok(first.warnings.some(w=>w.includes('without a time zone')));
   const count=(await db.query('select count(*)::int n from scout.evidence')).rows[0].n;
   const repeat=await collectHSA(db,options);assert.equal(repeat.created,0);assert.equal(repeat.changed,0);assert.equal(calls,1);
   assert.deepEqual((await db.query('select * from scout.records where id=$1',[f.mgr.id])).rows[0],record);
   assert.equal((await db.query('select count(*)::int n from scout.evidence')).rows[0].n,count);
  }finally{await db.close();}
 }
});

test('recorded DOSI newsletter keeps separate items, real URLs, changes and bounded failures',async()=>{
 const db=await database();const f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/scout16-gaps.json.gz',import.meta.url))));
 const feeds=JSON.parse(await readFile(new URL('./fixtures/expansion-feeds.json',import.meta.url),'utf8'));
 const article=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/dosi-roundup-captures.json.gz',import.meta.url))))[1].content;
 let html=f.newsletter.body,calls=0,issue=f.newsletter.url;
 const read=async(url,budget)=>{budget.requests++;
  if(url.includes('/xrpc/'))return{url,body:JSON.stringify({feed:[feeds['deepstewardship.bsky.social'].feed[0]]})};
  if(url===issue)return{url,headers:{'content-type':'text/html'},body:html};
  assert.match(url,/dosi-deep-sea-round-up/);
  return{url,headers:{'content-type':'text/html'},body:article.replaceAll(f.newsletter.url,issue)};
 };
 const model=async(_instruction,inputs)=>{calls++;assert.equal(inputs.length,1);const i=inputs[0];
  const candidate=Object.fromEntries(CONTENT_FIELDS.map(key=>[key,i.scripted[key]??null]));
  const existing=i.candidates.find(c=>i.exact_ids.includes(c.id));
  if(i.scripted.kind==='event'){
   assert.equal(candidate.event_url,null);assert.equal(candidate.registration_url,null);assert.equal(candidate.starts_at,null);
   assert.throws(()=>validateDecision({...result,source_id:i.source_id,candidate:{...candidate,event_url:i.url+'#scout-item-fake'},quotes:[candidate.title]},i),/newsletter link|unsupported/);
   assert.throws(()=>validateDecision({...result,source_id:i.source_id,candidate:{...candidate,event_url:i.links[0]},quotes:[candidate.title]},i),/newsletter link/);
  }
  return[{...result,source_id:i.source_id,action:existing?'update':'new',record_id:existing?.id??null,candidate,priority:'normal',quotes:[candidate.title]}];
 };
 try{
  const tracker=(await db.query("select id from scout.trackers where seed_key='bbnj-trackers-2026-10-01:18'")).rows[0].id;
  const options={trackerId:tracker,since:'2026-09-24',read,makeModel:()=>async()=>{throw new Error('Observation-only fixture');}};
  const observed=await collectHSA(db,options);assert.equal(observed.pages,2);assert.equal(observed.requests,3);assert.equal(observed.outcome,'partial');
  assert.ok(observed.warnings.some(w=>w.includes('item limit')));
  const items=(await db.query("select * from scout.evidence where parsed#>>'{source,item_key}' is not null")).rows;
  assert.equal(items.length,8);assert.equal(new Set(items.map(e=>e.parsed.source.item_key)).size,8);
  assert.ok(items.every(e=>e.url===f.newsletter.url&&!e.url.includes('#')));
  const paper=items.find(e=>e.parsed.title.startsWith('Connecting international'));
  const event=items.find(e=>e.parsed.title.startsWith('Science for BBNJ'));
  assert.ok(paper&&event);assert.equal(event.parsed.start_on,'2026-10-06');assert.equal(event.parsed.starts_at,null);
  assert.ok(!paper.content.includes(event.parsed.title));assert.ok(!event.content.includes(paper.parsed.title));
  for(const item of [paper,event]){const run=await collectHSA(db,{...options,sourceId:item.id,model});assert.equal(run.created,1);assert.equal(run.assessed,1);}
  const records=(await db.query('select * from scout.records order by id')).rows;assert.equal(records.length,2);assert.equal(calls,2);
  const count=(await db.query('select count(*)::int n from scout.evidence')).rows[0].n;
  html=html.replaceAll('padding: 0 9px 0 9px','padding: 1px')+'<footer>Rotating footer</footer><script>random()</script>';
  for(const item of [paper,event]){const repeat=await collectHSA(db,{...options,sourceId:item.id,model});assert.equal(repeat.candidates,0);assert.equal(repeat.changed,0);}
  assert.equal(calls,2);assert.equal((await db.query('select count(*)::int n from scout.evidence')).rows[0].n,count);
  html=html.replaceAll('6 October 2026','7 October 2026');
  const changed=await collectHSA(db,options);assert.equal(changed.candidates,2); // Two independently dated entries changed.
  const latest=(await db.query("select * from scout.evidence where parsed->>'title'=$1 order by collected_at desc limit 1",[event.parsed.title])).rows[0];
  assert.equal(latest.url,event.url);assert.equal(latest.parsed.source.item_key,event.parsed.source.item_key);assert.equal(latest.parsed.start_on,'2026-10-07');
  const revised=await collectHSA(db,{...options,sourceId:latest.id,model});assert.equal(revised.created,0);assert.equal(calls,3);
  html='Malformed newsletter';const failed=await collectHSA(db,{...options,sourceId:latest.id,model});
  assert.equal(failed.outcome,'partial');assert.ok(failed.warnings.some(w=>w.includes('layout unavailable')));assert.equal(calls,3);
  assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,2);
  issue=issue.replace('01-10','08-10');html=f.newsletter.body;
  await collectHSA(db,options);
  const next=(await db.query("select * from scout.evidence where url=$1 and parsed->>'title'=$2",[issue,event.parsed.title])).rows[0];
  assert.notEqual(next.parsed.source.identity,event.parsed.source.identity);
 }finally{await db.close();}
});

test('official UN baseline preserves all action types/notes and assesses only the selected current window while disabled',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/un-treaty.json.gz',import.meta.url))));let calls=0;
 try {
  const tracker=(await db.query('select * from scout.trackers where url=$1',[UNTC])).rows[0];
  const options={trackerId:tracker.id,validate:true,since:'2026-10-01',read:async(url,budget)=>{assert.equal(url,UNTC);budget.requests++;return f.html;},model:async(_instruction,inputs)=>{
   calls++;assert.equal(inputs.length,1);const i=inputs[0];assert.equal(i.scripted.treaty.country,'Mozambique');
   assert.equal(i.scripted.treaty.action,'accession');assert.equal(i.scripted.treaty.date,'2026-10-02');
   const candidate=Object.fromEntries(CONTENT_FIELDS.map(k=>[k,i.scripted[k]]));
   assert.throws(()=>validateDecision({...result,source_id:i.source_id,candidate:{...candidate,title:'Mozambique'},quotes:[candidate.title]},i),/country\/action\/date/);
   return [{...structuredClone(f.decision),source_id:i.source_id}];
  }};
  await assert.rejects(collectHSA(db,{...options,validate:false}),/not yet proven/);
  const first=await collectHSA(db,options);assert.equal(first.outcome,'success',first.warnings.join('; '));assert.equal(first.created,1);assert.equal(calls,1);
  assert.equal(first.baseline_participants,149);assert.equal(first.baseline_parties,102);
  const evidence=(await db.query('select * from scout.evidence')).rows;assert.equal(evidence.length,2);
  const baseline=evidence.find(e=>e.parsed.assessment.state==='baseline');assert.equal(baseline.content,f.html.body);assert.equal(baseline.published_at,null);
  const rows=baseline.parsed.participants;assert.equal(rows.find(r=>r.country==='Germany').action,'ratification');
  assert.equal(rows.find(r=>r.country==='Mozambique').action,'accession');assert.equal(rows.find(r=>r.country==='Morocco').action,'acceptance');
  assert.equal(rows.find(r=>r.country==='Armenia').action,'approval');assert.deepEqual(rows.find(r=>r.country==='Denmark').note_refs,['1']);
  assert.match(baseline.parsed.notes['1'],/Faroe Islands and Greenland/);
  assert.equal(Number(f.xml.body.match(/<Parties>(\d+)<\/Parties>/)[1]),baseline.parsed.parties);
  assert.match(f.xml.body,/<Entry>Mozambique<\/Entry><Entry\/><Entry>\s*2 Oct\s+2026 a/);
  const record=(await db.query('select * from scout.records')).rows[0];assert.equal(record.kind,'treaty_status');assert.equal(record.priority,'high');
  assert.equal(record.title,'Mozambique — accession — 2 Oct 2026');assert.equal(record.starts_at,null);assert.equal(record.last_communicated_at,null);
  const source=evidence.find(e=>e.record_id===record.id);assert.equal(source.url,UNTC);assert.equal(source.published_at,null);
  const repeat=await collectHSA(db,options);assert.equal(repeat.outcome,'no_change');assert.equal(repeat.candidates,0);assert.equal(calls,1);
  assert.equal((await db.query('select count(*)::int n from scout.evidence')).rows[0].n,2);
  assert.deepEqual((await db.query('select * from scout.records')).rows,[record]);
  assert.deepEqual((await db.query('select * from scout.trackers where id=$1',[tracker.id])).rows[0],tracker);
  assert.equal((await db.query('select stats from scout.collection_runs where id=$1',[first.run_id])).rows[0].stats.validation,true);
 }finally{await db.close();}
});

test('UN additions and corrections retain identity; inconsistent, missing-row and malformed responses preserve the baseline',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/un-treaty.json.gz',import.meta.url))));let html=f.html.body,calls=0;
 try {
  const tracker=(await db.query('select * from scout.trackers where url=$1',[UNTC])).rows[0];
  const options={trackerId:tracker.id,validate:true,since:'2026-10-04',read:async(_url,budget)=>{budget.requests++;return {...f.html,body:html};},model:async(_instruction,inputs)=>{
   calls++;return inputs.map(i=>({...result,source_id:i.source_id,record_id:i.exact_ids[0]??null,action:i.exact_ids.length?'update':'new',
    candidate:Object.fromEntries(CONTENT_FIELDS.map(k=>[k,i.scripted[k]])),quotes:[i.scripted.title]}));
  }};
  const initial=await collectHSA(db,options);assert.equal(initial.outcome,'no_change');assert.equal(calls,0);
  assert.equal((await db.query('select count(*)::int n from scout.evidence')).rows[0].n,1);
  const row=html.match(/<tr\b[^>]*>(?:(?!<\/tr>)[\s\S])*?\bPeru\b[\s\S]*?<\/tr>/)[0];
  html=html.replace(row,row.replace('<td>&nbsp;</td>','<td>3 Oct 2026 a<br></td>')).replace(/(Parties\s*:\s*)102/,(_m,prefix)=>prefix+'103');
  const added=await collectHSA(db,options);assert.equal(added.created,1,added.warnings.join('; '));assert.equal(calls,1);
  const record=(await db.query('select * from scout.records')).rows[0];assert.equal(record.title,'Peru — accession — 3 Oct 2026');
  html=html.replace('3 Oct 2026 a','2 Oct 2026 AA');
  const corrected=await collectHSA(db,options);assert.equal(corrected.created,0);assert.equal(corrected.changed,1);assert.equal(calls,2);
  const records=(await db.query('select * from scout.records')).rows;assert.equal(records.length,1);assert.equal(records[0].id,record.id);
  assert.equal(records[0].identity_key,record.identity_key);assert.equal(records[0].title,'Peru — approval — 2 Oct 2026');
  const count=(await db.query('select count(*)::int n from scout.evidence')).rows[0].n;
  html=html.replace('background-color:#D7D7D7','background-color:white').replace('</body>','<script>/* rotating cosmetic content */</script></body>');
  assert.equal((await collectHSA(db,options)).outcome,'no_change');assert.equal(calls,2);
  const valid=html,evidence=(await db.query('select * from scout.evidence order by id')).rows;
  const missing=valid.replace(/<tr\b[^>]*>(?:(?!<\/tr>)[\s\S])*?\bPeru\b[\s\S]*?<\/tr>/,'')
   .replace(/(Parties\s*:\s*)103/,(_m,p)=>p+'102').replace(/(Signatories\s*:\s*)145/,(_m,p)=>p+'144');
  const missingStatus=valid.replace('2 Oct 2026 AA','').replace(/(Parties\s*:\s*)103/,(_m,p)=>p+'102');
  for(const broken of [valid.slice(0,valid.length/2),'<html></html>',valid.replace('2 Oct 2026 AA','31 Feb 2026 AA'),
   valid.replace(/(Parties\s*:\s*)103/,(_m,p)=>p+'101'),missing,missingStatus,valid.replace("name='1'","name='2'")]){
   html=broken;const failed=await collectHSA(db,options);assert.equal(failed.outcome,'failed');assert.equal(calls,2);
   assert.deepEqual((await db.query('select * from scout.records')).rows,records);
   assert.deepEqual((await db.query('select * from scout.evidence order by id')).rows,evidence);
  }
  assert.equal((await db.query('select count(*)::int n from scout.evidence')).rows[0].n,count);
  assert.equal((await db.query('select enabled from scout.trackers where id=$1',[tracker.id])).rows[0].enabled,false);
 }finally{await db.close();}
});

test('recorded GFW partnership reassessment retains technical activity while generic noise stays excluded',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/scout16-gaps.json.gz',import.meta.url))));
 const feeds=JSON.parse(await readFile(new URL('./fixtures/expansion-feeds.json',import.meta.url),'utf8'));
 let calls=0;
 try {
  const tracker=(await db.query("select * from scout.trackers where seed_key='bbnj-trackers-2026-10-01:19'")).rows[0];
  for(const source of [f.gfw,f.gfwNoise]){
   const row={...source,tracker_id:tracker.id},keys=Object.keys(row);
   await db.query(`insert into scout.evidence (${keys.join(',')}) values (${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row));
  }
  assert.equal(f.gfw.parsed.assessment.priority,'low');assert.equal(f.gfwDecision.priority,'high');
  validateDecision(f.gfwDecision,f.gfwInput);
  await db.query("update scout.evidence set parsed=jsonb_set(parsed,'{assessment,state}','\"pending\"') where id=$1",[f.gfw.id]);
  const options={trackerId:tracker.id,sourceId:f.gfw.id,since:'2026-09-24',read:async(url,budget)=>{
   budget.requests++;return {url,headers:{'content-type':'text/html'},body:url.includes('/xrpc/')?JSON.stringify(feeds['globalfishingwatch.org']):'<p>Supporting fixture</p>'};
  },model:async(instruction,inputs)=>{
   calls++;assert.match(instruction,/concrete ocean-data\/monitoring tools, AI methods or implementation partnerships, even without treaty keywords/);
   assert.match(instruction,/Low: generic advocacy, AI promotion or explainers without a concrete new technical activity/);
   assert.deepEqual(inputs.map(i=>i.source_id),[f.gfw.id]);return [structuredClone(f.gfwDecision)];
  }};
  const first=await collectHSA(db,options);assert.equal(first.created,1,first.warnings.join('; '));assert.equal(calls,1);
  const record=(await db.query('select * from scout.records')).rows[0];assert.equal(record.priority,'high');assert.equal(record.kind,'announcement');
  assert.equal(record.identity_key,f.gfw.parsed.source.identity);
  const repeat=await collectHSA(db,options);assert.equal(repeat.candidates,0);assert.equal(repeat.changed,0);assert.equal(calls,1);
  assert.deepEqual((await db.query('select * from scout.records')).rows,[record]);
  const noise=(await db.query('select * from scout.evidence where id=$1',[f.gfwNoise.id])).rows[0];
  assert.equal(noise.record_id,null);assert.deepEqual(noise.parsed.assessment,f.gfwNoise.parsed.assessment);
  const technical=(await db.query('select * from scout.evidence where id=$1',[f.gfw.id])).rows[0];
  assert.equal(technical.content,f.gfw.content);assert.equal(technical.content_hash,f.gfw.content_hash);
 }finally{await db.close();}
});

test('the same finding across configured feeds retains each source without a duplicate or version bump',async()=>{
 const db=await database();let calls=0;
 try{
  const trackers=(await db.query("select * from scout.trackers where seed_key in ('bbnj-trackers-2026-10-01:17','bbnj-trackers-2026-10-01:18') order by seed_key")).rows;
  const read=async()=>({body:JSON.stringify({feed:[{post:{uri:'at://did:plc:original/app.bsky.feed.post/shared',author:{handle:HSA},indexedAt:'2026-10-01T00:00:00Z',record:{text:'Interoperability consultation',createdAt:'2026-10-01T00:00:00Z'}}}]})});
  const model=async(_instruction,inputs)=>{calls++;return inputs.map(i=>({...result,source_id:i.source_id,action:i.exact_ids.length?'supporting_evidence':'new',record_id:i.exact_ids[0]??null}));};
  await collectHSA(db,{trackerId:trackers[0].id,read,model});const original=(await db.query('select * from scout.records')).rows[0];
  const second=await collectHSA(db,{trackerId:trackers[1].id,read,model});assert.equal(second.created,0);assert.equal(second.changed,0);assert.equal(calls,2);
  assert.deepEqual((await db.query('select * from scout.records')).rows,[original]);assert.equal((await db.query('select count(distinct tracker_id)::int n from scout.evidence where record_id=$1',[original.id])).rows[0].n,2);
 }finally{await db.close();}
});

test('recorded HUB calendar uses explicit UTC evidence, gates repeats and preserves records on malformed schedules',async()=>{
 const db=await database(),recorded=JSON.parse(await readFile(new URL('./fixtures/hub-calendar.json',import.meta.url),'utf8'));
 let calls=0,malformed=false,supporting=false;let feed=structuredClone(recorded);
 const read=async(url,budget)=>{budget.requests++;return {url,headers:{},body:url.endsWith('format=json')?JSON.stringify(feed):malformed?'BEGIN:VCALENDAR':feed.calendar};};
 const model=async(_instruction,inputs)=>{calls++;return inputs.map(i=>({...result,source_id:i.source_id,
   action:supporting?'supporting_evidence':i.exact_ids.length?'update':'new',record_id:i.exact_ids[0]??null,
   candidate:{...Object.fromEntries(CONTENT_FIELDS.map(field=>[field,i.scripted[field]??null])),...(supporting?{starts_at:null,ends_at:null,event_url:null,registration_url:null}:{})},quotes:['This practical webinar demonstrates how large language models can help people work with real ocean data in the Ocean Data Platform.']}));};
 try{
  const tracker=(await db.query("insert into scout.trackers(name,url,collector,coverage,cadence,enabled) values('HUB Ocean events calendar','https://www.hubocean.earth/events-calendar','web','Ocean data and AI training','7 days',true) returning *")).rows[0];
  const options={trackerId:tracker.id,since:'2026-09-24',read,model};
  const first=await collectHSA(db,options);assert.equal(first.created,1,JSON.stringify(first));assert.equal(calls,1);
  let row=(await db.query('select * from scout.records')).rows[0];assert.equal(row.priority,'high');assert.equal(row.starts_at.toISOString(),'2026-10-22T13:30:00.000Z');assert.equal(row.ends_at.toISOString(),'2026-10-22T14:15:00.000Z');
  assert.equal(row.organization,'HUB Ocean');assert.equal(row.location,'Online (Teams)');assert.match(row.registration_url,/events.teams.microsoft.com/);
  const repeat=await collectHSA(db,options);assert.equal(repeat.outcome,'no_change');assert.equal(calls,1);assert.equal(repeat.skipped,1);
  const source=(await db.query('select * from scout.evidence where record_id=$1',[row.id])).rows[0];
  await db.query("update scout.evidence set parsed=jsonb_set(parsed,'{assessment,state}','\"pending\"') where id=$1",[source.id]);supporting=true;
  assert.equal((await collectHSA(db,options)).changed,0);assert.deepEqual((await db.query('select * from scout.records')).rows[0],row);
  const preserved=(await db.query('select parsed from scout.evidence where id=$1',[source.id])).rows[0].parsed;
  for(const field of CONTENT_FIELDS)assert.deepEqual(preserved[field],source.parsed[field]);
  const next=await assessmentInput(db,{...source,parsed:preserved},tracker);
  for(const field of ['starts_at','ends_at','event_url','registration_url'])assert.deepEqual(next.scripted[field],source.parsed[field]);supporting=false;
  feed.calendar=feed.calendar.replaceAll('20261022','20261023');feed.upcoming[0].endDate+=86400000;
  const changed=await collectHSA(db,options);assert.equal(changed.changed,1,JSON.stringify(changed));assert.equal(calls,3);
  row=(await db.query('select * from scout.records')).rows[0];assert.equal(row.starts_at.toISOString(),'2026-10-23T13:30:00.000Z');assert.equal(row.status,'rescheduled');
  malformed=true;const failed=await collectHSA(db,options);assert.equal(failed.outcome,'partial');assert.equal(calls,3);assert.deepEqual((await db.query('select * from scout.records')).rows[0],row);
  feed={unexpected:true};assert.equal((await collectHSA(db,options)).outcome,'failed');assert.deepEqual((await db.query('select * from scout.records')).rows[0],row);
 }finally{await db.close();}
});

test('combined evidence can raise relevance while weaker facts preserve cancellation/date; uncertainty preserves the accepted priority',async()=>{
 const db=await database();let action='update',priority='high',postId='weaker';
 const title='Marine data standards workshop';
 try{
  const r=(await db.query(`insert into scout.records(kind,title,organization,identity_key,priority,starts_at,status,evidence_rank,evidence_at)
    values('event',$1,'High Seas Alliance','known','normal','2026-10-05T12:00:00Z','cancelled',2,'2026-09-30T00:00:00Z') returning *`,[title])).rows[0];
  const read=async(url,budget)=>{budget.requests++;return{url,headers:{},body:JSON.stringify({feed:[{post:{uri:`at://did:plc:test/app.bsky.feed.post/${postId}`,author:{handle:'weaker.bsky.social'},indexedAt:'2026-10-01T00:00:00Z',record:{text:`${title}. High Seas Alliance. Scheduled.`,createdAt:'2026-10-01T00:00:00Z'}}}]})};};
  const model=async(_question,inputs)=>inputs.map(i=>({...result,source_id:i.source_id,action,record_id:r.id,priority,
    candidate:full({kind:'event',title,organization:'High Seas Alliance',status:'scheduled'}),quotes:[title]}));
  const first=await collectHSA(db,{since:'2026-09-01',read,model});assert.equal(first.changed,1);
  let after=(await db.query('select * from scout.records')).rows[0];
  assert.equal(after.priority,'high');assert.equal(after.status,'cancelled');assert.deepEqual(after.starts_at,r.starts_at);
  assert.equal((await db.query("select parsed#>>'{assessment,priority_accepted}' accepted from scout.evidence")).rows[0].accepted,'true');
  postId='corroboration';action='supporting_evidence';priority='normal';
  assert.equal((await collectHSA(db,{since:'2026-09-01',read,model})).changed,1);
  after=(await db.query('select * from scout.records')).rows[0];assert.equal(after.priority,'normal');assert.equal(after.status,'cancelled');
  postId='uncertain';action='uncertain';priority=null;
  await collectHSA(db,{since:'2026-09-01',read,model});
  assert.deepEqual((await db.query('select * from scout.records')).rows[0],after);
  await db.exec(`insert into auth.users(id) values('00000000-0000-0000-0000-000000000001');
    insert into auth.identities values('00000000-0000-0000-0000-000000000001','google','{"iss":"https://accounts.google.com","email_verified":true,"custom_claims":{"hd":"oceanagentics.com"}}');
    set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';set role authenticated;`);
  const visible=(await db.query('select priority_reason from scout.source_details')).rows;
  assert.equal(visible.length,2);assert.ok(visible.every(row=>row.priority_reason===result.reason));
  await assert.rejects(db.query("update scout.records set priority='low'"),{code:'42501'});
  await assert.rejects(db.query('select * from scout.evidence'),{code:'42501'});
 }finally{await db.close();}
});

test('HTML context includes visible facts past a long head and a changed tail; source hashes retain no duplicate fields',async()=>{
 const db=await database();
 try{
  const tracker=(await db.query('select * from scout.trackers limit 1')).rows[0];
  const prefix='Public background. '.repeat(200);
  const old=`<head><script>${'x'.repeat(5000)}</script></head><main>${prefix}Workshop scheduled.</main>`;
  const a=await observe(db,tracker.id,input.url,old,null,{}, {text:prefix+'Workshop scheduled.'},{},'2026-10-01T00:00:00Z');
  const b=await observe(db,tracker.id,input.url,old.replace('Workshop scheduled.','Workshop cancelled.'),null,{}, {text:prefix+'Workshop cancelled.'},{},'2026-10-01T01:00:00Z');
  const context=await assessmentInput(db,b,tracker);
  assert.match(context.text,/Workshop cancelled/);assert.ok(!context.text.includes('xxxx'));assert.equal(context.context_truncated,true);
  assert.equal(b.parsed.source.previous_id,a.id);assert.equal(b.parsed.source.fields.text.length,64);
 }finally{await db.close();}
});

test('conference sessions and recurring dates stay distinct even when they share an event URL',async()=>{
 const db=await database();
 const url='https://highseasalliance.org/events/conference';
 const examples=[{key:'one',title:'Ocean conference Session A',starts_at:'2026-10-10T12:00:00Z'},
   {key:'two',title:'Ocean conference Session B',starts_at:'2026-10-10T12:00:00Z'},
   {key:'three',title:'Ocean conference Session A',starts_at:'2026-11-10T12:00:00Z'}];
 const feed={feed:examples.map(c=>({post:{uri:`at://did:plc:test/app.bsky.feed.post/${c.key}`,author:{handle:HSA},indexedAt:'2026-10-01T00:00:00Z',record:{text:`${c.title}. High Seas Alliance. ${c.starts_at} ${url}`,createdAt:'2026-10-01T00:00:00Z'}}}))};
 const read=async(u,budget)=>{budget.requests++;return{url:u,headers:{},body:JSON.stringify(feed)};};
 const model=async(_question,inputs)=>inputs.map(i=>{const c=examples.find(c=>i.url.endsWith('/'+c.key));return {...result,source_id:i.source_id,priority:'normal',candidate:full({kind:'event',title:c.title,organization:'High Seas Alliance',starts_at:c.starts_at,event_url:url}),quotes:[c.title]};});
 try{
  const run=await collectHSA(db,{since:'2026-09-01',read,model});assert.equal(run.created,3);assert.equal(run.pending,0);
  const rows=(await db.query('select * from scout.records order by id')).rows;assert.equal(rows.length,3);assert.equal(new Set(rows.map(r=>r.identity_key)).size,3);
  await collectHSA(db,{since:'2026-09-01',read,model});assert.deepEqual((await db.query('select * from scout.records order by id')).rows,rows);
 }finally{await db.close();}
});

test('saved live model results remain complete and source-backed under the accepted contract',async()=>{
 const cases=JSON.parse(await readFile(new URL('./fixtures/assessment-cases.json',import.meta.url),'utf8'));
 const results=JSON.parse(await readFile(new URL('./fixtures/assessment-results.json',import.meta.url),'utf8'));
 for(const c of cases){const stored=results.results.filter(r=>r.source_id===c.source_id).at(-1).actual;
   const actual=JSON.parse(JSON.stringify(stored).replaceAll('"$source_text"',JSON.stringify(c.text)));
   validateDecision(actual,c);assert.equal(actual.priority,c.expected.priority);assert.equal(actual.action,c.expected.action);assert.equal(actual.candidate?.kind??null,c.expected.kind);}
 assert.equal(results.accounting.model_attempts.length,2);
});
