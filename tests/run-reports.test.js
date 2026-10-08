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

test('legacy schedule and zone captures retain UTC timing across source edits without record date evidence',async()=>{
  const db=await database(),post=JSON.parse(await readFile(new URL('./fixtures/hsa-webinar-time.json',import.meta.url),'utf8'));
  const zoom='https://us06web.zoom.us/webinar/register/WN_cueG31LFSVOVPdkUxm5SHQ';
  let html=await readFile(new URL('./fixtures/hsa-zoom.html',import.meta.url),'utf8');
  const model=async(_instruction,inputs)=>inputs.map(input=>{
    const existing=input.candidates.find(c=>input.exact_ids.includes(c.id));
    if(input.url!==zoom)return {...decision(input),action:existing?'no_substantive_change':'uncertain',record_id:existing?.id??null,candidate:null,quotes:[]};
    return {...decision(input),action:existing?'update':'new',record_id:existing?.id??null,
      candidate:{...Object.fromEntries(CONTENT_FIELDS.map(k=>[k,null])),kind:'event',title:input.scripted.title,description:input.scripted.description.slice(0,200),event_url:zoom,registration_url:zoom}};
  });
  const fixtureRead=async(url,budget)=>{budget.requests++;return{url,status:200,headers:{'content-type':url===zoom?'text/html':'application/json'},body:url===zoom?html:JSON.stringify({feed:[post]})};};
  try{
    const first=await collectHSA(db,{...options,since:'2026-09-01',read:fixtureRead,model});assert.equal(first.created,1,first.warnings.join(';'));
    const record=(await db.query('select * from scout.records')).rows[0];assert.equal(Object.hasOwn(record,'date_evidence'),false);
    assert.equal(record.starts_at.toISOString(),'2026-09-29T11:30:00.000Z');
    const sources=(await db.query('select * from scout.evidence where record_id=$1',[record.id])).rows;
    assert.ok(sources.some(s=>s.url===zoom&&s.parsed.local_schedule.date==='2026-09-29'));
    assert.ok(sources.some(s=>s.parsed.date_parts?.zone==='EDT'));
    html=html.replace('This webinar will unpack','This webinar will explore');
    const edited=await collectHSA(db,{...options,since:'2026-09-01',read:fixtureRead,model});assert.equal(edited.created,0,edited.warnings.join(';'));
    const updated=(await db.query('select * from scout.records')).rows;assert.equal(updated.length,1);
    assert.equal(updated[0].starts_at.toISOString(),record.starts_at.toISOString());assert.match(updated[0].description,/will explore/);
  }finally{await db.close();}
});

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
      if(_url.endsWith(':countTokens'))return Response.json({totalTokens:200});
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
    for(const step of ['detect','prepare','generate','validate','save'])assert.equal(stepState(report,step),'Skipped',step);
  }finally{await db.close();}
});

