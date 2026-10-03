import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {PGlite} from '@electric-sql/pglite';
import {collectHSA,HSA,HSA_WEB,IDDRI,DOSI_WEB,UNTC,DOALOS,UN_SIDE_EVENTS,sourceURL} from '../collector/hsa.js';
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
  const unsupported=(await db.query("select id from scout.trackers where collector='web' and url<>all($1::text[]) and url<>'https://www.hubocean.earth/events-calendar' limit 1",[[UNTC,DOALOS,UN_SIDE_EVENTS,HSA_WEB,IDDRI,DOSI_WEB]])).rows[0].id;
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

test('DOSI website independently discovers nine distinct items, retains technical guide context and gates cosmetic repeats while disabled',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/dosi-website.json.gz',import.meta.url))));let calls=0;const requested=[];
 try{
  const tracker=(await db.query('select * from scout.trackers where url=$1',[DOSI_WEB])).rows[0];
  const options={trackerId:tracker.id,validate:true,since:'2026-03-01',read:async(u,b)=>{b.requests++;requested.push(u);const r=Object.values(f).find(r=>r.url===u);assert.ok(r,'Only discovered recorded URLs');return r;},model:async()=>{throw new Error('Observation-only fixture');}};
  await assert.rejects(collectHSA(db,{...options,validate:false}),/not yet proven/);
  const first=await collectHSA(db,options);assert.equal(first.candidates,9,first.warnings.join('; '));assert.equal(first.requests,5);assert.equal(first.outcome,'partial');assert.equal(first.issues_listed,10);assert.equal(first.issues_selected,10);
  assert.deepEqual(requested,[f.home.url,f.guide.url,f.feed.url,f.roundup.url,f.newsletter.url]);
  assert.match(first.warnings.join(' '),/year-only recaps/);assert.match(first.warnings.join(' '),/9 issues not followed/);assert.match(first.warnings.join(' '),/14 linked items not captured/);
  const sources=(await db.query('select * from scout.evidence')).rows,guide=sources.find(s=>s.url===f.guide.url);
  assert.equal(guide.published_at,null);assert.equal(guide.parsed.dosi_web.publication_on,'2026-04-02');assert.equal(guide.parsed.start_on,null);assert.equal(JSON.parse(guide.content).body,f.guide.body);
  const input=await assessmentInput(db,guide,tracker);assert.match(input.text,/centralised platform or a network of regional nodes/);assert.match(input.text,/who will undertake such development/);assert.ok(!input.context_truncated);
  assert.equal(input.scripted.description,'The Clearing-House Mechanism (CHM) will serve as a centralised open-access platform to enable Parties to access, provide, and disseminate information, knowledge, and data related to the BBNJ Agreement.');assert.ok(input.scripted.description.length<=280);
  assert.throws(()=>validateDecision({...result,source_id:input.source_id,candidate:full({title:input.scripted.title,description:input.scripted.description.slice(0,-1)}),quotes:[input.scripted.title]},input),/complete source sentence/);
  assert.throws(()=>validateDecision({...result,source_id:input.source_id,candidate:full({title:input.scripted.title,kind:'event'}),quotes:[input.scripted.title]},input),/announcement identity/);
  const africa=sources.find(s=>s.parsed.title.startsWith('Science for BBNJ'));
  assert.equal(africa.parsed.start_on,'2026-10-06');assert.equal(africa.parsed.starts_at,null);assert.equal(africa.parsed.event_url,null);assert.equal(africa.parsed.registration_url,null);assert.equal(africa.parsed.organization,null);
  assert.equal(africa.parsed.dosi_web.issue_published_at,'2026-10-01T09:02:04.000Z');assert.equal(africa.published_at,null);
  assert.equal(new Set(sources.map(s=>s.url+':'+s.parsed.source.item_key)).size,9);assert.ok(sources.every(s=>!s.url.includes('#')&&s.url!==DOSI_WEB));
  const model=async(_p,inputs)=>{calls++;return inputs.map(i=>({...result,source_id:i.source_id,candidate:full(Object.fromEntries(CONTENT_FIELDS.map(k=>[k,i.scripted[k]??null]))),quotes:[i.scripted.title]}));};
  const assessed=await collectHSA(db,{...options,sourceId:guide.id,model});assert.equal(assessed.created,1);assert.equal(assessed.assessed,1);assert.equal(calls,1);
  const record=(await db.query('select * from scout.records')).rows[0];assert.equal(record.kind,'announcement');assert.equal(record.starts_at,null);
  for(const key of ['home','guide','roundup'])f[key].body=f[key].body.replace('<body','<!-- unrelated cancellation and rotating news --> <body').replace('<p','<p data-cosmetic="1"');
  f.newsletter.body=f.newsletter.body.replaceAll('padding: 0 9px 0 9px','padding: 1px');
  const repeated=await collectHSA(db,{...options,sourceId:guide.id,model});assert.equal(repeated.skipped,9);assert.equal(repeated.candidates+repeated.created+repeated.changed,0);assert.equal(calls,1);
  assert.deepEqual((await db.query('select * from scout.records')).rows,[record]);assert.deepEqual((await db.query('select * from scout.trackers where id=$1',[tracker.id])).rows[0],tracker);
 }finally{await db.close();}
});

test('DOSI website guide material content/publication and newsletter date/link changes preserve exact identities and separate issues',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/dosi-website.json.gz',import.meta.url))));
 try{
  const tracker=(await db.query('select * from scout.trackers where url=$1',[DOSI_WEB])).rows[0];
  const options={trackerId:tracker.id,validate:true,since:'2026-03-01',read:async(u,b)=>{b.requests++;return Object.values(f).find(r=>r.url===u);},model:async()=>{throw new Error('Observation-only fixture');}};
  await collectHSA(db,options);
  const old=(await db.query('select * from scout.evidence where url=$1',[f.guide.url])).rows[0];
  f.guide.body=f.guide.body.replaceAll('who will undertake such development','who will coordinate such development');
  assert.equal((await collectHSA(db,options)).candidates,1);
  f.guide.body=f.guide.body.replace('April 2, 2026','April 3, 2026');
  assert.equal((await collectHSA(db,options)).candidates,1);
  const latest=(await db.query('select * from scout.evidence where url=$1 order by collected_at desc limit 1',[f.guide.url])).rows[0];assert.equal(latest.parsed.source.identity,old.parsed.source.identity);assert.equal(latest.parsed.dosi_web.publication_on,'2026-04-03');assert.equal(latest.parsed.starts_at,null);
  f.newsletter.body=f.newsletter.body.replaceAll('6 October 2026','7 October 2026');assert.equal((await collectHSA(db,options)).candidates,2);
  const africa=(await db.query("select * from scout.evidence where parsed->>'title' like 'Science for BBNJ%' order by collected_at desc limit 1")).rows[0];assert.equal(africa.parsed.start_on,'2026-10-07');assert.equal(africa.parsed.starts_at,null);
  const key='https://www.sciencedirect.com/science/article/pii/S0308597X26002629';f.newsletter.body=f.newsletter.body.replaceAll(key,key+'?edition=2');assert.equal((await collectHSA(db,options)).candidates,1);
  const paper=(await db.query("select * from scout.evidence where parsed->>'title' like 'Connecting international%' order by collected_at desc limit 1")).rows[0];assert.equal(paper.parsed.source.item_key,key+'?edition=2');
  const next=f.newsletter.url.replace('01-10','08-10');f.roundup.body=f.roundup.body.replaceAll(f.newsletter.url,next);f.newsletter.url=next;
  assert.equal((await collectHSA(db,options)).candidates,8);assert.equal((await db.query('select count(*)::int n from scout.evidence where url=$1',[next])).rows[0].n,8);
 }finally{await db.close();}
});

test('DOSI website source failures preserve captures and exclude stale pending content from model work',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/dosi-website.json.gz',import.meta.url))));let calls=0,fail;
 try{
  const tracker=(await db.query('select * from scout.trackers where url=$1',[DOSI_WEB])).rows[0];
  const options={trackerId:tracker.id,validate:true,since:'2026-03-01',read:async(u,b)=>{b.requests++;if(u===fail)throw new Error('Recorded outage HTTP 503');return Object.values(f).find(r=>r.url===u);},model:async()=>{throw new Error('Observation-only fixture');}};
  await collectHSA(db,options);const before=(await db.query('select id,content_hash,content,parsed from scout.evidence order by id')).rows;
  const guide=before.find(s=>s.parsed.title==='A DOSI Guide to BBNJ PrepCom'),item=before.find(s=>s.parsed.source.item_key);
  const model=async()=>{calls++;throw new Error('Unexpected stale assessment');};
  fail=f.home.url;assert.equal((await collectHSA(db,{...options,sourceId:guide.id,model})).outcome,'failed');
  for(const key of ['feed','roundup','newsletter']){fail=f[key].url;const run=await collectHSA(db,{...options,sourceId:item.id,model});assert.equal(run.candidates,0);assert.match(run.warnings.join(' '),/503/);}
  fail=f.guide.url;await collectHSA(db,{...options,sourceId:guide.id,model});fail=null;
  f.guide.body=f.guide.body.replace('April 2, 2026','April 31, 2026');assert.match((await collectHSA(db,{...options,sourceId:guide.id,model})).warnings.join(' '),/publication date/);
  f.newsletter.body='Malformed';await collectHSA(db,{...options,sourceId:item.id,model});
  f.feed.body=f.feed.body.replace('</rss>','');await collectHSA(db,{...options,sourceId:item.id,model});
  assert.equal(calls,0);assert.deepEqual((await db.query('select id,content_hash,content,parsed from scout.evidence order by id')).rows,before);
 }finally{await db.close();}
});

test('DOSI independent website newsletter corroborates retained Bluesky paper and Africa event without record changes or unrelated merges',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/dosi-website.json.gz',import.meta.url))));
 try{
  const tracker=(await db.query('select * from scout.trackers where url=$1',[DOSI_WEB])).rows[0],feed=(await db.query("select id from scout.trackers where seed_key='bbnj-trackers-2026-10-01:18'")).rows[0];
  const options={trackerId:tracker.id,validate:true,since:'2026-03-01',read:async(u,b)=>{b.requests++;return Object.values(f).find(r=>r.url===u);},model:async()=>{throw new Error('Observation-only fixture');}};
  await collectHSA(db,options);
  const items=(await db.query("select * from scout.evidence where parsed->>'title' like 'Connecting international%' or parsed->>'title' like 'Science for BBNJ%'")).rows;
  for(const s of items){const p=s.parsed;
   const r=(await db.query('insert into scout.records(kind,title,description,priority,identity_key) values($1,$2,$3,\'normal\',$4) returning *',[p.kind,p.title,p.description.slice(0,280),p.source.identity])).rows[0];
   await db.query('insert into scout.evidence(tracker_id,record_id,url,content_hash,content,parsed,last_seen_at) values($1,$2,$3,$4,$5,$6,clock_timestamp())',[feed.id,r.id,s.url,s.content_hash,JSON.parse(s.content).item,{...p,assessment:{state:'complete'}}]);
  }
  const records=(await db.query('select * from scout.records order by id')).rows;
  for(const s of items){const run=await collectHSA(db,{...options,sourceId:s.id,model:async(_p,[i])=>{
    assert.equal(i.exact_ids.length,1);const candidate=full(Object.fromEntries(CONTENT_FIELDS.map(k=>[k,i.scripted[k]??null])));
    const other=records.find(r=>r.id!==i.exact_ids[0]);if(i.candidates.some(c=>c.id===other.id))assert.throws(()=>validateDecision({...result,source_id:i.source_id,action:'supporting_evidence',record_id:other.id,candidate,quotes:[candidate.title]},i));
    return[{...result,source_id:i.source_id,action:'supporting_evidence',record_id:i.exact_ids[0],candidate,priority:'normal',quotes:[candidate.title]}];}});assert.equal(run.assessed,1);assert.equal(run.created+run.changed,0);}
  assert.deepEqual((await db.query('select * from scout.records order by id')).rows,records);assert.equal((await db.query('select count(*)::int n from scout.evidence where record_id is not null')).rows[0].n,4);
 }finally{await db.close();}
});

