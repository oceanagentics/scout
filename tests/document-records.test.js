import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {PGlite} from '@electric-sql/pglite';
import {collectHSA} from '../collector/hsa.js';
import {gemini,MODEL_LIMITS} from '../collector/model.js';
import {CONTENT_FIELDS} from '../collector/assessment.js';
import {prepareDocument,PREPARATION_VERSION} from '../collector/octo-documents.js';
import {packDocument,validateFinding,candidatesFor,DOCUMENT_VERSION} from '../collector/document-records.js';
import {stepState} from '../src/runs.js';

const fixture=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/octo-webinars.json.gz',import.meta.url))));
const mp=JSON.parse(fixture.posts.body).find(p=>p.id===16281);
const feedURL='https://octogroup.org/feed/';
const article={...mp,id:99,link:'https://octogroup.org/two-sessions/',title:{rendered:'Data workshops'},content:{rendered:'<h1>Data workshops</h1><p>First session</p><p>2026-10-21T10:00:00Z</p><p>Ocean Institute</p><p>Second session</p><p>2026-10-22T10:00:00Z</p><p>Marine data standards workshop.</p>'}};
const answer=findings=>({complete:true,reason:'All supplied finding evidence considered.',findings});
const proposal=(title='First session',date='2026-10-21T10:00:00Z')=>({anchor:title,urls:[],
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
    budget.requests++;
    if(url!==feedURL&&!url.endsWith('/'+post.id)){
      const known=(await db.query("select content::jsonb->'article' article from scout.evidence where record_id is null and parsed#>>'{document,id}'=$1 order by last_seen_at desc limit 1",[url.split('/').at(-1)])).rows[0];
      if(known)return known.article;
    }
    return {url,status:200,body:url===feedURL?'<rss><channel><item><guid>https://octogroup.org/?p='+post.id+'</guid><link>'+post.link+'</link><title>'+post.title.rendered+'</title><description>Feed excerpt.</description></item></channel></rss>':JSON.stringify(post)};
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


const resolution=(input,outcome='new',record_id=null)=>({outcome,record_id,reason:'Supported finding identity considered against supplied records.',evidence:{identity:input.finding.anchor,distinction:input.finding.anchor}});
const stages=(findings,resolve=input=>resolution(input))=>input=>{
  if(input.stage==='extract'){assert.equal(input.candidates,undefined);assert.equal(input.existing,undefined);return answer(typeof findings==='function'?findings(input):findings);}
  assert.equal(input.stage,'resolve');return resolve(input);
};
const current=async db=>(await db.query('select * from scout.records order by title')).rows;
const progress=async(db,id)=>(await db.query("select parsed from scout.evidence where record_id is null and ($1::text is null or parsed#>>'{document,id}'=$1) order by last_seen_at desc limit 1",[id==null?null:String(id)])).rows[0].parsed.document;
const release={...proposal(),anchor:'Ocean Data Release',candidate:{...Object.fromEntries(CONTENT_FIELDS.map(k=>[k,null])),kind:'announcement',title:'Ocean Data Release',organization:'Ocean Institute',description:'A new ocean data portal was released.'},
  evidence:{kind:'Ocean Data Release',title:'Ocean Data Release',organization:'Ocean Institute',description:'A new ocean data portal was released.',priority:'A new ocean data portal was released.'}};
const digest={...article,title:{rendered:'Weekly digest'},content:{rendered:'<h2>Ocean Data Release</h2><p>Ocean Institute</p><p>A new ocean data portal was released.</p>'}};
const bulletin={...digest,id:100,link:'https://octogroup.org/research-bulletin/',title:{rendered:'Research bulletin'}};
const seed=async(db,p=release,key='fixture')=>(await db.query('insert into scout.records('+CONTENT_FIELDS.join(',')+',priority,identity_key) values('+CONTENT_FIELDS.map((_,i)=>'$'+(i+1)).join(',')+',$11,$12) returning *',[...CONTENT_FIELDS.map(k=>p.candidate[k]),p.priority,key])).rows[0];

test('generic enclosing titles retrieve the same finding BEFORE resolution; corroboration associates both sources without overwriting',async()=>{
  const db=await setup();try{
    const first=runner(db,stages([release]),{post:digest});assert.equal((await first.run()).created,1);
    const old=(await current(db))[0];
    const second=runner(db,stages([{...release,priority:'normal'}],input=>{
      assert.equal(input.candidates.length,1);assert.equal(input.candidates[0].id,old.id);
      assert.equal(input.candidates[0].description,release.candidate.description);assert.equal(input.repair,undefined);
      assert.equal(input.coverage.complete,true);assert.ok(input.coverage.terms.includes('release'));
      return resolution(input,'evidence',old.id);
    }),{post:bulletin});
    const run=await second.run();assert.equal(run.processed,2,run.warnings.join(';'));assert.equal(run.created,0);
    assert.equal(second.requests.length,2);assert.deepEqual(await current(db),[old]);
    const linked=(await db.query('select record_id,url,parsed from scout.evidence where record_id is not null')).rows;
    assert.deepEqual(new Set(linked.map(e=>e.url)),new Set([digest.link,bulletin.link]));assert.ok(linked.every(e=>e.record_id===old.id&&e.parsed.document.capture_id));
    assert.equal(linked.find(e=>e.url===bulletin.link).parsed.assessment.priority,'normal');
    assert.equal(linked.find(e=>e.url===bulletin.link).parsed.assessment.priority_accepted,false);
    const detail=await report(db,run.run_id);assert.equal(detail.stats.model_attempts.length,2);
    for(const kind of ['extract_input','extract_response','retrieval','resolve_input','resolve_response'])assert.ok(Object.values(detail.report.artifacts).some(a=>a.kind===kind));
    assert.equal((await second.run()).processed,2);assert.equal(second.requests.length,2);
    const reconsider=runner(db,stages([{...release,priority:'normal'}],input=>resolution(input,'evidence',old.id)),{post:digest});
    await reconsider.run({documentVersion:'rating-review'});
    const original=(await db.query('select parsed from scout.evidence where record_id=$1 and url=$2',[old.id,digest.link])).rows[0].parsed;
    assert.equal(original.authority,true);assert.equal(original.assessment.priority,'high');assert.equal(original.finding.priority,'normal');
  }finally{await db.close();}
});

test('finding search uses independent supported facts across changed titles/URLs and missing fields, while disclosing lexical misses',async()=>{
  const db=await setup();try{
    const old=await seed(db);
    const source={url:'https://octogroup.org/unrelated/',parsed:{document:{identity:'new-document'}}};
    for(const candidate of [
      {...release.candidate,organization:null,description:null},
      {...release.candidate,title:'Portal availability',description:null},
      {...release.candidate,title:'Portal availability',organization:null},
    ]){
      const found=await candidatesFor(db,source,{...release,anchor:candidate.title,candidate});
      assert.deepEqual(found.rows.map(r=>r.id),[old.id]);assert.equal(found.coverage.complete,true);
    }
    const absent={...release,anchor:'Unrelated subject',candidate:{...release.candidate,title:'Unrelated subject',organization:null,description:null}};
    const missed=await candidatesFor(db,source,absent);assert.equal(missed.rows.length,0);assert.match(missed.coverage.weakness,/miss paraphrases/);assert.ok(missed.coverage.missing.includes('organization'));
    const event=proposal();const saved=await seed(db,event,'event');
    for(const candidate of [
      {...event.candidate,title:'Different title',organization:null,description:null,event_url:null},
      {...event.candidate,title:'Different title',organization:null,description:null,starts_at:null},
    ])assert.ok((await candidatesFor(db,source,{...event,anchor:'Different title',candidate})).rows.some(r=>r.id===saved.id));
    const changed={...release,anchor:'Ocean Portal Launch',candidate:{...release.candidate,title:'Ocean Portal Launch'},evidence:{...release.evidence,title:'Ocean Portal Launch',kind:'Ocean Portal Launch'}};
    const post={...bulletin,content:{rendered:bulletin.content.rendered.replaceAll('Ocean Data Release','Ocean Portal Launch')}};
    const run=await runner(db,stages([changed],input=>{
      assert.ok(input.candidates.some(r=>r.id===old.id));return resolution(input,'evidence',old.id);
    }),{post}).run();
    assert.equal(run.processed,1,run.warnings.join(';'));assert.equal((await current(db)).length,2);
    assert.equal((await db.query('select title from scout.records where id=$1',[old.id])).rows[0].title,old.title);
  }finally{await db.close();}
});

test('distinct sessions and explicit annual editions sharing titles/URLs remain separate; repeat/version/changed text reuse identities',async()=>{
  const db=await setup(),post=structuredClone(article);
  const source=runner(db,stages([proposal(),proposal('Second session','2026-10-22T10:00:00Z')],input=>{
    const old=input.candidates.find(r=>r.title===input.finding.candidate.title);
    return resolution(input,old?'evidence':'new',old?.id??null);
  }),{post});
  try{
    const first=await source.run();assert.equal(first.created,2,first.warnings.join(';'));assert.equal(source.requests.length,3);
    const old=await current(db);assert.equal(old[0].event_url,old[1].event_url);
    assert.equal((await source.run()).processed,1);assert.equal(source.requests.length,3);
    post.content.rendered+='<p>Minor punctuation change.</p>';
    assert.equal((await source.run()).processed,1);assert.equal((await source.run({documentVersion:'explicit-review'})).processed,1);
    assert.equal((await current(db)).length,2);assert.equal(source.requests.length,9);
    const p={...proposal('First session','2027-10-21T10:00:00Z'),anchor:'First session 2027 edition'};
    const next={...article,content:{rendered:article.content.rendered.replaceAll('2026','2027').replace('First session','First session 2027 edition')}};
    const edition=await runner(db,stages([p],input=>{
      assert.equal(input.candidates.length,2);return resolution(input);
    }),{post:next}).run();
    assert.equal(edition.created,1,edition.warnings.join(';'));assert.equal((await current(db)).length,3);
  }finally{await db.close();}
});

test('announcement identity URLs and quoted aliases retrieve renamed findings with otherwise missing facts',async()=>{
  const db=await setup();try{
    const url='https://data.example/ocean-release';
    await runner(db,stages([{...release,urls:[url]}]),{post:{...digest,content:{rendered:digest.content.rendered+'<a href="'+url+'">Release</a>'}}}).run();const old=(await current(db))[0];
    const alias='Portal launch, previously called Ocean Data Release.';
    const p={...release,anchor:'Portal launch',urls:[url],
      candidate:{...release.candidate,title:'Portal launch',organization:null,description:null},
      evidence:{kind:'Portal launch',title:'Portal launch',identity:alias,priority:'A new ocean data portal was released.'}};
    const post={...bulletin,content:{rendered:'<p>'+alias+'</p><a href="'+url+'">Original announcement</a><p>A new ocean data portal was released.</p>'}};
    // URL alone retrieves before resolution; alias terms independently retrieve too.
    const source={url:post.link,parsed:{document:{identity:'octo:post:100'}}};
    assert.deepEqual((await candidatesFor(db,source,{...p,evidence:{...p.evidence,identity:undefined}})).rows.map(r=>r.id),[old.id]);
    assert.deepEqual((await candidatesFor(db,source,{...p,urls:[]})).rows.map(r=>r.id),[old.id]);
    const run=await runner(db,stages([p],input=>{
      assert.equal(input.candidates[0].id,old.id);assert.deepEqual(input.coverage.urls,[url]);assert.deepEqual(input.candidates[0].identity_urls,[url]);
      return {...resolution(input,'evidence',old.id),evidence:{identity:alias}};
    }),{post}).run();
    assert.equal(run.processed,2,run.warnings.join(';'));assert.deepEqual(await current(db),[old]);
  }finally{await db.close();}
});

test('disputed dates/organizers cannot create duplicates or false merges; uncertainty is valid and inspectable',async()=>{
  for(const conflict of ['starts_at','organization']){
    const db=await setup();try{
      await runner(db,stages([proposal()])).run();const old=(await current(db))[0];
      const value=conflict==='starts_at'?'2027-10-21T10:00:00Z':'Other Institute';
      const p={...proposal(),candidate:{...proposal().candidate,[conflict]:value},evidence:{...proposal().evidence,[conflict]:value}};
      const post={...article,id:100,content:{rendered:article.content.rendered+'<p>'+value+'</p>'}};
      let attempts=0;
      const source=runner(db,stages([p],input=>{
        assert.equal(input.candidates[0].id,old.id);
        if(++attempts===1)return resolution(input,'new');
        if(attempts===2){assert.match(input.repair.errors.join(),/disputed/);return resolution(input,'evidence',old.id);}
        assert.match(input.repair.errors.join(),/Disputed/);return resolution(input,'uncertain');
      }),{post});
      const run=await source.run();assert.equal(run.processed,1);assert.equal(run.uncertain,1);assert.equal(run.failed,0);assert.equal(source.requests.length,4);
      assert.deepEqual(await current(db),[old]);assert.equal((await progress(db,100)).processing.state,'uncertain');
      const detail=await report(db,run.run_id);assert.match(stepState(detail.report,'validate'),/^Uncertain/);
      assert.ok(Object.values(detail.report.artifacts).some(a=>a.kind==='uncertain_findings'));
      assert.equal((await source.run()).processed,1);assert.equal(source.requests.length,4);
    }finally{await db.close();}
  }
});

test('evidenced corrections update only authoritative findings, preserve unknowns and reject source authority laundering',async()=>{
  const db=await setup();try{
    await runner(db,stages([proposal()])).run();const old=(await current(db))[0];
    const date='2026-11-21T10:00:00Z',change='First session rescheduled to '+date,authority='Ocean Institute announces this correction.';
    const p={...proposal('First session',date),candidate:{...proposal('First session',date).candidate,description:null,organization:null},evidence:{...proposal('First session',date).evidence,change,authority}};
    const post={...article,content:{rendered:article.content.rendered+'<p>'+change+'</p><p>'+authority+'</p>'}};
    const corrected=await runner(db,stages([p],input=>{
      assert.equal(input.candidates[0].authoritative_source,true);
      return {...resolution(input,'update',old.id),evidence:{identity:p.anchor,change,authority}};
    }),{post}).run();
    assert.equal(corrected.processed,1,corrected.warnings.join(';'));assert.equal(corrected.changed,1);
    const updated=(await current(db))[0];assert.equal(new Date(updated.starts_at).toISOString(),new Date(date).toISOString());
    assert.equal(updated.organization,old.organization);assert.equal(updated.description,old.description);
    const other={...post,id:100,link:'https://octogroup.org/support/',content:{rendered:post.content.rendered+'<p>'+article.link+'</p>'}};
    assert.equal((await runner(db,stages([p],input=>resolution(input,'evidence',old.id)),{post:other}).run()).processed,2);
    const disputed={...p,candidate:{...p.candidate,starts_at:'2026-12-21T10:00:00Z'},evidence:{...p.evidence,starts_at:'2026-12-21T10:00:00Z',change:'First session rescheduled to 2026-12-21T10:00:00Z'}};
    other.content.rendered+='<p>'+disputed.evidence.change+'</p>';
    const blocked=await runner(db,stages([disputed],input=>{
      assert.equal(input.candidates[0].same_source,true);assert.equal(input.candidates[0].authoritative_source,false);
      return input.repair?resolution(input,'uncertain'):{...resolution(input,'update',old.id),evidence:{identity:p.anchor,change:disputed.evidence.change,authority}};
    }),{post:other}).run();
    assert.equal(blocked.processed,1);assert.deepEqual(await current(db),[updated]);
  }finally{await db.close();}
});

test('ambiguous candidates stay uncertain; nine compact candidates are allowed; byte and database bounds defer intact sets',async()=>{
  for(const count of [2,9,20,101]){
    const db=await setup();try{
      for(let i=0;i<count;i++)await seed(db,{...release,candidate:{...release.candidate,description:count===20?'Long description '.repeat(15):null,organization:null}},'candidate-'+i);
      const source=runner(db,stages([release],input=>{
        assert.equal(input.candidates.length,count);assert.equal(input.coverage.matching_count,count);
        if(count===2&&!input.repair)return resolution(input,'evidence',input.candidates[0].id);
        if(count===2)assert.match(input.repair.errors.join(),/Ambiguous/);
        return resolution(input,'uncertain');
      }),{post:digest});
      const run=await source.run();assert.equal(run.processed,0);assert.equal((await current(db)).length,count);
      assert.equal((await db.query('select count(*)::int n from scout.evidence where record_id is not null')).rows[0].n,0);
      assert.equal(source.requests.length,count===2?3:count===9?2:1);
      if(count>=20)assert.ok(run.warnings.some(w=>/8000 bytes|retrieval incomplete/.test(w)));
      const retrieval=Object.values((await report(db,run.run_id)).report.artifacts).find(a=>a.kind==='retrieval').data;
      assert.equal(retrieval.coverage.matching_count,count);assert.equal(retrieval.coverage.complete,count<=100);
    }finally{await db.close();}
  }
});

test('extraction repair persists valid findings, exhausts independently, and resumes without losing evidence',async()=>{
  const db=await setup();let fixed=false;
  const bad={...proposal('Second session','2026-10-22T10:00:00Z'),priority:'urgent'};
  const source=runner(db,input=>input.stage==='extract'?answer(fixed?[{...bad,priority:'high'}]:[proposal(),bad]):resolution(input));
  try{
    const failed=await source.run();assert.equal(failed.processed,0);assert.equal(failed.created,0);assert.equal(source.requests.length,3);
    const state=Object.values((await progress(db)).processing_versions)[0];assert.equal(state.findings.length,1);assert.equal(state.findings[0].resolution,undefined);
    fixed=true;const recovery=await source.run();assert.equal(recovery.processed,1,recovery.warnings.join(';'));assert.equal(recovery.created,2);
    assert.equal(source.requests.length,6);assert.equal((await current(db)).length,2);
    assert.ok(Object.values((await report(db,failed.run_id)).report.artifacts).some(a=>a.kind==='validation_errors'&&a.data.stage==='extract'));
  }finally{await db.close();}
});

test('resolution repair and exhaustion retain prior saves; partial work resumes without extraction or duplicate writes',async()=>{
  const db=await setup();let fixed=false;
  const source=runner(db,stages([proposal(),proposal('Second session','2026-10-22T10:00:00Z')],input=>{
    if(input.finding.anchor==='Second session'&&!fixed)return {...resolution(input,'evidence','not-supplied')};
    return resolution(input);
  }));
  try{
    const failed=await source.run();assert.equal(failed.processed,0);assert.equal(failed.created,1);assert.equal(source.requests.length,5);
    assert.ok(failed.warnings.some(w=>w.includes('Two resolve repair attempts exhausted')));
    fixed=true;const recovered=await source.run();assert.equal(recovered.processed,1,recovered.warnings.join(';'));assert.equal(recovered.created,1);
    assert.equal(source.requests.length,6);assert.equal((await current(db)).length,2);
    assert.equal(JSON.parse(JSON.parse(source.requests.at(-1)).contents[0].parts[0].text)[0].stage,'resolve');
  }finally{await db.close();}
});

test('both stages share durable minute/run limits, counted transient retry and resumable repair state',async()=>{
  const db=await setup();try{
    const source=runner(db,(input,n)=>n===1?new Response('temporary',{status:503}):answer([proposal()]),{advance:false});
    const run=await source.run();assert.equal(run.processed,0);assert.equal(source.requests.length,2);
    assert.equal((await report(db,run.run_id)).stats.model_attempts.length,2);assert.ok(run.warnings.some(w=>w.includes('quota')));
    const bounded=runner(db,input=>{assert.equal(input.stage,'resolve');return {...resolution(input),record_id:'bad'};},{runLimit:1});
    const next=await bounded.run();assert.equal(next.processed,0);assert.equal(bounded.requests.length,1);
    const recovery=runner(db,input=>{assert.equal(input.stage,'resolve');assert.ok(input.repair.errors.length);return resolution(input);});
    const recovered=await recovery.run();assert.equal(recovered.processed,1,recovered.warnings.join(';'));assert.equal(recovery.requests.length,1);
    assert.equal((await current(db)).length,1);
  }finally{await db.close();}
});

test('malformed outputs in either stage repair with redacted text; intact oversized repair defers',async()=>{
  const db=await setup();try{
    let extract=0,resolve=0;
    const source=runner(db,input=>{
      const n=input.stage==='extract'?++extract:++resolve;
      if(n===1)return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'not JSON test-key'}]}}]});
      assert.equal(input.repair.rejected,'not JSON [REDACTED]');
      return input.stage==='extract'?answer([proposal()]):resolution(input);
    });
    const run=await source.run();assert.equal(run.processed,1,run.warnings.join(';'));assert.equal(source.requests.length,4);
    const detail=await report(db,run.run_id);assert.equal(detail.stats.model_attempts.length,4);assert.ok(!JSON.stringify(detail).includes('test-key'));
    assert.equal(stepState(detail.report,'validate'),'Pass');assert.ok(Object.values(detail.report.operations).some(o=>o.recovered_by));
    const huge=runner(db,()=>({bad:'X'.repeat(9000)}));const failed=await huge.run({documentVersion:'oversized-output'});
    assert.equal(huge.requests.length,1);assert.equal(failed.processed,0);assert.ok(failed.warnings.some(w=>w.includes('Repair request exceeds')));
    assert.ok(Object.values((await report(db,failed.run_id)).report.artifacts).some(a=>a.kind==='validation_errors'&&a.data.response.bad.length===9000));
  }finally{await db.close();}
});

