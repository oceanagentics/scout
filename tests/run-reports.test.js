import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile,readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { collectHSA,HSA } from '../collector/hsa.js';
import { gemini } from '../collector/model.js';
import { CONTENT_FIELDS } from '../collector/assessment.js';
import { startReport } from '../collector/report.js';
import { runAPI,stepState,mountRunDetail } from '../src/runs.js';

const member='00000000-0000-4000-8000-000000000001', outsider='00000000-0000-4000-8000-000000000002';
async function database({reports=true}={}){
  const db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');
    create table auth.identities(user_id uuid,provider text,identity_data jsonb);
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    insert into auth.users(id) values('${member}'),('${outsider}');
    insert into auth.identities values('${member}','google','{"iss":"https://accounts.google.com","email_verified":true,"custom_claims":{"hd":"oceanagentics.com"}}');`);
  for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())if(reports||!name.endsWith('_scout_run_reports.sql'))await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/seeds/trackers.sql',import.meta.url),'utf8'));
  return db;
}
const feed=(texts=['Interoperability consultation.'])=>({feed:texts.map((text,i)=>({post:{uri:'at://did:plc:test/app.bsky.feed.post/'+i,author:{handle:HSA,displayName:'High Seas Alliance'},indexedAt:'2026-10-04T10:00:00Z',record:{text,createdAt:'2026-10-04T10:00:00Z'}}}))});
const decision=i=>({source_id:i.source_id,action:'new',record_id:null,priority:'high',reason:'Concrete implementation consultation',quotes:[i.scripted.title],clear_fields:[],candidate:{...Object.fromEntries(CONTENT_FIELDS.map(k=>[k,null])),kind:'announcement',title:i.scripted.title,description:i.scripted.title,organization:'High Seas Alliance'}});
const options={since:'2026-10-01',now:()=> '2026-10-04T12:00:00Z'};
const read=texts=>async(url,b)=>{b.requests++;return{url,status:200,headers:{authorization:'must-not-enter-artifacts'},body:JSON.stringify(feed(texts))};};

test('report migration preserves existing data, accounting and other-service access without backfilling history',async()=>{
  const db=await database({reports:false});
  try{
    await db.exec(`create schema unrelated;create table unrelated.private_data(secret text);insert into unrelated.private_data values('other service');
      insert into scout.collection_runs(tracker_id,outcome,finished_at,stats)
        select id,'partial',clock_timestamp(),'{"warnings":["Original warning"],"model_attempts":[{"at":"2026-10-03T12:00:00Z"}]}' from scout.trackers limit 1;`);
    const before=(await db.query('select to_jsonb(r) data from scout.collection_runs r')).rows;
    const trackers=(await db.query('select * from scout.trackers order by id')).rows;
    await db.exec(await readFile(new URL('../supabase/migrations/20261004090000_scout_run_reports.sql',import.meta.url),'utf8'));
    assert.deepEqual((await db.query("select to_jsonb(r)-'report' data from scout.collection_runs r")).rows,before);
    assert.deepEqual((await db.query('select * from scout.trackers order by id')).rows,trackers);
    assert.equal((await db.query('select report from scout.collection_runs')).rows[0].report,null);
    assert.equal((await db.query('select secret from unrelated.private_data')).rows[0].secret,'other service');
    await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[member]);
    assert.equal((await db.query('select stats from scout.collection_runs')).rows[0].stats.warnings[0],'Original warning');
    await assert.rejects(db.query('select * from unrelated.private_data'),{code:'42501'});
  }finally{await db.close();}
});

test('successful run persists progress, exact model bodies and capture/record links; unchanged run skips assessment',async()=>{
  const db=await database();let calls=0;
  try{
    const makeModel=(runId,_deadline,trace)=>gemini({apiKey:'secret-fixture-value',ledger:db,runId,trace,fetch:async(_url,request)=>{
      calls++;const saved=(await db.query('select report from scout.collection_runs where id=$1',[runId])).rows[0].report;
      assert.equal(stepState(saved,'generate'),'Running');assert.equal(stepState(saved,'save'),'Not reached');
      const artifact=Object.values(saved.artifacts).find(a=>a.kind==='model_request');assert.equal(artifact.data.body,request.body);
      assert.ok(!JSON.stringify(saved).includes('secret-fixture-value'));assert.ok(!JSON.stringify(saved).includes('must-not-enter-artifacts'));
      const inputs=JSON.parse(JSON.parse(request.body).contents[0].parts[0].text);
      return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(inputs.map(decision))}]}}]},{headers:{authorization:'response-secret'}});
    }});
    const first=await collectHSA(db,{...options,read:read(),makeModel});assert.equal(first.created,1);
    const row=(await db.query('select * from scout.collection_runs where id=$1',[first.run_id])).rows[0];
    for(const step of ['fetch','detect','prepare','generate','validate','save'])assert.equal(stepState(row.report,step),'Pass',step);
    assert.ok(Object.values(row.report.operations).some(o=>o.step==='save'&&o.record_ids.length===1));
    assert.ok(Object.values(row.report.artifacts).some(a=>a.kind==='capture'&&!a.data));
    assert.ok(Object.values(row.report.artifacts).some(a=>a.kind==='model_response'&&a.data.body.includes('STOP')));
    assert.ok(!JSON.stringify(row.report).includes('response-secret'));
    const repeat=await collectHSA(db,{...options,read:read(),makeModel});assert.equal(repeat.assessed,0);assert.equal(calls,1);
    const report=(await db.query('select report from scout.collection_runs where id=$1',[repeat.run_id])).rows[0].report;
    for(const step of ['detect','generate','validate','save'])assert.equal(stepState(report,step),'Skipped',step);
  }finally{await db.close();}
});

test('mixed proposal validation retains first save, failed response and source evidence; no repair is invented',async()=>{
  const db=await database();
  try{
    const run=await collectHSA(db,{...options,read:read(['Interoperability consultation.','Ocean monitoring consultation.']),model:async(_p,inputs)=>inputs.map((i,n)=>n?{...decision(i),quotes:['invented quotation']}:decision(i))});
    assert.equal(run.outcome,'partial');assert.equal(run.created,1);assert.equal(run.pending,1);
    const report=(await db.query('select report from scout.collection_runs where id=$1',[run.run_id])).rows[0].report;
    assert.equal(stepState(report,'validate'),'Fail · mixed outcomes');assert.equal(stepState(report,'save'),'Pass');
    const error=Object.values(report.artifacts).find(a=>a.kind==='error');assert.equal(error.data.message,'Assessment rejected: unsupported quote');assert.match(error.data.repair,/No model repair/);
    assert.equal(Object.values(report.artifacts).filter(a=>a.kind==='model_request').length,0); // Injected model has no wire request.
    assert.equal((await db.query('select count(*)::int n from scout.evidence')).rows[0].n,2);
  }finally{await db.close();}
});

test('fetch failures do not claim downstream work, and running/interrupted checkpoints survive',async()=>{
  const db=await database();let release;
  try{
    const pending=collectHSA(db,{...options,read:()=>new Promise((_resolve,reject)=>{release=()=>reject(new Error('Source unavailable'));})});
    while(!release)await new Promise(r=>setTimeout(r,1));
    const running=(await db.query("select * from scout.collection_runs where outcome='running'")).rows[0];
    assert.equal(stepState(running.report,'fetch'),'Running');assert.equal(stepState(running.report,'prepare'),'Not reached');
    release();const failed=await pending;
    const report=(await db.query('select report from scout.collection_runs where id=$1',[failed.run_id])).rows[0].report;
    assert.equal(stepState(report,'fetch'),'Fail');for(const step of ['detect','prepare','generate','validate','save'])assert.equal(stepState(report,step),'Not reached');
    const interrupted=(await db.query('insert into scout.collection_runs(tracker_id) values($1) returning id',[running.tracker_id])).rows[0].id;
    const trace=await startReport(db,interrupted);await trace.start('fetch',{note:'Checkpoint before process termination'});
    assert.equal(stepState((await db.query('select report from scout.collection_runs where id=$1',[interrupted])).rows[0].report,'fetch'),'Running');
    // No timeout heuristic converts a missing completion marker into invented facts.
  }finally{await db.close();}
});

test('malformed model output is retained before parsing fails, with credentials excluded',async()=>{
  const db=await database();
  try{
    const run=await collectHSA(db,{...options,read:read(),makeModel:(runId,_d,trace)=>gemini({apiKey:'private-model-key',ledger:db,runId,trace,fetch:async()=>new Response('not JSON private-model-key')})});
    const report=(await db.query('select report from scout.collection_runs where id=$1',[run.run_id])).rows[0].report;
    assert.equal(stepState(report,'generate'),'Fail');assert.equal(stepState(report,'validate'),'Not reached');
    assert.ok(!JSON.stringify(report).includes('private-model-key'));assert.ok(JSON.stringify(report).includes('not JSON [REDACTED]'));
    assert.ok(!JSON.stringify(run).includes('private-model-key'));
  }finally{await db.close();}
});

test('unexpected interruption preserves earlier committed evidence and marks the incomplete run failed',async()=>{
  const db=await database();
  try{
    const interrupted={query:async(sql,args)=>{
      if(sql.startsWith('select *,last_seen_at::text'))throw new Error('Injected queue failure');
      return db.query(sql,args);
    }};
    await assert.rejects(collectHSA(interrupted,{...options,read:read()}),/Injected queue failure/);
    const row=(await db.query('select * from scout.collection_runs')).rows[0];
    assert.equal(row.outcome,'failed');assert.ok(row.finished_at);
    assert.equal(stepState(row.report,'fetch'),'Pass');assert.equal(stepState(row.report,'detect'),'Pass');assert.equal(stepState(row.report,'prepare'),'Not reached');
    assert.ok(Object.values(row.report.artifacts).some(a=>a.kind==='capture'));
    assert.equal((await db.query('select count(*)::int n from scout.evidence')).rows[0].n,1);
  }finally{await db.close();}
});

test('provider errors and unreadable bodies retain request references and counted attempts without changing retries',async()=>{
  const db=await database();let calls=0;
  try{
    const run=await collectHSA(db,{...options,read:read(),makeModel:(runId,_d,trace)=>gemini({apiKey:'private-provider-key',ledger:db,runId,trace,fetch:async()=>{
      calls++;
      if(calls===1)return new Response('Temporary provider error for private-provider-key',{status:503,headers:{authorization:'header-secret'}});
      return new Response(new ReadableStream({start(c){c.error(new Error('broken stream'));}}),{status:503});
    }})});
    assert.equal(calls,2);
    const row=(await db.query('select * from scout.collection_runs where id=$1',[run.run_id])).rows[0];assert.equal(row.stats.model_attempts.length,2);
    const artifacts=Object.values(row.report.artifacts),outputs=artifacts.filter(a=>a.kind==='model_response');assert.equal(outputs.length,2);
    assert.equal(outputs[0].data.body,'Temporary provider error for [REDACTED]');assert.equal(outputs[0].data.credential_redacted,true);
    assert.equal(outputs[1].data.unavailable,'Response body could not be read.');assert.ok(!Object.hasOwn(outputs[1].data,'body'));
    assert.ok(artifacts.some(a=>a.kind==='model_request'));assert.ok(!JSON.stringify(row).includes('private-provider-key'));assert.ok(!JSON.stringify(row).includes('header-secret'));
    const transport=Object.values(row.report.operations).filter(o=>o.attempt);assert.deepEqual(transport.map(o=>o.state),['fail','fail']);assert.ok(transport.every(o=>o.artifacts.length===2));
  }finally{await db.close();}
});

test('report RPCs restrict member access, page metadata only, and keep unreferenced/transport-bearing evidence private',async()=>{
  const db=await database();
  try{
    const run=await collectHSA(db,{...options,read:read(),model:async(_p,inputs)=>inputs.map(decision)});
    const row=(await db.query('select * from scout.collection_runs where id=$1',[run.run_id])).rows[0];
    const [key,ref]=Object.entries(row.report.artifacts).find(([,a])=>a.kind==='capture');
    const legacy=(await db.query("insert into scout.collection_runs(tracker_id,stats) values($1,'{\"assessment_results\":[\"historical only\"]}') returning id",[row.tracker_id])).rows[0].id;
    await db.query("insert into scout.collection_runs(tracker_id) select $1 from generate_series(1,21)",[row.tracker_id]);
    await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[member]);
    const detail=(await db.query('select scout.run_detail($1) d',[run.run_id])).rows[0].d;
    assert.ok(Object.values(detail.report.artifacts).every(a=>!Object.hasOwn(a,'data')));
    assert.equal((await db.query('select scout.run_detail($1) d',[legacy])).rows[0].d.report,null);
    assert.equal(stepState(null,'fetch'),'Unavailable');
    const first=(await db.query('select * from scout.run_history($1)',[row.tracker_id])).rows;assert.equal(first.length,20);
    const next=(await db.query('select * from scout.run_history($1,$2,$3)',[row.tracker_id,first.at(-1).started_at,first.at(-1).id])).rows;assert.equal(next.length,3);assert.ok(!next.some(x=>first.some(y=>y.id===x.id)));
    const artifact=(await db.query('select scout.run_artifact($1,$2) a',[run.run_id,key])).rows[0].a;assert.match(artifact.content,/Interoperability/);
    assert.equal((await db.query('select scout.run_artifact($1,$2) a',[run.run_id,ref.source_id])).rows[0].a,null);
    for(const sql of ['select report from scout.collection_runs','select * from scout.evidence','update scout.collection_runs set report=null'])await assert.rejects(db.query(sql),{code:'42501'});
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[outsider]);
    assert.deepEqual((await db.query('select * from scout.run_history($1)',[row.tracker_id])).rows,[]);
    for(const [sql,args]of [['select scout.run_detail($1) d',[run.run_id]],['select scout.run_artifact($1,$2) d',[run.run_id,key]]])assert.equal((await db.query(sql,args)).rows[0].d,null);
    await db.exec('reset role;set role anon');await assert.rejects(db.query('select scout.run_detail($1)',[run.run_id]),{code:'42501'});
    await db.exec('reset role');await db.query('update scout.evidence set content=$2 where id=$1',[ref.source_id,JSON.stringify({text:'Public source',headers:{authorization:'private-header'}})]);
    await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[member]);
    const protectedBody=(await db.query('select scout.run_artifact($1,$2) a',[run.run_id,key])).rows[0].a;assert.match(protectedBody.unavailable,/backend-only/);assert.ok(!JSON.stringify(protectedBody).includes('private-header'));
  }finally{await db.close();}
});

test('frontend API uses scoped RPCs and abortable, bounded history without dashboard artifact reads',async()=>{
  const calls=[],signal=new AbortController().signal,client={rpc(name,args){calls.push({name,args});return{abortSignal(s){assert.equal(s,signal);return Promise.resolve({data:[]});}};}};
  const api=runAPI(client);assert.deepEqual(calls,[]);
  await api.history('tracker',null,signal);await api.detail('run',signal);await api.artifact('run','a1',signal);
  assert.deepEqual(calls.map(x=>x.name),['run_history','run_detail','run_artifact']);assert.equal(calls[0].args.p_before_at,null);
});

test('run view navigates on demand, renders artifacts as text, and discards late reads on close',async()=>{
  class Element {
    constructor(tag){this.tag=tag;this.children=[];this.events={};this.value='';}
    set textContent(value){this.value=String(value);this.children=[];}
    get textContent(){return this.value+this.children.map(c=>c.textContent??c).join(' ');}
    set innerHTML(_value){throw Error('No dynamic HTML rendering allowed');}
    append(...children){this.children.push(...children);}
    replaceChildren(...children){this.value='';this.children=children;}
    setAttribute(){}
    addEventListener(name,fn){this.events[name]=fn;}
  }
  const old=globalThis.document,root=new Element('root'),calls=[],tick=()=>new Promise(r=>setImmediate(r));
  const walk=(el)=>[el,...el.children.flatMap(c=>typeof c==='object'?walk(c):[])];
  const click=label=>walk(root).find(e=>e.tag==='button'&&e.textContent===label).events.click();
  let finishLate,signalSeen;
  const api={
    async history(id,before,signal){calls.push('history');signalSeen=signal;assert.equal(id,'tracker');return before?[]:Array.from({length:20},(_,i)=>({id:String(i),started_at:'2026-10-04T12:00:00Z',outcome:i?'partial':'success',report_available:i===0}));},
    async detail(id){calls.push('detail:'+id);return {id,outcome:'partial',started_at:'2026-10-04T12:00:00Z',finished_at:id==='0'?null:'2026-10-04T12:01:00Z',counts:{created:1},report:id==='0'?{version:1,operations:{o1:{step:'prepare',state:'pass',source_ids:['source'],url:'javascript:bad()',artifacts:['a1']},o2:{step:'save',state:'running',record_ids:[member]}},artifacts:{a1:{title:'captured text'},a2:{title:'unlinked request'}}}:null};},
    async artifact(_id,key){calls.push('artifact:'+key);return key==='a1'?'<img src=x onerror=attack()><script>attack()</script>':new Promise(r=>{finishLate=r;});},
  };
  globalThis.document={createElement:tag=>new Element(tag)};
  try{
    const close=mountRunDetail(root,api,{id:'tracker',name:'<b>Untrusted source</b>'},()=>{});
    await tick();assert.deepEqual(calls,['history','detail:0']);assert.match(root.textContent,/Generate records · Not reached/);assert.match(root.textContent,/Save records · Running/);assert.match(root.textContent,/may have been interrupted/);
    assert.equal(walk(root).filter(e=>e.tag==='a'&&e.href?.startsWith('javascript:')).length,0);
    assert.ok(walk(root).some(e=>e.tag==='a'&&e.href==='/?record='+member));
    await click('Inspect captured text');assert.equal(walk(root).find(e=>e.tag==='pre').textContent,'<img src=x onerror=attack()><script>attack()</script>');
    assert.equal(walk(root).filter(e=>['img','script','b'].includes(e.tag)).length,0);
    const late=click('Inspect unlinked request');await tick();assert.ok(finishLate);
    const history=walk(root).find(e=>e.tag==='nav');await history.children[1].events.click();await tick();
    assert.match(root.textContent,/step outcomes, source associations and exact request artifacts were not instrumented/);assert.match(root.textContent,/Fetch · Unavailable/);assert.ok(!root.textContent.includes('Inspect captured text'));
    finishLate('late source');await late;assert.ok(!root.textContent.includes('late source'));
    await click('Older runs');await tick();assert.equal(calls.filter(x=>x==='history').length,2);assert.match(root.textContent,/No runs on this page/);
    await click('Newer runs');await tick();const waiting=click('Inspect unlinked request');await tick();close();finishLate('signed-out source');await waiting;
    assert.equal(root.textContent,'');assert.equal(root.hidden,true);assert.equal(signalSeen.aborted,true);
  }finally{if(old===undefined)delete globalThis.document;else globalThis.document=old;}
});