test('DOSI guide context does not fabricate technical evidence for general material or turn publication into an event',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/dosi-website.json.gz',import.meta.url))));
 try{
  const tracker=(await db.query('select * from scout.trackers where url=$1',[DOSI_WEB])).rows[0];
  f.guide.body=f.guide.body.replace(/<p\b[^>]*><strong>The Clearing-House Mechanism:[\s\S]*?<\/p>/,'');
  const options={trackerId:tracker.id,validate:true,since:'2026-03-01',read:async(u,b)=>{b.requests++;return Object.values(f).find(r=>r.url===u);},model:async()=>{throw new Error('Observation-only fixture');}};
  await collectHSA(db,options);const s=(await db.query('select * from scout.evidence where url=$1',[f.guide.url])).rows[0];
  const run=await collectHSA(db,{...options,sourceId:s.id,model:async(_p,[i])=>{assert.doesNotMatch(i.text,/technical architecture|regional nodes|who will undertake/);assert.equal(i.scripted.starts_at,null);return[{...result,source_id:i.source_id,action:'no_substantive_change',candidate:null,priority:'low',quotes:[i.scripted.title],reason:'Recorded general-context exclusion fixture'}];}});
  assert.equal(run.assessed,1);assert.equal(run.created,0);assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,0);
 }finally{await db.close();}
});

test('actual DOSI guide assessment retains technical High relevance and a complete literal description with publication-only precision',async()=>{
 const {live}=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/dosi-website.json.gz',import.meta.url))));
 validateDecision(Object.fromEntries(SCHEMA.items.required.map(k=>[k,live.decision[k]])),live.input);
 assert.equal(live.decision.state,'complete');assert.equal(live.decision.priority,'high');assert.equal(live.record.priority,'high');assert.equal(live.record.kind,'announcement');
 assert.equal(live.record.title,live.input.scripted.title);assert.equal(live.record.description,live.input.scripted.description);assert.equal(live.record.description.length,201);assert.ok(live.record.description.endsWith('.'));
 assert.match(live.input.text,/technical architecture.*centralised platform or a network of regional nodes/);assert.match(live.input.text,/who will undertake such development/);assert.equal(live.input.context_truncated,false);
 assert.equal(live.input.scripted.dosi_web.publication_on,'2026-04-02');assert.equal(live.decision.model_decision,undefined);assert.equal(live.accounting.model_attempts.length,1);assert.equal(live.accounting.model_attempts[0].input_bound,6000);
 for(const key of ['organization','starts_at','ends_at','event_url','registration_url','location','status','last_communicated_at'])assert.equal(live.record[key],null);
});

test('HSA website independently follows recorded RSS/API and registration, preserves explicit timezone precision and gates cosmetic repeats',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/hsa-website.json.gz',import.meta.url))));let calls=0;
 f.feed.body=f.feed.body.replace(/<item>[\s\S]*?<\/item>/g,s=>s.includes('>6800</post-id>')?s:'');
 try {
  const tracker=(await db.query('select * from scout.trackers where url=$1',[HSA_WEB])).rows[0];
  const options={trackerId:tracker.id,validate:true,since:'2026-09-28',read:async(url,budget)=>{budget.requests++;return url==='https://bit.ly/clhmreg1'?f.registration:Object.values(f).find(r=>r.url===sourceURL(url));},model:async(_instruction,inputs)=>{calls++;return inputs.map(i=>{
   assert.equal(i.scripted.hsa_web.session,true);assert.match(i.scripted.title,/^Session 1 - Designing/);assert.equal(i.scripted.starts_at,'2026-10-15T13:00:00.000Z');
   assert.equal(i.scripted.ends_at,null);assert.equal(i.scripted.location,null);assert.equal(i.scripted.organization,'High Seas Alliance and partners');
   assert.match(i.scripted.event_url,/zoom.us\/webinar\/register\/WN_NvlqQrDmR8WISTqMw-vSeg$/);assert.match(i.text,/basic functions and operational requirements/);
   const candidate=full(Object.fromEntries(CONTENT_FIELDS.map(k=>[k,i.scripted[k]])));
   assert.throws(()=>validateDecision({...result,source_id:i.source_id,candidate:{...candidate,starts_at:'2026-09-28T07:46:32Z'},quotes:[candidate.title]},i),/unsupported|unconfirmed/);
   assert.throws(()=>validateDecision({...result,source_id:i.source_id,candidate:{...candidate,ends_at:'2026-10-15T14:00:00Z'},quotes:[candidate.title]},i),/unsupported|unconfirmed/);
   return {...result,source_id:i.source_id,candidate:{...candidate,event_url:null,registration_url:null},quotes:[candidate.title]};
  });}};
  await assert.rejects(collectHSA(db,{...options,validate:false}),/not yet proven/);
  const first=await collectHSA(db,options);assert.equal(first.created,1,first.warnings.join('; '));assert.equal(first.assessed,1);assert.equal(first.requests,3);assert.equal(first.outcome,'partial');
  const record=(await db.query('select * from scout.records')).rows[0],source=(await db.query('select * from scout.evidence')).rows[0];
  assert.equal(record.priority,'high');assert.equal(record.starts_at.toISOString(),'2026-10-15T13:00:00.000Z');assert.equal(record.event_url,record.registration_url);
  assert.equal(source.published_at.toISOString(),'2026-09-28T07:46:32.000Z');assert.equal(source.url,JSON.parse(f['chm-api'].body).link);assert.equal(source.parsed.assessment.model_decision.candidate.event_url,null);
  f['chm-api'].body=f['chm-api'].body.replace('"modified_gmt":"2026-09-28T07:46:32"','"modified_gmt":"2026-10-03T01:00:00"').replace('<p>','<p class=\\"cosmetic\\">');
  f.registration.body=f.registration.body.replace('window.setData = {','/* harmless asset revision */ window.setData = {');
  const repeated=await collectHSA(db,options);assert.equal(repeated.candidates+repeated.created+repeated.changed,0);assert.equal(calls,1);assert.deepEqual((await db.query('select * from scout.records')).rows,[record]);
  assert.equal((await db.query('select count(*)::int n from scout.evidence')).rows[0].n,1);assert.deepEqual((await db.query('select * from scout.trackers where id=$1',[tracker.id])).rows[0],tracker);
 }finally{await db.close();}
});

test('HSA website material descriptions and compatible date corrections update the same retained session',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/hsa-website.json.gz',import.meta.url))));let calls=0;
 f.feed.body=f.feed.body.replace(/<item>[\s\S]*?<\/item>/g,s=>s.includes('>6800</post-id>')?s:'');
 try {
  const tracker=(await db.query('select * from scout.trackers where url=$1',[HSA_WEB])).rows[0];
  const options={trackerId:tracker.id,validate:true,since:'2026-09-28',read:async(url,budget)=>{budget.requests++;return url==='https://bit.ly/clhmreg1'?f.registration:Object.values(f).find(r=>r.url===sourceURL(url));},model:async(_instruction,inputs)=>{calls++;return inputs.map(i=>({...result,source_id:i.source_id,action:i.exact_ids.length?'update':'new',record_id:i.exact_ids[0]??null,candidate:full(Object.fromEntries(CONTENT_FIELDS.map(k=>[k,i.scripted[k]]))),quotes:[i.text.slice(0,100)]}));}};
  await collectHSA(db,options);const before=(await db.query('select * from scout.records')).rows[0];
  f['chm-api'].body=f['chm-api'].body.replace('basic functions and operational requirements','revised basic functions and operational requirements');
  const description=await collectHSA(db,options);assert.equal(description.changed,1,description.warnings.join('; '));assert.equal(description.created,0);
  f['chm-api'].body=f['chm-api'].body.replace('15 October 2026','16 October 2026');f.registration.body=f.registration.body.replace('Oct 15, 2026','Oct 16, 2026');
  const schedule=await collectHSA(db,{...options,since:'2026-10-01'});assert.equal(schedule.changed,1,schedule.warnings.join('; '));assert.equal(schedule.created,0);assert.equal(calls,3);
  const after=(await db.query('select * from scout.records')).rows[0];assert.equal(after.id,before.id);assert.equal(after.identity_key,before.identity_key);assert.equal(after.starts_at.toISOString(),'2026-10-16T13:00:00.000Z');assert.equal(after.status,'rescheduled');
  assert.equal((await db.query('select count(*)::int n from scout.evidence')).rows[0].n,3);
 }finally{await db.close();}
});