test('legacy Low findings retain reader-visible source/reason and skip unchanged calls while uncertainty and fresh identity remain guarded',async()=>{
  for(const scenario of ['saved','uncertain','concurrent']){
    const db=await database();let calls=0,sourceId,concurrent;
    const reason='General BBNJ advocacy promotion.',fixtureRead=read(['BBNJ advocacy announcement.']);
    const model=async(_instruction,inputs)=>{
      calls++;assert.equal(inputs.length,1);const input=inputs[0];sourceId=input.source_id;
      const low={...decision(input),priority:'low',reason};
      if(scenario==='uncertain')return [{...low,action:'uncertain',candidate:null}];
      if(scenario==='concurrent'){
        assert.equal(input.candidates.length,0);
        concurrent=(await db.query('insert into scout.records('+CONTENT_FIELDS.join(',')+',priority,identity_key) values('+CONTENT_FIELDS.map((_,i)=>'$'+(i+1)).join(',')+',$11,$12) returning *',
          [...CONTENT_FIELDS.map(k=>low.candidate[k]),'normal','concurrent-fixture'])).rows[0];
      }
      return [low];
    };
    try{
      const run=await collectHSA(db,{...options,read:fixtureRead,model});assert.equal(calls,1);
      const rows=(await db.query('select * from scout.records order by id')).rows;
      const source=(await db.query('select * from scout.evidence where id=$1',[sourceId])).rows[0];
      if(scenario!=='saved'){
        assert.equal(run.created,0);assert.deepEqual(rows,concurrent?[concurrent]:[]);assert.equal(source.record_id,null);
        assert.equal(source.parsed.assessment.state,'uncertain');
        if(concurrent){assert.match(source.parsed.assessment.reason,/refreshed shortlist/);assert.equal(source.parsed.assessment.model_decision.priority,'low');}
        continue;
      }
      assert.equal(run.created,1,run.warnings.join(';'));assert.equal(rows.length,1);assert.equal(rows[0].priority,'low');
      assert.equal(source.record_id,rows[0].id);assert.equal(source.parsed.assessment.reason,reason);assert.equal(source.parsed.assessment.priority_accepted,true);
      await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[member]);
      assert.deepEqual((await db.query('select record_id,url,priority_reason from scout.source_details')).rows,[{record_id:rows[0].id,url:source.url,priority_reason:reason}]);
      await db.exec('reset role');
      const repeat=await collectHSA(db,{...options,read:fixtureRead,model});assert.equal(repeat.assessed,0);assert.equal(repeat.created,0);assert.equal(calls,1);
      assert.deepEqual((await db.query('select * from scout.records order by id')).rows,rows);
      assert.deepEqual((await db.query('select parsed from scout.evidence where id=$1',[sourceId])).rows[0].parsed,source.parsed);
    }finally{await db.close();}
  }
});

test('recovered provider retry summarizes successful generation while retaining both attempts and the error',async()=>{
  const db=await database();let calls=0;
  try{
    const run=await collectHSA(db,{...options,read:read(),makeModel:(runId,_d,trace)=>gemini({apiKey:'private-retry-key',ledger:db,runId,trace,fetch:async(_url,request)=>{
      if(_url.endsWith(':countTokens'))return Response.json({totalTokens:200});
      calls++;
      const row=(await db.query('select * from scout.collection_runs where id=$1',[runId])).rows[0];
      assert.equal(stepState(row.report,'generate'),'Running');assert.equal(row.stats.model_attempts.length,calls);
      if(calls===1)return new Response('Temporary provider error for private-retry-key',{status:503});
      const inputs=JSON.parse(JSON.parse(request.body).contents[0].parts[0].text);
      return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(inputs.map(decision))}]}}]});
    }})});
    assert.equal(calls,2);assert.equal(run.outcome,'success');assert.equal(run.created,1);
    const row=(await db.query('select * from scout.collection_runs where id=$1',[run.run_id])).rows[0];
    assert.equal(stepState(row.report,'generate'),'Pass');assert.equal(row.stats.model_attempts.length,2);
    const attempts=Object.values(row.report.operations).filter(o=>o.attempt);
    assert.deepEqual(attempts.map(o=>o.state),['fail','pass']);assert.deepEqual(attempts.map(o=>o.artifacts.length),[3,2]);
    assert.equal(attempts[0].artifacts[0],attempts[1].artifacts[0]);
    assert.equal(row.report.artifacts[attempts[0].artifacts.at(-1)].data.body,'Temporary provider error for [REDACTED]');
    assert.equal(row.report.artifacts[attempts[1].artifacts[1]].data.http_status,200);
  }finally{await db.close();}
});