test('concurrent matching insert refreshes actual candidates before resolution; no duplicate is created',async()=>{
  const db=await setup();let old;
  const source=runner(db,stages([release],async input=>{
    if(!input.repair){assert.equal(input.candidates.length,0);old=await seed(db);return resolution(input);}
    assert.match(input.repair.errors.join(),/changed after input/);assert.equal(input.candidates[0].id,old.id);
    return resolution(input,'evidence',old.id);
  }),{post:digest});
  try{
    const run=await source.run();assert.equal(run.processed,1,run.warnings.join(';'));assert.equal(run.created,0);
    assert.equal(source.requests.length,3);assert.equal((await current(db)).length,1);
  }finally{await db.close();}
});

test('concurrent record changes prevent stale updates; refreshed resolution can remain uncertain',async()=>{
  const db=await setup();try{
    await runner(db,stages([proposal()])).run();const old=(await current(db))[0];
    const source=runner(db,stages([proposal()],async input=>{
      if(!input.repair){await db.query("update scout.records set description='Concurrent review' where id=$1",[old.id]);return resolution(input,'update',old.id);}
      assert.equal(input.candidates[0].description,'Concurrent review');assert.match(input.repair.errors.join(),/changed after input/);
      return resolution(input,'uncertain');
    }));
    const run=await source.run({documentVersion:'concurrent-review'});assert.equal(run.processed,0);assert.equal(source.requests.length,3);
    assert.equal((await current(db))[0].description,'Concurrent review');
  }finally{await db.close();}
});