test('HSA literal cancellation survives failed registration and removal; omitted status or unrelated past cancellation cannot clear it',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/hsa-website.json.gz',import.meta.url))));let calls=0,fail=false;
 f.feed.body=f.feed.body.replace(/<item>[\s\S]*?<\/item>/g,s=>s.includes('>6800</post-id>')?s:'');
 try {
  const tracker=(await db.query('select * from scout.trackers where url=$1',[HSA_WEB])).rows[0];
  const options={trackerId:tracker.id,validate:true,since:'2026-09-28',read:async(url,budget)=>{budget.requests++;if(fail&&url==='https://bit.ly/clhmreg1')throw new Error('Source returned HTTP 404');return url==='https://bit.ly/clhmreg1'?f.registration:Object.values(f).find(r=>r.url===sourceURL(url));},model:async(_instruction,inputs)=>{calls++;return inputs.map(i=>{
   const candidate=full(Object.fromEntries(CONTENT_FIELDS.map(k=>[k,i.scripted[k]]))),record_id=i.exact_ids[0]??null,action=record_id?'update':'new';
   if(i.scripted.status==='cancelled')assert.ok(i.text.includes('This webinar has been cancelled.'));
   if(i.text.includes('An earlier unrelated workshop was cancelled.')){
    assert.equal(i.scripted.status,null);
    assert.throws(()=>validateDecision({...result,source_id:i.source_id,action,record_id,candidate:{...candidate,status:'cancelled'},quotes:['An earlier unrelated workshop was cancelled.']},i),/unconfirmed/);
    assert.throws(()=>validateDecision({...result,source_id:i.source_id,action,record_id,candidate,clear_fields:['status'],quotes:['An earlier unrelated workshop was cancelled.']},i),/cannot be cleared/);
   }
   return {...result,source_id:i.source_id,action,record_id,candidate,quotes:[i.scripted.status==='cancelled'?'This webinar has been cancelled.':i.text.slice(0,100)]};
  });}};
  await collectHSA(db,options);const original=(await db.query('select * from scout.records')).rows[0],article=JSON.parse(f['chm-api'].body);
  const title=article.title.rendered,content=article.content.rendered;fail=true;
  article.title.rendered='A different webinar';article.content.rendered='<p>This webinar has been cancelled.</p>'+content;
  f.feed.body=f.feed.body.replace(title,article.title.rendered);f['chm-api'].body=JSON.stringify(article);
  const ambiguous=await collectHSA(db,options);assert.equal(ambiguous.assessed+ambiguous.candidates,0);assert.equal(calls,1);assert.deepEqual((await db.query('select * from scout.records')).rows,[original]);
  f.feed.body=f.feed.body.replace(article.title.rendered,title);article.title.rendered=title;article.content.rendered=content;
  const retained=article.content.rendered.replace(/<p>REGISTER HERE:[\s\S]*?<\/p>/,'');
  article.content.rendered='<p>This webinar has been cancelled.</p>'+article.content.rendered;f['chm-api'].body=JSON.stringify(article);fail=true;
  const cancelled=await collectHSA(db,options);assert.equal(cancelled.changed,1,cancelled.warnings.join('; '));assert.equal(cancelled.created,0);
  assert.ok(cancelled.warnings.includes('Source returned HTTP 404'));const record=(await db.query('select * from scout.records')).rows[0];assert.equal(record.id,original.id);assert.equal(record.identity_key,original.identity_key);assert.equal(record.status,'cancelled');assert.equal(record.registration_url,original.registration_url);assert.deepEqual(record.starts_at,original.starts_at);
  for(const body of ['<p>This webinar has been cancelled.</p>'+retained,retained,'<p>An earlier unrelated workshop was cancelled.</p>'+retained]){
   article.content.rendered=body;f['chm-api'].body=JSON.stringify(article);const change=await collectHSA(db,options);assert.equal(change.assessed,1,change.warnings.join('; '));assert.equal(change.created,0);
   assert.equal((await db.query('select status from scout.records')).rows[0].status,'cancelled');
  }
  const repeat=await collectHSA(db,options);assert.equal(repeat.candidates+repeat.changed+repeat.created,0);assert.equal(calls,5);assert.equal((await db.query('select count(*)::int n from scout.evidence')).rows[0].n,5);
 }finally{await db.close();}
});

test('HSA current RSS enumeration captures separate articles; recap publication and multiple sessions cannot become one scheduled event',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/hsa-website.json.gz',import.meta.url))));
 try {
  const tracker=(await db.query('select * from scout.trackers where url=$1',[HSA_WEB])).rows[0];
  const options={trackerId:tracker.id,validate:true,since:'2026-09-28',read:async(url,budget)=>{budget.requests++;return url==='https://bit.ly/clhmreg1'?f.registration:Object.values(f).find(r=>r.url===sourceURL(url));}};
  const first=await collectHSA(db,options);assert.equal(first.articles_listed,10);assert.equal(first.articles_selected,4);assert.equal(first.candidates,4,first.warnings.join('; '));assert.equal(first.requests,6);assert.equal(first.pending,4);
  const sources=(await db.query('select * from scout.evidence')).rows,recap=sources.find(s=>s.parsed.hsa_web.id==='6810'),multi=sources.find(s=>s.parsed.hsa_web.id==='6803');
  assert.equal(recap.published_at.toISOString(),'2026-10-01T10:26:53.000Z');assert.equal(recap.parsed.hsa_web.recap,true);
  const i=await assessmentInput(db,recap,tracker),candidate=full(Object.fromEntries(CONTENT_FIELDS.map(k=>[k,i.scripted[k]])));
  assert.equal(candidate.kind,'announcement');assert.equal(candidate.starts_at,null);assert.equal(candidate.event_url,null);
  assert.throws(()=>validateDecision({...result,source_id:i.source_id,candidate:{...candidate,kind:'event'},quotes:[candidate.title]},i),/unconfirmed/);
  const m=await assessmentInput(db,multi,tracker);assert.equal(m.scripted.hsa_web.multiple,true);
  assert.throws(()=>validateDecision({...result,source_id:m.source_id,candidate:full({title:m.scripted.title}),quotes:[m.scripted.title]},m),/multiple HSA/);
  const bounded=await collectHSA(db,{...options,since:'2026-09-01'});assert.equal(bounded.articles_selected,7);assert.ok(bounded.warnings.includes('HSA article limit reached'));assert.equal(bounded.requests,6);assert.equal(bounded.candidates,0);
 }finally{await db.close();}
});

test('HSA RSS/API failures and conflicting article/registration clocks preserve known evidence and never assess stale pending data',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/hsa-website.json.gz',import.meta.url))));let fail=null,calls=0;
 f.feed.body=f.feed.body.replace(/<item>[\s\S]*?<\/item>/g,s=>s.includes('>6800</post-id>')?s:'');
 try {
  const tracker=(await db.query('select * from scout.trackers where url=$1',[HSA_WEB])).rows[0];
  const options={trackerId:tracker.id,validate:true,since:'2026-09-28',read:async(url,budget)=>{budget.requests++;const key=url==='https://bit.ly/clhmreg1'?'registration':url.endsWith('/feed/')?'feed':'chm-api';
   if(fail?.key===key){if(fail.error)throw new Error(fail.error);return {...f[key],body:fail.body};}return f[key];}};
  await collectHSA(db,options);const sources=(await db.query('select * from scout.evidence')).rows;assert.equal(sources.length,1);
  for(const bad of [{key:'feed',body:'<html>challenge</html>'},{key:'feed',body:f.feed.body.replace('</rss>','')},{key:'chm-api',body:'{}'},{key:'chm-api',body:f['chm-api'].body.replace('"id":6800','"id":6810')},
   {key:'chm-api',body:f['chm-api'].body.replace('9AM EDT','10AM EDT')},{key:'chm-api',body:f['chm-api'].body.replace('15 October 2026','31 February 2026')},{key:'registration',body:f.registration.body.replace('Oct 15, 2026 09:00 PM','Oct 15, 2026 10:00 PM')},{key:'registration',error:'HTTP 403'}]){
   fail=bad;const run=await collectHSA(db,{...options,model:async()=>{calls++;throw new Error('Stale assessment');}});assert.equal(run.candidates+run.assessed,0,run.warnings.join('; '));assert.equal(calls,0);assert.deepEqual((await db.query('select * from scout.evidence')).rows,sources);
  }
 }finally{await db.close();}
});

test('HSA unavailable registration never infers the publisher as organizer; unrelated advocacy stays Low with no record',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/hsa-website.json.gz',import.meta.url))));
 f.feed.body=f.feed.body.replace(/<item>[\s\S]*?<\/item>/g,s=>s.includes('>6800</post-id>')?s:'');
 try {
  const tracker=(await db.query('select * from scout.trackers where url=$1',[HSA_WEB])).rows[0];
  const options={trackerId:tracker.id,validate:true,since:'2026-09-28',read:async(url,budget)=>{budget.requests++;if(url==='https://bit.ly/clhmreg1')throw new Error('HTTP 403');return Object.values(f).find(r=>r.url===sourceURL(url));}};
  const initial=await collectHSA(db,{...options,model:async(_instruction,inputs)=>inputs.map(i=>{
   assert.equal(i.scripted.organization,null);assert.equal(i.scripted.starts_at,'2026-10-15T13:00:00.000Z');
   const candidate=full(Object.fromEntries(CONTENT_FIELDS.map(k=>[k,i.scripted[k]])));
   assert.throws(()=>validateDecision({...result,source_id:i.source_id,candidate:{...candidate,organization:'High Seas Alliance'},quotes:[candidate.title]},i),/unsupported|unconfirmed/);
   return {...result,source_id:i.source_id,candidate,quotes:[candidate.title]};
  })});assert.equal(initial.created,1,initial.warnings.join('; '));assert.equal((await db.query('select organization from scout.records')).rows[0].organization,null);
  const article=JSON.parse(f['chm-api'].body),old=article.title.rendered;article.id=6801;article.link=article.link.replace('webinar-alert','generic-advocacy');article.title.rendered='Generic ocean advocacy';article.content.rendered='<p>Celebrate the ocean and share your love for marine life.</p>';
  f.feed.body=f.feed.body.replaceAll(old,article.title.rendered).replaceAll('>6800<','>6801<').replaceAll('webinar-alert','generic-advocacy');f['chm-api']={...f['chm-api'],url:f['chm-api'].url.replace('/6800?','/6801?'),body:JSON.stringify(article)};
  const low=await collectHSA(db,{...options,model:async(_instruction,inputs)=>inputs.map(i=>({...result,source_id:i.source_id,priority:'low',candidate:full({title:i.scripted.title,description:i.scripted.description}),quotes:[i.scripted.title]}))});
  assert.equal(low.created,0);assert.equal(low.assessed,1,low.warnings.join('; '));assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,1);
 }finally{await db.close();}
});

test('HSA website reuses corroborated Bluesky session identity while keeping series, policy brief, EOI, MGR and future sessions separate',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/hsa-website.json.gz',import.meta.url))));
 f.feed.body=f.feed.body.replace(/<item>[\s\S]*?<\/item>/g,s=>s.includes('>6800</post-id>')?s:'');
 try {
  const tracker=(await db.query('select * from scout.trackers where url=$1',[HSA_WEB])).rows[0],url='https://us06web.zoom.us/webinar/register/WN_NvlqQrDmR8WISTqMw-vSeg';
  const title='Session 1 - Designing the BBNJ Clearing-House Mechanism: Basic Functions across the Agreement';
  const existing=(await db.query("insert into scout.records(kind,title,event_url,identity_key,priority) values('event',$1,$2,'post:existing-chm-session','normal') returning *",[title,url])).rows[0];
  const other=(await db.query("insert into scout.records(kind,title,identity_key,priority) values ('announcement','Designing the Clearing-House Mechanism webinar series','series','normal'),('announcement','Clearing-House Mechanism policy brief','policy','high'),('announcement','Expression of Interest Clearing-House Mechanism','eoi','high'),('event','Unpacking Part II Marine Genetic Resources','mgr','normal') returning *")).rows;
  const bsky=(await db.query("select id from scout.trackers where seed_key='bbnj-trackers-2026-10-01:17'")).rows[0];
  await db.query("insert into scout.evidence(tracker_id,record_id,url,content_hash,content,parsed) values($1,$2,'https://bsky.app/profile/highseasalliance.bsky.social/post/sample','sample','Recorded session link','{}')",[bsky.id,existing.id]);
  const options={trackerId:tracker.id,validate:true,since:'2026-09-28',read:async(u,budget)=>{budget.requests++;return u==='https://bit.ly/clhmreg1'?f.registration:Object.values(f).find(r=>r.url===sourceURL(u));},model:async(_instruction,inputs)=>inputs.map(i=>{
   assert.ok(i.candidates.every(r=>r.kind==='event'));const candidate=full(Object.fromEntries(CONTENT_FIELDS.map(k=>[k,i.scripted[k]])));
   if(candidate.title.startsWith('Session 2')) {assert.throws(()=>validateDecision({...result,source_id:i.source_id,action:'update',record_id:existing.id,candidate,quotes:[candidate.title]},i),/distinct session/);return {...result,source_id:i.source_id,candidate,quotes:[candidate.title]};}
   assert.ok(i.candidates.some(r=>r.id===existing.id));return {...result,source_id:i.source_id,action:'update',record_id:existing.id,candidate,quotes:[candidate.title]};
  })};
  const merged=await collectHSA(db,options);assert.equal(merged.created,0,merged.warnings.join('; '));assert.equal(merged.assessed,1);
  assert.equal((await db.query('select identity_key from scout.records where id=$1',[existing.id])).rows[0].identity_key,existing.identity_key);
  f.registration.body=f.registration.body.replaceAll('Session 1','Session 2').replaceAll('WN_NvlqQrDmR8WISTqMw-vSeg','WN_SecondSession').replace('Oct 15, 2026','Oct 16, 2026');f.registration.url=f.registration.url.replace('WN_NvlqQrDmR8WISTqMw-vSeg','WN_SecondSession');
  f['chm-api'].body=f['chm-api'].body.replaceAll('first session','second session').replace('15 October 2026','16 October 2026');
  const distinct=await collectHSA(db,options);assert.equal(distinct.created,1,distinct.warnings.join('; '));assert.equal(distinct.assessed,1);
  const all=(await db.query('select * from scout.records')).rows;assert.equal(all.length,6);for(const prior of other)assert.deepEqual(all.find(r=>r.id===prior.id),prior);
 }finally{await db.close();}
});