for(const [name,step,model]of [
  ['queue selection cannot make failed input preparation mixed','prepare',undefined],
  ['accepted batch shape cannot make a single rejected proposal mixed','validate',async(_p,inputs)=>inputs.map(i=>({...decision(i),quotes:['invented quotation']}))],
  ['failed batch-shape checkpoint still fails validation','validate',async()=>[]],
])test(name,async()=>{
  const db=await database();
  try{
    const run=await collectHSA(db,{...options,read:read(),model});
    const report=(await db.query('select report from scout.collection_runs where id=$1',[run.run_id])).rows[0].report;
    assert.equal(stepState(report,step),'Fail');assert.equal(run.created,0);assert.equal(run.pending,1);
    assert.ok(Object.values(report.operations).some(o=>o.step===step&&o.checkpoint));
    assert.ok(!Object.values(report.operations).some(o=>o.step===step&&!o.checkpoint&&o.state==='pass'));
    assert.equal(stepState(report,'save'),'Not reached');
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
    const run=await collectHSA(db,{...options,read:read(),makeModel:(runId,_d,trace)=>gemini({apiKey:'private-provider-key',ledger:db,runId,trace,fetch:async url=>{
      if(url.endsWith(':countTokens'))return Response.json({totalTokens:200});
      calls++;
      if(calls===1)return new Response('Temporary provider error for private-provider-key',{status:503,headers:{authorization:'header-secret'}});
      return new Response(new ReadableStream({start(c){c.error(new Error('broken stream'));}}),{status:503});
    }})});
    assert.equal(calls,2);
    const row=(await db.query('select * from scout.collection_runs where id=$1',[run.run_id])).rows[0];assert.equal(row.stats.model_attempts.length,2);assert.equal(stepState(row.report,'generate'),'Fail');
    const artifacts=Object.values(row.report.artifacts),outputs=artifacts.filter(a=>a.kind==='model_response');assert.equal(outputs.length,2);
    assert.equal(outputs[0].data.body,'Temporary provider error for [REDACTED]');assert.equal(outputs[0].data.credential_redacted,true);
    assert.equal(outputs[1].data.unavailable,'Response body could not be read.');assert.ok(!Object.hasOwn(outputs[1].data,'body'));
    assert.ok(artifacts.some(a=>a.kind==='model_request'));assert.ok(!JSON.stringify(row).includes('private-provider-key'));assert.ok(!JSON.stringify(row).includes('header-secret'));
    const transport=Object.values(row.report.operations).filter(o=>o.attempt);assert.deepEqual(transport.map(o=>o.state),['fail','fail']);assert.deepEqual(transport.map(o=>o.artifacts.length),[3,2]);
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
    await db.query("update scout.collection_runs set stats=stats||'{\"uncertain\":1}'::jsonb where id=$1",[run.run_id]);
    await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[member]);
    const detail=(await db.query('select scout.run_detail($1) d',[run.run_id])).rows[0].d;
    assert.equal(detail.counts.uncertain,1);
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
    async detail(id){calls.push('detail:'+id);return {id,outcome:'partial',started_at:'2026-10-04T12:00:00Z',finished_at:id==='0'?null:'2026-10-04T12:01:00Z',counts:{created:1},report:id==='0'?{version:1,operations:{o1:{step:'prepare',state:'pass',source_ids:['source'],url:'javascript:bad()',artifacts:['a1']},o2:{step:'save',state:'running',record_ids:[member]},o3:{step:'generate',state:'pass'},o4:{step:'generate',state:'fail',attempt:1},o5:{step:'generate',state:'pass',attempt:2}},artifacts:{a1:{title:'captured text'},a2:{title:'unlinked request'}}}:null};},
    async artifact(_id,key){calls.push('artifact:'+key);return key==='a1'?'<img src=x onerror=attack()><script>attack()</script>':new Promise(r=>{finishLate=r;});},
  };
  globalThis.document={createElement:tag=>new Element(tag)};
  try{
    const close=mountRunDetail(root,api,{id:'tracker',name:'<b>Untrusted source</b>'},()=>{});
    await tick();assert.deepEqual(calls,['history','detail:0']);assert.match(root.textContent,/Generate records · Pass/);assert.match(root.textContent,/Generation succeeded after retry/);assert.match(root.textContent,/Fail · Attempt 1/);assert.match(root.textContent,/Pass · Attempt 2/);assert.match(root.textContent,/Validate and repair · Not reached/);assert.match(root.textContent,/Save records · Running/);assert.match(root.textContent,/may have been interrupted/);
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
    const closeDocument=mountRunDetail(root,{...api,detail:async()=>({id:'0',outcome:'partial',report:{version:1,path:'octo-documents',operations:{},artifacts:{}}})},{id:'tracker',name:'OCTO'},()=>{});
    await tick();assert.match(root.textContent,/OCTO document fetch\/prepare only/);assert.match(root.textContent,/Generate records · Not reached/);assert.match(root.textContent,/Save records · Not reached/);
    assert.ok(!root.textContent.includes('Legacy scripted collector'));closeDocument();
    const closeRecords=mountRunDetail(root,{...api,detail:async()=>({id:'0',outcome:'partial',report:{version:1,path:'octo-records',operations:{v1:{step:'validate',state:'fail',recovered_by:'v2'},v2:{step:'validate',state:'pass'}},artifacts:{}}})},{id:'tracker',name:'OCTO'},()=>{});
    await tick();assert.match(root.textContent,/OCTO document processing/);assert.match(root.textContent,/Validate and repair · Pass/);assert.match(root.textContent,/Recovered by later operation v2/);closeRecords();
    for(const [path,label]of [['author-records','Author feed'],['gfw-records','GFW'],['discovery-records','Bluesky discovery'],['iucn-records','IUCN'],['dosi-records','DOSI'],['iddri-records','IDDRI']]){
      const closeIntegrated=mountRunDetail(root,{...api,detail:async()=>({id:'0',outcome:'partial',report:{version:1,path,operations:{},artifacts:{}}})},{id:'tracker',name:label},()=>{});
      await tick();assert.ok(root.textContent.includes(label+' document processing'));assert.match(root.textContent,/support coverage/);assert.ok(!root.textContent.includes('Legacy scripted collector'));closeIntegrated();
    }
    const closeUncertain=mountRunDetail(root,{...api,detail:async()=>({id:'0',outcome:'partial',counts:{uncertain:1},report:{version:1,path:'octo-records',operations:{v1:{step:'validate',state:'uncertain',note:'Identity remains unresolved.'}},artifacts:{}}})},{id:'tracker',name:'OCTO'},()=>{});
    await tick();assert.match(root.textContent,/Validate and repair · Uncertain/);assert.match(root.textContent,/uncertain: 1/);assert.match(root.textContent,/Identity remains unresolved/);closeUncertain();
  }finally{if(old===undefined)delete globalThis.document;else globalThis.document=old;}
});