test('different session/edition labels cannot merge through a shared URL when dates are missing',async()=>{
  for(const edition of [false,true]){
    const db=await setup();try{
      const first={...proposal(),anchor:edition?'First session 2026 edition':'First session'};
      const post={...article,content:{rendered:article.content.rendered+'<p>'+first.anchor+'</p>'}};
      await runner(db,stages([first]),{post}).run();const old=(await current(db))[0];
      const p={...proposal(edition?'First session':'Second session'),anchor:edition?'First session 2027 edition':'Second session'};
      p.candidate.starts_at=null;
      const next={...post,content:{rendered:post.content.rendered+'<p>'+p.anchor+'</p>'}};
      const source=runner(db,stages([p],input=>{
        assert.equal(input.candidates[0].id,old.id);
        if(input.repair){assert.match(input.repair.errors.join(),/Distinct/);return resolution(input,'uncertain');}
        return resolution(input,'evidence',old.id);
      }),{post:next});
      const run=await source.run();assert.equal(run.uncertain,1,run.warnings.join(';'));assert.equal(source.requests.length,3);
      assert.deepEqual(await current(db),[old]);
    }finally{await db.close();}
  }
});

test('concurrent document progress cannot be overwritten and its speculative record save rolls back',async()=>{
  const db=await setup();try{
    const source=runner(db,stages([proposal()],async input=>{
      const key=input.version;
      await db.query("update scout.evidence set parsed=jsonb_set(parsed,array['document','processing_versions',$2],(parsed#>array['document','processing_versions',$2])||jsonb_build_object('revision',(parsed#>>array['document','processing_versions',$2,'revision'])::int+1,'external_progress',true)) where id=$1",[input.source_id,key]);
      return resolution(input);
    }));
    const run=await source.run();assert.equal(run.processed,0);assert.equal(run.created,0);assert.equal(source.requests.length,2);
    assert.ok(run.warnings.some(w=>w.includes('progress changed concurrently')));assert.equal((await current(db)).length,0);
    const state=Object.values((await progress(db)).processing_versions)[0];assert.equal(state.external_progress,true);assert.equal(state.findings[0].resolution,undefined);
  }finally{await db.close();}
});