test('actual HSA website assessment retains the technical workshop, compatible UTC start, real registration and supported organizer',async()=>{
 const {live}=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/hsa-website.json.gz',import.meta.url))));
 validateDecision(live.decision.model_decision,live.input);validateDecision(Object.fromEntries(SCHEMA.items.required.map(k=>[k,live.decision[k]])),live.input);
 assert.equal(live.decision.state,'complete');assert.equal(live.record.priority,'high');assert.equal(live.record.title,live.input.scripted.title);
 assert.equal(live.record.organization,'High Seas Alliance and partners');assert.equal(new Date(live.record.starts_at).toISOString(),'2026-10-15T13:00:00.000Z');
 assert.equal(live.record.event_url,live.record.registration_url);assert.equal(live.record.event_url,'https://us06web.zoom.us/webinar/register/WN_NvlqQrDmR8WISTqMw-vSeg');
 assert.equal(live.record.description,live.input.scripted.description);assert.ok(live.record.description.endsWith('.'));
 assert.deepEqual(live.decision.candidate,live.decision.model_decision.candidate);
 for(const key of ['ends_at','location','status','last_communicated_at'])assert.equal(live.record[key],null);
});

test('recorded UN side event keeps unpublished reservation and parent dates unknown, retaining hosts, identity and repeat gating',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/un-side-events.json.gz',import.meta.url))));let calls=0;
 try {
  const tracker=(await db.query('select * from scout.trackers where url=$1',[UN_SIDE_EVENTS])).rows[0];
  const options={trackerId:tracker.id,validate:true,since:'2026-01-01',read:async(url,budget)=>{
   budget.requests++;if(url.endsWith('.pdf'))throw new Error('Response content exceeded max size');assert.ok(f[sourceURL(url)],url);return f[sourceURL(url)];
  },model:async(_instruction,inputs)=>{calls++;return inputs.map(i=>{
   assert.equal(i.scripted.side_event.id,'6915');assert.equal(i.scripted.side_event.schedule_published,false);
   assert.equal(i.scripted.starts_at,null);assert.equal(i.scripted.ends_at,null);assert.equal(i.scripted.location,null);assert.equal(i.scripted.status,null);
   assert.match(i.scripted.organization,/UN Division.*Secretariat of the Convention/);assert.match(i.text,/outcomes of the BBNJ Preparatory Commission/);
   assert.ok(i.links.some(u=>u.endsWith('Programme.pdf')));assert.doesNotMatch(i.text,/2026-07-29T|27 July/);
   const candidate=full(Object.fromEntries(CONTENT_FIELDS.map(k=>[k,i.scripted[k]])));
   assert.throws(()=>validateDecision({...result,source_id:i.source_id,candidate:{...candidate,starts_at:'2026-07-27T00:00:00Z'},quotes:[candidate.title]},i),/unsupported/);
   assert.throws(()=>validateDecision({...result,source_id:i.source_id,candidate:{...candidate,event_url:i.links[1]},quotes:[candidate.title]},i),/session facts/);
   return {...result,source_id:i.source_id,priority:'normal',candidate:{...candidate,event_url:null},quotes:[candidate.title]};
  });}};
  await assert.rejects(collectHSA(db,{...options,validate:false}),/not yet proven/);
  const first=await collectHSA(db,options);assert.equal(first.created,1,first.warnings.join('; '));assert.equal(first.assessed,1);assert.equal(first.outcome,'partial');assert.equal(first.sessions_listed,13);assert.equal(first.sessions_selected,1);assert.equal(first.requests,5);
  const record=(await db.query('select * from scout.records')).rows[0],source=(await db.query('select * from scout.evidence')).rows[0];
  assert.equal(record.event_url,'https://www.cbd.int/side-events/6915');assert.equal(record.starts_at,null);assert.equal(record.registration_url,null);assert.equal(source.published_at,null);
  assert.equal(source.parsed.source.item_key,record.event_url);assert.equal(source.parsed.assessment.model_decision.candidate.event_url,null);
  assert.equal(JSON.parse(source.content).responses.length,3);assert.match(source.content,/2026-07-29T10:15/);assert.ok(record.description.endsWith('.'));
  const reservation=Object.values(f).find(r=>r.url?.includes('/reservations/')&&JSON.parse(r.body)[0].sideEvent.id===6915);
  reservation.body=reservation.body.replace('2026-07-29T10:15:00.000Z','2026-07-30T10:15:00.000Z'); // Unpublished clock is not a material fact.
  f[UN_SIDE_EVENTS].body=f[UN_SIDE_EVENTS].body.replace('</body>','<nav>Rotating banner</nav></body>');
  const repeat=await collectHSA(db,options);assert.equal(repeat.candidates,0);assert.equal(repeat.created+repeat.changed,0);assert.equal(calls,1);
  assert.deepEqual((await db.query('select * from scout.records')).rows,[record]);assert.equal((await db.query('select count(*)::int n from scout.evidence')).rows[0].n,1);
  const context=await assessmentInput(db,source,tracker);let bytes=0;
  await gemini({apiKey:'injected',runId:first.run_id,ledger:{query:async()=>({rows:[]})},fetch:async(_url,r)=>{bytes=Buffer.byteLength(r.body);return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'[]'}]}}]});}})(INSTRUCTION,[context],SCHEMA);assert.ok(bytes<8000);
  assert.deepEqual((await db.query('select * from scout.trackers where id=$1',[tracker.id])).rows[0],tracker);
 }finally{await db.close();}
});

test('UN side-event published schedule updates same identity; status conflicts and reversed clocks preserve evidence with visible review warning',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/un-side-events.json.gz',import.meta.url))));let calls=0;
 const reservation=Object.values(f).find(r=>r.url?.includes('/reservations/')&&JSON.parse(r.body)[0].sideEvent.id===6915);
 const conference=Object.values(f).find(r=>r.url?.includes('/conferences?')&&r.body.includes('690223bab532af1ed6303146'));
 conference.body=conference.body.replace('false','true');
 try {
  const tracker=(await db.query('select * from scout.trackers where url=$1',[UN_SIDE_EVENTS])).rows[0];
  const options={trackerId:tracker.id,validate:true,since:'2026-01-01',read:async(url,budget)=>{
   budget.requests++;if(url.endsWith('.pdf'))throw new Error('Response content exceeded max size');
   if(url.includes('/venue-rooms?'))return {url,headers:{'content-type':'application/json'},body:JSON.stringify([{_id:'5d37431d867afd0001bfe57b',title:'Injected Room',location:'Injected Venue'}])};
   return f[sourceURL(url)];
  },model:async(_instruction,inputs)=>{calls++;return inputs.map(i=>({...result,source_id:i.source_id,action:i.exact_ids.length?'update':'new',record_id:i.exact_ids[0]??null,
   candidate:full(Object.fromEntries(CONTENT_FIELDS.map(k=>[k,i.scripted[k]]))),quotes:[i.scripted.title]}));}};
  const first=await collectHSA(db,options);assert.equal(first.created,1,first.warnings.join('; '));assert.equal(first.requests,6);
  const original=(await db.query('select * from scout.records')).rows[0];assert.equal(original.starts_at.toISOString(),'2026-07-29T10:15:00.000Z');assert.equal(original.ends_at.toISOString(),'2026-07-29T11:35:00.000Z');assert.equal(original.status,'scheduled');assert.equal(original.location,'Injected Room, Injected Venue');
  reservation.body=reservation.body.replaceAll('2026-07-29T','2026-07-30T');
  const update=await collectHSA(db,options);assert.equal(update.changed,1);assert.equal(update.created,0);assert.equal(calls,2);
  const revised=(await db.query('select * from scout.records')).rows[0];assert.equal(revised.id,original.id);assert.equal(revised.identity_key,original.identity_key);assert.equal(revised.starts_at.toISOString(),'2026-07-30T10:15:00.000Z');
  const sources=(await db.query('select * from scout.evidence order by id')).rows,good=reservation.body;
  for(const body of [good.replace(/"status":\s*"scheduled"/,'"status":"rejected"'),good.replace(/"status":\s*"scheduled"/,'"status":"withdrawn"'),good.replace(/"status":\s*"scheduled"/,'"status":"unknown"'),good.replace('2026-07-30T11:35:00.000Z','2026-07-30T09:00:00.000Z')]) {
   assert.notEqual(body,good);reservation.body=body;
   const conflict=await collectHSA(db,options);assert.equal(conflict.outcome,'partial');assert.ok(conflict.warnings.some(w=>w.includes('schedule conflict')&&w.includes('requires review')),conflict.warnings.join('; '));assert.equal(conflict.candidates+conflict.assessed+conflict.changed,0);assert.equal(calls,2);
   assert.deepEqual((await db.query('select * from scout.records')).rows,[revised]);assert.deepEqual((await db.query('select * from scout.evidence order by id')).rows,sources);
  }
 }finally{await db.close();}
});

