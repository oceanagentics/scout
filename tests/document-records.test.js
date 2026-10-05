import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {PGlite} from '@electric-sql/pglite';
import {collectHSA} from '../collector/hsa.js';
import {gemini,MODEL_LIMITS} from '../collector/model.js';
import {CONTENT_FIELDS} from '../collector/assessment.js';
import {prepareDocument} from '../collector/octo-documents.js';
import {packDocument,validateFinding as validateCitedFinding,DOCUMENT_VERSION} from '../collector/document-records.js';
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
function cited(p,input){
  if(p.citations)return p;
  const citations=[],evidence={};
  for(const [k,quote]of Object.entries(p.evidence).filter(([k])=>k!=='authority')){
    const doc=input.segments.find(s=>s.text.includes(quote))?.doc??Object.entries(input.documents).find(([,d])=>d.url===quote||d.title?.includes(quote))?.[0]??'P';
    evidence[k]=[citations.length];citations.push({doc,quote});
  }
  // Literal test labels also provide identity/distinction context to resolution.
  if(!citations.some(c=>c.quote===p.anchor)){const doc=input.segments.find(s=>s.text.includes(p.anchor))?.doc??'P';citations.push({doc,quote:p.anchor});}
  const dates={};
  for(const k of ['starts_at','ends_at'])if(p.candidate[k])dates[k]={local:p.candidate[k].slice(0,19),zone:'UTC',parts:Object.fromEntries(['year','date','time','zone'].map(part=>[part,evidence[k]??[]]))};
  return {...p,citations,evidence,dates};
}
function reviewed(out,input){
  if(input.stage==='extract')return out?.findings?{...out,findings:out.findings.map(p=>cited(p,input))}:out;
  if(!out?.outcome)return out;
  const evidence=Object.fromEntries(Object.entries(out.evidence).filter(([k])=>k!=='authority').map(([k,q])=>[k,Array.isArray(q)?q:input.finding.citations.flatMap((c,i)=>c.quote.includes(q)?[i]:[])]));
  return {facts:Object.fromEntries([...CONTENT_FIELDS.filter(k=>input.finding.candidate[k]!==null),'priority'].map(k=>[k,'supported'])),
    conflict:out.outcome==='update'?'correction':'none',...out,evidence};
}
function runner(db,respond,{post=article,advance=true,runLimit=10,tokens=()=>200}={}){
  const requests=[];let calls=0;
  const options={trackerId:fixture.tracker.id,validate:true,documents:'process',read:async(url,budget)=>{
    budget.requests++;
    if(url!==feedURL&&!url.includes('/wp-json/wp/v2/posts/'))throw new Error('Only the announcement is supplied');
    return {url,status:200,body:url===feedURL?'<rss><channel><item><guid>https://octogroup.org/?p='+post.id+'</guid><link>'+post.link+'</link><title>'+post.title.rendered+'</title><description>Feed excerpt.</description></item></channel></rss>':JSON.stringify(post)};
  },makeModel:(runId,deadline,trace)=>{
    const actual=gemini({apiKey:'test-key',ledger:db,runId,deadline,trace,runLimit,fetch:async(url,request)=>{
      if(url.endsWith(':countTokens'))return Response.json({totalTokens:tokens()});
      requests.push(request.body);assert.equal(JSON.parse(request.body).generationConfig.maxOutputTokens,MODEL_LIMITS.output);
      const input=JSON.parse(JSON.parse(request.body).contents[0].parts[0].text)[0];
      const out=reviewed(await respond(input,++calls),input);
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
const validateFinding=(p,input)=>validateCitedFinding(cited(p,input),input);
const report=async(db,id)=>(await db.query('select report,stats from scout.collection_runs where id=$1',[id])).rows[0];


const resolution=(input,outcome='new',record_id=null)=>({outcome,record_id,reason:'Supported finding identity considered against supplied records.',evidence:{identity:input.finding.anchor,distinction:input.finding.anchor}});
const stages=(findings,resolve=input=>resolution(input))=>input=>{
  if(input.stage==='extract'){assert.equal(input.candidates,undefined);assert.equal(input.existing,undefined);return answer(typeof findings==='function'?findings(input):findings);}
  assert.equal(input.stage,'resolve');return resolve(input);
};
const current=async db=>(await db.query('select * from scout.records order by title')).rows;
const progress=async(db,id)=>(await db.query("select parsed from scout.evidence where record_id is null and ($1::text is null or parsed#>>'{document,id}'=$1) order by last_seen_at desc limit 1",[id==null?null:String(id)])).rows[0].parsed.document;
const release={...proposal(),anchor:'Ocean Data Workshop',candidate:{...Object.fromEntries(CONTENT_FIELDS.map(k=>[k,null])),kind:'event',title:'Ocean Data Workshop',organization:'Ocean Institute',description:'A workshop on ocean data standards.'},
  evidence:{kind:'Ocean Data Workshop',title:'Ocean Data Workshop',organization:'Ocean Institute',description:'A workshop on ocean data standards.',priority:'A workshop on ocean data standards.'}};
const digest={...article,title:{rendered:'Weekly digest'},content:{rendered:'<h2>Ocean Data Workshop</h2><p>Ocean Institute</p><p>A workshop on ocean data standards.</p>'}};
const seed=async(db,p=release,key='fixture')=>(await db.query('insert into scout.records('+CONTENT_FIELDS.join(',')+',priority,identity_key) values('+CONTENT_FIELDS.map((_,i)=>'$'+(i+1)).join(',')+',$11,$12) returning *',[...CONTENT_FIELDS.map(k=>p.candidate[k]),p.priority,key])).rows[0];

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
  for(const capacity of ['input','output','runtime']){
    const db=await setup();try{
      const prepared=prepareDocument({title:article.title.rendered,html:article.content.rendered,url:article.link});
      const source=runner(db,()=>{
        if(capacity==='runtime')throw new DOMException('Injected request timeout','TimeoutError');
        return Response.json({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:'{"findings":['}]}}],usageMetadata:{candidatesTokenCount:65536}});
      },{runLimit:1,tokens:()=>capacity==='input'?MODEL_LIMITS.input+1:200});
      const failed=await source.run(),state=Object.values((await progress(db)).processing_versions)[0];
      assert.equal(failed.created,0);assert.equal(state.capacity.kind,capacity);assert.equal(state.cursor,0);
      assert.ok(state.end>0&&state.end<prepared.text.length);assert.equal(state.pending,undefined);
      assert.equal(source.requests.length,capacity==='input'?0:1);
      const ledger=(await report(db,failed.run_id)).stats;
      assert.equal(ledger.model_attempts.length,1);assert.equal(ledger.model_attempts[0].output_bound,65536);
      if(capacity==='output')assert.equal(ledger.model_usage[0].finishReason,'MAX_TOKENS');
      const resumed=runner(db,input=>{assert.equal(input.repair,undefined);return answer([]);});
      assert.equal((await resumed.run()).processed,1);assert.equal(resumed.requests.length,2);
      assert.equal(JSON.parse(JSON.parse(resumed.requests[0]).contents[0].parts[0].text)[0].range[1],state.end);
      assert.equal((await resumed.run()).processed,1);assert.equal(resumed.requests.length,2);
    }finally{await db.close();}
  }
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

test('grounding rejects invented values and imprecise/invalid dates; time deferral dispatches no model work',async()=>{
  const prepared=prepareDocument({title:article.title.rendered,html:article.content.rendered,url:article.link});
  const input=packDocument({id:'source'},prepared,0,DOCUMENT_VERSION),p=proposal();
  assert.throws(()=>validateFinding({...p,candidate:{...p.candidate,location:'Invented room'}},input),/location/);
  assert.throws(()=>validateFinding({...p,urls:['https://invented.example/']},input),/finding URLs/);
  for(const part of ['year','time','zone']){
    const missing=cited(p,input);missing.dates.starts_at.parts[part]=[];
    assert.throws(()=>validateCitedFinding(missing,input),/year\/date\/clock\/zone/);
  }
  const dated={...input,segments:[{...input.segments[0],text:'2026-02-30T10:00:00Z '+input.segments[0].text}]};
  assert.throws(()=>validateFinding({...p,candidate:{...p.candidate,starts_at:'2026-02-30T10:00:00Z'},evidence:{...p.evidence,starts_at:'2026-02-30T10:00:00Z'}},dated),/year\/date\/clock\/zone/);
  const db=await setup(),source=runner(db,stages([]));try{
    const run=await source.run({deadline:Date.now()+900});assert.equal(run.processed,0);assert.equal(source.requests.length,0);
    assert.equal(stepState((await report(db,run.run_id)).report,'validate'),'Not reached');
    assert.equal((await source.run()).processed,1);assert.equal(source.requests.length,1);
  }finally{await db.close();}
});

test('retained complete=false uses two resumable repairs, preserves incremental findings and stops unchanged exhaustion',async()=>{
  const live=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/gfw-live-extraction.json.gz',import.meta.url))));
  const refused=JSON.parse(JSON.parse(live.artifacts.a17.data.body).candidates[0].content.parts[0].text);
  for(const partial of [false,true,'persistent','final-round']){const db=await setup();try{
    if(typeof partial==='string'){
      const order=[];let extracts=0;
      const source=runner(db,input=>{order.push(input.stage);if(input.stage==='resolve')return resolution(input);
        extracts++;return {...refused,findings:partial==='persistent'||extracts===3?[proposal()]:[]};});
      const failed=await source.run();assert.equal(failed.created,1);assert.equal((await current(db)).length,1);
      assert.deepEqual(order,partial==='persistent'?['extract','resolve','extract','extract']:['extract','extract','extract','resolve']);
      const state=Object.values((await progress(db)).processing_versions)[0];assert.equal(state.exhausted,true);assert.equal(state.cursor,0);assert.ok(state.findings[0].resolution);
      await source.run();assert.equal(source.requests.length,4);continue;
    }
    const source=runner(db,()=>partial?{...refused,findings:[proposal()]}:refused,{runLimit:1}),failed=await source.run();
    assert.equal(failed.processed,0);assert.equal(source.requests.length,1);
    let state=Object.values((await progress(db)).processing_versions)[0];assert.equal(state.cursor,0);assert.equal(state.pending.round,1);
    assert.equal(state.findings.length,partial?1:0);assert.equal(state.pending.repair.rejected.complete,false);
    if(partial){
      const recovery=runner(db,input=>{if(input.stage==='resolve')return resolution(input);assert.equal(input.repair.rejected.complete,false);return answer([proposal()]);});
      const recovered=await recovery.run();assert.equal(recovered.processed,1);assert.equal(recovery.requests.length,2);assert.equal((await current(db)).length,1);
      assert.equal((await recovery.run()).created,0);assert.equal(recovery.requests.length,2);
    }else{
      await source.run();state=Object.values((await progress(db)).processing_versions)[0];assert.equal(state.pending.round,2);
      await source.run();state=Object.values((await progress(db)).processing_versions)[0];assert.equal(state.exhausted,true);assert.equal(source.requests.length,3);
      await source.run();assert.equal(source.requests.length,3);assert.equal((await current(db)).length,0);
    }
    assert.equal((await db.query("select count(*)::int n from scout.collection_runs cross join lateral jsonb_array_elements(coalesce(stats->'model_attempts','[]')) a")).rows[0].n,3);
  }finally{await db.close();}}
});

test('only renderer-inserted links may be omitted from anchors; literal URL prose and exact citations remain intact',async()=>{
  const url='https://example.org/meeting',html='<p>14th <a href="'+url+'">Meeting</a> of the Commission.</p>'+
    '<p>Literal Meeting &lt;'+url+'&gt; of the Commission.</p><p><a href="/other"><img src="/image" alt="Meeting poster"></a></p>';
  const prepared=prepareDocument({title:'Meeting notice',url,html}),input=packDocument({id:'source'},prepared,0,'test');
  assert.ok(!JSON.stringify(prepared).includes('\\u0000'));
  for(const insertion of prepared.insertions){
    const link=prepared.links[insertion.link];assert.equal(prepared.text.slice(insertion.start,insertion.end),' <'+link.target+'>');
    assert.match(html.slice(link.start,link.end),/^<(a|img)/);
  }
  assert.equal(prepared.insertions.length,3);
  const p={...release,anchor:'14th Meeting of the Commission',candidate:{...release.candidate,title:'14th Meeting of the Commission',organization:null,description:null},
    citations:[{doc:'P',quote:'14th Meeting <'+url+'> of the Commission.'}],evidence:Object.fromEntries(['kind','title','priority'].map(k=>[k,[0]])),dates:{}};
  assert.equal(validateCitedFinding(p,input),p);
  const unmarked={...input,segments:input.segments.map(({inserted_links,...s})=>s)};assert.throws(()=>validateCitedFinding(p,unmarked),/anchor/);
  const literal={...p,anchor:'Literal Meeting of the Commission',citations:[{doc:'P',quote:'Literal Meeting <'+url+'> of the Commission.'}]};
  assert.throws(()=>validateCitedFinding(literal,input),/anchor/);
  p.citations[0].quote='14th Meeting of the Commission.';assert.throws(()=>validateCitedFinding(p,input),/citations\[0\].*<URL>.*separately/);
  const actual=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/iddri-website.json.gz',import.meta.url)))).spacing.link_delimiters;
  for(const reply of actual.replies)for(const finding of reply.response.findings){
    assert.throws(()=>validateCitedFinding(finding,actual.input),/citations\[0\].*<URL>.*separately/);
    assert.throws(()=>validateCitedFinding({...finding,citations:[{doc:'P',quote:actual.input.documents.P.url},...finding.citations]},actual.input),/citations\[1\]/);
  }
});
