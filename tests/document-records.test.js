import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {PGlite} from '@electric-sql/pglite';
import {collectHSA} from '../collector/hsa.js';
import {gemini,MODEL_LIMITS} from '../collector/model.js';
import {CONTENT_FIELDS} from '../collector/assessment.js';
import {prepareDocument,PREPARATION_VERSION} from '../collector/octo-documents.js';
import {packDocument,validateProposal,DOCUMENT_VERSION} from '../collector/document-records.js';
import {stepState} from '../src/runs.js';

const fixture=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/octo-webinars.json.gz',import.meta.url))));
const mp=JSON.parse(fixture.posts.body).find(p=>p.id===16281);
const feedURL='https://octogroup.org/feed/';
const article={...mp,id:99,link:'https://octogroup.org/two-sessions/',title:{rendered:'Data workshops'},content:{rendered:'<h1>Data workshops</h1><p>First session</p><p>2026-10-21T10:00:00Z</p><p>Ocean Institute</p><p>Second session</p><p>2026-10-22T10:00:00Z</p><p>Marine data standards workshop.</p>'}};
const answer=proposals=>({complete:true,reason:'All supplied finding evidence considered.',proposals});
const proposal=(title='First session',date='2026-10-21T10:00:00Z')=>({action:'new',record_id:null,anchor:title,
  candidate:{...Object.fromEntries(CONTENT_FIELDS.map(k=>[k,null])),kind:'event',title,organization:'Ocean Institute',description:'Marine data standards workshop.',event_url:article.link,starts_at:date},
  priority:'high',reason:'Concrete marine data standards workshop.',evidence:{kind:title,title,organization:'Ocean Institute',description:'Marine data standards workshop.',event_url:article.link,starts_at:date,priority:'Marine data standards workshop.'}});