test('UN identical-title CBD sessions remain distinct and an existing DOALOS event with the exact URL is reused',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/un-side-events.json.gz',import.meta.url))));
 f[UN_SIDE_EVENTS].body=f[UN_SIDE_EVENTS].body.replace(/<li\b[^>]*>[\s\S]*?<\/li>/g,item=>/cbd.int\/side-events\/(5838|5378)/.test(item)?item:'');
 try {
  const tracker=(await db.query('select * from scout.trackers where url=$1',[UN_SIDE_EVENTS])).rows[0];
  const title='Towards living in harmony with the ocean from coasts to areas beyond national jurisdiction: Synergies between the BBNJ Agreement and the work under the CBD';
  const existing=(await db.query("insert into scout.records(kind,title,event_url,identity_key,priority) values('event',$1,'https://www.cbd.int/side-events/5838','event:https://www.cbd.int/side-events/5838','normal') returning *",[title])).rows[0];
  const doalos=(await db.query('select id from scout.trackers where url=$1',[DOALOS])).rows[0];
  await db.query("insert into scout.evidence(tracker_id,record_id,url,content_hash,content,parsed) values($1,$2,$3,'prior','Existing DOALOS session evidence','{}')",[doalos.id,existing.id,DOALOS]);
  const run=await collectHSA(db,{trackerId:tracker.id,validate:true,since:'2024-01-01',read:async(url,budget)=>{budget.requests++;assert.ok(f[sourceURL(url)],url);return f[sourceURL(url)];},model:async(_instruction,inputs)=>inputs.map(i=>{
   const candidate=full(Object.fromEntries(CONTENT_FIELDS.map(k=>[k,i.scripted[k]])));
   if(i.scripted.side_event.id==='5378') for(const [action,value] of [['update',candidate],['no_substantive_change',null]])
    assert.throws(()=>validateDecision({...result,source_id:i.source_id,action,record_id:existing.id,candidate:value,quotes:[candidate.title]},i),/distinct CBD session/);
   return {...result,source_id:i.source_id,action:i.scripted.side_event.id==='5838'?'update':'new',record_id:i.scripted.side_event.id==='5838'?existing.id:null,candidate,quotes:[candidate.title]};
  })});
  assert.equal(run.assessed,2,run.warnings.join('; '));assert.equal(run.created,1);assert.equal(run.pending,0);
  const records=(await db.query('select * from scout.records')).rows;assert.equal(records.length,2);assert.ok(records.some(r=>r.id===existing.id));assert.equal(new Set(records.map(r=>r.title)).size,1);assert.equal(new Set(records.map(r=>r.event_url)).size,2);
  assert.ok(records.every(r=>r.starts_at===null));assert.equal((await db.query('select count(*)::int n from scout.evidence where tracker_id=$1',[tracker.id])).rows[0].n,2);
 }finally{await db.close();}
});

test('UN malformed listing/API or detail outage cannot overwrite known items or assess stale pending evidence',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/un-side-events.json.gz',import.meta.url))));let fail=null,calls=0;
 try {
  const tracker=(await db.query('select * from scout.trackers where url=$1',[UN_SIDE_EVENTS])).rows[0];
  const options={trackerId:tracker.id,validate:true,since:'2026-01-01',read:async(url,budget)=>{
   budget.requests++;if(url.endsWith('.pdf'))throw new Error('Response content exceeded max size');
   if(fail==='outage'&&url.includes('reservations'))throw new Error('HTTP 403');
   const response=f[sourceURL(url)];return fail&&url===fail.url?{...response,body:fail.body}:response;
  }};
  await collectHSA(db,options);const sources=(await db.query('select * from scout.evidence')).rows;assert.equal(sources.length,1);
  const reservation=Object.values(f).find(r=>r.url?.includes('/reservations/')&&JSON.parse(r.body)[0].sideEvent.id===6915);
  for(const bad of ['outage',{url:UN_SIDE_EVENTS,body:'<html>Challenge</html>'},{url:UN_SIDE_EVENTS,body:f[UN_SIDE_EVENTS].body.replace('</html>','')},
   {url:reservation.url,body:'{}'},{url:reservation.url,body:reservation.body.replace(/"id":\s*6915/,'"id":6916')}]) {
   fail=bad;const run=await collectHSA(db,{...options,model:async()=>{calls++;throw new Error('Must not assess stale content');}});
   assert.equal(run.assessed+run.candidates,0);assert.equal(calls,0);assert.deepEqual((await db.query('select * from scout.evidence')).rows,sources);
  }
 }finally{await db.close();}
});

test('UN PDF-only items keep unknown facts and low noise creates no record; listing and supporting requests stay bounded',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/un-side-events.json.gz',import.meta.url))));
 const original=f[UN_SIDE_EVENTS].body;
 f[UN_SIDE_EVENTS].body=original.replace(/<li\b[^>]*>[\s\S]*?<\/li>/g,item=>item.includes('BBNJCITES_SECOP20_flyer.pdf')?item.replace(/(<a\b[^>]*>)[\s\S]*?(<\/a>)/,'$1Generic ocean advocacy$2'):'');
 try {
  const tracker=(await db.query('select * from scout.trackers where url=$1',[UN_SIDE_EVENTS])).rows[0];
  const options={trackerId:tracker.id,validate:true,since:'2025-01-01',read:async(url,budget)=>{budget.requests++;if(url.endsWith('.pdf'))throw new Error('Unsupported PDF');return f[sourceURL(url)];}};
  const low=await collectHSA(db,{...options,model:async(_instruction,inputs)=>inputs.map(i=>{
   assert.equal(i.scripted.title,'Generic ocean advocacy');
   for(const k of ['organization','event_url','registration_url','starts_at','ends_at','location','status'])assert.equal(i.scripted[k],null);
   return {...result,source_id:i.source_id,candidate:full(Object.fromEntries(CONTENT_FIELDS.map(k=>[k,i.scripted[k]]))),priority:'low',quotes:[i.scripted.title]};
  })});assert.equal(low.assessed,1,low.warnings.join('; '));assert.equal(low.created,0);
  f[UN_SIDE_EVENTS].body=original;const bounded=await collectHSA(db,{...options,since:'2024-01-01'});
  assert.ok(bounded.warnings.includes('UN side-event item limit reached'));assert.ok(bounded.warnings.some(w=>w.includes('supporting-page limit')));assert.ok(bounded.requests<=6);assert.ok(bounded.candidates<=3);
 }finally{await db.close();}
});

test('actual UN side-event assessment retains Normal relevance, unknown dates and source-backed event URL completion',async()=>{
 const {live}=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/un-side-events.json.gz',import.meta.url))));
 validateDecision(live.decision.model_decision,live.input);
 validateDecision(Object.fromEntries(SCHEMA.items.required.map(k=>[k,live.decision[k]])),live.input);
 assert.equal(live.decision.state,'complete');assert.equal(live.record.priority,'normal');assert.equal(live.decision.model_decision.candidate.event_url,null);
 assert.equal(live.record.event_url,'https://www.cbd.int/side-events/6915');assert.equal(live.record.identity_key,'event:'+live.record.event_url);
 assert.equal(live.record.title,live.input.scripted.title);assert.equal(live.record.organization,live.input.scripted.organization);assert.ok(live.record.description.endsWith('.'));
 for(const key of ['starts_at','ends_at','location','registration_url','status','last_communicated_at'])assert.equal(live.record[key],null);
 assert.equal(live.input.scripted.side_event.schedule_published,false);assert.doesNotMatch(live.decision.reason,/architecture|interoperability|scheduled/i);
});

test('recorded DOALOS notices retain official facts, date-only metadata, stable updates and cosmetic repeat gating while disabled',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/doalos-notices.json.gz',import.meta.url))));let calls=0;
 f[DOALOS].body=f[DOALOS].body.replaceAll('International Conference on BBNJ','Other homepage item'); // Isolate the notice path.
 try {
  const tracker=(await db.query('select * from scout.trackers where url=$1',[DOALOS])).rows[0];
  const options={trackerId:tracker.id,validate:true,since:'2026-07-01',read:async(url,budget)=>{budget.requests++;assert.ok(f[url],url);return f[url];},model:async(_instruction,inputs)=>{
   calls++;return inputs.map(i=>{
    assert.equal(i.scripted.notification.issued_on,'2026-07-16');assert.equal(i.scripted.notification.action_required_by,null);
    assert.match(i.text,/Permanent Mission of Ireland/);assert.ok(!i.text.includes('Skip to main content'));
    const candidate=Object.fromEntries(CONTENT_FIELDS.map(k=>[k,i.scripted[k]]));
    assert.throws(()=>validateDecision({...result,source_id:i.source_id,candidate:{...candidate,kind:'event',starts_at:'2026-07-16T00:00:00Z'},quotes:[candidate.title]},i),/unsupported starts_at/);
    return {...result,source_id:i.source_id,action:i.exact_ids.length?'update':'new',record_id:i.exact_ids[0]??null,candidate,quotes:[candidate.title]};
   });
  }};
  await assert.rejects(collectHSA(db,{...options,validate:false}),/not yet proven/);
  const first=await collectHSA(db,options);assert.equal(first.outcome,'partial');assert.equal(first.created,1);assert.equal(first.assessed,1);assert.equal(first.pending,0);assert.equal(first.requests,3);
  assert.ok(first.warnings.some(w=>w.includes('PDFs')));assert.equal(calls,1);
  let record=(await db.query('select * from scout.records')).rows[0];assert.equal(record.kind,'announcement');assert.equal(record.priority,'high');
  assert.equal(record.organization,'Division for Ocean Affairs and the Law of the Sea');
  for(const key of ['location','event_url','registration_url','starts_at','ends_at','status','last_communicated_at'])assert.equal(record[key],null);
  const source=(await db.query('select * from scout.evidence')).rows[0];assert.equal(source.content,f[source.url].body);assert.equal(source.published_at,null);
  assert.equal(source.parsed.source.listing_url,DOALOS+'/notifications');assert.ok(source.parsed.source.links.some(link=>link.endsWith('20260716BBNJNotification2026002.pdf')));
  const context=await assessmentInput(db,source,tracker);let bytes=0;
  await gemini({apiKey:'injected',runId:first.run_id,ledger:{query:async()=>({rows:[]})},fetch:async(_url,r)=>{bytes=Buffer.byteLength(r.body);return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'[]'}]}}]});}})(INSTRUCTION,[context],SCHEMA);
  assert.ok(bytes<8000);
  f[source.url].body=f[source.url].body.replace('</body>','<nav>Rotating navigation</nav><script>random()</script></body>').replaceAll('col-lg-8','col-lg-9');
  const repeat=await collectHSA(db,options);assert.equal(repeat.candidates,0);assert.equal(repeat.created+repeat.changed,0);assert.equal(repeat.pending,0);assert.equal(calls,1);
  assert.deepEqual((await db.query('select * from scout.records')).rows,[record]);assert.equal((await db.query('select count(*)::int n from scout.evidence')).rows[0].n,1);
  for(const url of [DOALOS+'/notifications',source.url])f[url].body=f[url].body.replaceAll('Pre-collection notification under article 12','Corrected pre-collection notification under article 12');
  const changed=await collectHSA(db,{...options,since:'2026-10-01'});assert.equal(changed.created,0);assert.equal(changed.changed,1);assert.equal(calls,2);
  const revised=(await db.query('select * from scout.records')).rows[0];assert.equal(revised.id,record.id);assert.equal(revised.identity_key,record.identity_key);assert.match(revised.title,/^Corrected/);
  assert.equal((await db.query('select count(*)::int n from scout.evidence')).rows[0].n,2);
  assert.deepEqual((await db.query('select * from scout.trackers where id=$1',[tracker.id])).rows[0],tracker);
 }finally{await db.close();}
});