test('interrupted transactional save rolls back record and resolution together, then repairs without re-extraction',async()=>{
  const db=await setup();let interrupted=false;
  const adapter={query:db.query.bind(db),transaction:work=>db.transaction(tx=>work({query:async(sql,args)=>{
    if(!interrupted&&sql.startsWith("update scout.evidence set parsed=jsonb_set")&&JSON.parse(args[2]).findings?.some(f=>f.resolution)){interrupted=true;throw new Error('Interrupted save');}
    return tx.query(sql,args);
  }}))};
  const source=runner(adapter,stages([proposal()]));
  try{
    const run=await source.run();assert.equal(run.processed,1,run.warnings.join(';'));assert.equal(run.created,1);assert.ok(interrupted);
    assert.equal(source.requests.length,3);assert.equal((await current(db)).length,1);
    assert.equal(Object.values((await progress(db)).processing_versions)[0].findings.filter(f=>f.record_id).length,1);
  }finally{await db.close();}
});

test('zero and Low findings retain extraction/resolution evidence without inserting records',async()=>{
  const db=await setup();try{
    const zero=runner(db,stages([]));assert.equal((await zero.run()).processed,1);assert.equal(zero.requests.length,1);
    const low=runner(db,stages([{...proposal(),priority:'low'}]));const run=await low.run({documentVersion:'low-review'});
    assert.equal(run.processed,1,run.warnings.join(';'));assert.equal(low.requests.length,2);assert.equal((await current(db)).length,0);
    assert.ok(Object.values((await progress(db)).processing_versions).some(s=>s.findings.some(f=>f.finding.priority==='low'&&f.resolution.outcome==='new'&&f.record_id===null)));
  }finally{await db.close();}
});

