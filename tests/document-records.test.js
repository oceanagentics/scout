import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {PGlite} from '@electric-sql/pglite';
import {collectHSA} from '../collector/hsa.js';
import {gemini,MODEL_LIMITS} from '../collector/model.js';
import {CONTENT_FIELDS} from '../collector/assessment.js';
import {prepareDocument} from '../collector/octo-documents.js';
import {packDocument,processDocument,validateFinding as validateCitedFinding,DOCUMENT_VERSION} from '../collector/document-records.js';
import {supportDocuments} from '../collector/octo-documents.js';
import {startReport} from '../collector/report.js';
import {hostedHSA} from '../collector/hosted-hsa.js';
import {stepState} from '../src/runs.js';
import {filterRecords} from '../src/records.js';
import {eligibleRecords} from '../notifications/slack.js';

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

test('dated findings save and repeat using source proofs without a record date evidence column',async()=>{
  const db=await setup(),source=runner(db,stages([proposal()]));
  try{
    const run=await source.run();assert.equal(run.created,1,run.warnings.join(';'));
    const records=await current(db),record=records[0];assert.equal(Object.hasOwn(record,'date_evidence'),false);
    assert.equal(record.starts_at.toISOString(),'2026-10-21T10:00:00.000Z');
    const evidence=(await db.query('select parsed from scout.evidence where record_id=$1',[record.id])).rows[0].parsed;
    assert.equal(evidence.accepted_fields.starts_at.value,'2026-10-21T10:00:00Z');
    assert.equal(evidence.accepted_fields.starts_at.sources[0].capture_id,evidence.document.capture_id);
    assert.deepEqual(evidence.finding.dates.starts_at,{local:'2026-10-21T10:00:00',zone:'UTC',parts:Object.fromEntries(['year','date','time','zone'].map(part=>[part,evidence.finding.evidence.starts_at]))});
    const calls=source.requests.length;await source.run();assert.equal(source.requests.length,calls);
    assert.deepEqual(await current(db),records);
  }finally{await db.close();}
});

test('automatic rotation resumes a quota-deferred checkpoint without fetching or changing source timestamps',async()=>{
  const db=await setup();
  try{
    const first=runner(db,stages([proposal()]),{runLimit:1});
    const stopped=await first.run();assert.equal(stopped.deferred.reason,'turn');assert.equal(stopped.failed,0);
    assert.equal(first.requests.length,1);assert.equal((await current(db)).length,0);
    const capture=(await db.query('select id,last_seen_at,content from scout.evidence where record_id is null')).rows[0];
    const state=Object.values((await progress(db)).processing_versions)[0];
    assert.equal(state.state,'deferred');assert.equal(state.findings.length,1);
    await db.query('update scout.trackers set enabled=true where id=$1',[fixture.tracker.id]);
    const resume=runner(db,input=>{assert.equal(input.stage,'resolve');return resolution(input);});
    const completed=await resume.run({rotation:true,validate:false,read:async()=>{throw new Error('Retained work must not fetch');}});
    assert.equal(completed.resumed,true);assert.equal(completed.created,1,completed.warnings.join(';'));
    assert.equal(completed.requests,0);assert.equal(resume.requests.length,1);
    const after=(await db.query('select last_seen_at,content from scout.evidence where id=$1',[capture.id])).rows[0];
    assert.deepEqual(after,{last_seen_at:capture.last_seen_at,content:capture.content});
    assert.equal(Object.values((await progress(db)).processing_versions)[0].state,'complete');
    await resume.run({rotation:true,validate:false});assert.equal(resume.requests.length,1);
    assert.equal((await current(db)).length,1);
  }finally{await db.close();}
});