test('DOALOS deadline notice and cross-source identity remain separate from publication and other notices',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/doalos-notices.json.gz',import.meta.url))));
 f[DOALOS].body=f[DOALOS].body.replaceAll('International Conference on BBNJ','Other homepage item');
 try {
  const tracker=(await db.query('select * from scout.trackers where url=$1',[DOALOS])).rows[0];
  const title='Pre-collection notification under article 12, paragraph 2, of the BBNJ Agreement';
  const known=(await db.query("insert into scout.records(kind,title,organization,identity_key,priority) values('announcement',$1,'Division for Ocean Affairs and the Law of the Sea','post:known-notice','normal') returning *",[title])).rows[0];
  const run=await collectHSA(db,{trackerId:tracker.id,validate:true,since:'2026-02-01',read:async(url,budget)=>{budget.requests++;return f[url];},model:async(_instruction,inputs)=>inputs.map(i=>{
   const existing=i.candidates.find(r=>r.title===i.scripted.title);
   if(i.scripted.notification.number==='2026-001'){
    assert.equal(i.scripted.notification.issued_on,'2026-02-10');assert.equal(i.scripted.notification.action_required_by,'2026-03-16');assert.match(i.text,/Action required by 16 March 2026/);
    assert.ok(i.links.includes('https://forms.office.com/e/dVpJpcpRZR'));assert.equal(i.scripted.registration_url,null);
   }else assert.equal(existing.id,known.id);
   return {...result,source_id:i.source_id,action:existing?'supporting_evidence':'new',record_id:existing?.id??null,quotes:[i.scripted.title],
    candidate:Object.fromEntries(CONTENT_FIELDS.map(k=>[k,i.scripted[k]]))};
  })});
  assert.equal(run.pending,0);assert.equal(run.assessed,2);assert.equal(run.created,1);assert.equal(run.changed,1);
  const records=(await db.query('select * from scout.records')).rows;assert.equal(records.length,2);assert.ok(records.every(r=>r.starts_at===null&&r.ends_at===null));
  assert.ok(records.some(r=>r.id===known.id&&r.identity_key===known.identity_key&&r.priority==='high'));
  assert.equal((await db.query('select count(distinct url)::int n from scout.evidence')).rows[0].n,2);
 }finally{await db.close();}
});

test('DOALOS malformed/challenged sources cannot replace captures or assess stale pending content',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/doalos-notices.json.gz',import.meta.url))));let changed=null,calls=0;
 f[DOALOS].body=f[DOALOS].body.replaceAll('International Conference on BBNJ','Other homepage item');
 try {
  const tracker=(await db.query('select * from scout.trackers where url=$1',[DOALOS])).rows[0],detail=DOALOS+'/notification-2026-002';
  const options={trackerId:tracker.id,validate:true,since:'2026-07-01',read:async(url,budget)=>{budget.requests++;return changed?.[url]??f[url];},model:async()=>{calls++;throw new Error('Injected assessment outage');}};
  assert.equal((await collectHSA(db,options)).pending,1);assert.equal(calls,1);
  const evidence=(await db.query('select * from scout.evidence')).rows;
  for(const [url,body] of [[DOALOS,'<html>Challenge</html>'],[DOALOS+'/notifications','<html>Unexpected list</html>'],
   [DOALOS+'/notifications',f[DOALOS+'/notifications'].body.replaceAll('16 July 2026','31 February 2026')],
   [detail,f[detail].body.replace('</html>','')],[detail,f[detail].body.replaceAll('16 July 2026','17 July 2026')]]){
   changed={[url]:{...f[url],body}};const run=await collectHSA(db,options);assert.ok(['failed','partial'].includes(run.outcome));assert.equal(run.pending,1);assert.equal(calls,1);
   assert.deepEqual((await db.query('select * from scout.evidence')).rows,evidence);
  }
  assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,0);
 }finally{await db.close();}
});

test('DOALOS notification bounds and low-relevance decisions never imply full website coverage',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/doalos-notices.json.gz',import.meta.url))));
 f[DOALOS].body=f[DOALOS].body.replaceAll('International Conference on BBNJ','Other homepage item');
 try {
  const tracker=(await db.query('select * from scout.trackers where url=$1',[DOALOS])).rows[0];
  const detail=DOALOS+'/notification-2026-002',title='Pre-collection notification under article 12, paragraph 2, of the BBNJ Agreement';
  // An injected generic-explainer notice exercises the assessment gate, not a claim about the real official notice.
  for(const url of [DOALOS+'/notifications',detail])f[url].body=f[url].body.replaceAll(title,'Explainer video: An introduction to the BBNJ Agreement');
  let calls=0;
  const options={trackerId:tracker.id,validate:true,since:'2026-07-01',read:async(url,budget)=>{budget.requests++;assert.ok(f[url],url);return f[url];},model:async(_q,inputs)=>{calls++;return inputs.map(i=>({...result,source_id:i.source_id,priority:'low',candidate:Object.fromEntries(CONTENT_FIELDS.map(k=>[k,i.scripted[k]])),quotes:[i.scripted.title]}));}};
  const low=await collectHSA(db,options);assert.equal(low.created,0);assert.equal(low.assessed,1);assert.equal(low.pending,0);assert.equal(low.outcome,'partial');
  assert.equal((await collectHSA(db,options)).candidates,0);assert.equal(calls,1);
  const row=[...f[DOALOS+'/notifications'].body.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)].at(-1)[0];
  for(let n=3;n<=7;n++){
   const number=`2026-00${n}`,url=DOALOS+'/notification-'+number;
   f[DOALOS+'/notifications'].body=f[DOALOS+'/notifications'].body.replace('</tbody>',row.replaceAll('2026-002',number)+'</tbody>');
   f[url]={...f[detail],url,body:f[detail].body.replaceAll('notification-2026-002','notification-'+number)};
  }
  const bounded=await collectHSA(db,{...options,model:async()=>{throw new Error('Bounded observation only');}});
  assert.equal(bounded.pages,6);assert.equal(bounded.requests,6);assert.equal(bounded.notices_in_window,6);assert.ok(bounded.warnings.some(w=>w.includes('detail limit')));
 }finally{await db.close();}
});

test('recorded DOALOS homepage conference includes real detail and registration, with distinct date/deadline and no invented session clocks',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/doalos-notices.json.gz',import.meta.url))));let calls=0,fail=false;
 const url='https://www.deepoceanbbnj.cn/2026.html';
 try {
  const tracker=(await db.query('select * from scout.trackers where url=$1',[DOALOS])).rows[0];
  const options={trackerId:tracker.id,validate:true,since:'2026-07-01',read:async(u,budget)=>{budget.requests++;assert.ok(f[u],u);if(fail&&u===url)throw new Error('Source returned HTTP 403');return f[u];},model:async(_q,inputs)=>{
   calls++;return inputs.map(i=>{
    if(i.scripted.kind==='event'){
     assert.equal(i.url,DOALOS);assert.equal(i.scripted.event_url,url);assert.equal(i.scripted.start_on,'2026-11-05');assert.equal(i.scripted.registration_deadline_on,'2026-10-15');
     assert.equal(i.scripted.registration_url,'https://www.deepoceanbbnj.cn/index/register/');assert.equal(i.scripted.starts_at,null);assert.equal(i.scripted.ends_at,null);assert.equal(i.scripted.time_zone,null);
     assert.match(i.scripted.organization,/China Deep Ocean Affairs Administration/);assert.match(i.scripted.location,/Xiamen International Conference Center/);
     assert.match(i.text,/DePTH-GPT/);assert.match(i.text,/Clearing-House Mechanism/);
    }
    const candidate=Object.fromEntries(CONTENT_FIELDS.map(k=>[k,i.scripted[k]]));
    if(candidate.kind==='event'){candidate.event_url=null;candidate.registration_url=null;} // Reproduce the first live model omission.
    return {...result,source_id:i.source_id,candidate,quotes:[i.scripted.title]};
   });
  }};
  const first=await collectHSA(db,options);assert.equal(first.created,2,JSON.stringify(first));assert.equal(first.pending,0);assert.equal(first.pages,4);assert.equal(first.outcome,'partial');
  const records=(await db.query('select * from scout.records order by id')).rows;assert.equal(records.filter(r=>r.kind==='event').length,1);
  const retained=records.find(r=>r.kind==='event');assert.equal(retained.event_url,url);assert.equal(retained.registration_url,'https://www.deepoceanbbnj.cn/index/register/');
  const event=(await db.query('select * from scout.evidence where url=$1',[DOALOS])).rows[0];assert.equal(event.parsed.source.item_key,url);assert.equal(event.published_at,null);
  assert.equal(event.parsed.assessment.model_decision.candidate.event_url,null);assert.equal(event.parsed.assessment.candidate.event_url,url);
  const raw=JSON.parse(event.content);assert.equal(raw.detail.url,url);assert.equal(raw.detail.body,f[url].body);assert.match(raw.listing,/Registration by 15 October 2026/);
  const context=await assessmentInput(db,event,tracker);let bytes=0;
  await gemini({apiKey:'injected',runId:first.run_id,ledger:{query:async()=>({rows:[]})},fetch:async(_u,r)=>{bytes=Buffer.byteLength(r.body);return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'[]'}]}}]});}})(INSTRUCTION,[context],SCHEMA);assert.ok(bytes<8000);
  const before=calls;f[url].body=f[url].body.replace('width:100%;','width:99%;').replace('</body>','<!-- New comment --><script>random()</script></body>');
  const repeat=await collectHSA(db,options);assert.equal(repeat.candidates,0);assert.equal(repeat.created+repeat.changed,0);assert.equal(calls,before);
  fail=true;const failed=await collectHSA(db,options);assert.equal(failed.outcome,'partial');assert.equal(failed.candidates,0);assert.equal(calls,before);
  assert.deepEqual((await db.query('select * from scout.records order by id')).rows,records);
  assert.equal((await db.query('select count(*)::int n from scout.evidence')).rows[0].n,2);
  assert.equal((await db.query('select enabled from scout.trackers where id=$1',[tracker.id])).rows[0].enabled,false);
 }finally{await db.close();}
});

test('DOALOS conference listing survives unavailable details; recovery and deadline corrections retain its existing identity',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/doalos-notices.json.gz',import.meta.url))));let fail=true,calls=0;
 const url='https://www.deepoceanbbnj.cn/2026.html';
 try {
  const tracker=(await db.query('select * from scout.trackers where url=$1',[DOALOS])).rows[0];
  const options={trackerId:tracker.id,validate:true,since:'2026-10-01',read:async(u,budget)=>{budget.requests++;if(fail&&u===url)throw new Error('Source unavailable');return f[u];},model:async(_q,inputs)=>{
   calls++;return inputs.map(i=>({...result,source_id:i.source_id,action:i.exact_ids.length?'update':'new',record_id:i.exact_ids[0]??null,
    priority:fail?'normal':'high',candidate:Object.fromEntries(CONTENT_FIELDS.map(k=>[k,i.scripted[k]])),quotes:[i.scripted.title]}));
  }};
  assert.equal((await collectHSA(db,options)).created,1);const first=(await db.query('select * from scout.records')).rows[0];
  assert.equal(first.event_url,url);assert.equal(first.registration_url,null);assert.equal(first.location,null);assert.equal(first.starts_at,null);
  assert.equal((await collectHSA(db,options)).candidates,0);assert.equal(calls,1);
  fail=false;assert.equal((await collectHSA(db,options)).changed,1);assert.equal(calls,2);
  const recovered=(await db.query('select * from scout.records')).rows[0];assert.equal(recovered.id,first.id);assert.equal(recovered.identity_key,first.identity_key);assert.equal(recovered.priority,'high');assert.ok(recovered.registration_url);
  for(const u of [DOALOS,url])f[u].body=f[u].body.replaceAll('15 October 2026','16 October 2026');
  const corrected=await collectHSA(db,options);assert.equal(corrected.candidates,1);assert.equal(corrected.created,0);assert.equal(calls,3);
  const evidence=(await db.query('select * from scout.evidence order by collected_at desc')).rows;
  assert.equal(evidence[0].parsed.registration_deadline_on,'2026-10-16');assert.equal(evidence[0].parsed.start_on,'2026-11-05');
  assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,1);
  f[url].body=f[url].body.replaceAll('5 November 2026','6 November 2026');
  const conflict=await collectHSA(db,options);assert.equal(conflict.outcome,'partial');assert.equal(conflict.candidates,0);assert.equal(calls,3);assert.ok(conflict.warnings.some(w=>w.includes('dates disagree')));
 }finally{await db.close();}
});