test('independent health checks record failures and recovery without Slack posts, and compact only redundant success history',async()=>{
  const db=await database();try{
    await db.exec(`create schema cron;create schema net;create schema vault;
      create table cron.job(jobid bigint primary key,jobname text,active boolean);
      create table cron.job_run_details(jobid bigint,end_time timestamptz);
      create table net._http_response(id bigint primary key,status_code int,timed_out boolean,error_msg text);
      create table net.requests(id bigserial primary key,url text,body jsonb,headers jsonb);
      create table vault.decrypted_secrets(name text,decrypted_secret text);
      insert into cron.job values(1,'scout-collection',true);
      insert into vault.decrypted_secrets values('scout_loop_backend_key','fixture-key'),
        ('scout_loop_slack_webhook','https://hooks.slack.com/services/TFZ8FRLBV/B0C5TEK4R38/fixture');
      create function net.http_post(url text,headers jsonb default '{}',body jsonb default '{}',timeout_milliseconds int default 5000)
        returns bigint language sql as $$insert into net.requests(url,body,headers) values(url,body,headers) returning id$$;`);
    const operations=await readFile(new URL('../supabase/scout-loop.sql',import.meta.url),'utf8');
    await db.exec(operations.slice(operations.indexOf('create or replace function'),operations.indexOf('-- Install paused.')));
    const tracker=(await db.query('select id from scout.trackers order by id limit 1')).rows[0].id;
    const control=(await db.query("insert into scout.collection_runs(tracker_id,stats) values($1,jsonb_build_object('purpose','scheduler','enabled',true,'supported','[]'::jsonb,'last_tick_at',now())) returning id",[tracker])).rows[0].id;
    await db.query("select scout.loop_tick('next')");
    assert.equal((await db.query('select body from net.requests')).rows[0].body,null);
    assert.ok(!JSON.stringify((await db.query('select stats from scout.collection_runs where id=$1',[control])).rows).includes('fixture-key'));
    await db.exec("insert into net._http_response values(1,401,false,null)");
    await db.query("update scout.collection_runs set stats=jsonb_set(stats,'{dispatches,0,at}',to_jsonb((now()-interval '3 minutes')::text)) where id=$1",[control]);
    let health=(await db.query('select scout.loop_health() health')).rows[0].health;
    assert.ok(health.issues.includes('Worker HTTP failure: 401'));
    assert.equal((await db.query('select count(*)::int n from net.requests')).rows[0].n,1);
    assert.deepEqual((await db.query('select stats from scout.collection_runs where id=$1',[control])).rows[0].stats.health.issues,health.issues);
    await db.exec('update cron.job set active=false');
    health=(await db.query('select scout.loop_health() health')).rows[0].health;
    assert.ok(health.issues.includes('Collection scheduler stopped'));
    await db.exec('update cron.job set active=true;update net._http_response set status_code=200 where id=1');
    health=(await db.query('select scout.loop_health() health')).rows[0].health;
    assert.ok(!health.issues.includes('Collection scheduler stopped'));assert.ok(!health.issues.includes('Worker HTTP failure: 401'));
    assert.equal((await db.query('select count(*)::int n from net.requests')).rows[0].n,1);
    const unstamped=(await db.query("insert into scout.collection_runs(tracker_id,started_at,finished_at,outcome,stats) values($1,now()-interval '4 minutes',now(),'no_change','{\"purpose\":\"notification\",\"delivery\":{\"status\":\"sent\",\"communicated\":0,\"records\":[{}]}}') returning id",[tracker])).rows[0].id;
    assert.ok((await db.query('select scout.loop_health() health')).rows[0].health.issues.some(issue=>issue.includes('Slack delivery uncertain')));
    await db.query("update scout.collection_runs set stats=jsonb_set(stats,'{delivery,communicated}','1') where id=$1",[unstamped]);
    assert.ok(!(await db.query('select scout.loop_health() health')).rows[0].health.issues.some(issue=>issue.includes('Slack delivery uncertain')));
    assert.equal((await db.query('select count(*)::int n from net.requests')).rows[0].n,1);
    await db.query(`insert into scout.collection_runs(tracker_id,started_at,finished_at,outcome,stats,report)
      select $1,now()-interval '40 days',now()-interval '40 days'+n*interval '1 second','no_change',
        '{"stage":"fetch","requests":2,"prepared":0}'::jsonb,'{"artifacts":{"duplicate_body":"safe public source"}}'::jsonb
      from generate_series(1,3) n`,[tracker]);
    const repair=(await db.query(`insert into scout.collection_runs(tracker_id,started_at,finished_at,outcome,stats,report)
      values($1,now()-interval '40 days',now()-interval '40 days','partial',
      '{"stage":"initial_review","model_attempts":[{"at":"2026-01-01"}]}','{"artifacts":{"rejected":"original"}}') returning id`,[tracker])).rows[0].id;
    await db.query('select scout.loop_retention()');
    const compacted=(await db.query("select stats,report from scout.collection_runs where stats->>'stage'='fetch'")).rows;
    assert.equal(compacted.length,1);assert.equal(compacted[0].report,null);assert.equal(compacted[0].stats.compacted_runs,2);assert.equal(compacted[0].stats.compacted_requests,4);
    assert.equal((await db.query('select report from scout.collection_runs where id=$1',[repair])).rows[0].report.artifacts.rejected,'original');
    await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[member]);
    const status=(await db.query('select awaiting_initial,parked,loop_state from scout.tracker_status where id=$1',[tracker])).rows[0];
    assert.equal(status.awaiting_initial,0);
    await assert.rejects(db.query('select * from scout.source_queue'),{code:'42501'});
    await assert.rejects(db.query('select scout.loop_health()'),{code:'42501'});
  }finally{await db.close();}
});