test('MPAtlas complete text and long table context reach extraction; lookup never enters extraction input',async()=>{
  for(const long of [false,true]){
    const db=await setup(),inputs=[];
    const row='<tr><td>First session</td><td>2026-10-21T10:00:00Z</td><td>Ocean Institute</td><td>Marine data standards workshop.</td></tr>';
    const post=long?{...article,content:{rendered:'<h1>Data workshops</h1><h2>First session</h2><table><caption>Schedule</caption><tr><th>Session</th><th>UTC date</th><th>Organizer</th><th>Context</th></tr>'+row.repeat(25)+'</table><p><a href="/register">Register</a></p>'}}:mp;
    const source=runner(db,stages(input=>{inputs.push(input);return long?[proposal()]:[];}),{post});
    try{
      const run=await source.run();assert.equal(run.processed,1,run.warnings.join(';'));
      const prepared=(await progress(db)).prepared_versions[PREPARATION_VERSION];
      assert.equal(inputs.map(i=>prepared.text.slice(...i.range)).join(''),prepared.text);
      if(long){
        assert.equal((await current(db)).length,1);assert.ok(inputs.length>1);
        assert.ok(inputs.filter(i=>i.table_headers.length).every(i=>i.table_headers.join('').includes('Session\tUTC date')));
        assert.ok(inputs.slice(1).every(i=>i.segments.some(s=>s.text.includes('Data workshops'))));
        assert.ok(inputs.some(i=>i.segments.some(s=>s.text.includes('https://octogroup.org/register'))));
      }else{
        assert.equal(inputs.length,1);assert.deepEqual(inputs[0].omitted_ranges,[]);
        assert.match(inputs[0].segments.map(s=>s.text).join('\n'),/allows users to complete MPA Guide assessments and submit additional data/);
      }
      assert.ok(source.requests.every(r=>Buffer.byteLength(r)<=8000));
    }finally{await db.close();}
  }
});

