import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {PGlite} from '@electric-sql/pglite';
import {collectHSA,sourceURL,HSA,GFW_WEB,LIMITS} from '../collector/hsa.js';
import {gemini} from '../collector/model.js';
import {CONTENT_FIELDS} from '../collector/assessment.js';
import {PREPARATION_VERSION} from '../collector/octo-documents.js';

const fixture=async name=>{const raw=await readFile(new URL('./fixtures/'+name,import.meta.url));return JSON.parse(name.endsWith('.gz')?gunzipSync(raw):raw);};
const hsa=await fixture('hsa-webinar-time.json'),gaps=await fixture('scout16-gaps.json.gz'),gfw=await fixture('gfw-website.json.gz'),expansion=await fixture('expansion-feeds.json');
const article=JSON.parse(gfw['partnership-api'].body);
const response=(url,body,mime='application/json')=>({url,status:200,headers:{'content-type':mime,'set-cookie':'never-store-response-headers'},body:typeof body==='string'?body:JSON.stringify(body)});
const answer=findings=>({complete:true,reason:'Supplied range considered.',findings});
const resolve=input=>({outcome:input.candidates.length?'evidence':'new',record_id:input.candidates[0]?.id??null,reason:'Same finding or new finding against all supplied candidates.',
  evidence:{identity:[0],distinction:[0]},facts:Object.fromEntries([...CONTENT_FIELDS.filter(k=>input.finding.candidate[k]!==null),'priority'].map(k=>[k,'supported'])),conflict:'none'});
