import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {collectHSA,HSA} from '../collector/hsa.js';
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