test('grounding rejects invented values and imprecise/invalid dates; time deferral dispatches no model work',async()=>{
  const prepared=prepareDocument({title:article.title.rendered,html:article.content.rendered,url:article.link});
  const input=packDocument({id:'source'},prepared,0,DOCUMENT_VERSION),p=proposal();
  assert.throws(()=>validateFinding({...p,candidate:{...p.candidate,location:'Invented room'}},input),/location/);
  assert.throws(()=>validateFinding({...p,urls:['https://invented.example/']},input),/finding URLs/);
  assert.throws(()=>validateFinding({...p,candidate:{...p.candidate,starts_at:'2026-10-21T00:00:00Z'},evidence:{...p.evidence,starts_at:'2026-10-21'}},input),/date, clock and zone/);
  const dated={...input,segments:[{text:'2026-02-30T10:00:00Z '+input.segments[0].text}]};
  assert.throws(()=>validateFinding({...p,candidate:{...p.candidate,starts_at:'2026-02-30T10:00:00Z'},evidence:{...p.evidence,starts_at:'2026-02-30T10:00:00Z'}},dated),/date, clock and zone/);
  const db=await setup(),source=runner(db,stages([]));try{
    const run=await source.run({deadline:Date.now()+900});assert.equal(run.processed,0);assert.equal(source.requests.length,0);
    assert.equal(stepState((await report(db,run.run_id)).report,'validate'),'Not reached');
    assert.equal((await source.run()).processed,1);assert.equal(source.requests.length,1);
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