async function database(){
  const db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
    create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');create table auth.identities(user_id uuid,provider text,identity_data jsonb);
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;`);
  for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/seeds/trackers.sql',import.meta.url),'utf8'));return db;
}
const tracker=async(db,url)=>(await db.query('select * from scout.trackers where url=$1',[url])).rows[0];
const stored=async db=>(await db.query('select * from scout.records')).rows;
const detail=async(db,id)=>(await db.query('select * from scout.collection_runs where id=$1',[id])).rows[0];
function runModel(db,respond){
  const inputs=[],requests=[];
  const makeModel=(runId,deadline,trace)=>{
    const model=gemini({apiKey:'fixture-test-key',ledger:db,runId,deadline,trace,fetch:async(_url,request)=>{
      requests.push(request.body);assert.ok(Buffer.byteLength(request.body)<=8000);
      const input=JSON.parse(JSON.parse(request.body).contents[0].parts[0].text)[0];inputs.push(input);
      const out=await respond(input);
      return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(out)}]}}],usageMetadata:{promptTokenCount:200,candidatesTokenCount:100}});
    }});
    return async(...args)=>{
      await db.query("update scout.collection_runs set stats=jsonb_set(stats,'{model_attempts}',(select jsonb_agg(a||jsonb_build_object('at',(a->>'at')::timestamptz-interval '61 seconds')) from jsonb_array_elements(stats->'model_attempts') a)) where jsonb_array_length(coalesce(stats->'model_attempts','[]'))>0");
      return model(...args);
    };
  };
  return {makeModel,inputs,requests};
}
const base=(title,citations)=>({anchor:title,urls:[],candidate:{...Object.fromEntries(CONTENT_FIELDS.map(k=>[k,null])),kind:'announcement',title},
  priority:'normal',reason:'Substantive public source finding.',citations,evidence:Object.fromEntries(['kind','title','priority'].map(k=>[k,{refs:[0],rationale:'Cited source finding.'}])),dates:{}});

test('all four existing author configurations use exact item captures and retain feed provenance without config changes',async()=>{
  const db=await database();try{
    const before=(await db.query('select * from scout.trackers order by id')).rows;
    for(const [actor,item]of [[HSA,hsa],...Object.entries(expansion).map(([actor,data])=>[actor,data.feed[0]])]){
      const t=await tracker(db,'https://bsky.app/profile/'+actor),calls=[];
      const run=await collectHSA(db,{trackerId:t.id,validate:true,documents:true,read:async url=>{
        calls.push(url);assert.equal(new URL(url).searchParams.get('actor'),actor);return response(url,{feed:[item,item]});
      }});
      assert.equal(run.prepared,1);assert.equal(calls.length,1);
      const source=(await db.query('select * from scout.evidence where tracker_id=$1',[t.id])).rows[0];
      assert.equal(source.content,JSON.stringify(item));assert.equal(source.parsed.document.id,item.post.uri);
      const report=(await detail(db,run.run_id)).report,provenance=Object.values(report.artifacts).find(a=>a.kind==='provenance');
      assert.equal(provenance.data.provenance.length,2);assert.deepEqual(provenance.data.provenance.map(p=>p.position),[0,1]);
      assert.ok(!JSON.stringify(report).includes('never-store-response-headers'));
      assert.ok(Object.values(report.artifacts).some(a=>a.kind==='fetch_response'&&JSON.parse(a.data.body).feed.length===2));
    }
    assert.deepEqual((await db.query('select * from scout.trackers order by id')).rows,before);assert.equal((await stored(db)).length,0);
  }finally{await db.close();}
});

test('real HSA link enters shared support retrieval, combines cited schedule, saves and skips unchanged model work',async()=>{
  const db=await database();try{
    const t=await tracker(db,'https://bsky.app/profile/'+HSA),post=structuredClone(hsa),registration=structuredClone(gaps.zoom),calls=[];
    const title='Unpacking Part II of BBNJ: Marine Genetic Resources and Digital Sequence Information';
    const transport=runModel(db,input=>{
      if(input.stage==='resolve')return resolve(input);
      const support=input.segments.find(s=>s.doc!=='P'&&s.text.includes(title)&&s.text.includes('Sep 29, 2026 07:30 AM'));
      if(!support)return answer([]);
      const p=base(title,[{doc:support.doc,quote:title},{doc:support.doc,quote:'Sep 29, 2026 07:30 AM'},
        {doc:'P',quote:'29 Sept, 7:30 AM EDT'},{doc:support.doc,quote:registration.url}]);
      Object.assign(p.candidate,{kind:'event',description:'Webinar on marine genetic resources and digital sequence information.',registration_url:registration.url,starts_at:'2026-09-29T11:30:00Z'});
      Object.assign(p.evidence,{description:{refs:[0],rationale:'Faithful summary of the registration title.'},registration_url:{refs:[3],rationale:'Retained registration destination.'},
        starts_at:{refs:[1,2],rationale:'Registration supplies event year/day; author gives 07:30 EDT, America/New_York.'}});
      p.dates.starts_at={local:'2026-09-29T07:30:00',zone:'America/New_York',parts:{year:[1],date:[1],time:[2],zone:[2]}};
      return answer([p]);
    });
    const options={trackerId:t.id,validate:true,documents:'process',makeModel:transport.makeModel,read:async url=>{
      calls.push(url);return url===registration.url?registration:response(url,{feed:[post,post]});
    }};
    let run=await collectHSA(db,options);
    for(let i=0;i<2&&!run.processed;i++)run=await collectHSA(db,options);
    assert.equal(run.processed,1,run.warnings.join(';'));
    const rows=await stored(db);assert.equal(rows.length,1);assert.equal(new Date(rows[0].starts_at).toISOString(),'2026-09-29T11:30:00.000Z');
    const sources=(await db.query('select * from scout.evidence where record_id is null')).rows;
    assert.equal(JSON.parse(sources.find(s=>s.url===registration.url).content).body,registration.body);
    assert.ok(sources.find(s=>s.url===registration.url).parsed.document.prepared_versions[PREPARATION_VERSION].text.includes(title));
    const association=(await db.query('select parsed from scout.evidence where record_id=$1 and url<>$2',[rows[0].id,registration.url])).rows[0].parsed;
    assert.equal(association.accepted_fields.starts_at.rank,2);assert.equal(association.document.sources[1].relationship,'registration');
    const count=transport.requests.length;
    run=await collectHSA(db,options);assert.equal(run.processed,1);assert.equal(transport.requests.length,count);
    post.post.record.text+='\nAdditional public context.';run=await collectHSA(db,options);
    assert.equal(run.processed,1,run.warnings.join(';'));assert.ok(transport.requests.length>count);assert.equal((await stored(db)).length,1);
    const changed=transport.requests.length;
    registration.body=registration.body.replace('This webinar will unpack','This public webinar will unpack');
    run=await collectHSA(db,options);assert.equal(run.processed,1,run.warnings.join(';'));assert.ok(transport.requests.length>changed);assert.equal((await stored(db))[0].id,rows[0].id);
    assert.ok(calls.filter(url=>url===registration.url).length>=4);
    const report=(await detail(db,run.run_id)).report;
    assert.equal(report.path,'author-records');assert.ok(Object.values(report.artifacts).some(a=>a.kind==='model_request'));
    assert.ok(Object.values(report.artifacts).some(a=>a.kind==='support_coverage'&&a.data.links.some(l=>l.state==='fetched')));
  }finally{await db.close();}
});

test('conflicting repeated author identities retain both payloads without model writes; a later consistent observation recovers',async()=>{
  const db=await database();try{
    const t=await tracker(db,'https://bsky.app/profile/'+HSA),variant=structuredClone(hsa);variant.post.cid='changed-cid';variant.post.record.text+=' Conflicting variant.';
    let items=[hsa,variant];const model=runModel(db,()=>answer([]));
    const options={trackerId:t.id,validate:true,documents:'process',makeModel:model.makeModel,read:async url=>response(url,{feed:items})};
    const first=await collectHSA(db,options);assert.equal(first.uncertain,2);assert.equal(model.requests.length,0);
    assert.equal((await db.query('select count(*)::int n from scout.evidence where record_id is null')).rows[0].n,2);
    assert.ok(Object.values((await detail(db,first.run_id)).report.operations).some(o=>o.state==='uncertain'));
    items=[variant];const next=await collectHSA(db,{...options,read:async url=>url.includes('getAuthorFeed')?response(url,{feed:items}):Promise.reject(new Error('Support unavailable'))});
    assert.equal(next.processed,1,next.warnings.join(';'));assert.ok(model.requests.length);assert.equal((await stored(db)).length,0);
  }finally{await db.close();}
});

const listing=ids=>({...gfw.home,body:gfw.home.body.replace(/<article id="post-(\d+)"[\s\S]*?<\/article>/g,(raw,id)=>ids.includes(id)?raw:'')});
test('GFW full body reaches shared requests/save; unchanged, source-change and failed-detail recovery preserve identity',async()=>{
  const db=await database();try{
    const t=await tracker(db,GFW_WEB),post=structuredClone(article),home=listing([String(article.id)]),inputs=[],details=[];let fail=false;
    const model=runModel(db,input=>{
      if(input.stage==='resolve')return resolve(input);
      inputs.push(input);const segment=input.segments.find(s=>s.text.includes('jointly develop machine learning models'));
      if(!segment)return answer([]);
      const p=base(input.title,[{doc:'P',quote:input.title},{doc:'P',quote:'jointly develop machine learning models'}]);
      p.candidate.description='A partnership to develop machine learning models for ocean monitoring.';p.evidence.description={refs:[1],rationale:'Concise summary of the cited technical partnership.'};
      p.priority='high';p.evidence.priority={refs:[1],rationale:'Concrete ocean-data methods partnership.'};return answer([p]);
    });
    const options={trackerId:t.id,validate:true,documents:'process',makeModel:model.makeModel,read:async url=>{
      if(url===GFW_WEB)return home;
      if(url.includes('/wp-json/wp/v2/posts/'))details.push(url);
      if(url===gfw['partnership-api'].url)return fail?{...response(url,'Detail unavailable','text/plain'),status:503}:response(url,JSON.stringify(post));
      throw new Error('Support fixture unavailable');
    }};
    let run=await collectHSA(db,options);for(let i=0;i<3&&!run.processed;i++)run=await collectHSA(db,options);
    assert.equal(run.processed,1,run.warnings.join(';'));const row=(await stored(db))[0];assert.ok(row);assert.equal(row.priority,'high');
    const primary=(await db.query("select * from scout.evidence where record_id is null and parsed#>>'{document,identity}'=$1",['gfw:post:'+article.id])).rows[0];
    assert.equal(primary.content,JSON.stringify(article));const clean=primary.parsed.document.prepared_versions[PREPARATION_VERSION];
    assert.equal(inputs.map(i=>clean.text.slice(...i.range)).join(''),clean.text);assert.ok(clean.text.indexOf('jointly develop machine learning models')>=0);
    const count=model.requests.length;run=await collectHSA(db,options);assert.equal(run.processed,1);assert.equal(model.requests.length,count);
    post.content.rendered+='<p>New technical appendix.</p>';run=await collectHSA(db,options);
    for(let i=0;i<3&&!run.processed;i++)run=await collectHSA(db,options);
    assert.equal(run.processed,1,run.warnings.join(';'));assert.equal((await stored(db)).length,1);assert.equal((await stored(db))[0].id,row.id);
    const changed=model.requests.length;fail=true;const failed=await collectHSA(db,options);assert.equal(failed.documents,0);assert.ok(failed.failed);assert.equal(model.requests.length,changed);
    const failedRun=await detail(db,failed.run_id);assert.equal(failedRun.stats.document_source.progress.after_id,details.at(-1).split('/').at(-1));
    assert.ok(Object.values(failedRun.report.artifacts).some(a=>a.kind==='fetch_response'&&a.data.status===503&&a.data.body==='Detail unavailable'));
    fail=false;const recovered=await collectHSA(db,options);assert.equal(recovered.processed,1);assert.equal(model.requests.length,changed);
  }finally{await db.close();}
});

test('GFW persists failed/deferred/unlisted identities and attempt cursor across bounded runs, including listing failure',async()=>{
  const db=await database();try{
    const t=await tracker(db,GFW_WEB),calls=[];let home=gfw.home;
    const options={trackerId:t.id,validate:true,documents:true,read:async url=>{
      calls.push(url);if(url===GFW_WEB){if(!home)throw new Error('Listing unavailable');return home;}
      const found=Object.values(gfw).find(v=>v?.url===url&&v.body);if(found)return found;throw new Error('Detail unavailable');
    }};
    const first=await collectHSA(db,options),firstState=(await detail(db,first.run_id)).stats.document_source;
    assert.equal(first.documents,4);assert.equal(firstState.known.length,29);
    calls.length=0;const second=await collectHSA(db,options),secondState=(await detail(db,second.run_id)).stats.document_source;
    assert.equal(second.documents,0);assert.equal(calls.length,5);assert.notEqual(secondState.progress.after_id,firstState.progress.after_id);
    assert.equal(secondState.known.length,29);
    home=null;calls.length=0;const third=await collectHSA(db,options),thirdState=(await detail(db,third.run_id)).stats.document_source;
    assert.equal(calls.length,5);assert.equal(thirdState.known.length,29);assert.notEqual(thirdState.progress.after_id,secondState.progress.after_id);
    assert.ok(Object.values((await detail(db,third.run_id)).report.artifacts).some(a=>a.kind==='coverage'&&a.data.coverage?.some(c=>c.state==='failed')));
  }finally{await db.close();}
});

test('source limits/failures stay inspectable; unsupported or unscoped document routes do no source/model work',async()=>{
  const db=await database();try{
    const t=await tracker(db,'https://bsky.app/profile/'+HSA);let calls=0;
    const options={trackerId:t.id,validate:true,documents:true,read:async(url,budget)=>{calls++;budget.requests=LIMITS.requests;return response(url,{feed:[hsa],cursor:'next'});}};
    const bounded=await collectHSA(db,options);assert.equal(calls,1);assert.equal(bounded.documents,1);assert.ok(bounded.failed);
    const report=(await detail(db,bounded.run_id)).report;assert.ok(Object.values(report.operations).some(o=>o.step==='fetch'&&o.state==='skipped'));
    const empty=await collectHSA(db,{...options,read:async url=>response(url,{feed:[]})});assert.equal(empty.documents,0);
    const failed=await collectHSA(db,{...options,read:async()=>{throw new Error('Feed failure');}});assert.equal(failed.documents,0);assert.ok(failed.failed);
    assert.ok(Object.values((await detail(db,failed.run_id)).report.operations).some(o=>o.step==='prepare'&&o.state==='fail'));
    const rows=(await db.query('select count(*)::int n from scout.collection_runs')).rows[0].n;
    const other=await tracker(db,'https://iucn.org/our-work/topic/high-seas');
    for(const change of [{validate:false},{trackerId:other.id},{sourceId:'00000000-0000-4000-8000-000000000001'},{documents:'all'}])
      await assert.rejects(collectHSA(db,{...options,...change,read:()=>{throw new Error('Must not read');}}),e=>e.status===400);
    assert.equal((await db.query('select count(*)::int n from scout.collection_runs')).rows[0].n,rows);
  }finally{await db.close();}
});