test('actual DOALOS live assessments preserve identity and the corrected complete source-backed event',async()=>{
 const f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/doalos-notices.json.gz',import.meta.url))));
 for(const sample of f.live){
  const decision=sample.decision.model_decision??Object.fromEntries(SCHEMA.items.required.map(k=>[k,sample.decision[k]]));
  validateDecision(decision,sample.input);
 }
 const [first,last]=f.live;
 assert.equal(first.record.event_url,null);assert.equal(first.record.id,last.record.id);assert.equal(first.record.identity_key,last.record.identity_key);
 assert.equal(last.record.event_url,'https://www.deepoceanbbnj.cn/2026.html');assert.equal(last.record.registration_url,'https://www.deepoceanbbnj.cn/index/register/');
 assert.equal(last.record.priority,'high');assert.equal(last.record.starts_at,null);assert.equal(last.record.ends_at,null);assert.equal(last.record.last_communicated_at,null);
 assert.equal(last.input.scripted.start_on,'2026-11-05');assert.equal(last.input.scripted.registration_deadline_on,'2026-10-15');
 assert.doesNotMatch(last.decision.reason,/architecture/i);assert.ok(last.record.description.endsWith('.'));
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

test('IDDRI recorded bilingual listings independently capture publications and event precision; repeat ignores chrome',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/iddri-website.json.gz',import.meta.url))));let calls=0;
 try{
  const tracker=(await db.query('select * from scout.trackers where url=$1',[IDDRI])).rows[0];
  const options={trackerId:tracker.id,validate:true,since:'2026-01-01',read:async(u,b)=>{b.requests++;const r=Object.values(f).find(r=>r.url===u);if(!r||r.error)throw new Error(r?.error??'Missing recorded source');return r;},
   model:async(_p,inputs)=>{calls++;return inputs.map(i=>({...result,source_id:i.source_id,action:i.scripted.iddri.translation_of?'supporting_evidence':'new',record_id:i.scripted.iddri.translation_of?i.exact_ids[0]??null:null,candidate:full(Object.fromEntries(CONTENT_FIELDS.map(k=>[k,i.scripted[k]]))),priority:'normal',quotes:[i.scripted.title]}));}};
  await assert.rejects(collectHSA(db,{...options,validate:false}),/not yet proven/);
  const first=await collectHSA(db,options);assert.equal(first.created,2,first.warnings.join('; '));assert.equal(first.articles_listed,24);assert.equal(first.articles_selected,4);assert.equal(first.requests,6);assert.equal(first.outcome,'partial');
  const records=(await db.query('select * from scout.records order by id')).rows,sources=(await db.query('select * from scout.evidence')).rows;
  const en=sources.find(s=>s.parsed.iddri.language==='en'&&s.parsed.kind==='announcement'),fr=sources.find(s=>s.parsed.iddri.language==='fr'),event=sources.find(s=>s.parsed.kind==='event');
  assert.equal(en.published_at,null);assert.equal(en.parsed.iddri.publication,'2026-03');assert.equal(en.parsed.starts_at,null);assert.ok(en.parsed.source.links[0].endsWith('.pdf'));
  assert.match(fr.parsed.title,/l'Accord/);assert.equal(en.record_id,fr.record_id);assert.equal(fr.parsed.iddri.node,en.parsed.iddri.node);
  assert.equal(event.parsed.starts_at,'2026-02-26T17:00:00.000Z');assert.equal(event.parsed.ends_at,null);assert.equal(event.parsed.organization,null);assert.equal(event.parsed.location,'On Zoom');assert.equal(event.parsed.status,null);
  assert.match(first.warnings.join(' '),/404/);assert.match(JSON.parse(event.content).support.error,/404/);
  for(const name of ['brief','brief-fr','event'])f[name].body=f[name].body.replace('<body','<!-- unrelated navigation, old cancelled event, assets --> <body').replace('<p>','<p class="cosmetic">');
  const count=calls,repeated=await collectHSA(db,options);assert.equal(repeated.candidates+repeated.created+repeated.changed,0);assert.equal(calls,count);assert.equal(repeated.skipped,3);
  assert.deepEqual((await db.query('select * from scout.records order by id')).rows,records);assert.deepEqual((await db.query('select * from scout.trackers where id=$1',[tracker.id])).rows[0],tracker);
 }finally{await db.close();}
});

test('IDDRI material article changes and a consistent session clock correction retain identity and history',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/iddri-website.json.gz',import.meta.url))));
 try{
  const tracker=(await db.query('select * from scout.trackers where url=$1',[IDDRI])).rows[0];
  const options={trackerId:tracker.id,validate:true,since:'2026-01-01',read:async(u,b)=>{b.requests++;const r=Object.values(f).find(r=>r.url===u);if(r.error)throw new Error(r.error);return r;},
   model:async(_p,inputs)=>inputs.map(i=>({...result,source_id:i.source_id,action:i.scripted.iddri.translation_of?'supporting_evidence':i.exact_ids.length?'update':'new',record_id:i.exact_ids[0]??null,candidate:full(Object.fromEntries(CONTENT_FIELDS.map(k=>[k,i.scripted[k]]))),priority:'normal',quotes:[i.text.slice(0,100)]}))};
  await collectHSA(db,options);const before=(await db.query("select * from scout.records where kind='event'")).rows[0];
  f.event.body=f.event.body.replaceAll('12pm EST','1pm EST').replace('practical challenges ahead of PrepCom 3','revised practical challenges ahead of PrepCom 3');
  const change=await collectHSA(db,options);assert.equal(change.created,0);assert.equal(change.changed,1,change.warnings.join('; '));
  const after=(await db.query('select * from scout.records where id=$1',[before.id])).rows[0];assert.equal(after.starts_at.toISOString(),'2026-02-26T18:00:00.000Z');assert.equal(after.status,'rescheduled');assert.equal(after.identity_key,before.identity_key);
  assert.equal((await db.query('select count(*)::int n from scout.evidence')).rows[0].n,4);
  // An inconsistent clock, invalid day or identity change must not overwrite accepted facts.
  for(const alter of [s=>s.replace('On Zoom, 1pm EST','On Zoom, 2pm EST'),s=>s.replace('event-date__day">26','event-date__day">31'),s=>s.replace('rel="canonical" href="https://www.iddri.org/en/','rel="canonical" href="https://www.iddri.org/fr/')]){
   const good=f.event.body;f.event.body=alter(good);const failed=await collectHSA(db,options);assert.equal(failed.changed+failed.created,0);assert.match(failed.warnings.join(' '),/clocks|date|identity/);assert.deepEqual((await db.query('select * from scout.records where id=$1',[before.id])).rows[0],after);f.event.body=good;
  }
 }finally{await db.close();}
});

test('IDDRI date-only windows and failures never invent UTC, assess stale detail or treat a failed list as unchanged',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/iddri-website.json.gz',import.meta.url))));let calls=0,fail=null;
 try{
  const tracker=(await db.query('select * from scout.trackers where url=$1',[IDDRI])).rows[0];
  f.event.body=f.event.body.replaceAll('12pm EST','12pm');
  const options={trackerId:tracker.id,validate:true,since:'2026-01-01',read:async(u,b)=>{b.requests++;if(u===fail)throw new Error('Source returned HTTP 503');const r=Object.values(f).find(r=>r.url===u);if(r.error)throw new Error(r.error);return r;}};
  await collectHSA(db,{...options,model:async()=>{throw new Error('Deliberately deferred');}});
  const before=(await db.query('select * from scout.evidence')).rows,event=before.find(s=>s.parsed.kind==='event');
  assert.equal(event.parsed.start_on,'2026-02-26');assert.equal(event.parsed.starts_at,null);
  const guarded={...options,model:async()=>{calls++;throw new Error('Unexpected model call');}};
  fail=f.event.url;const detail=await collectHSA(db,{...guarded,sourceId:event.id});assert.equal(calls,0);assert.equal(detail.assessed,0);assert.match(detail.warnings.join(' '),/503/);
  fail=IDDRI;const listing=await collectHSA(db,guarded);assert.equal(listing.outcome,'failed');assert.equal(calls,0);assert.equal(listing.candidates,0);
  fail=null;const later=await collectHSA(db,{...options,since:'2026-10-01',model:async()=>{throw new Error('Deferred');}});assert.equal(later.articles_selected,3);assert.equal(later.candidates,0);assert.equal(later.skipped,3); // Previously seen items remain eligible.
  assert.equal((await db.query('select count(*)::int n from scout.evidence')).rows[0].n,before.length);
 }finally{await db.close();}
});

test('IDDRI same-month selection retains month precision and records valid Low noise without a finding',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/iddri-website.json.gz',import.meta.url))));
 try{
  const tracker=(await db.query('select * from scout.trackers where url=$1',[IDDRI])).rows[0];
  const r=await collectHSA(db,{trackerId:tracker.id,validate:true,since:'2026-03-30',read:async(u,b)=>{b.requests++;return Object.values(f).find(r=>r.url===u);},model:async(_p,inputs)=>inputs.map(i=>({...result,source_id:i.source_id,candidate:full(Object.fromEntries(CONTENT_FIELDS.map(k=>[k,i.scripted[k]]))),priority:'low',reason:'Injected low-noise gating case',quotes:[i.scripted.title]}))});
  assert.equal(r.articles_selected,2);assert.equal(r.assessed,2);assert.equal(r.created,0);
  for(const source of(await db.query('select * from scout.evidence')).rows){assert.equal(source.published_at,null);assert.equal(source.parsed.iddri.publication,'2026-03');assert.equal(source.parsed.starts_at,null);assert.equal(source.parsed.assessment.state,'complete');}
  const empty=await collectHSA(db,{trackerId:tracker.id,validate:true,since:'2027-01-01',read:async(u,b)=>{b.requests++;return Object.values(f).find(r=>r.url===u);},model:async()=>{throw new Error('Completed captures must not be reassessed');}});
  assert.equal(empty.candidates+empty.assessed,0);
 }finally{await db.close();}
});