test('completed Low findings retain reader-visible sources and reasons; uncertain findings and repeat calls stay excluded',async()=>{
  const db=await setup(),title='Ocean film screening',description='A public screening of an ocean film.';
  const low={anchor:title,urls:[],candidate:{...Object.fromEntries(CONTENT_FIELDS.map(k=>[k,null])),kind:'event',title,description},
    priority:'low',reason:'General public film promotion.',evidence:{kind:title,title,description,priority:description}};
  const uncertain={...low,anchor:'Audience discussion',candidate:{...low.candidate,title:'Audience discussion'},
    evidence:{...low.evidence,kind:'Audience discussion',title:'Audience discussion'}};
  const source=runner(db,stages([low]),
    {post:{...article,title:{rendered:title},content:{rendered:'<h1>'+title+'</h1><p>'+description+'</p>'}}});
  try{
    const run=await source.run();assert.equal(run.created,1,run.warnings.join(';'));assert.equal(source.requests.length,2);
    const records=await current(db);assert.equal(records.length,1);assert.equal(records[0].priority,'low');
    assert.deepEqual(filterRecords(records,{priority:'low'}),records);
    const [association]=(await db.query('select * from scout.evidence where record_id=$1',[records[0].id])).rows;
    assert.equal(association.url,article.link);assert.equal(association.parsed.finding.reason,low.reason);
    assert.equal(association.parsed.assessment.priority_accepted,true);assert.equal(association.parsed.accepted_fields.priority.value,'low');
    const state=Object.values((await progress(db)).processing_versions)[0];
    assert.equal(state.state,'complete');assert.equal(state.findings[0].record_id,records[0].id);
    const reader='00000000-0000-0000-0000-000000000001';
    await db.query('insert into auth.users(id) values($1)',[reader]);
    await db.query("insert into auth.identities values($1,'google',$2)",[reader,{iss:'https://accounts.google.com',email_verified:true,custom_claims:{hd:'oceanagentics.com'}}]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[reader]);await db.exec('set role authenticated');
    const visible=(await db.query('select * from scout.source_details')).rows;
    assert.equal(visible.length,1);assert.equal(visible[0].record_id,records[0].id);
    assert.equal(visible[0].url,article.link);assert.equal(visible[0].priority_reason,low.reason);
    await db.exec('reset role');
    for(const kind of ['findings','digest'])assert.deepEqual(eligibleRecords(records,{kind,from:'2026-10-01',through:'2026-10-31'}),[]);
    const repeat=await source.run();assert.equal(repeat.created,0);assert.equal(source.requests.length,2);
    assert.deepEqual(await current(db),records);assert.deepEqual(Object.values((await progress(db)).processing_versions)[0],state);
    const unresolved=runner(db,stages([uncertain],input=>({...resolution(input,'uncertain'),
      facts:{kind:'supported',title:'supported',description:'supported',priority:'unsupported'}})),
      {post:{...article,id:100,link:'https://octogroup.org/discussion/',content:{rendered:'<h1>Audience discussion</h1><p>'+description+'</p>'}}});
    assert.equal((await unresolved.run()).created,0);assert.equal(unresolved.requests.length,2);
    assert.equal(Object.values((await progress(db,100)).processing_versions)[0].findings[0].resolution.outcome,'uncertain');
    assert.deepEqual(await current(db),records);
    assert.equal((await db.query('select count(*)::int n from scout.evidence where record_id is not null')).rows[0].n,1);
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
  const occurrence='Ocean Data Workshop is the data standards session at the 2026 Atlantic Forum.';
  const finding={...release,candidate:{...release.candidate,description:occurrence},evidence:{...release.evidence,description:occurrence,identity:occurrence}};
  const source=runner(db,stages([finding],async input=>{
    if(!input.repair){assert.equal(input.candidates.length,0);old=await seed(db,finding);return resolution(input);}
    assert.match(input.repair.errors.join(),/changed after input/);assert.equal(input.candidates[0].id,old.id);
    return {...resolution(input,'evidence',old.id),evidence:{identity:occurrence},comparisons:[{record_id:old.id,relation:'possible_match',
      citations:input.finding.evidence.identity,reason:'Both identify the data standards session at the 2026 Atlantic Forum.'}]};
  }),{post:{...digest,content:{rendered:digest.content.rendered+'<p>'+occurrence+'</p>'}}});
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


test('webinar location Online retains webinar evidence and completed repeats without reprocessing',async()=>{
  const db=await setup(),title='Ocean data webinar',description='A webinar on ocean data standards.';
  const post={...article,title:{rendered:title},content:{rendered:'<h1>'+title+'</h1><p>'+description+'</p>'}};
  const finding={anchor:title,urls:[],candidate:{...Object.fromEntries(CONTENT_FIELDS.map(k=>[k,null])),kind:'event',title,description,location:'Online'},
    priority:'high',reason:'Concrete ocean data standards webinar.',evidence:{kind:description,title,description,location:description,priority:description}};
  const source=runner(db,stages([finding],input=>{
    assert.deepEqual(input.field_audit.fields.location,{claim:'Online',quotes:[description]});
    return resolution(input);
  }),{post});
  try{
    const run=await source.run();assert.equal(run.created,1,run.warnings.join(';'));
    const records=await current(db);assert.equal(records[0].location,'Online');
    const evidence=(await db.query('select parsed from scout.evidence where record_id=$1',[records[0].id])).rows[0].parsed;
    assert.equal(evidence.accepted_fields.location.value,'Online');
    assert.equal(evidence.finding.citations[evidence.finding.evidence.location[0]].quote,description);
    assert.equal(source.requests.length,2);
    const [extract,resolve]=source.requests.map(request=>JSON.parse(request).systemInstruction.parts[0].text);
    assert.match(extract,/source identifies as a webinar, set location="Online"/);
    assert.match(resolve,/identifying this event as a webinar is sufficient support/);
    const repeated=await source.run();assert.equal(repeated.created,0);assert.equal(repeated.changed,0);
    assert.equal(source.requests.length,2);assert.deepEqual(await current(db),records);
  }finally{await db.close();}
});

test('initial-only review parks a rejected finding and saves another, then makes no unchanged repair calls',async()=>{
  const db=await setup();try{
    const captured=await runner(db,()=>{throw new Error('fetch-only must not call a model');}).run({documents:true});
    const source=(await db.query('select * from scout.evidence where id=$1',[captured.document_ids[0]])).rows[0];
    const prepared=source.parsed.document.prepared_versions[source.parsed.document.preparation.version];
    const run=(await db.query('insert into scout.collection_runs(tracker_id) values($1) returning id',[source.tracker_id])).rows[0].id;
    const trace=await startReport(db,run),context=await supportDocuments(db,{source,prepared,trace});let calls=0;
    const model=async(instruction,[input],schema)=>{
      calls++;
      if(input.stage==='extract')return answer([cited(proposal(),input),cited(proposal('Second session','2026-10-22T10:00:00Z'),input)]);
      assert.ok(schema.required.includes('comparisons'));
      if(input.finding.anchor==='First session')return {invalid:true};
      return reviewed({...resolution(input),comparisons:[]},input);
    };
    const reviewedSource=await processDocument(db,{source,prepared:context,trace,model,deadline:Date.now()+20000,repairs:false});
    assert.equal(reviewedSource.state,'needs_repair');assert.equal(reviewedSource.created,1);assert.equal(calls,3);
    const retained=(await db.query('select * from scout.source_queue where id=$1',[source.id])).rows[0];
    assert.equal(retained.queue_state,'needs_repair');
    assert.equal(retained.progress.findings[0].pending.round,1);
    assert.deepEqual(retained.progress.findings[0].pending.repair.rejected,{invalid:true});
    await processDocument(db,{source:retained,prepared:context,trace,model,deadline:Date.now()+20000,repairs:false});
    assert.equal(calls,3);
  }finally{await db.close();}
});

test('automatic fetching captures new material during provider cooldown, then globally reviews the oldest capture',async()=>{
  const db=await setup();try{
    await db.query('update scout.trackers set enabled=true where id=$1',[fixture.tracker.id]);
    const secret='sb_secret_scout_test_only',env={url:'https://example.supabase.co',secretKeys:{default:secret},publishableKeys:{default:'sb_publishable_test_only'},jwks:null};
    const connect=()=>({reserve:async()=>({unsafe:async(q,p=[])=>/pg_try_advisory_lock|pg_advisory_unlock/.test(q)?[{acquired:true}]:(await db.query(q,p)).rows,release(){}}),end:async()=>{}});
    let post=article,calls=0;
    const cooldown=(await db.query("insert into scout.collection_runs(tracker_id,outcome,finished_at,stats) values($1,'partial',now(),jsonb_build_object('model_retry_at',now()+interval '1 hour')) returning id",[fixture.tracker.id])).rows[0].id;
    const invoke=()=>hostedHSA(new Request('https://example.test?next=true',{method:'POST',headers:{apikey:secret}}),{
      env,databaseURL:'unused',apiKey:'test-key',connect,
      collect:(database,options)=>collectHSA(database,{...options,
        read:async(url,budget)=>{budget.requests++;return {url,status:200,body:url===feedURL?'<rss><channel><item><guid>https://octogroup.org/?p='+post.id+'</guid><link>'+post.link+'</link><title>'+post.title.rendered+'</title><description>Feed excerpt.</description></item></channel></rss>':JSON.stringify(url.endsWith('/99')?article:post)};}}),
      modelFetch:async(url,request)=>{
        if(url.endsWith(':countTokens'))return Response.json({totalTokens:100});
        calls++;const input=JSON.parse(JSON.parse(request.body).contents[0].parts[0].text)[0];
        return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(answer([]))}]}}]});
      }});
    const first=await (await invoke()).json();
    assert.equal(first.review.reason,'provider');assert.equal(first.documents,1);assert.equal(calls,0);
    await db.query("update scout.collection_runs set stats=stats||jsonb_build_object('retry_at',now()-interval '1 second') where stats->>'stage'='fetch'");
    post={...article,id:100,link:'https://octogroup.org/new-session/',title:{rendered:'New session'}};
    const second=await (await invoke()).json();assert.equal(second.review.reason,'provider');assert.equal(second.documents,2);assert.equal(calls,0);
    await db.query("update scout.collection_runs set stats=stats-'model_retry_at' where id=$1",[cooldown]);
    await db.query("update scout.collection_runs set stats=stats||jsonb_build_object('retry_at',now()-interval '1 second') where stats->>'stage'='fetch'");
    const notification=(await db.query("insert into scout.collection_runs(tracker_id,stats) values($1,'{\"purpose\":\"notification\"}') returning id",[fixture.tracker.id])).rows[0].id;
    const waiting=await (await invoke()).json();assert.equal(waiting.review,undefined);assert.equal(waiting.documents,2);assert.equal(calls,0);
    await db.query("update scout.collection_runs set started_at=now()-interval '111 seconds' where id=$1",[notification]);
    const third=await (await invoke()).json();assert.equal(third.review.state,'complete');assert.equal(calls,1);
    const queue=(await db.query("select parsed#>>'{document,id}' id,queue_state from scout.source_queue order by collected_at")).rows;
    assert.deepEqual(queue,[{id:'99',queue_state:'complete'},{id:'100',queue_state:'awaiting_initial'}]);
    const fourth=await (await invoke()).json();assert.equal(fourth.review.state,'complete');assert.equal(calls,2);
    await invoke();assert.equal(calls,2);
  }finally{await db.close();}
});