async function setup(){
  const db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
    create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');create table auth.identities(user_id uuid,provider text,identity_data jsonb);
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;`);
  for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
  await db.query("insert into scout.trackers(id,name,url,collector,cadence,enabled) values($1,'OCTO','https://octogroup.org/webinars/','web','7 days',false)",[fixture.tracker.id]);
  return db;
}
function runner(db,respond,{post=article,advance=true,runLimit=10}={}){
  const requests=[];let calls=0;
  const options={trackerId:fixture.tracker.id,validate:true,documents:'process',read:async(url,budget)=>{
    budget.requests++;return {url,status:200,body:url===feedURL?'<rss><channel><item><guid>https://octogroup.org/?p='+post.id+'</guid><link>'+post.link+'</link><title>'+post.title.rendered+'</title><description>Feed excerpt.</description></item></channel></rss>':JSON.stringify(post)};
  },makeModel:(runId,deadline,trace)=>{
    const actual=gemini({apiKey:'test-key',ledger:db,runId,deadline,trace,runLimit,fetch:async(_url,request)=>{
      requests.push(request.body);assert.ok(Buffer.byteLength(request.body)<=MODEL_LIMITS.input);
      const input=JSON.parse(JSON.parse(request.body).contents[0].parts[0].text)[0];
      const out=await respond(input,++calls);
      return out instanceof Response?out:Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(out)}]}}],usageMetadata:{promptTokenCount:200,candidatesTokenCount:100}});
    }});
    return async(...args)=>{
      // Simulate elapsed minutes in isolated test data; retain every reservation.
      if(advance)await db.query("update scout.collection_runs set stats=jsonb_set(stats,'{model_attempts}',(select jsonb_agg(a||jsonb_build_object('at',(a->>'at')::timestamptz-interval '61 seconds')) from jsonb_array_elements(stats->'model_attempts') a)) where jsonb_array_length(coalesce(stats->'model_attempts','[]'))>0");
      return actual(...args);
    };
  }};
  return {requests,run:(extra={})=>collectHSA(db,{...options,...extra})};
}
const report=async(db,id)=>(await db.query('select report,stats from scout.collection_runs where id=$1',[id])).rows[0];

test('two same-URL events commit separately, exact repeat skips, changed content and deliberate versions reassess without duplicates',async()=>{
  const db=await setup();const post=structuredClone(article);
  const source=runner(db,input=>answer([proposal(),proposal('Second session','2026-10-22T10:00:00Z')].map(p=>{
    const r=input.existing.find(r=>r.title===p.candidate.title);return r?{...p,action:'update',record_id:r.id}:p;
  })),{post});
  try{
    const first=await source.run();assert.equal(first.processed,1,first.warnings.join(';'));assert.equal(first.created,2);
    const records=(await db.query('select * from scout.records order by title')).rows;assert.equal(records.length,2);assert.equal(records[0].event_url,records[1].event_url);
    assert.equal((await db.query('select count(*)::int n from scout.evidence where record_id is not null')).rows[0].n,2);
    const repeat=await source.run();assert.equal(source.requests.length,1);assert.equal(repeat.processed,1,repeat.warnings.join(';'));
    assert.equal((await db.query("select count(*)::int n from scout.evidence e join scout.evidence s on e.parsed#>>'{document,capture_id}'=s.id::text where e.last_seen_at=s.last_seen_at")).rows[0].n,2);
    assert.equal(stepState((await report(db,repeat.run_id)).report,'generate'),'Skipped');
    post.content.rendered+='<p>Minor punctuation correction.</p>';const changed=await source.run();assert.equal(changed.processed,1,changed.warnings.join(';'));
    const revised=await source.run({documentVersion:'document-prompt-1/rubric-2'});assert.equal(revised.processed,1,revised.warnings.join(';'));
    assert.equal(source.requests.length,3);assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,2);
    const detail=await report(db,first.run_id);assert.equal(detail.stats.model_attempts.length,1);
    for(const step of ['generate','validate','save'])assert.equal(stepState(detail.report,step),'Pass');
    assert.ok(Object.values(detail.report.operations).filter(o=>o.record_ids?.length).length===2);
  }finally{await db.close();}
});

test('zero findings and new Low are completed assessments without records',async()=>{
  const db=await setup();let low=false;
  const source=runner(db,()=>answer(low?[{...proposal(),priority:'low'}]:[]));
  try{
    const zero=await source.run();assert.equal(zero.processed,1,zero.warnings.join(';'));
    low=true;const assessment=await source.run({documentVersion:'low-review'});assert.equal(assessment.processed,1,assessment.warnings.join(';'));
    assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,0);
    const evidence=(await db.query('select parsed from scout.evidence where record_id is null')).rows[0];
    assert.equal(evidence.parsed.document.processing.state,'complete');
    assert.ok(Object.values(evidence.parsed.document.processing_versions).some(v=>v.accepted.some(a=>a.proposal.priority==='low')));
  }finally{await db.close();}
});

test('rejected field repairs retain accepted proposals, exact requests/errors and counted attempts',async()=>{
  const db=await setup();const bad={...proposal('Second session','2026-10-22T10:00:00Z'),candidate:{...proposal('Second session','2026-10-22T10:00:00Z').candidate,location:'Invented room'}};
  const source=runner(db,(input,n)=>{
    if(n===1)return answer([proposal(),bad]);
    assert.ok(input.repair.errors.some(e=>e.includes('location')));assert.deepEqual(input.repair.rejected.proposals[1],bad);
    assert.ok(input.accepted[0].record_id);return answer([proposal(),proposal('Second session','2026-10-22T10:00:00Z')]);
  });
  try{
    const run=await source.run();assert.equal(run.processed,1,run.warnings.join(';'));assert.equal(run.created,2);
    const detail=await report(db,run.run_id);assert.equal(detail.stats.model_attempts.length,2);
    assert.equal(stepState(detail.report,'validate'),'Pass');
    assert.ok(Object.values(detail.report.operations).some(o=>o.state==='fail'&&o.recovered_by));
    assert.equal(Object.values(detail.report.artifacts).filter(a=>a.kind==='model_request').length,2);
    assert.ok(Object.values(detail.report.artifacts).some(a=>a.kind==='validation_errors'&&a.data.errors.some(e=>e.includes('location'))));
    assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,2);
  }finally{await db.close();}
});

test('repair exhaustion stays failed with accepted saves; next invocation recovers without duplicate creation',async()=>{
  const db=await setup();let recover=false;
  const bad={...proposal('Second session','2026-10-22T10:00:00Z'),priority:'urgent'};
  const source=runner(db,()=>answer([proposal(),recover?proposal('Second session','2026-10-22T10:00:00Z'):bad]));
  try{
    const failed=await source.run();assert.equal(failed.processed,0);assert.equal(failed.created,1);
    assert.equal(source.requests.length,3);assert.ok(failed.warnings.some(w=>w.includes('Two repair attempts exhausted')));
    assert.equal((await report(db,failed.run_id)).stats.model_attempts.length,3);
    recover=true;const fixed=await source.run();assert.equal(fixed.processed,1,fixed.warnings.join(';'));assert.equal(fixed.created,1);
    assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,2);
  }finally{await db.close();}
});

test('real minute/run guards count transient retry and repair reservations without marking processing complete',async()=>{
  const db=await setup();
  const source=runner(db,(_input,n)=>n===1?new Response('temporary',{status:503}):answer([{...proposal(),priority:'urgent'}]),{advance:false});
  try{
    const run=await source.run();assert.equal(run.processed,0);assert.equal(source.requests.length,2);
    const detail=await report(db,run.run_id);assert.equal(detail.stats.model_attempts.length,2);assert.ok(run.warnings.some(w=>w.includes('quota')));
    assert.ok(Object.values(detail.report.artifacts).some(a=>a.kind==='model_response'&&a.data.http_status===503));
    const next=runner(db,()=>answer([{...proposal(),priority:'urgent'}]),{runLimit:1});
    const bounded=await next.run();assert.equal(next.requests.length,1);assert.equal(bounded.processed,0);
    const recovery=runner(db,input=>{assert.ok(input.repair.errors.some(e=>e.includes('priority')));return answer([]);});
    const recovered=await recovery.run();assert.equal(recovered.processed,1,recovered.warnings.join(';'));assert.equal(recovery.requests.length,1);
  }finally{await db.close();}
});

test('MPAtlas substantive text reaches measured model requests with no omitted document ranges',async()=>{
  const db=await setup(),inputs=[];
  const source=runner(db,input=>{inputs.push(input);return answer([]);},{post:mp});
  try{
    const run=await source.run();assert.equal(run.processed,1,run.warnings.join(';'));
    const prepared=(await db.query('select parsed from scout.evidence where record_id is null')).rows[0].parsed.document.prepared_versions[PREPARATION_VERSION];
    assert.equal(inputs.map(i=>prepared.text.slice(...i.range)).join(''),prepared.text);
    assert.match(inputs.map(i=>i.segments.map(s=>s.text).join('\n')).join('\n'),/allows users to complete MPA Guide assessments and submit additional data/);
    assert.equal(inputs.length,1);assert.deepEqual(inputs[0].omitted_ranges,[]);
    assert.ok(source.requests.every(r=>Buffer.byteLength(r)<=8000));
  }finally{await db.close();}
});

test('long table ranges carry headings, headers and schedule/link context while overlapping proposals deduplicate',async()=>{
  const db=await setup(),inputs=[];
  const row='<tr><td>First session</td><td>2026-10-21T10:00:00Z</td><td>Ocean Institute</td><td>Marine data standards workshop.</td></tr>';
  const post={...article,content:{rendered:'<h1>Data workshops</h1><h2>First session</h2><table><caption>Schedule</caption><tr><th>Session</th><th>UTC date</th><th>Organizer</th><th>Context</th></tr>'+row.repeat(25)+'</table><p><a href="/register">Register</a></p>'}};
  const source=runner(db,input=>{inputs.push(input);return answer(input.segments.some(s=>s.text.includes('Marine data standards workshop.'))?[proposal()]:[]);},{post});
  try{
    const run=await source.run();assert.equal(run.processed,1,run.warnings.join(';'));assert.equal(run.created,1);assert.ok(source.requests.length>1);
    const prepared=(await db.query('select parsed from scout.evidence where record_id is null')).rows[0].parsed.document.prepared_versions[PREPARATION_VERSION];
    assert.equal(inputs.map(i=>prepared.text.slice(...i.range)).join(''),prepared.text);
    assert.ok(inputs.filter(i=>i.table_headers.length).every(i=>i.table_headers.join('').includes('Session\tUTC date')));
    assert.ok(inputs.slice(1).every(i=>i.segments.some(s=>s.text.includes('Data workshops'))));
    assert.ok(inputs.some(i=>i.segments.some(s=>s.text.includes('https://octogroup.org/register'))));
    assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,1);
    assert.ok(Object.values((await report(db,run.run_id)).report.operations).some(o=>o.step==='save'&&o.state==='skipped'));
  }finally{await db.close();}
});

test('unknown update values preserve facts; unsupported identities, fields, date precision and edition changes are rejected',async()=>{
  const db=await setup(),post=structuredClone(article);let unknown=false;
  const source=runner(db,input=>{
    let p=proposal();if(unknown){p={...p,action:'update',record_id:input.existing[0].id,candidate:{...p.candidate,organization:null,description:null,starts_at:null}};}
    return answer([p]);
  },{post});
  try{
    assert.equal((await source.run()).processed,1);unknown=true;post.content.rendered+='<p>Unchanged finding.</p>';
    const run=await source.run();assert.equal(run.processed,1,run.warnings.join(';'));
    const old=(await db.query('select * from scout.records')).rows[0];assert.equal(old.organization,'Ocean Institute');assert.equal(old.description,'Marine data standards workshop.');assert.ok(old.starts_at);
    const prepared=prepareDocument({title:article.title.rendered,html:article.content.rendered,url:article.link});
    const input=packDocument({id:'source'},prepared,[],0,DOCUMENT_VERSION);
    const p=proposal();assert.throws(()=>validateProposal({...p,action:'update',record_id:'unknown'},input,[]),/supplied existing ID/);
    assert.throws(()=>validateProposal({...p,candidate:{...p.candidate,location:'Invented room'}},input,[]),/location/);
    assert.throws(()=>validateProposal({...p,candidate:{...p.candidate,starts_at:'2026-10-21T00:00:00Z'},evidence:{...p.evidence,starts_at:'2026-10-21'}},input,[]),/date, clock and zone/);
    const dated={...input,segments:[{text:'2026-02-30T10:00:00Z '+input.segments[0].text}]};
    assert.throws(()=>validateProposal({...p,candidate:{...p.candidate,starts_at:'2026-02-30T10:00:00Z'},evidence:{...p.evidence,starts_at:'2026-02-30T10:00:00Z'}},dated,[]),/date, clock and zone/);
    const other={...old,starts_at:'2027-10-21T10:00:00Z',anchor:p.anchor};
    assert.throws(()=>validateProposal({...p,action:'update',record_id:old.id},input,[other]),/same-finding correction/);
    const correction='First session rescheduled to 2026-10-21T10:00:00Z';
    assert.ok(validateProposal({...p,action:'update',record_id:old.id,evidence:{...p.evidence,change:correction}},{...input,segments:[...input.segments,{text:correction}]},[other]));
  }finally{await db.close();}
});

test('a record changed after request cannot be overwritten; refreshed repair can defer explicitly',async()=>{
  const db=await setup();try{
    await runner(db,()=>answer([proposal()])).run();
    const post={...article,content:{rendered:article.content.rendered+'<p>Corrected description.</p>'}};
    const source=runner(db,async(input,n)=>{
      if(n===1){await db.query("update scout.records set description='Concurrent review'");return answer([{...proposal(),action:'update',record_id:input.existing[0].id,
        candidate:{...proposal().candidate,description:'Corrected description.'},evidence:{...proposal().evidence,description:'Corrected description.'}}]);}
      assert.ok(input.repair.errors.some(e=>e.includes('changed after input')));assert.equal(input.existing[0].description,'Concurrent review');
      return {complete:false,reason:'Reconcile the concurrent review before changing it.',proposals:[]};
    },{post});
    const run=await source.run();assert.equal(run.processed,0);assert.equal((await db.query('select description from scout.records')).rows[0].description,'Concurrent review');
    assert.ok(run.warnings.some(w=>w.includes('Unresolved source context')));
  }finally{await db.close();}
});

test('malformed returned JSON repairs with the exact rejected text, while oversized repair context defers intact',async()=>{
  const db=await setup();try{
    const source=runner(db,(input,n)=>{
      if(n===1)return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'not JSON test-key'}]}}]});
      assert.equal(input.repair.rejected,'not JSON [REDACTED]');return answer([]);
    });
    const run=await source.run();assert.equal(run.processed,1,run.warnings.join(';'));assert.equal(source.requests.length,2);
    assert.ok(!JSON.stringify((await report(db,run.run_id)).report).includes('test-key'));
    const huge=runner(db,()=>({bad:'X'.repeat(9000)}));const failed=await huge.run({documentVersion:'oversized-output'});
    assert.equal(huge.requests.length,1);assert.equal(failed.processed,0);assert.ok(failed.warnings.some(w=>w.includes('Repair request exceeds')));
    const artifacts=Object.values((await report(db,failed.run_id)).report.artifacts);assert.ok(artifacts.some(a=>a.kind==='validation_errors'&&a.data.response.bad.length===9000));
  }finally{await db.close();}
});

test('record and accepted-proposal state roll back together on interrupted save, then recover',async()=>{
  const db=await setup();let interrupted=false;
  const adapter={query:db.query.bind(db),transaction:work=>db.transaction(tx=>work({query:async(sql,args)=>{
    if(!interrupted&&sql.startsWith("update scout.evidence set parsed=jsonb_set(parsed,'{document}',")&&JSON.parse(args[2]).accepted?.length===2){interrupted=true;throw new Error('Injected interrupted second save');}
    return tx.query(sql,args);
  }}))};
  const source=runner(adapter,()=>answer([proposal(),proposal('Second session','2026-10-22T10:00:00Z')]));
  try{
    const run=await source.run();assert.equal(run.processed,1,run.warnings.join(';'));assert.equal(run.created,2);assert.ok(interrupted);assert.equal(source.requests.length,2);
    assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,2);
    const state=(await db.query('select parsed from scout.evidence where record_id is null')).rows[0].parsed.document;
    assert.equal(Object.values(state.processing_versions)[0].accepted.length,2);
  }finally{await db.close();}
});

test('older preparation artifacts keep their captured version after newer preparation is stored',async()=>{
  const db=await setup(),source=runner(db,()=>answer([]));try{
    const first=await source.run({documents:true});const row=(await db.query('select * from scout.evidence')).rows[0];
    const old={...row.parsed.document.prepared_versions[PREPARATION_VERSION],version:'octo-documents-v1',text:'Earlier prepared context'};
    await db.query("update scout.evidence set parsed=jsonb_set(parsed,'{document}',(parsed->'document')||$2::jsonb) where id=$1",[row.id,JSON.stringify({prepared:old,prepared_versions:{},preparation:{state:'complete',version:old.version}})]);
    const firstReport=(await report(db,first.run_id)).report,key=Object.keys(firstReport.artifacts).find(k=>firstReport.artifacts[k].kind==='preparation');
    delete firstReport.artifacts[key].preparation_version;await db.query('update scout.collection_runs set report=$2 where id=$1',[first.run_id,firstReport]);
    const current=await source.run({documents:true}),currentReport=(await report(db,current.run_id)).report,currentKey=Object.keys(currentReport.artifacts).find(k=>currentReport.artifacts[k].kind==='preparation');
    const member='00000000-0000-4000-8000-000000000001';await db.query('insert into auth.users(id) values($1)',[member]);
    await db.query("insert into auth.identities values($1,'google',$2)",[member,{iss:'https://accounts.google.com',email_verified:true,custom_claims:{hd:'oceanagentics.com'}}]);
    await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[member]);
    assert.deepEqual((await db.query('select scout.run_artifact($1,$2) a',[first.run_id,key])).rows[0].a,old);
    const latest=(await db.query('select scout.run_artifact($1,$2) a',[current.run_id,currentKey])).rows[0].a;
    assert.equal(latest.version,PREPARATION_VERSION);assert.match(latest.text,/First session/);assert.notEqual(latest.text,old.text);
  }finally{await db.close();}
});

test('time-bounded processing remains recoverable without dispatching a model request',async()=>{
  const db=await setup(),source=runner(db,()=>answer([]));try{
    const deferred=await source.run({deadline:Date.now()+900});assert.equal(deferred.processed,0);assert.equal(source.requests.length,0);
    assert.ok(deferred.warnings.some(w=>w.includes('time bound')));
    assert.equal(stepState((await report(db,deferred.run_id)).report,'validate'),'Not reached');
    const recovered=await source.run();assert.equal(recovered.processed,1,recovered.warnings.join(';'));assert.equal(source.requests.length,1);
  }finally{await db.close();}
});