test('IDDRI corroborates the same Bluesky-linked publication and reuses a verified translation and rejects uncorroborated article and annual/session merges',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/iddri-website.json.gz',import.meta.url))));
 try{
  const tracker=(await db.query('select * from scout.trackers where url=$1',[IDDRI])).rows[0];
  await collectHSA(db,{trackerId:tracker.id,validate:true,since:'2026-01-01',read:async(u,b)=>{b.requests++;const r=Object.values(f).find(r=>r.url===u);if(r.error)throw new Error(r.error);return r;},model:async()=>{throw new Error('Deferred');}});
  const sources=(await db.query('select * from scout.evidence')).rows,en=sources.find(s=>s.url===f.brief.url),fr=sources.find(s=>s.url===f['brief-fr'].url);
  const old=(await db.query("insert into scout.records(kind,title,organization,identity_key,priority) values('announcement',$1,'IDDRI','post:iddri-brief','normal') returning *",[en.parsed.title])).rows[0];
  const social=(await db.query("select id from scout.trackers where url='https://bsky.app/profile/iddri.bsky.social'")).rows[0];
  await db.query("insert into scout.evidence(tracker_id,record_id,url,content_hash,content,parsed,last_seen_at) values($1,$2,'https://bsky.app/profile/iddri.bsky.social/post/brief','iddri-social',$3,$4,clock_timestamp())",[social.id,old.id,JSON.stringify({text:en.parsed.title,urls:[en.url]}),JSON.stringify({source:{identity:'post:iddri-brief',rank:2}})]);
  const input=await assessmentInput(db,en,tracker),candidate=full(Object.fromEntries(CONTENT_FIELDS.map(k=>[k,en.parsed[k]])));
  const decision={...result,source_id:en.id,action:'supporting_evidence',record_id:old.id,candidate,priority:'normal',quotes:[en.parsed.title]};
  validateDecision(decision,input);assert.equal(input.candidates.find(r=>r.id===old.id).registration_link,true);
  const fi=await assessmentInput(db,fr,tracker);
  const fd={...decision,source_id:fr.id,candidate:full(Object.fromEntries(CONTENT_FIELDS.map(k=>[k,fr.parsed[k]]))),quotes:[fr.parsed.title]};
  validateDecision(fd,fi);assert.ok(fi.exact_ids.includes(old.id));
  assert.throws(()=>validateDecision({...fd,action:'new',record_id:null},fi),/already has a finding/);
  assert.throws(()=>validateDecision(fd,{...fi,exact_ids:[],scripted:{...fi.scripted,iddri:{...fi.scripted.iddri,translation_of:null}},candidates:fi.candidates.map(c=>({...c,registration_link:false}))}),/same explicitly linked/);
  assert.throws(()=>validateDecision({...decision,candidate:{...candidate,kind:'event',starts_at:'2026-03-23T00:00:00Z'}},input),/unsupported|unconfirmed/);
  const event=sources.find(s=>s.parsed.kind==='event'),ei=await assessmentInput(db,event,tracker);
  const ec=full(Object.fromEntries(CONTENT_FIELDS.map(k=>[k,event.parsed[k]])));
  const prior={id:'annual',kind:'event',title:ec.title+' 2025',event_url:event.url,starts_at:'2025-02-26T17:00:00Z',organization:null};
  assert.throws(()=>validateDecision({...result,source_id:event.id,action:'update',record_id:prior.id,candidate:ec,quotes:[ec.title]},{...ei,candidates:[prior]}),/recurring edition/);
  const session={...prior,title:'Session 1 '+ec.title,starts_at:ec.starts_at};
  assert.throws(()=>validateDecision({...result,source_id:event.id,action:'update',record_id:session.id,candidate:{...ec,title:'Session 2 '+ec.title},quotes:[ec.title]},{...ei,candidates:[session],scripted:{...ei.scripted,title:'Session 2 '+ec.title},text:'Session 2 '+ei.text}),/distinct session/);
  const done=await collectHSA(db,{trackerId:tracker.id,validate:true,since:'2026-01-01',sourceId:en.id,read:async(u,b)=>{b.requests++;const r=Object.values(f).find(r=>r.url===u);if(r.error)throw new Error(r.error);return r;},model:async()=>[decision]});
  assert.equal(done.created,0);assert.equal(done.assessed,1,done.warnings.join('; '));assert.equal((await db.query('select record_id from scout.evidence where id=$1',[en.id])).rows[0].record_id,old.id);
  assert.deepEqual((await db.query('select * from scout.records')).rows,[old]);
 }finally{await db.close();}
});

test('IDDRI actual multi-session UNOC programme does not turn its conference range into an individual session',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/iddri-website.json.gz',import.meta.url))));
 const unoc=f.listing.body.match(/<article class="line-teaser">[\s\S]*?<\/article>/g).find(s=>s.includes('href="/en/publications-and-events/conference/iddri-unoc"'));
 f.listing.body=f.listing.body.replace(/<article class="line-teaser">[\s\S]*?<\/article>/g,'').replace('87 results','87 results'+unoc);
 f['listing-fr'].body=f['listing-fr'].body.replace(/<article class="line-teaser">[\s\S]*?<\/article>/g,s=>s.includes('troisieme-reunion-de-la-commission')?s:'');
 try{
  const tracker=(await db.query('select * from scout.trackers where url=$1',[IDDRI])).rows[0];let checked=false;
  const run=await collectHSA(db,{trackerId:tracker.id,validate:true,since:'2025-06-01',read:async(u,b)=>{b.requests++;const r=Object.values(f).find(r=>r.url===u);if(!r)throw new Error('Programme support unavailable (injected)');return r;},
   model:async(_p,inputs)=>inputs.map(i=>{if(i.scripted.iddri.multiple){checked=true;assert.equal(i.scripted.starts_at,null);assert.equal(i.scripted.start_on,null);assert.equal(i.scripted.organization,null);
    assert.throws(()=>validateDecision({...result,source_id:i.source_id,candidate:full(Object.fromEntries(CONTENT_FIELDS.map(k=>[k,i.scripted[k]]))),quotes:[i.scripted.title]},i),/multiple IDDRI/);}
    return {...result,source_id:i.source_id,action:'uncertain',candidate:null,priority:null,reason:'Multiple sessions need separate evidence',quotes:[]};})});
  assert.equal(checked,true,run.warnings.join('; '));assert.equal(run.created,0);assert.match(run.warnings.join(' '),/parent dates/);
  const source=(await db.query('select * from scout.evidence where url=$1',[f.unoc.url])).rows[0];assert.match(JSON.parse(source.content).text,/Wednesday 11 June/);assert.match(JSON.parse(source.content).text,/Monitoring, control and surveillance/);
 }finally{await db.close();}
});

test('IDDRI publication changes are material but broken translation corroboration cannot create a second finding',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/iddri-website.json.gz',import.meta.url))));
 try{
  const tracker=(await db.query('select * from scout.trackers where url=$1',[IDDRI])).rows[0];let calls=0;
  const options={trackerId:tracker.id,validate:true,since:'2026-03-01',read:async(u,b)=>{b.requests++;return Object.values(f).find(r=>r.url===u);},
   model:async(_p,inputs)=>{calls++;return inputs.map(i=>{const candidate=full(Object.fromEntries(CONTENT_FIELDS.map(k=>[k,i.scripted[k]])));
    if(i.scripted.iddri.translation_unconfirmed){assert.throws(()=>validateDecision({...result,source_id:i.source_id,candidate,quotes:[i.text.slice(0,100)]},i),/translation identity/);return {...result,source_id:i.source_id,action:'uncertain',candidate:null,priority:null,reason:'Publisher translation corroboration changed',quotes:[]};}
    return {...result,source_id:i.source_id,action:i.scripted.iddri.translation_of?'supporting_evidence':i.exact_ids.length?'update':'new',record_id:i.exact_ids[0]??null,candidate,priority:'normal',quotes:[i.text.slice(0,100)]};});}};
  const initial=await collectHSA(db,options);assert.equal(initial.created,1);assert.equal(initial.assessed,2);
  const original=(await db.query('select * from scout.records')).rows[0];
  f.brief.body=f.brief.body.replaceAll('To prepare for this milestone','To prepare for the revised milestone');
  const changed=await collectHSA(db,options);assert.equal(changed.changed,1);assert.equal(changed.created,0);
  const updated=(await db.query('select * from scout.records')).rows[0];assert.equal(updated.id,original.id);assert.match(updated.description,/revised milestone/);
  f['brief-fr'].body=f['brief-fr'].body.replaceAll('202603-PB0226-BBNJ%20COP1.pdf','202603-distinct-publication.pdf');
  const disputed=await collectHSA(db,options);assert.equal(disputed.created+disputed.changed,0);assert.match(disputed.warnings.join(' '),/translation.*corroboration/);
  assert.deepEqual((await db.query('select * from scout.records')).rows,[updated]);
  const count=calls,repeated=await collectHSA(db,options);assert.equal(calls,count,JSON.stringify(repeated));
  assert.equal((await db.query('select count(*)::int n from scout.evidence')).rows[0].n,4);
 }finally{await db.close();}
});

test('IDDRI reciprocal translated event and shared registration corroborate one session without changing its English facts',async()=>{
 const db=await database(),f=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/iddri-website.json.gz',import.meta.url))));
 for(const name of ['listing','listing-fr'])f[name].body=f[name].body.replace(/<article class="line-teaser">[\s\S]*?<\/article>/g,s=>s.includes(name==='listing'?'making-mpas-work-high-seas':'faire-fonctionner-les-amp-en-haute-mer')?s:'');
 try{
  const tracker=(await db.query('select * from scout.trackers where url=$1',[IDDRI])).rows[0];
  const r=await collectHSA(db,{trackerId:tracker.id,validate:true,since:'2026-01-01',read:async(u,b)=>{b.requests++;const r=Object.values(f).find(r=>r.url===u);if(r.error)throw new Error(r.error);return r;},
   model:async(_p,inputs)=>inputs.map(i=>({...result,source_id:i.source_id,action:i.scripted.iddri.translation_of?'supporting_evidence':'new',record_id:i.exact_ids[0]??null,candidate:full(Object.fromEntries(CONTENT_FIELDS.map(k=>[k,i.scripted[k]]))),priority:'normal',quotes:[i.scripted.title]}))});
  assert.equal(r.created,1,r.warnings.join('; '));assert.equal(r.assessed,2,r.warnings.join('; '));
  const records=(await db.query('select * from scout.records')).rows,sources=(await db.query('select * from scout.evidence')).rows;
  assert.equal(records.length,1);assert.match(records[0].title,/^Making MPAs/);assert.equal(records[0].starts_at.toISOString(),'2026-02-26T17:00:00.000Z');
  assert.equal(sources.length,2);assert.equal(new Set(sources.map(s=>s.record_id)).size,1);assert.equal(sources.find(s=>s.parsed.iddri.language==='fr').parsed.iddri.translation_of,f.event.url);
 }finally{await db.close();}
});

test('actual IDDRI policy-brief assessment is Normal, literal and not a scheduled event or technical High claim',async()=>{
 const {live}=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/iddri-website.json.gz',import.meta.url))));
 validateDecision(Object.fromEntries(SCHEMA.items.required.map(k=>[k,live.decision[k]])),live.input);
 assert.equal(live.decision.state,'complete');assert.equal(live.decision.priority,'normal');assert.equal(live.record.priority,'normal');
 assert.equal(live.record.kind,'announcement');assert.equal(live.record.title,live.input.scripted.title);assert.equal(live.record.organization,'IDDRI');assert.equal(live.record.description,live.input.scripted.description);
 assert.equal(live.input.scripted.iddri.publication,'2026-03');assert.equal(live.decision.model_decision,undefined);
 assert.doesNotMatch(live.decision.reason,/architecture specifications|technical workshop/i);
 for(const key of ['starts_at','ends_at','event_url','registration_url','location','status','last_communicated_at'])assert.equal(live.record[key],null);
});