test('three durable transport failures park unchanged initial work while quota deferrals do not consume that bound',async()=>{
  const db=await setup();try{
    const captured=await runner(db,()=>{}).run({documents:true});let source=(await db.query('select * from scout.evidence where id=$1',[captured.document_ids[0]])).rows[0];
    const run=(await db.query('insert into scout.collection_runs(tracker_id) values($1) returning id',[source.tracker_id])).rows[0].id;
    const trace=await startReport(db,run),context=await supportDocuments(db,{source,prepared:source.parsed.document.prepared_versions[source.parsed.document.preparation.version],trace});
    let calls=0,reason='minute';
    const model=async()=>{calls++;throw Object.assign(new Error('Temporary '+reason),{deferred:{reason,retry_at:new Date().toISOString()}});};
    await processDocument(db,{source,prepared:context,trace,model,deadline:Date.now()+20000,repairs:false});
    reason='network';
    for(let i=0;i<3;i++){
      source=(await db.query('select * from scout.evidence where id=$1',[source.id])).rows[0];
      await processDocument(db,{source,prepared:context,trace,model,deadline:Date.now()+20000,repairs:false});
    }
    source=(await db.query('select * from scout.source_queue where id=$1',[source.id])).rows[0];
    assert.equal(source.queue_state,'needs_repair');assert.equal(source.progress.network_failures,3);
    await processDocument(db,{source,prepared:context,trace,model,deadline:Date.now()+20000,repairs:false});assert.equal(calls,4);
  }finally{await db.close();}
});
