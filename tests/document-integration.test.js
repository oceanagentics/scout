import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {PGlite} from '@electric-sql/pglite';
import {collectHSA,HSA,HSA_WEB,GFW_WEB,HARVEST,DOALOS,UN_SIDE_EVENTS,CBD_REGISTRY,sourceURL} from '../collector/hsa.js';
import {gemini,requestBody} from '../collector/model.js';
import {CONTENT_FIELDS} from '../collector/assessment.js';
import {collectDocuments,prepareDocument,supportDocuments} from '../collector/octo-documents.js';
import {prepareDosiDocument,retrieveDosiDocuments} from '../collector/dosi-documents.js';
import {startReport} from '../collector/report.js';
import {packDocument,processDocument,validateFinding,validateResolution,DOCUMENT_VERSION,DOCUMENT_SCHEMA,DOCUMENT_INSTRUCTION} from '../collector/document-records.js';

const fixture=async name=>{const raw=await readFile(new URL('./fixtures/'+name,import.meta.url));return JSON.parse(name.endsWith('.gz')?gunzipSync(raw):raw);};

const answer=findings=>({complete:true,reason:'Supplied announcement considered.',findings});
// Injected decisions test storage/validation only; they are not model-quality evidence.
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

function runModel(db,respond,advance=false){
  const requests=[];
  const makeModel=(runId,deadline,trace)=>{
    const model=gemini({apiKey:'fixture-test-key',ledger:db,runId,deadline,trace,fetch:async(url,request)=>{
      if(url.endsWith(':countTokens'))return Response.json({totalTokens:200});
      requests.push(request.body);assert.equal(JSON.parse(request.body).generationConfig.maxOutputTokens,65536);
      assert.equal(JSON.parse(request.body).generationConfig.thinkingConfig.thinkingLevel,'medium');
      const input=JSON.parse(JSON.parse(request.body).contents[0].parts[0].text)[0];
      const out=await respond(input);
      return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(out)}]}}]});
    }});
    return async(...args)=>{
      if(advance)await db.query("update scout.collection_runs set stats=jsonb_set(stats,'{model_attempts}',(select jsonb_agg(a||jsonb_build_object('at',(a->>'at')::timestamptz-interval '61 seconds')) from jsonb_array_elements(stats->'model_attempts') a)) where jsonb_array_length(coalesce(stats->'model_attempts','[]'))>0");
      return model(...args);
    };
  };
  return {makeModel,requests};
}

const base=(title,citations)=>({anchor:title,urls:[],candidate:{...Object.fromEntries(CONTENT_FIELDS.map(k=>[k,null])),kind:'event',title},
  priority:'normal',reason:'Substantive public source finding.',citations,evidence:Object.fromEntries(['kind','title','priority'].map(k=>[k,[0]])),dates:{}});

test('saved webinar and conference passages require literal evidence and leave missing details unknown',async()=>{
  const octo=await fixture('octo-webinars.json.gz'),gfw=await fixture('gfw-live-repair.json.gz');
  const webinar=JSON.parse(octo.posts.body).find(p=>p.id===16281),conference=JSON.parse(gfw.artifacts.a2.data.body);
  for(const [post,anchor,quote] of [
    [webinar,webinar.title.rendered,'Date/Time: Tuesday, October 20, Noon US EDT/9 am US PDT/4 pm UTC/5 pm BST/6 pm CEST'],
    [conference,'14th Meeting of the SPRFMO Commission','But as members of SPRFMO gather in Panama this week for the 14th Meeting <https://www.sprfmo.int/meetings/comm/14th-commission-meeting> of the SPRFMO Commission,'],
  ]){
    const prepared=prepareDocument({title:post.title.rendered,url:post.link,html:post.content.rendered});
    const start=prepared.text.indexOf(quote);assert.ok(start>=0);
    const input=packDocument({id:'retained-announcement'},prepared,start,DOCUMENT_VERSION);
    const finding=base(anchor,[{doc:'P',quote:anchor===webinar.title.rendered?anchor:quote}]);
    finding.candidate.kind='event';
    assert.equal(validateFinding(finding,input),finding);
    for(const kind of ['announcement','treaty_status'])assert.throws(()=>validateFinding({...finding,candidate:{...finding.candidate,kind}},input),/supported kind/);
    assert.ok(prepared.links.length>0);assert.deepEqual(Object.keys(input.documents),['P']);
    const invented=structuredClone(finding);invented.citations[0].quote+=' invented details';
    assert.throws(()=>validateFinding(invented,input),/citation/);
    const dated=structuredClone(finding);
    dated.candidate.starts_at='2026-10-20T16:00:00Z';
    dated.evidence.starts_at=[0];
    dated.dates.starts_at={local:'2026-10-20T16:00:00',zone:'UTC',parts:{year:[],date:[0],time:[0],zone:[0]}};
    assert.throws(()=>validateFinding(dated,input),/year\/date\/clock\/zone/);
  }
});

test('whole GFW announcement saves in two calls; retained invalid output repairs exceed the old byte cap intact',async context=>{
  const saved=await fixture('gfw-live-repair.json.gz'),post=JSON.parse(saved.artifacts.a2.data.body);
  const card=saved.artifacts.a1.data.body.match(/<article id="post-74977"[\s\S]*?<\/article>/)[0];
  const listing='<html><head><link rel="canonical" href="'+GFW_WEB+'"><link rel="https://api.w.org/" href="https://globalfishingwatch.org/wp-json/"></head><body>'+card+'</body></html>';
  for(const rejected of [false,true]){
    const db=await database();try{
      const tracker=(await db.query('select * from scout.trackers where url=$1',[GFW_WEB])).rows[0],reads=[];
      const decision=structuredClone(saved.artifacts.a24.data.response);
      if(!rejected){
        decision.findings[0].evidence=Object.fromEntries(Object.entries(decision.findings[0].evidence).map(([k,v])=>[k.replace(/^candidate\./,''),v.refs]));
        for(const field of ['organization','description']){decision.findings[0].candidate[field]=null;delete decision.findings[0].evidence[field];}
      }
      const transport=runModel(db,input=>input.stage==='resolve'?resolve(input):input.range[0]?answer([]):decision);
      const options={trackerId:tracker.id,validate:true,documents:'process',makeModel:transport.makeModel,read:async url=>{
        reads.push(url);
        assert.ok([GFW_WEB,saved.artifacts.a2.data.url].includes(url),'Incidental link must not be requested: '+url);
        return {url,status:200,headers:{'content-type':url===GFW_WEB?'text/html':'application/json'},body:url===GFW_WEB?listing:saved.artifacts.a2.data.body};
      }};
      const first=await collectHSA(db,options);
      assert.equal(reads.length,2);assert.equal(first.requests,2);
      const source=(await db.query('select * from scout.evidence where tracker_id=$1 and record_id is null',[tracker.id])).rows[0];
      const state=Object.values(source.parsed.document.processing_versions)[0];
      if(rejected){
        assert.equal(first.processed,0);assert.equal(transport.requests.length,2);assert.equal(first.created,0);assert.equal(state.cursor,0);
        assert.deepEqual(state.pending.repair.rejected,saved.artifacts.a24.data.response);
        assert.ok(Buffer.byteLength(transport.requests[1])>8000);
        assert.deepEqual(JSON.parse(JSON.parse(transport.requests[1]).contents[0].parts[0].text)[0].repair.rejected,saved.artifacts.a24.data.response);
        const repeated=await collectHSA(db,options);assert.equal(repeated.processed,0);assert.equal(transport.requests.length,2);
        assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,0);
      }else{
        assert.equal(first.processed,1,first.warnings.join(';'));assert.equal(first.created,1);assert.equal(transport.requests.length,2);
        const prepared=Object.values(source.parsed.document.prepared_versions)[0];
        assert.equal(state.cursor,prepared.text.length);assert.ok(state.findings[0].record_id);
        const record=(await db.query('select * from scout.records')).rows[0];assert.equal(record.title,decision.findings[0].candidate.title);
        assert.equal(record.starts_at,null);assert.equal(record.organization,null);
        const repeated=await collectHSA(db,options);assert.equal(repeated.processed,1);assert.equal(transport.requests.length,2);
        assert.deepEqual((await db.query('select * from scout.records')).rows,[record]);
      }
      assert.equal(reads.length,4);
      context.diagnostic(JSON.stringify({source:rejected?'GFW retained rejection':'GFW injected event',request_bytes:transport.requests.map(b=>Buffer.byteLength(b)),cursor:state.cursor}));
    }finally{await db.close();}
  }
});

test('Harvest configured primary and observed index reach full model input with durable provenance and unchanged repeat',async()=>{
  const saved=await fixture('harvest-website.json.gz'),db=await database();try{
    const tracker=(await db.query('select * from scout.trackers where url=$1',[HARVEST])).rows[0],reads=[],inputs=[];
    const responses=new Map([saved.home,saved.webinars].map(r=>[r.url,r]));
    const transport=runModel(db,async input=>{
      assert.equal(input.stage,'extract');const url=input.documents.P.url;assert.ok(responses.has(url));inputs.push(url);
      const source=(await db.query('select * from scout.evidence where id=$1',[input.source_id])).rows[0];
      const prepared=Object.values(source.parsed.document.prepared_versions)[0];
      assert.equal(source.content,responses.get(url).body);assert.ok(prepared.text.length>4000);
      assert.deepEqual(input.range,[0,prepared.text.length]);assert.deepEqual(input.omitted_ranges,[]);
      assert.equal(input.segments.map(s=>s.text).join(''),prepared.text);assert.deepEqual(Object.keys(input.documents),['P']);
      return answer([]); // Injected zero tests the route, not actual event coverage.
    });
    const options={trackerId:tracker.id,validate:true,documents:'process',makeModel:transport.makeModel,read:async url=>{
      reads.push(url);assert.ok(responses.has(url),'Incidental destination must remain unfetched: '+url);
      return {status:200,...responses.get(url)}; // Historical saved bodies omit HTTP status.
    }};
    await assert.rejects(collectHSA(db,{...options,sourceId:'00000000-0000-4000-8000-000000000000'}),{status:400});assert.equal(reads.length,0);
    const first=await collectHSA(db,options);assert.equal(first.documents,2);assert.equal(first.processed,2,first.warnings.join(';'));
    assert.deepEqual(inputs,[saved.home.url,saved.webinars.url]);assert.deepEqual(reads,inputs);assert.equal(transport.requests.length,2);
    const run=(await db.query('select stats,report from scout.collection_runs where id=$1',[first.run_id])).rows[0];
    assert.equal(run.stats.model_attempts.length,2);assert.equal(run.stats.document_source.progress.after_url,saved.webinars.url);
    assert.deepEqual(run.stats.document_source.known,[{url:saved.home.url,id:'4426'},{url:saved.webinars.url,id:'4323'}]);
    const coverage=Object.values(run.report.artifacts).find(a=>a.kind==='coverage'&&a.data.documents?.some(d=>d.provenance));
    assert.deepEqual(coverage.data.documents.map(d=>d.provenance[0].listing.via),['configured',saved.home.url]);
    const repeat=await collectHSA(db,options);assert.equal(repeat.processed,2);assert.equal(transport.requests.length,2);assert.equal(repeat.created,0);
    assert.deepEqual(reads,[...inputs,...inputs]);assert.deepEqual((await db.query('select * from scout.trackers where id=$1',[tracker.id])).rows[0],tracker);
    assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,0);
  }finally{await db.close();}
});

test('HUB calendar, whole item and associated ICS use shared resolution and unchanged-repeat progress',async()=>{
  const saved=await fixture('hub-calendar.json'),db=await database();try{
    const home='https://www.hubocean.earth/events-calendar',item=saved.upcoming[0],url=new URL(item.fullUrl,home).href;
    const tracker=(await db.query("insert into scout.trackers(name,url,collector,cadence) values('HUB Ocean',$1,'web','7 days') returning *",[home])).rows[0],reads=[],inputs=[];
    const responses=new Map([[home+'?format=json',{body:JSON.stringify(saved),mime:'application/json'}],
      [url+'?format=json',{body:JSON.stringify({item}),mime:'application/json'}],[url+'?format=ical',{body:saved.calendar,mime:'text/calendar'}]]);
    const transport=runModel(db,async input=>{
      if(input.stage==='resolve')return resolve(input); // Injected identities exercise shared saving, not provider correctness.
      inputs.push(input);const source=(await db.query('select * from scout.evidence where id=$1',[input.source_id])).rows[0];
      const prepared=source.parsed.document.prepared_versions['hub-documents-v1'];
      assert.deepEqual(input.range,[0,prepared.text.length]);assert.deepEqual(input.omitted_ranges,[]);
      assert.equal(input.segments.map(s=>s.text).join(''),prepared.text);assert.deepEqual(Object.keys(input.documents),['P']);
      assert.equal(source.content,input.documents.P.url===url?JSON.stringify(item):responses.get(input.documents.P.url).body);
      const finding=base(item.title,[{doc:'P',quote:item.title}]);finding.priority='high';
      return answer([finding]);
    },true);
    const options={trackerId:tracker.id,validate:true,documents:'process',makeModel:transport.makeModel,read:async target=>{
      reads.push(target);assert.ok(responses.has(target),'Incidental links/media must not be fetched: '+target);
      const r=responses.get(target);return {url:target,status:200,headers:{'content-type':r.mime},body:r.body};
    }};
    await assert.rejects(collectHSA(db,{...options,sourceId:'00000000-0000-4000-8000-000000000000'}),{status:400});assert.equal(reads.length,0);
    const first=await collectHSA(db,options);assert.equal(first.documents,3);assert.equal(first.processed,3,first.warnings.join(';'));
    assert.equal(first.created,1);assert.equal(first.requests,2);assert.equal(transport.requests.length,6);
    assert.deepEqual(inputs.map(p=>p.documents.P.url),[home+'?format=json',url,url+'?format=ical']);
    const rows=(await db.query('select * from scout.records')).rows;assert.equal(rows.length,1);assert.equal(rows[0].title,item.title);
    for(const key of CONTENT_FIELDS.filter(k=>!['kind','title'].includes(k)))assert.equal(rows[0][key],null);
    assert.equal((await db.query('select count(*)::int n from scout.evidence where record_id=$1',[rows[0].id])).rows[0].n,3);
    const prior=(await db.query('select * from scout.collection_runs where id=$1',[first.run_id])).rows[0];
    assert.equal(prior.stats.model_attempts.length,6);assert.equal(prior.report.path,'hub-records');
    assert.equal(prior.stats.document_source.known.length,3);assert.equal(prior.stats.document_source.pending.length,0);
    const repeat=await collectHSA(db,options);assert.equal(repeat.processed,3);assert.equal(repeat.created,0);assert.equal(repeat.requests,3);
    assert.equal(transport.requests.length,6);assert.equal(inputs.length,3);
    assert.deepEqual((await db.query('select * from scout.records')).rows,rows);
    assert.deepEqual((await db.query('select * from scout.collection_runs where id=$1',[first.run_id])).rows[0],prior);
    assert.deepEqual((await db.query('select * from scout.trackers where id=$1',[tracker.id])).rows[0],tracker);
    const report=(await db.query('select report from scout.collection_runs where id=$1',[repeat.run_id])).rows[0].report;
    assert.equal(Object.values(report.operations).filter(o=>['generate','validate','save'].includes(o.step)&&o.state==='skipped').length,9);
  }finally{await db.close();}
});

test('HSA whole HTML and same-ID API fallback resume pending resolution and skip unchanged completed findings',async context=>{
  const saved=await fixture('hsa-web-full-api.json.gz'),feed=(await fixture('hsa-website.json.gz')).feed,article=JSON.parse(saved.api.body);
  const listing={...feed,body:feed.body.replace(/<item>[\s\S]*?<\/item>/g,item=>item.includes('<link>'+article.link+'</link>')?item:'')}; // One observed listing; announcement bodies stay whole.
  for(const route of ['html','api']){const db=await database();try{
    const tracker=(await db.query('select * from scout.trackers where url=$1',[HSA_WEB])).rows[0],reads=[],inputs=[];
    const description='Join the first session of the webinar series on designing the Clearing-House Mechanism under the BBNJ Agreement, also known as the High Seas Treaty.';
    const finding=base(article.title.rendered,[{doc:'P',quote:article.title.rendered},{doc:'P',quote:description},{doc:'P',quote:'https://bit.ly/clhmreg1'}]);
    Object.assign(finding.candidate,{description,registration_url:'https://bit.ly/clhmreg1'});
    Object.assign(finding.evidence,{kind:[1],description:[1],priority:[1],registration_url:[2]});
    const transport=runModel(db,async input=>{
      inputs.push(input);if(input.stage==='resolve')return resolve(input); // Injected reply checks shared mechanics, not provider accuracy.
      const source=(await db.query('select * from scout.evidence where id=$1',[input.source_id])).rows[0],prepared=Object.values(source.parsed.document.prepared_versions)[0];
      assert.equal(source.content,saved[route].body);assert.equal(source.parsed.document.identity,'hsa:document:6800');
      assert.deepEqual(input.range,[0,prepared.text.length]);assert.deepEqual(input.omitted_ranges,[]);
      assert.equal(input.segments.map(s=>s.text).join(''),prepared.text);assert.deepEqual(Object.keys(input.documents),['P']);
      assert.ok(prepared.text.includes('9PM UTC+8'));assert.ok(prepared.text.includes('https://bit.ly/clhmreg1'));
      return answer([finding]);
    });
    let remaining=1,feedAvailable=true;
    const options={trackerId:tracker.id,validate:true,documents:'process',makeModel:(...args)=>{const model=transport.makeModel(...args);return(...input)=>{
      if(remaining--<=0)throw new Error('Model quota reached');return model(...input);
    };},read:async url=>{
      reads.push(url);assert.ok([feed.url,saved.html.url,saved.api.url].includes(url),'Incidental URL must remain unfetched: '+url);
      return url===feed.url?{...listing,status:feedAvailable?200:503}:url===saved.html.url?{...saved.html,status:route==='html'?200:400}:saved.api;
    }};
    await assert.rejects(collectHSA(db,{...options,sourceId:'00000000-0000-4000-8000-000000000000'}),{status:400});assert.equal(reads.length,0);
    const first=await collectHSA(db,options),requests=[feed.url,saved.html.url,...route==='api'?[saved.api.url]:[]];
    assert.equal(first.documents,1);assert.equal(first.created,0);assert.deepEqual(reads,requests);assert.equal(transport.requests.length,1);
    const prior=(await db.query('select * from scout.collection_runs where id=$1',[first.run_id])).rows[0];
    assert.equal(prior.report.path,'hsa-records');assert.deepEqual(prior.stats.document_source.known,[{url:article.link,id:'6800'}]);
    assert.equal(prior.stats.model_attempts.length,1);remaining=1;feedAvailable=false;
    const resumed=await collectHSA(db,options);assert.equal(resumed.created,1,resumed.warnings.join(';'));
    assert.equal(transport.requests.length,2);assert.deepEqual(inputs.map(i=>i.stage),['extract','resolve']);assert.deepEqual(reads,[...requests,...requests]);
    const rows=(await db.query('select * from scout.records')).rows;assert.equal(rows.length,1);assert.equal(rows[0].description,description);
    assert.equal(rows[0].registration_url,'https://bit.ly/clhmreg1');
    for(const key of ['organization','location','status','starts_at','ends_at','event_url'])assert.equal(rows[0][key],null);
    const repeat=await collectHSA(db,options);assert.equal(repeat.processed,1);assert.equal(repeat.created,0);assert.equal(transport.requests.length,2);
    assert.deepEqual(reads,[...requests,...requests,...requests]);assert.deepEqual((await db.query('select * from scout.records')).rows,rows);
    assert.deepEqual((await db.query('select * from scout.collection_runs where id=$1',[first.run_id])).rows[0],prior);
    assert.deepEqual((await db.query('select * from scout.trackers where id=$1',[tracker.id])).rows[0],tracker);
    const report=(await db.query('select report from scout.collection_runs where id=$1',[repeat.run_id])).rows[0].report;
    assert.equal(Object.values(report.operations).filter(o=>['generate','validate','save'].includes(o.step)&&o.state==='skipped').length,3);
    context.diagnostic(JSON.stringify({route,requests_per_run:requests.length,model_calls:transport.requests.length,records:rows.length,repeat_model_calls:0}));
  }finally{await db.close();}}
});

test('DOALOS whole pages resume resolution, retain non-events and recheck known notices through a listing outage',async context=>{
  const saved=await fixture('doalos-notices.json.gz'),db=await database();try{
    const tracker=(await db.query('select * from scout.trackers where url=$1',[DOALOS])).rows[0],reads=[],inputs=[];
    const listing=DOALOS+'/notifications',notices=[DOALOS+'/notification-2026-001',DOALOS+'/notification-2026-002'];
    const mgr=DOALOS+'/mgr-notifications/bbnj-mgr-temp-2026-001',title='2026 International Conference on BBNJ: Science and Governance (5 November 2026)';
    const transport=runModel(db,async input=>{
      inputs.push(input);if(input.stage==='resolve'){
        for(const field of CONTENT_FIELDS.filter(k=>!['kind','title'].includes(k)))assert.equal(input.finding.candidate[field],null);
        return {...resolve(input),outcome:'uncertain',record_id:null,facts:{kind:'supported',title:'supported',priority:'unsupported'},reason:'The selected title alone does not establish the proposed substantive priority.'};
      }
      const url=input.documents.P.url,source=(await db.query('select * from scout.evidence where id=$1',[input.source_id])).rows[0];
      const prepared=source.parsed.document.prepared_versions['doalos-documents-v1'];
      assert.equal(source.content,saved[url].body);assert.equal(source.parsed.document.identity,'doalos:'+new URL(url).pathname);
      assert.deepEqual(input.range,[0,prepared.text.length]);assert.deepEqual(input.omitted_ranges,[]);
      assert.equal(input.segments.map(s=>s.text).join(''),prepared.text);assert.deepEqual(Object.keys(input.documents),['P']);
      if(url===DOALOS)return answer([base(title,[{doc:'P',quote:title}])]); // Injected uncertainty preserves the gathering without accepting title-only priority.
      assert.ok(prepared.text.includes(url===notices[1]?'No action required':'Action required by 16 March 2026'));
      return answer([]); // Official notification/action dates are not gatherings.
    },true);
    let remaining=1,available=true;
    const options={trackerId:tracker.id,validate:true,documents:'process',makeModel:(...args)=>{const model=transport.makeModel(...args);return(...input)=>{
      if(remaining--<=0)throw new Error('Model quota reached');return model(...input);
    };},read:async url=>{
      reads.push(url);assert.ok([DOALOS,listing,...notices,mgr].includes(url),'Incidental destination must stay unfetched: '+url);
      if(url===mgr)throw new Error('No retained MGR response');
      return {...saved[url],status:!available&&[DOALOS,listing].includes(url)?503:200,headers:{'content-type':'text/html'}};
    }};
    await assert.rejects(collectHSA(db,{...options,sourceId:'00000000-0000-4000-8000-000000000000'}),{status:400});assert.equal(reads.length,0);
    const first=await collectHSA(db,options);assert.equal(first.documents,4);assert.equal(first.created,0);assert.equal(transport.requests.length,1);
    remaining=4;const resumed=await collectHSA(db,options);assert.equal(resumed.processed,3,resumed.warnings.join(';'));assert.equal(resumed.uncertain,1);
    assert.deepEqual(inputs.map(i=>i.stage),['extract','resolve','extract','extract','extract']);assert.equal(transport.requests.length,5);
    const prior=(await db.query('select * from scout.collection_runs where id=$1',[resumed.run_id])).rows[0];
    assert.equal(prior.report.path,'doalos-records');assert.equal(prior.stats.document_source.known.length,5);
    assert.ok(prior.stats.document_source.pending.some(p=>p.url===mgr&&p.state==='failed'));
    const coverage=Object.values(prior.report.artifacts).find(a=>a.kind==='coverage'&&a.data.documents?.some(d=>d.provenance));
    assert.equal(coverage.data.complete,false);
    const via=coverage.data.documents.find(d=>d.url===notices[0]).provenance.flatMap(p=>p.via);
    assert.ok(via.some(v=>v.parent_url===DOALOS));assert.ok(via.some(v=>v.parent_url===listing));
    available=false;const outage=await collectHSA(db,options);assert.equal(outage.documents,2);assert.equal(outage.processed,2);
    available=true;const repeated=await collectHSA(db,options);assert.equal(repeated.processed,3);assert.equal(repeated.uncertain,1);assert.equal(transport.requests.length,5);
    assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,0);
    assert.deepEqual((await db.query('select * from scout.collection_runs where id=$1',[resumed.run_id])).rows[0],prior);
    assert.deepEqual((await db.query('select * from scout.trackers where id=$1',[tracker.id])).rows[0],tracker);
    context.diagnostic(JSON.stringify({documents:4,injected_model_calls:5,records:0,uncertain_gatherings:1,known_notices_during_outage:2,repeat_model_calls:0}));
  }finally{await db.close();}
});

test('UN side-event whole sources resume native pending sessions through a listing outage and repeat without model calls',async context=>{
  const saved=await fixture('un-side-events.json.gz'),db=await database();try{
    const tracker=(await db.query('select * from scout.trackers where url=$1',[UN_SIDE_EVENTS])).rows[0],reads=[],inputs=[];
    // Retained API bodies originally used projections; rewriting their query URL proves local mechanics, not live unprojected coverage.
    const sessions=new Map(Object.values(saved).filter(r=>r.url?.startsWith('https://api.cbd.int/')).map(r=>[JSON.parse(new URL(r.url).searchParams.get('q'))['sideEvent.id'],r]));
    const title=JSON.parse(sessions.get(6915).body)[0].sideEvent.title;
    const description='It will also explore interlinkages and opportunities for cooperation between the BBNJ Agreement and work under the CBD, including the KMGBF, as well as synergies in their implementation, in particular with regard to scientific and technical issues.';
    const transport=runModel(db,async input=>{
      inputs.push(input);if(input.stage==='resolve'){
        for(const field of CONTENT_FIELDS.filter(k=>!['kind','title','description'].includes(k)))assert.equal(input.finding.candidate[field],null);
        return resolve(input);
      }
      const source=(await db.query('select * from scout.evidence where id=$1',[input.source_id])).rows[0],identity=source.parsed.document.identity;
      const prepared=source.parsed.document.prepared_versions['un-side-documents-v2'],id=identity==='un-side:listing'?null:+identity.split(':').at(-1);
      assert.equal(source.content,id?sessions.get(id).body:saved[UN_SIDE_EVENTS].body);assert.equal(source.parsed.document.id,identity);
      assert.deepEqual(input.range,[0,prepared.text.length]);assert.deepEqual(input.omitted_ranges,[]);
      assert.equal(input.segments.map(s=>s.text).join(''),prepared.text);assert.deepEqual(Object.keys(input.documents),['P']);
      assert.ok(prepared.links.every(l=>l.state==='unfetched'));
      if(id!==6915)return answer([]); // Injected zeroes for other sources are not semantic coverage claims.
      assert.ok(prepared.text.includes(description));assert.ok(prepared.blocks.some(b=>b.source_paths?.includes('$[0].sideEvent.hostOrgs[0]')));
      const finding=base(title,[{doc:'P',quote:title},{doc:'P',quote:description}]);finding.candidate.description=description;
      finding.evidence={kind:[1],title:[0],description:[1],priority:[1]};return answer([finding]);
    },true);
    let remaining=2,available=true;
    const options={trackerId:tracker.id,validate:true,documents:'process',makeModel:(...args)=>{const model=transport.makeModel(...args);return(...input)=>{
      if(remaining--<=0)throw new Error('Model quota reached');return model(...input);
    };},read:async url=>{
      reads.push(url);if(url===UN_SIDE_EVENTS)return {...saved[url],status:available?200:503};
      const u=new URL(url),q=JSON.parse(u.searchParams.get('q'));
      assert.equal(u.origin+u.pathname,'https://api.cbd.int/api/v2016/reservations/');assert.deepEqual([...u.searchParams.keys()],['q']);
      assert.deepEqual(Object.keys(q),['sideEvent.id']);assert.ok([6915,5838,5378].includes(q['sideEvent.id']));return {...sessions.get(q['sideEvent.id']),url};
    }};
    await assert.rejects(collectHSA(db,{...options,sourceId:'00000000-0000-4000-8000-000000000000'}),{status:400});
    const cbd=(await db.query('select id from scout.trackers where url=$1',[CBD_REGISTRY])).rows[0];
    await assert.rejects(collectHSA(db,{...options,trackerId:cbd.id}),{status:400});assert.equal(reads.length,0);
    const first=await collectHSA(db,options);assert.equal(first.documents,4);assert.equal(first.requests,4);assert.equal(first.created,0);assert.equal(transport.requests.length,2);
    const pending=(await db.query("select parsed#>'{document,processing_versions}' versions from scout.evidence where tracker_id=$1 and record_id is null and parsed#>>'{document,identity}'='un-side:session:6915'",[tracker.id])).rows[0];
    assert.equal(Object.values(pending.versions)[0].findings.length,1);assert.equal(Object.values(pending.versions)[0].findings[0].resolution,undefined);
    available=false;remaining=3;const resumed=await collectHSA(db,options);
    assert.equal(resumed.documents,3);assert.equal(resumed.requests,4);assert.equal(resumed.created,1,resumed.warnings.join(';'));
    assert.equal(inputs.filter(i=>i.stage==='extract').length,4);assert.equal(new Set(inputs.filter(i=>i.stage==='extract').map(i=>i.source_id)).size,4);
    assert.equal(inputs.filter(i=>i.stage==='resolve').length,1);assert.equal(inputs.at(-1).finding.candidate.title,title);
    const prior=(await db.query('select * from scout.collection_runs where id=$1',[resumed.run_id])).rows[0];
    assert.equal(prior.report.path,'un-side-records');assert.deepEqual(prior.stats.document_source.known.map(d=>d.id).sort(),['un-side:listing','un-side:session:5378','un-side:session:5838','un-side:session:6915']);
    const coverage=Object.values(prior.report.artifacts).find(a=>a.kind==='coverage'&&a.data.documents?.some(d=>d.provenance));
    assert.equal(coverage.data.complete,false);assert.equal(coverage.data.coverage.filter(c=>c.relationship==='source-references'&&c.state==='unfetched').length,3);
    const records=(await db.query('select * from scout.records')).rows;assert.equal(records.length,1);assert.equal(records[0].title,title);assert.equal(records[0].description,description);
    const versions=(await db.query("select id,content,parsed#>'{document,processing_versions}' versions from scout.evidence where tracker_id=$1 and record_id is null order by id",[tracker.id])).rows;
    assert.equal(versions.length,4);
    available=true;const repeated=await collectHSA(db,options);assert.equal(repeated.documents,4);assert.equal(repeated.processed,4);assert.equal(repeated.requests,4);assert.equal(transport.requests.length,5);
    assert.deepEqual((await db.query('select * from scout.records')).rows,records);
    assert.deepEqual((await db.query("select id,content,parsed#>'{document,processing_versions}' versions from scout.evidence where tracker_id=$1 and record_id is null order by id",[tracker.id])).rows,versions);
    assert.deepEqual((await db.query('select * from scout.collection_runs where id=$1',[resumed.run_id])).rows[0],prior);
    assert.deepEqual((await db.query('select * from scout.trackers where id=$1',[tracker.id])).rows[0],tracker);
    context.diagnostic(JSON.stringify({documents:4,requests_per_run:4,injected_model_calls:5,simulated_records:1,known_sessions_during_outage:3,repeat_model_calls:0}));
  }finally{await db.close();}
});

test('retained UN wrong match requires occurrence proof while same-title new remains unresolved',async()=>{
  const actual=await fixture('un-side-identity-failures.json.gz'),before=JSON.stringify(actual);
  const {input,response}=actual.wrong_match,{finding,candidates}=input;
  assert.equal(actual.wrong_match.run_id,'40cc4275-ad9f-4c63-8c03-6ed704779e47');
  assert.equal(response.record_id,'6c839b7d-cfd5-4eba-8ae8-5cde08b46097');
  assert.equal(finding.candidate.starts_at,null);assert.deepEqual(response.evidence.identity,[0]);
  assert.throws(()=>validateResolution(response,finding,candidates,{}),/extracted occurrence passage/);
  const comparison={record_id:response.record_id,relation:'possible_match',citations:[0],reason:'The titles match.'};
  const compared={...response,comparisons:[comparison]};
  assert.throws(()=>validateResolution(compared,finding,candidates,{}),/extracted occurrence passage/);
  const taggedTitle={...finding,evidence:{...finding.evidence,identity:[0]}};
  assert.throws(()=>validateResolution(compared,taggedTitle,candidates,{}),/title-only evidence/);
  for(const outcome of ['evidence','update'])assert.throws(()=>validateResolution({...compared,outcome},taggedTitle,candidates,{}),/title-only evidence/);
  const uncertain={...compared,outcome:'uncertain',record_id:null};
  assert.equal(validateResolution(uncertain,finding,candidates,{}).outcome,'uncertain');
  const distinct=actual.distinct_edition;
  assert.throws(()=>validateResolution(distinct.response,distinct.input.finding,distinct.input.candidates,{}),/distinct cited label/,
    'The genuine same-title edition remains a disclosed false negative; no permissive context heuristic');
  const iddri=actual.iddri_distinct;
  assert.equal(validateResolution(iddri.response,iddri.input.finding,iddri.input.candidates,{}).outcome,'new');
  const framed=actual.framed_title,p=framed.response.findings[0];
  assert.equal(framed.run_id,'afe85427-d9e5-4b1e-9fe5-1d2d9cc388a3');
  assert.equal(validateFinding(p,framed.extract_input),p);
  assert.equal(p.citations[0].quote,framed.prepared.text.slice(36,204));
  const titleOnly={...resolve({finding:p,candidates:framed.candidates}),record_id:response.record_id,
    comparisons:[comparison],evidence:{identity:[0]}};
  assert.throws(()=>validateResolution(titleOnly,p,framed.candidates,{documents:[{id:'P',prepared:framed.prepared}]}),/title-only evidence/,
    'Actual generated field framing cannot turn its unchanged title value into occurrence evidence');
  assert.equal(JSON.stringify(actual),before,'Exact retained findings, candidates and replies are not repaired in the fixture');
  const db=await database();try{
    const tracker=(await db.query('select id from scout.trackers where url=$1',[UN_SIDE_EVENTS])).rows[0];
    const old=candidates.find(r=>r.id===response.record_id);
    await db.query('insert into scout.records(id,'+CONTENT_FIELDS.join(',')+',priority) values('+Array.from({length:CONTENT_FIELDS.length+2},(_,i)=>'$'+(i+1)).join(',')+')',
      [old.id,...CONTENT_FIELDS.map(k=>old[k]??null),old.priority]);
    const rows=(await db.query('select * from scout.records')).rows;
    // Retained resolution lifecycle only; whole API acquisition is not simulated here.
    const source=(await db.query('insert into scout.evidence(tracker_id,url,content,content_hash,parsed) values($1,$2,$3,md5($3),$4) returning *',
      [tracker.id,input.url,finding.citations.map(c=>c.quote).join('\n'),JSON.stringify({document:{identity:'un-side:session:5378'}})])).rows[0];
    const run=(await db.query('insert into scout.collection_runs(tracker_id) values($1) returning id',[tracker.id])).rows[0].id,trace=await startReport(db,run);
    const prepared=await supportDocuments(db,{source,prepared:prepareDocument({title:finding.candidate.title,url:source.url,html:source.content}),trace});
    const version=DOCUMENT_VERSION+'/'+prepared.version+'/'+prepared.context;
    const state={state:'failed',revision:0,cursor:prepared.text.length,findings:[{key:'retained',finding,pending:{round:2,repair:{rejected:response,errors:['Retained identity failure']}}}]};
    await db.query("update scout.evidence set parsed=jsonb_set(parsed,'{document,processing_versions}',$2::jsonb) where id=$1",[source.id,JSON.stringify({[version]:state})]);
    const transport=runModel(db,supplied=>{assert.deepEqual(supplied.finding,finding);return response;});
    const options={source:(await db.query('select * from scout.evidence where id=$1',[source.id])).rows[0],prepared,trace,deadline:Date.now()+100000,model:transport.makeModel(run,Date.now()+100000,trace)};
    assert.equal((await processDocument(db,options)).state,'failed');assert.equal(transport.requests.length,1);
    options.source=(await db.query('select * from scout.evidence where id=$1',[source.id])).rows[0];
    const entry=options.source.parsed.document.processing_versions[version].findings[0];
    assert.equal(entry.exhausted,true);assert.equal(entry.pending.round,3);assert.deepEqual(entry.pending.repair.rejected,response);
    const exhausted=JSON.stringify(entry);await processDocument(db,options);assert.equal(transport.requests.length,1);
    assert.equal(JSON.stringify(Object.values((await db.query('select parsed from scout.evidence where id=$1',[source.id])).rows[0].parsed.document.processing_versions)[0].findings[0]),exhausted);
    assert.deepEqual((await db.query('select * from scout.records')).rows,rows);
    assert.equal((await db.query('select count(*)::int n from scout.evidence where record_id is not null')).rows[0].n,0);
    assert.equal((await db.query('select stats from scout.collection_runs where id=$1',[run])).rows[0].stats.model_attempts.length,1);
  }finally{await db.close();}
});

test('selected occurrence and alias passages preserve genuine matches and correction guards',()=>{
  const title='Ocean Data Workshop',alias='Atlantic Data Lab',occurrence=title+', the session at the 2026 Atlantic Forum.';
  const aliasProof=title+' at the 2026 Atlantic Forum is also called '+alias+'.';
  const sourceURL='https://example.org/atlantic-forum/session';
  const prepared={documents:[{id:'P',url:sourceURL,hash:'new',capture_id:'capture',relationship:'primary'}]};
  const finding=base(title,[{doc:'P',quote:title},{doc:'P',quote:occurrence},{doc:'P',quote:'Room B'}]);
  finding.candidate.description=occurrence;finding.evidence.description=[1];finding.evidence.identity=[1];
  const old={...finding.candidate,id:'existing',anchors:[title],same_source:true,fact_evidence:{}};
  const comparison={record_id:old.id,relation:'possible_match',citations:[1],reason:'Both refer to the named session at the 2026 Atlantic Forum.'};
  const decision={...resolve({finding,candidates:[old]}),evidence:{identity:[1]},comparisons:[comparison]};
  assert.equal(validateResolution(decision,finding,[old],prepared).outcome,'evidence');
  for(const value of [occurrence,sourceURL,title]){
    const text='Recorded value: '+value;
    const field={tag:'source-field',start:0,end:text.length,value_range:[16,text.length]};
    const wrapped={...finding,citations:[finding.citations[0],{doc:'P',quote:text}]};
    const structured={documents:[{...prepared.documents[0],prepared:{text,blocks:[field]}}]};
    if(value===occurrence)assert.equal(validateResolution(decision,wrapped,[old],structured).outcome,'evidence');
    else assert.throws(()=>validateResolution(decision,wrapped,[old],structured),/title-only evidence/);
  }
  for(const proof of [undefined,[0]])assert.throws(()=>validateResolution(decision,{...finding,evidence:{...finding.evidence,identity:proof}},[old],prepared),/extracted occurrence passage/);
  assert.throws(()=>validateResolution({...decision,comparisons:[{...comparison,citations:[0]}]},finding,[old],prepared),/extracted occurrence passage/);
  assert.throws(()=>validateResolution(decision,{...finding,citations:[finding.citations[0],{doc:'P',quote:sourceURL}]},[old],prepared),/extracted occurrence passage/);
  const aliased={...finding,anchor:alias,candidate:{...finding.candidate,title:alias},citations:[{doc:'P',quote:alias},{doc:'P',quote:aliasProof}]};
  assert.equal(validateResolution(decision,aliased,[old],prepared).outcome,'evidence');
  assert.throws(()=>validateResolution(decision,{...aliased,citations:[aliased.citations[0],{doc:'P',quote:occurrence}]},[old],prepared),/Target lacks supported finding identity/);
  assert.throws(()=>validateResolution(decision,finding,[{...old,kind:'announcement'}],prepared),/Target lacks supported finding identity/);
  assert.throws(()=>validateResolution(decision,finding,[old,{...old,id:'other'}],prepared),/Ambiguous finding identity/);
  const generic={...finding,candidate:{...finding.candidate,organization:'Ocean Institute',description:'A workshop on ocean data standards.'},evidence:{kind:[0],title:[0],priority:[0],organization:[1],description:[1]}};
  const genericOld={...old,...generic.candidate};
  const genericDecision={...decision,facts:{...decision.facts,organization:'supported',description:'supported'}};
  assert.throws(()=>validateResolution(genericDecision,generic,[genericOld],prepared),/extracted occurrence passage/,
    'Matching generic fields and a shared title cannot substitute for selected occurrence evidence');
  const moved={...finding,candidate:{...finding.candidate,location:'Room B'},evidence:{...finding.evidence,location:[2]}};
  const previous={...old,location:'Room A',fact_evidence:{location:{rank:0,sources:[{url:sourceURL,hash:'old'}]}}};
  const correction={...decision,outcome:'update',conflict:'correction',facts:{...decision.facts,location:'supported'},evidence:{identity:[1],change:[2]}};
  assert.equal(validateResolution(correction,moved,[previous],prepared).outcome,'update');
  assert.throws(()=>validateResolution({...correction,conflict:'completion'},moved,[previous],prepared),/correction decision/);
  assert.throws(()=>validateResolution(correction,moved,[previous],{documents:[{...prepared.documents[0],url:'https://example.org/another-source'}]}),/correction authority/);
  const unproven={...moved,evidence:{...moved.evidence,identity:[0]}};
  assert.throws(()=>validateResolution({...correction,evidence:{identity:[0],change:[2]}},unproven,[previous],prepared),/title-only evidence/);
  assert.throws(()=>validateResolution({...correction,outcome:'new',record_id:null,conflict:'none',evidence:{distinction:[0]},comparisons:[{...comparison,relation:'distinct'}]},unproven,[previous],prepared),/distinct cited label/);
});

test('retained HSA COP1 paraphrase requires candidate comparisons without forcing a merge',async()=>{
  const actual=await fixture('hsa-identity-failure.json.gz'),{finding,candidates,coverage}=actual.input,before=JSON.stringify(actual);
  assert.equal(actual.run_id,'f88603bc-83c9-4298-806c-018e96629f94');assert.equal(coverage.complete,true);assert.equal(candidates.length,10);
  assert.equal(candidates.find(r=>r.id===actual.existing_record).title,'first meeting of the COP of the BBNJ Agreement');
  assert.equal(finding.candidate.title,'The first BBNJ Conference of the Parties (BBNJ COP1)');
  assert.equal(actual.response.outcome,'new');assert.equal(actual.response.evidence.distinction[0],0);
  assert.throws(()=>validateResolution(actual.response,finding,candidates,{}),/every supplied candidate/);
  const comparisons=candidates.map(r=>({record_id:r.id,relation:r.id===actual.existing_record?'possible_match':'distinct',citations:[0],
    reason:r.id===actual.existing_record?'Both labels identify the inaugural BBNJ COP; no different edition or session is established.':
      'The cited inaugural BBNJ COP differs from the candidate gathering: '+r.title}));
  const proposal={...actual.response,comparisons};
  assert.throws(()=>validateResolution(proposal,finding,candidates,{}),/every supplied candidate/);
  assert.equal(validateResolution({...proposal,outcome:'uncertain'},finding,candidates,{}).record_id,null);
  assert.throws(()=>validateResolution({...proposal,outcome:'evidence',record_id:actual.existing_record},finding,candidates,{}),/Target lacks supported finding identity/);
  const distinct=comparisons.map(c=>({...c,relation:'distinct'}));
  assert.throws(()=>validateResolution({...proposal,comparisons:distinct.slice(1)},finding,candidates,{}),/every supplied candidate/);
  for(const changed of [
    [{...comparisons[0],record_id:'not-supplied'}],
    [comparisons[0],comparisons[0]],
    [{...comparisons[0],citations:[finding.citations.length]}],
    [{...comparisons[0],reason:''}],
  ])assert.throws(()=>validateResolution({...proposal,comparisons:changed},finding,candidates,{}),/Candidate comparisons/);
  // Coverage is enforced mechanically; a false semantic distinction remains a model-quality failure.
  assert.equal(validateResolution({...proposal,comparisons:distinct},finding,candidates,{}).outcome,'new');
  const named={...finding.candidate,id:'first-copy',anchors:[finding.anchor]};
  assert.throws(()=>validateResolution({...actual.response,outcome:'evidence',record_id:named.id,comparisons:[{
    record_id:named.id,relation:'distinct',citations:[0],reason:'Different gathering.'}]},finding,[named],{}),/Selected target cannot be declared distinct/);
  assert.throws(()=>validateResolution({...actual.response,outcome:'evidence',record_id:named.id},finding,[named,{...named,id:'second-copy'}],{}),/Ambiguous finding identity/);
  assert.equal(validateResolution(actual.response,finding,[],{}).outcome,'new','No-candidate output shape remains valid');
  assert.equal(JSON.stringify(actual),before,'Retained request, reply and all candidate values stay unchanged');
  for(const corrected of [false,true]){const db=await database();try{
    const tracker=(await db.query('select id from scout.trackers where url=$1',[HSA_WEB])).rows[0];
    const old=candidates.find(r=>r.id===actual.existing_record);
    await db.query('insert into scout.records(id,'+CONTENT_FIELDS.join(',')+',priority) values('+Array.from({length:CONTENT_FIELDS.length+2},(_,i)=>'$'+(i+1)).join(',')+')',
      [old.id,...CONTENT_FIELDS.map(k=>old[k]??null),old.priority]);
    const record=(await db.query('select * from scout.records where id=$1',[old.id])).rows[0];
    // Resume mechanics use the exact retained finding/quote, not a new whole-source acquisition.
    const source=(await db.query('insert into scout.evidence(tracker_id,url,content,content_hash,parsed) values($1,$2,$3,md5($3),$4) returning *',
      [tracker.id,actual.input.url,finding.citations[0].quote,JSON.stringify({document:{identity:'hsa:document:6736'}})])).rows[0];
    const run=(await db.query('insert into scout.collection_runs(tracker_id) values($1) returning id',[tracker.id])).rows[0].id,trace=await startReport(db,run);
    const prepared=await supportDocuments(db,{source,prepared:prepareDocument({title:finding.candidate.title,url:source.url,html:source.content}),trace});
    const version=DOCUMENT_VERSION+'/'+prepared.version+'/'+prepared.context,repair={rejected:actual.response,errors:['Retained prior resolution rejection']};
    const state={state:'failed',revision:0,cursor:prepared.text.length,findings:[{key:'retained',finding,pending:{round:2,repair}}]};
    await db.query("update scout.evidence set parsed=jsonb_set(parsed,'{document,processing_versions}',$2::jsonb) where id=$1",[source.id,JSON.stringify({[version]:state})]);
    const transport=runModel(db,input=>{
      assert.equal(input.stage,'resolve');assert.deepEqual(input.finding,finding);assert.deepEqual(input.repair,repair);
      assert.deepEqual(input.candidates.map(r=>r.id),[old.id]);
      return corrected?{...actual.response,outcome:'uncertain',reason:'The inaugural COP may match the existing first COP; no independent distinction.'}:actual.response;
    });
    const options={source:(await db.query('select * from scout.evidence where id=$1',[source.id])).rows[0],prepared,trace,deadline:Date.now()+100000,model:transport.makeModel(run,Date.now()+100000,trace)};
    const result=await processDocument(db,options);assert.equal(result.state,corrected?'uncertain':'failed');assert.equal(result.created,0);assert.equal(transport.requests.length,1);
    options.source=(await db.query('select * from scout.evidence where id=$1',[source.id])).rows[0];
    assert.equal(options.source.parsed.document.processing.version,version);
    const entry=options.source.parsed.document.processing_versions[version].findings[0];
    if(corrected)assert.equal(entry.resolution.outcome,'uncertain');else{assert.equal(entry.exhausted,true);assert.equal(entry.pending.round,3);assert.match(entry.error,/every supplied candidate/);}
    const report=(await db.query('select report,stats from scout.collection_runs where id=$1',[run])).rows[0];
    assert.equal(report.stats.model_attempts.length,1);assert.deepEqual(Object.values(report.report.operations).filter(o=>o.stage==='resolve'&&o.step==='generate').map(o=>o.repair),[2]);
    await processDocument(db,options);assert.equal(transport.requests.length,1,'Resolved/exhausted finding cannot receive a fresh allowance');
    assert.deepEqual((await db.query('select * from scout.records')).rows,[record]);
  }finally{await db.close();}}
});

test('saved UNOC announcement retains separate session labels without borrowing the parent schedule',async()=>{
  const saved=(await fixture('iddri-website.json.gz')).unoc;
  const prepared=prepareDocument({title:'IDDRI at UNOC',url:saved.url,html:saved.body});
  const titles=[
    'Monitoring, control and surveillance of future high seas MPAs: opportunities and challenges',
    'From Commitment to Action – Supporting the Early Implementation of the BBNJ Treaty',
  ];
  const findings=[];
  for(const title of titles){
    const start=prepared.text.indexOf(title);assert.ok(start>=0);
    const input=packDocument({id:'unoc-announcement'},prepared,start,DOCUMENT_VERSION);
    const finding=base(title,[{doc:'P',quote:title}]);finding.candidate.kind='event';
    assert.equal(validateFinding(finding,input),finding);
    findings.push(finding);
    assert.deepEqual(Object.keys(input.documents),['P']);
  }
  const existing={...findings[0].candidate,id:'first-session',anchors:[titles[0]]};
  const review={outcome:'new',record_id:null,reason:'Distinct session on the same announcement.',
    evidence:{distinction:[0]},facts:{kind:'supported',title:'supported',priority:'supported'},conflict:'none',comparisons:[{
      record_id:existing.id,relation:'distinct',citations:[0],reason:'The cited early-implementation session differs from the candidate session about MPA monitoring, control and surveillance.'}]};
  assert.equal(validateResolution(review,findings[1],[existing],prepared).outcome,'new');
  assert.throws(()=>validateResolution(review,findings[0],[existing],prepared),/distinct cited label/);
  assert.throws(()=>validateResolution({...review,comparisons:[],facts:{...review.facts,title:'unsupported'}},findings[1],[],prepared),/Unsupported\/conflicting/);
  const rejectedKind={...review,comparisons:[],facts:{...review.facts,kind:'unsupported'}};
  assert.throws(()=>validateResolution(rejectedKind,findings[1],[],prepared),/Unsupported\/conflicting/);
  assert.equal(validateResolution({...rejectedKind,outcome:'uncertain'},findings[1],[],prepared).outcome,'uncertain');
  const actual=(await fixture('hsa-social-preparation.json.gz')).announcement_contract.distinction_failure;
  const {finding,candidates}=actual.input;
  assert.ok(finding.anchor.endsWith('.'));assert.ok(!finding.citations[0].quote.endsWith('.'));
  const comparison={...actual.response,comparisons:candidates.map(r=>({record_id:r.id,relation:'distinct',citations:[0,2],
    reason:'The cited science side event differs from the candidate celebration of treaty entry into force.'}))};
  assert.equal(validateResolution(comparison,finding,candidates,prepared).outcome,'new');
  for(const label of [finding.anchor,finding.anchor.slice(0,-1)]){
    const duplicate={...candidates[0],title:label,anchors:[label]};
    assert.throws(()=>validateResolution(comparison,finding,[duplicate],prepared),/distinct cited label/);
  }
  const mpa=(await fixture('hsa-social-preparation.json.gz')).announcement_contract.mpa_distinction_failure;
  const supplied=JSON.parse(JSON.parse(mpa.request).contents[0].parts[0].text)[0];
  const decision=JSON.parse(JSON.parse(mpa.response).candidates[0].content.parts.find(p=>p.text).text),p=supplied.finding;
  decision.comparisons=supplied.candidates.map(r=>({record_id:r.id,relation:'distinct',citations:[0,2],
    reason:'The cited practical high seas MPA monitoring session differs from the candidate: '+r.title}));
  const before=JSON.stringify(supplied);assert.equal(validateResolution(decision,p,supplied.candidates,prepared).outcome,'new');
  assert.equal(JSON.stringify(supplied),before,'Retained presenter anchor, finding and progress are not rewritten');
  for(const label of [p.candidate.title,p.candidate.title+'.',p.anchor]){
    const duplicate={...supplied.candidates[0],title:label,anchors:[label]};
    assert.throws(()=>validateResolution({...decision,comparisons:decision.comparisons.slice(0,1)},p,[duplicate],prepared),/distinct cited label/);
  }
  assert.throws(()=>validateResolution(decision,{...p,evidence:{...p.evidence,title:[2]}},supplied.candidates,prepared),/distinct cited label/);
  assert.throws(()=>validateResolution({...decision,evidence:{distinction:[1]}},p,supplied.candidates,prepared),/distinct cited label/);
  const sharedTitle={...findings[1],candidate:{...findings[1].candidate,title:existing.title}};
  assert.equal(validateResolution(review,sharedTitle,[existing],prepared).outcome,'new','A cited distinct session anchor still takes precedence over a shared title');
});

test('retained whole newsletter accepts six injected events and repeats without another call',async context=>{
  const saved=await fixture('dosi-website.json.gz'),db=await database();
  const titles=['Science for BBNJ Implementation in Africa: Closing Knowledge Gaps and Building Partnerships for the High Seas',
    'Marine Minerals and the Media','International Marine Wood Borer Network Inaugural Symposium',
    'SEAMOUNTS: Building an International Science Seamounts','DSBS Seminar: Physiology of deep-sea cnidarians','ArtSea Matchmaking Online Exhibition & Event'];
  try{
    const tracker=(await db.query('select * from scout.trackers where url=$1',[saved.home.url])).rows[0];
    let newsletter;
    const transport=runModel(db,input=>{
      if(input.stage==='resolve')return {...resolve(input),outcome:'new',record_id:null,comparisons:input.candidates.map(r=>{
        assert.ok(titles.includes(r.title)&&r.title!==input.finding.candidate.title);
        return {record_id:r.id,relation:'distinct',citations:[0],reason:'Separate named gathering in the retained newsletter: '+input.finding.anchor};
      })};
      if(input.documents.P.url!==saved.newsletter.url)return answer([]);
      newsletter=input;assert.equal(input.range[0],0);assert.equal(input.segments.length,1);
      assert.equal(input.range[1],doc.prepared.text.length);assert.deepEqual(input.omitted_ranges,[]);
      return answer(titles.map(title=>base(title,[{doc:'P',quote:title}])));
    },true);
    const doc=prepareDosiDocument(saved.newsletter,{sourceURL});
    const source=(await db.query('insert into scout.evidence(tracker_id,url,content,content_hash,parsed) values($1,$2,$3,md5($3),$4) returning *',
      [tracker.id,doc.url,doc.raw,JSON.stringify({document:{identity:doc.identity}})])).rows[0];
    const run=(await db.query('insert into scout.collection_runs(tracker_id) values($1) returning id',[tracker.id])).rows[0].id;
    const trace=await startReport(db,run),deadline=Date.now()+100000;
    const prepared=await supportDocuments(db,{source,prepared:doc.prepared,trace});
    const options={source,prepared,trace,deadline,model:transport.makeModel(run,deadline,trace)};
    const result=await processDocument(db,options);assert.equal(result.created,6,result.error);assert.equal(result.state,'complete');assert.ok(newsletter);
    const rows=(await db.query('select * from scout.records order by title')).rows;assert.equal(rows.length,6);
    for(const row of rows)assert.equal(row.starts_at,null);
    options.source=(await db.query('select * from scout.evidence where id=$1',[source.id])).rows[0];
    const before=transport.requests.length,repeat=await processDocument(db,options);
    assert.equal(repeat.created,0);assert.equal(transport.requests.length,before);
    assert.deepEqual((await db.query('select * from scout.records order by title')).rows,rows);
    const body=transport.requests.find(b=>JSON.parse(JSON.parse(b).contents[0].parts[0].text)[0].documents?.P.url===saved.newsletter.url);
    context.diagnostic(JSON.stringify({source:'DOSI retained newsletter, injected decisions',whole_chars:newsletter.range[1],request_bytes:Buffer.byteLength(body),records:6,repeat_calls:0}));
  }finally{await db.close();}
});

test('retained DOSI repair resumes before fresh articles; raw UI churn preserves completed progress and history',async context=>{
  const saved=await fixture('dosi-website.json.gz'),{sources,runs}=saved.retained_resume,db=await database();
  try{
    const tracker=(await db.query('select * from scout.trackers where url=$1',[saved.home.url])).rows[0];
    for(const s of sources)await db.query('insert into scout.evidence(id,tracker_id,url,content_hash,content,parsed,last_seen_at) values($1,$2,$3,$4,$5,$6,$7)',
      [s.id,tracker.id,s.url,s.content_hash,s.content,JSON.stringify(s.parsed),s.last_seen_at]);
    for(const r of runs)await db.query('insert into scout.collection_runs(id,tracker_id,started_at,finished_at,outcome,stats,report) values($1,$2,$3,$4,$5,$6,$7)',
      [r.id,tracker.id,r.started_at,r.finished_at,r.outcome,JSON.stringify(r.stats),JSON.stringify(r.report)]);
    const historical=(await db.query('select * from scout.collection_runs order by id')).rows;
    const [completed,churn,newsletter]=sources,retained=new Map(sources.map(s=>[s.url,s]));
    const pending=newsletter.parsed.document.processing_versions[newsletter.parsed.document.processing.version].pending;
    assert.equal(pending.round,1);assert.equal(pending.repair.rejected.findings.length,5);
    const a=prepareDosiDocument({...saved.home,body:completed.content},{sourceURL}).prepared;
    const b=prepareDosiDocument({...saved.home,body:churn.content},{sourceURL}).prepared;
    assert.notEqual(completed.content_hash,churn.content_hash);assert.notDeepEqual(a.omissions,b.omissions);
    assert.deepEqual({...a,omissions:undefined},{...b,omissions:undefined});
    const title='Marine Minerals and the Media',reads=[];
    let prefix='<!-- injected external UI framing -->';
    const transport=runModel(db,input=>{
      if(input.stage==='resolve')return resolve(input);
      assert.equal(input.documents.P.url,newsletter.url);
      assert.deepEqual(input,{...pending.input,source_id:input.source_id,repair:pending.repair});
      assert.notEqual(input.source_id,newsletter.id,'Retained repair is rebound to the new raw capture');
      return answer([base(title,[{doc:'P',quote:title}])]);
    });
    // Replay the retained v1 preparation exactly; a version upgrade is checked separately below.
    const retainedPreparation=doc=>({...doc,prepared:{...retained.get(doc.url).parsed.document.prepared_versions['dosi-documents-v1'],omissions:doc.prepared.omissions}});
    const options={tracker,sourceURL,now:()=>new Date().toISOString(),deadline:Date.now()+100000,limits:{seconds:100,requests:8,pages:4},process:true,path:'dosi',makeModel:transport.makeModel,
      retrieve:async args=>{const result=await retrieveDosiDocuments(args);result.documents=result.documents.map(retainedPreparation);return result;},read:async url=>{
      reads.push(url);if(url===saved.feed.url)return saved.feed;
      const s=retained.get(url);if(!s)throw new Error('Fixture intentionally lacks other articles');
      return {url,status:200,headers:{'content-type':'text/html'},body:prefix+s.content};
    }};
    const first=await collectDocuments(db,options);
    assert.deepEqual(reads.slice(0,3),[saved.home.url,saved.feed.url,newsletter.url]);
    assert.equal(first.created,1,first.warnings.join(';'));assert.equal(transport.requests.length,2);
    const records=(await db.query('select * from scout.records')).rows;assert.equal(records[0].title,title);assert.equal(records[0].starts_at,null);
    const association=(await db.query('select * from scout.evidence where record_id is not null')).rows[0];
    prefix='<!-- another injected UI framing change -->';
    // Isolate completed-capture rechecks from the deliberately unavailable older articles above.
    const recheck=async()=>({documents:[churn,newsletter].map(s=>prepareDosiDocument({url:s.url,status:200,headers:{'content-type':'text/html'},body:prefix+s.content},{sourceURL})),coverage:[]});
    const repeat=await collectDocuments(db,{tracker,sourceURL,now:()=>new Date().toISOString(),deadline:Date.now()+100000,
      limits:{seconds:100,requests:4,pages:4},process:true,path:'dosi',makeModel:transport.makeModel,
      retrieve:async()=>{const result=await recheck();result.documents=result.documents.map(retainedPreparation);return result;}});
    assert.equal(repeat.created,0);assert.equal(transport.requests.length,2);
    assert.deepEqual((await db.query('select * from scout.records')).rows,records);
    const associations=(await db.query('select * from scout.evidence where record_id is not null')).rows;
    assert.equal(associations.length,1);assert.ok(associations[0].last_seen_at>association.last_seen_at);
    assert.deepEqual({...associations[0],last_seen_at:null},{...association,last_seen_at:null});
    assert.deepEqual((await db.query('select * from scout.collection_runs where id=any($1::uuid[]) order by id',[runs.map(r=>r.id)])).rows,historical);
    assert.deepEqual((await db.query('select id,record_id,url,content_hash,content,parsed,last_seen_at from scout.evidence where id=any($1::uuid[]) order by id',[sources.map(s=>s.id)])).rows,
      [...sources].sort((a,b)=>a.id.localeCompare(b.id)).map(s=>({...s,last_seen_at:new Date(s.last_seen_at)})));
    const report=(await db.query('select report from scout.collection_runs where id=$1',[first.run_id])).rows[0].report;
    assert.ok(Object.values(report.operations).some(op=>op.stage==='extract'&&op.repair===1));
    const resumed=(await db.query("select parsed from scout.evidence where record_id is null and url=$1 order by last_seen_at desc limit 1",[newsletter.url])).rows[0].parsed.document;
    assert.equal(resumed.processing.version,newsletter.parsed.document.processing.version);
    assert.equal(resumed.processing_versions[resumed.processing.version].state,'complete');
    let upgradedCalls=0;
    await collectDocuments(db,{...options,retrieve:recheck,model:async(_,[input])=>{upgradedCalls++;assert.equal(input.repair,undefined);return answer([]);}});
    assert.equal(upgradedCalls,2,'Only the changed DOSI preparation receives fresh extraction');
    const upgraded=(await db.query("select parsed from scout.evidence where record_id is null and url=$1 order by last_seen_at desc limit 1",[newsletter.url])).rows[0].parsed.document;
    assert.match(upgraded.processing.version,/dosi-documents-v2/);
    assert.deepEqual(upgraded.processing_versions[resumed.processing.version],resumed.processing_versions[resumed.processing.version]);
    assert.deepEqual(upgraded.prepared_versions['dosi-documents-v1'],resumed.prepared_versions['dosi-documents-v1']);
    assert.deepEqual((await db.query('select * from scout.collection_runs where id=any($1::uuid[]) order by id',[runs.map(r=>r.id)])).rows,historical);
    context.diagnostic(JSON.stringify({retained_repair_round:1,whole_chars:pending.input.range[1],model_calls:2,repeat_calls:0,historical_runs_unchanged:2}));
  }finally{await db.close();}
});

test('actual DOSI unknown-clock refusal resumes at repair one, can save null dates, and preserves completed sources and history',async()=>{
  const saved=(await fixture('hsa-social-preparation.json.gz')).announcement_contract.dosi_unknown_schedule;
  for(const mode of ['exhausted','wrong-source','ambiguous','refused','accepted']){const db=await database();try{
    const accepted=mode==='accepted';
    const r=structuredClone(saved.run);
    // Synthetic variants must not obtain fresh allowance from exhausted or unrelated history.
    const [responseId,response]=Object.entries(r.report.artifacts).find(([,a])=>a.kind==='extract_response'&&a.data.response.complete===false);
    if(mode==='exhausted')response.data.round=2;
    if(mode==='ambiguous'){
      r.report.artifacts.a999=structuredClone(response);
      for(const op of Object.values(r.report.operations))if(op.artifacts?.includes(responseId))op.artifacts.push('a999');
    }
    if(mode==='wrong-source')for(const op of Object.values(r.report.operations))
      if(op.artifacts?.some(id=>r.report.artifacts[id].kind==='processing_error'))op.source_ids=[saved.sources[1].id];
    await db.query('update scout.trackers set id=$1 where url=$2',[r.tracker_id,'https://bsky.app/profile/deepstewardship.bsky.social']);
    for(const s of saved.sources)await db.query('insert into scout.evidence(id,tracker_id,url,content_hash,content,parsed,last_seen_at) values($1,$2,$3,$4,$5,$6,$7)',
      [s.id,r.tracker_id,s.url,s.content_hash,s.content,JSON.stringify(s.parsed),s.last_seen_at]);
    await db.query('insert into scout.collection_runs(id,tracker_id,started_at,finished_at,outcome,stats,report) values($1,$2,$3,$4,$5,$6,$7)',
      [r.id,r.tracker_id,r.started_at,r.finished_at,r.outcome,JSON.stringify(r.stats),JSON.stringify(r.report)]);
    const original=(await db.query('select * from scout.collection_runs where id=$1',[r.id])).rows[0];
    const source=(await db.query('select * from scout.evidence where id=$1',[saved.sources[0].id])).rows[0];
    const previous=source.parsed.document.processing_versions[source.parsed.document.processing.version];assert.equal(previous.pending,undefined);
    const run=(await db.query('insert into scout.collection_runs(tracker_id) values($1) returning id',[r.tracker_id])).rows[0].id;
    const trace=await startReport(db,run),deadline=Date.now()+100000;
    const prepared=await supportDocuments(db,{source,prepared:source.parsed.document.prepared_versions['bluesky-author-documents-v3'],trace});
    const transport=runModel(db,input=>{
      if(input.stage==='resolve')return resolve(input);
      assert.deepEqual(input.repair.rejected,saved.response);assert.equal(input.range[1],384);
      if(!accepted)return saved.response;
      const quote='How Deep is Your Love will be screened in UK cinemas from 2nd October with preview screenings + Q&A in London from the 23rd of this month.';
      return answer([base('How Deep is Your Love',[{doc:'P',quote}])]);
    });
    const options={source,prepared,trace,deadline,model:transport.makeModel(run,deadline,trace)};
    const result=await processDocument(db,options);
    const state=(await db.query('select parsed from scout.evidence where id=$1',[source.id])).rows[0].parsed.document;
    if(['exhausted','wrong-source','ambiguous'].includes(mode)){
      assert.equal(transport.requests.length,0);assert.equal(!!state.processing_versions[state.processing.version].exhausted,mode==='exhausted');
      assert.deepEqual((await db.query('select * from scout.collection_runs where id=$1',[r.id])).rows[0],original);continue;
    }
    assert.equal(transport.requests.length,2);
    assert.equal(state.processing.version,source.parsed.document.processing.version);
    assert.equal(result.created,accepted?1:0);assert.equal(result.state,accepted?'complete':'failed');
    if(accepted){const record=(await db.query('select * from scout.records')).rows[0];assert.equal(record.starts_at,null);assert.equal(record.ends_at,null);assert.equal(record.status,null);}
    else assert.equal(state.processing_versions[state.processing.version].exhausted,true);
    options.source=(await db.query('select * from scout.evidence where id=$1',[source.id])).rows[0];
    await processDocument(db,options);assert.equal(transport.requests.length,2,'Completed or exhausted source cannot call again');
    for(const retained of saved.sources.slice(1)){
      const complete=(await db.query('select * from scout.evidence where id=$1',[retained.id])).rows[0];
      const context=await supportDocuments(db,{source:complete,prepared:complete.parsed.document.prepared_versions['bluesky-author-documents-v3'],trace});
      assert.equal((await processDocument(db,{...options,source:complete,prepared:context})).state,'complete');
    }
    assert.equal(transport.requests.length,2);assert.deepEqual((await db.query('select * from scout.collection_runs where id=$1',[r.id])).rows[0],original);
    assert.equal((await db.query('select stats from scout.collection_runs where id=$1',[run])).rows[0].stats.model_attempts.length,2);
    const details=(await db.query('select report from scout.collection_runs where id=$1',[run])).rows[0].report;
    const rounds=Object.values(details.operations).filter(o=>o.stage==='extract'&&o.step==='generate').map(o=>o.repair);
    assert.deepEqual(rounds,accepted?[1]:[1,2]);
  }finally{await db.close();}}
});

test('actual DOSI exhausted resolution stays stopped while later findings save, with exact legacy recovery and no extraction replay',async()=>{
  const saved=(await fixture('dosi-website.json.gz')).retained_resolution_exhaustion;
  for(const mode of ['retained','fresh','wrong-source','wrong-version','wrong-finding','wrong-error','ambiguous','extract-exhausted']){const db=await database();try{
    const r=structuredClone(saved.run),s=structuredClone(saved.source),version=s.parsed.document.processing.version,prior=s.parsed.document.processing_versions[version];
    const failed=prior.findings[1],next=prior.findings[2];assert.equal(prior.findings.length,7);assert.equal(prior.cursor,37407);
    if(mode==='fresh'){delete prior.exhausted;failed.pending={round:1,repair:r.report.artifacts.a12.data.repair};}
    if(mode==='wrong-source')r.report.operations.o22.source_ids=['00000000-0000-0000-0000-000000000000'];
    if(mode==='wrong-version')r.report.artifacts.a19.data.version+='-different';
    if(mode==='wrong-finding')r.report.artifacts.a19.data.finding=structuredClone(next.finding);
    if(mode==='wrong-error')r.report.artifacts.a24.data.errors=['Unrelated rejection'];
    if(mode==='ambiguous'){
      r.report.artifacts.a999=structuredClone(r.report.artifacts.a24);r.report.operations.o21.artifacts.push('a999');
    }
    if(mode==='extract-exhausted')prior.error=prior.error.replace('Two resolve','Two extract');
    await db.query('update scout.trackers set id=$1 where url=$2',[r.tracker_id,'https://www.dosi-project.org/biodiversity-beyond-national-jurisdiction-bbnj/']);
    await db.query('insert into scout.evidence(id,tracker_id,url,content_hash,content,parsed,last_seen_at) values($1,$2,$3,$4,$5,$6,$7)',
      [s.id,r.tracker_id,s.url,s.content_hash,s.content,JSON.stringify(s.parsed),s.last_seen_at]);
    await db.query('insert into scout.collection_runs(id,tracker_id,started_at,finished_at,outcome,stats,report) values($1,$2,$3,$4,$5,$6,$7)',
      [r.id,r.tracker_id,r.started_at,r.finished_at,r.outcome,JSON.stringify(r.stats),JSON.stringify(r.report)]);
    const originalRun=(await db.query('select * from scout.collection_runs where id=$1',[r.id])).rows[0];
    const old=r.report.artifacts.a12.data.candidates.find(c=>c.id==='442dce02-cdf6-471f-9d91-69fbd3d6e79b');
    await db.query('insert into scout.records(id,'+CONTENT_FIELDS.join(',')+',priority) values('+Array.from({length:CONTENT_FIELDS.length+2},(_,i)=>'$'+(i+1)).join(',')+')',
      [old.id,...CONTENT_FIELDS.map(k=>old[k]??null),old.priority]);
    const originalRecord=(await db.query('select * from scout.records where id=$1',[old.id])).rows[0];
    const run=(await db.query('insert into scout.collection_runs(tracker_id) values($1) returning id',[r.tracker_id])).rows[0].id;
    const trace=await startReport(db,run),deadline=Date.now()+100000;
    const source=(await db.query('select * from scout.evidence where id=$1',[s.id])).rows[0];
    const prepared=await supportDocuments(db,{source,prepared:s.parsed.document.prepared_versions['dosi-documents-v2'],trace});
    assert.equal(DOCUMENT_VERSION+'/'+prepared.version+'/'+prepared.context,version);
    for(const key of ['a16','a23'])assert.throws(()=>validateResolution(r.report.artifacts[key].data.response,failed.finding,r.report.artifacts.a12.data.candidates,prepared),/Unsupported\/conflicting factual evidence/);
    let scienceCalls=0,remaining=mode==='retained'?1:Infinity;
    const transport=runModel(db,input=>{
      assert.equal(input.stage,'resolve','Extraction must never reopen');
      if(input.finding.anchor===failed.finding.anchor){
        assert.equal(mode,'fresh','Retained exhausted finding must not run');scienceCalls++;
        return r.report.artifacts[scienceCalls===1?'a16':'a23'].data.response;
      }
      assert.notEqual(input.finding.anchor,prior.findings[0].finding.anchor,'Existing uncertain resolution remains retained');
      return input.finding.anchor===next.finding.anchor?{...resolve(input),outcome:'new',record_id:null}:
        {...resolve(input),outcome:'uncertain',record_id:null,reason:'Injected unresolved identity; no speculative save.'};
    });
    const model=transport.makeModel(run,deadline,trace);
    const options={source,prepared,trace,deadline,model:async(...args)=>{
      if(remaining--<=0)throw new Error('Model quota reached');
      await db.query("update scout.collection_runs set stats=jsonb_set(stats,'{model_attempts}',(select jsonb_agg(a||jsonb_build_object('at',(a->>'at')::timestamptz-interval '61 seconds')) from jsonb_array_elements(stats->'model_attempts') a)) where id=$1 and jsonb_array_length(coalesce(stats->'model_attempts','[]'))>0",[run]);
      return model(...args);
    }},result=await processDocument(db,options);
    assert.equal(result.state,'failed');
    if(mode==='retained'){
      assert.equal(result.created,1);assert.equal(transport.requests.length,1);assert.match(result.error,/quota/);
      options.source=(await db.query('select * from scout.evidence where id=$1',[s.id])).rows[0];
      const partial=options.source.parsed.document.processing_versions[version];assert.equal(partial.exhausted,undefined);
      assert.equal(partial.findings[1].exhausted,true);assert.ok(partial.findings[2].record_id);assert.equal(partial.findings[3].resolution,undefined);
      remaining=Infinity;const resumed=await processDocument(db,options);assert.equal(resumed.state,'failed');assert.equal(resumed.created,0);
    }
    const document=(await db.query('select parsed from scout.evidence where id=$1',[s.id])).rows[0].parsed.document,state=document.processing_versions[version];
    assert.equal(document.processing.version,version);
    if(!['retained','fresh'].includes(mode)){
      assert.equal(transport.requests.length,0);assert.equal(result.created,0);assert.equal(state.exhausted,true);assert.equal(state.findings[1].exhausted,undefined);
    }else{
      assert.equal(result.created,1,result.error);assert.equal(transport.requests.length,mode==='fresh'?7:5);assert.equal(scienceCalls,mode==='fresh'?2:0);
      assert.equal(state.exhausted,true);assert.equal(state.cursor,prior.cursor);assert.equal(state.findings[1].exhausted,true);assert.equal(state.findings[1].resolution,undefined);
      assert.deepEqual(state.findings[1].pending,{round:3,repair:{rejected:r.report.artifacts.a23.data.response,errors:r.report.artifacts.a24.data.errors}});
      if(mode==='retained')assert.deepEqual(state.findings[1].exhaustion_evidence,{run_id:r.id,artifact_id:'a24'});
      assert.deepEqual(state.findings[0],prior.findings[0]);assert.ok(state.findings.slice(2).every(f=>f.resolution));
      const created=(await db.query('select * from scout.records where id<>$1',[old.id])).rows;assert.equal(created.length,1);assert.equal(created[0].title,next.finding.candidate.title);
      assert.deepEqual((await db.query('select * from scout.records where id=$1',[old.id])).rows[0],originalRecord);
      const request=JSON.parse(transport.requests[0]);assert.match(request.generationConfig.responseJsonSchema.properties.outcome.description,/ANY facts value/);
      assert.match(request.systemInstruction.parts[0].text,/outcome MUST be uncertain/);
      assert.equal((await db.query('select stats from scout.collection_runs where id=$1',[run])).rows[0].stats.model_attempts.length,transport.requests.length);
    }
    options.source=(await db.query('select * from scout.evidence where id=$1',[s.id])).rows[0];
    const before=transport.requests.length,again=await processDocument(db,options);assert.equal(again.state,'failed');assert.equal(transport.requests.length,before);
    assert.deepEqual((await db.query('select * from scout.collection_runs where id=$1',[r.id])).rows[0],originalRun);
    for(const [key,value]of Object.entries(s.parsed.document.processing_versions))if(key!==version)assert.deepEqual(document.processing_versions[key],value);
    assert.deepEqual(document.prepared_versions,s.parsed.document.prepared_versions);
  }finally{await db.close();}}
});

test('DOSI legacy recovery reaches the ordinary bounded acquisition queue without reopening exhausted work',async()=>{
  const f=await fixture('dosi-website.json.gz'),saved=f.retained_resolution_exhaustion;
  const responses=new Map([...f.retained_resume.runs,saved.run].flatMap(r=>Object.values(r.report.artifacts)
    .filter(a=>a.kind==='fetch_response').map(a=>[a.data.url,{...a.data,headers:{'content-type':a.data.url.endsWith('/feed/')?'application/rss+xml':'text/html'}}])));
  for(const mode of ['recoverable','unsupported-history','complete','extract-exhausted','all-findings-exhausted','no-later-finding','old-version']){const db=await database();try{
    const s=structuredClone(saved.source),r=structuredClone(saved.run),version=s.parsed.document.processing.version,prior=s.parsed.document.processing_versions[version];
    if(mode==='unsupported-history')r.report.artifacts.a24.data.errors=['Unrelated rejection'];
    if(mode==='complete')prior.state='complete';
    if(mode==='extract-exhausted')prior.error=prior.error.replace('Two resolve','Two extract');
    if(mode==='all-findings-exhausted')for(const entry of prior.findings)if(!entry.resolution)entry.exhausted=true;
    if(mode==='no-later-finding')for(const entry of prior.findings.slice(2))entry.exhausted=true;
    if(mode==='old-version')s.parsed.document.processing.version=version.replace(DOCUMENT_VERSION,'announcement-events-old');
    await db.query('update scout.trackers set id=$1 where url=$2',[r.tracker_id,f.home.url]);
    const tracker=(await db.query('select * from scout.trackers where id=$1',[r.tracker_id])).rows[0];
    await db.query('insert into scout.evidence(id,tracker_id,url,content_hash,content,parsed,last_seen_at) values($1,$2,$3,$4,$5,$6,$7)',
      [s.id,tracker.id,s.url,s.content_hash,s.content,JSON.stringify(s.parsed),s.last_seen_at]);
    await db.query('insert into scout.collection_runs(id,tracker_id,started_at,finished_at,outcome,stats,report) values($1,$2,$3,$4,$5,$6,$7)',
      [r.id,tracker.id,r.started_at,r.finished_at,r.outcome,JSON.stringify(r.stats),JSON.stringify(r.report)]);
    // Rotate through retained responses that fill all four slots before the known October 1 newsletter unless repair priority admits it.
    const acquisition=structuredClone(r.stats.document_source);acquisition.progress.after_url='https://www.dosi-project.org/dosi-deep-sea-round-up-108/';
    await db.query('insert into scout.collection_runs(tracker_id,stats) values($1,$2)',[tracker.id,JSON.stringify({document_source:acquisition})]);
    const originalRun=(await db.query('select * from scout.collection_runs where id=$1',[r.id])).rows[0],reads=[];
    const transport=runModel(db,input=>{
      assert.equal(mode,'recoverable');assert.equal(input.source_id,s.id);assert.equal(input.stage,'resolve','No newsletter extraction replay');
      assert.deepEqual(input.finding,prior.findings[2].finding,'The exhausted science finding must receive zero attempts');
      return {...resolve(input),outcome:'new',record_id:null};
    });
    let pending;
    const result=await collectDocuments(db,{tracker,sourceURL,now:()=>new Date().toISOString(),deadline:Date.now()+100000,
      limits:{seconds:100,requests:8,pages:10,bytes:2_000_000},process:true,path:'dosi',
      retrieve:async options=>{pending=options.pending;return retrieveDosiDocuments(options);},
      read:async url=>{reads.push(url);assert.ok(responses.has(url),url);return responses.get(url);},
      makeModel:(...args)=>{const model=transport.makeModel(...args);return async(...call)=>{
        if(call[1][0].source_id!==s.id||transport.requests.length)throw new Error('Model quota reached');
        return model(...call);
      };}});
    const admitted=['recoverable','unsupported-history'].includes(mode);
    assert.equal(pending.some(p=>p.url===s.url&&p.state==='model-repair'),admitted,mode);
    assert.equal(reads.includes(s.url),admitted,mode);if(admitted)assert.deepEqual(reads.slice(0,3),[f.home.url,f.feed.url,s.url]);
    assert.equal(result.documents,4,JSON.stringify({mode,reads,warnings:result.warnings}));assert.equal(reads.length,5);assert.equal(result.requests,5);
    assert.equal(transport.requests.length,mode==='recoverable'?1:0);assert.equal(result.created,mode==='recoverable'?1:0);
    const document=(await db.query('select parsed from scout.evidence where id=$1',[s.id])).rows[0].parsed.document,state=document.processing_versions[version];
    if(mode==='recoverable'){
      assert.equal(state.exhausted,undefined);assert.equal(state.cursor,prior.cursor);assert.equal(state.findings[1].exhausted,true);
      assert.deepEqual(state.findings[1].pending,{round:3,repair:{rejected:r.report.artifacts.a23.data.response,errors:r.report.artifacts.a24.data.errors}});
      assert.deepEqual(state.findings[1].exhaustion_evidence,{run_id:r.id,artifact_id:'a24'});
      assert.ok(state.findings[2].record_id);assert.equal(state.findings[3].resolution,undefined);
      assert.equal((await db.query('select stats from scout.collection_runs where id=$1',[result.run_id])).rows[0].stats.model_attempts.length,1);
    }else assert.deepEqual(state,{...prior,revision:prior.revision+(mode==='unsupported-history'?1:0)});
    assert.deepEqual((await db.query('select * from scout.collection_runs where id=$1',[r.id])).rows[0],originalRun);
    assert.deepEqual((await db.query('select * from scout.trackers where id=$1',[tracker.id])).rows[0],tracker);
    assert.deepEqual(document.prepared_versions,s.parsed.document.prepared_versions);
  }finally{await db.close();}}
});

test('actual Harvest HTML offset changes preserve completed, pending and exhausted progress without discarding provenance',async()=>{
  const {offset_churn:{sources,records}}=await fixture('harvest-website.json.gz');
  const prepared=sources.map(s=>s.parsed.document.prepared_versions['octo-documents-v6']);
  assert.equal(prepared[0].text,prepared[1].text);assert.notDeepEqual(prepared[0],prepared[1]);
  for(const mode of ['complete','pending','exhausted']){const db=await database();try{
    const tracker=(await db.query('select * from scout.trackers where url=$1',[HARVEST])).rows[0];
    for(const r of records)await db.query('insert into scout.records('+Object.keys(r).join(',')+') values('+Object.keys(r).map((_,i)=>'$'+(i+1)).join(',')+')',
      Object.values(r).map(v=>v&&typeof v==='object'?JSON.stringify(v):v));
    const recordBefore=(await db.query('select * from scout.records order by id')).rows;
    const first=structuredClone(sources[0]),version=first.parsed.document.processing.version;
    if(mode!=='complete')first.parsed.document.processing_versions[version]={state:'failed',cursor:0,findings:[],revision:0,
      ...mode==='exhausted'?{exhausted:true,error:'Two extract repair attempts exhausted: injected retained rejection'}:
        {pending:{round:1,input:packDocument(first,prepared[0],0,DOCUMENT_VERSION),repair:{rejected:'Injected retained rejection',errors:['Invalid JSON']}}}};
    for(const s of mode==='complete'?[first,sources[1]]:[first])await db.query('insert into scout.evidence(id,tracker_id,url,content_hash,content,parsed,last_seen_at) values($1,$2,$3,$4,$5,$6,$7)',
      [s.id,tracker.id,s.url,s.content_hash,s.content,JSON.stringify(s.parsed),s.last_seen_at]);
    const inputs=[];let item={id:first.parsed.document.id,identity:first.parsed.document.identity,url:first.url,raw:sources[1].content,prepared:prepared[1]};
    const options={tracker,sourceURL,now:()=>new Date().toISOString(),deadline:Date.now()+100000,limits:{seconds:100,requests:4,pages:4},process:true,path:'harvest',
      retrieve:async()=>({documents:[item],coverage:[]}),model:async(_,supplied)=>{inputs.push(supplied[0]);return answer([]);}};
    const result=await collectDocuments(db,options);assert.equal(inputs.length,mode==='pending'?1:0,result.warnings.join(';'));
    assert.equal(result.processed,mode==='exhausted'?0:1);
    const latest=(await db.query('select * from scout.evidence where record_id is null order by last_seen_at desc,id limit 1')).rows[0];
    assert.equal(latest.parsed.document.processing.version,version);assert.equal(latest.content,sources[1].content);
    assert.deepEqual(latest.parsed.document.prepared_versions['octo-documents-v6'],prepared[1]);
    if(mode==='pending')assert.deepEqual(inputs[0],{...first.parsed.document.processing_versions[version].pending.input,source_id:latest.id,
      repair:first.parsed.document.processing_versions[version].pending.repair});
    if(mode==='exhausted')assert.equal(latest.parsed.document.processing_versions[version].exhausted,true);
    const repeat=await collectDocuments(db,options);assert.equal(inputs.length,mode==='pending'?1:0);assert.equal(repeat.processed,mode==='exhausted'?0:1);
    assert.deepEqual((await db.query('select * from scout.records order by id')).rows,recordBefore);
    assert.deepEqual((await db.query('select parsed from scout.evidence where id=$1',[first.id])).rows[0].parsed,first.parsed);
    if(mode==='complete'){
      assert.deepEqual(latest.parsed.document.processing_versions[sources[1].parsed.document.processing.version],sources[1].parsed.document.processing_versions[sources[1].parsed.document.processing.version]);
      for(const [index,change]of [
        p=>p.links[0].target+='?meaningful-change',p=>p.links[0].context+='Changed activity',p=>p.links.reverse(),
        p=>p.blocks[0].start++,p=>p.blocks[1].headings=[],p=>p.chunks[0].end--,p=>p.omissions[0].reason+=' Changed omission'
      ].entries()){
        item={...item,raw:'<!-- context '+index+' -->'+sources[1].content,prepared:structuredClone(prepared[1])};change(item.prepared);
        await collectDocuments(db,options);assert.equal(inputs.length,index+1,'Semantic context/ranges/order must remain exact');
      }
      item={...item,raw:sources[0].content,prepared:prepared[0]};await collectDocuments(db,options);assert.equal(inputs.length,8,'A → B → old A cannot reuse stale completion');
      item={...item,raw:sources[1].content,prepared:prepared[1]};await collectDocuments(db,options);assert.equal(inputs.length,8,'Equivalent current A reuses current completion');
    }
  }finally{await db.close();}}
});

test('same source identity with changed URL, factual context or omissions must not reuse completed processing',async()=>{
  const db=await database();try{
    const tracker=(await db.query('select * from scout.trackers limit 1')).rows[0];let calls=0;
    const original=prepareDocument({title:'Source',url:'https://example.org/source',html:'<p>Public gathering.</p>'});
    const item={id:'source',identity:'test:source',url:original.url,raw:'original',prepared:original};
    const options={tracker,sourceURL,now:()=>new Date().toISOString(),since:Date.now()-86400000,deadline:Date.now()+100000,
      limits:{seconds:100,requests:4,pages:4},process:true,path:'test',model:async()=>{calls++;return answer([]);},retrieve:async()=>({documents:[item],coverage:[]})};
    await collectDocuments(db,options);assert.equal(calls,1);
    for(const [key,value] of [['url','https://example.org/different-source'],['title','Changed factual context'],['omissions',[{reason:'Malformed JSON-LD could not be prepared; raw response retained.'}]]]){
      item.prepared={...original,[key]:value};item.raw=key;
      await collectDocuments(db,options);assert.equal(calls,['url','title','omissions'].indexOf(key)+2,key);
    }
    item.prepared=original;item.raw='original';await collectDocuments(db,options);
    assert.equal(calls,5,'Returning to earlier content after a real change is reassessed');
    item.raw='equivalent A2';await collectDocuments(db,options);assert.equal(calls,5);
    item.prepared={...original,title:'Different context B'};item.raw='B';await collectDocuments(db,options);assert.equal(calls,6);
    item.prepared=original;item.raw='original';
    let attempts=0;options.model=async()=>{calls++;if(attempts++===0)throw Object.assign(new Error('Invalid JSON'),{rejected:'retained new-epoch failure'});throw new Error('Model quota reached');};
    await collectDocuments(db,options);assert.equal(calls,8);
    const failed=(await db.query("select parsed#>array['document','processing_versions',parsed#>>'{document,processing,version}'] progress from scout.evidence where content='original'")).rows[0].progress;
    assert.equal(failed.state,'failed');assert.equal(failed.pending.round,1);
    item.raw='equivalent A3';const after=await collectDocuments(db,options);
    assert.equal(calls,9);assert.equal(after.processed,0,'Earlier A2 completion cannot cross the intervening B context');
    const latest=(await db.query("select parsed#>array['document','processing_versions',parsed#>>'{document,processing,version}'] progress from scout.evidence where content='equivalent A3'")).rows[0].progress;
    assert.equal(latest.pending.round,1);assert.deepEqual(latest.pending.repair,failed.pending.repair);assert.equal(latest.state,'failed');
    item.raw='equivalent A2';const revisited=await collectDocuments(db,options);
    assert.equal(revisited.processed,0,'Reobserving old A2 must not make its stale completion appear current');assert.equal(calls,10);
  }finally{await db.close();}
});

test('HSA processing saves a stated event or no event without following links; repeat adds no calls or duplicate writes',async context=>{
  const webinar=await fixture('hsa-webinar-time.json'),saved=await fixture('hsa-author-pinned.json.gz');
  const nonEvent=JSON.parse(saved.response.body).feed.find(i=>i.post.uri.endsWith('/3mtyfj3wpdx2g'));
  assert.ok(nonEvent.post.record.text.startsWith('The albatross:'));
  for(const [item,isEvent]of [[webinar,true],[nonEvent,false]]){
    const db=await database();try{
      const tracker=(await db.query('select * from scout.trackers where url=$1',['https://bsky.app/profile/'+HSA])).rows[0];
      const fetched=[];
      const transport=runModel(db,input=>{
        if(input.stage==='resolve')return resolve(input);
        assert.deepEqual(Object.keys(input.documents),['P']);
        if(!isEvent)return answer([]);
        const finding=base('Let’s Talk BBNJ',[{doc:'P',quote:item.post.record.text.split('\n')[0]}]);
        finding.candidate.kind='event';return answer([finding]);
      });
      const options={trackerId:tracker.id,validate:true,documents:'process',makeModel:transport.makeModel,read:async url=>{
        fetched.push(url);assert.ok(url.startsWith('https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed'));
        return {url,status:200,headers:{'content-type':'application/json'},body:JSON.stringify({feed:[item]})};
      }};
      const run=await collectHSA(db,options);
      assert.equal(run.processed,1,run.warnings.join(';'));assert.equal(run.created,isEvent?1:0);
      const source=(await db.query('select * from scout.evidence where tracker_id=$1 and record_id is null',[tracker.id])).rows[0];
      assert.equal(source.content,JSON.stringify(item));assert.equal(fetched.length,1);assert.equal(run.requests,1);
      const rows=(await db.query('select * from scout.records')).rows;
      assert.equal(rows.length,isEvent?1:0);
      if(isEvent)for(const field of ['starts_at','ends_at','organization','location'])assert.equal(rows[0][field],null);
      const before=transport.requests.length;assert.equal(before,isEvent?2:1);
      const repeat=await collectHSA(db,options);
      assert.equal(repeat.processed,1);assert.equal(fetched.length,2);assert.equal(repeat.requests,1);
      assert.equal(transport.requests.length,before);assert.deepEqual((await db.query('select * from scout.records')).rows,rows);
      const detail=(await db.query('select stats,report from scout.collection_runs where id=$1',[run.run_id])).rows[0];
      assert.equal(detail.stats.model_attempts.length,before);
      assert.equal(detail.report.path,'author-records');
      const coverage=Object.values(detail.report.artifacts).find(a=>a.kind==='support_coverage').data;
      assert.deepEqual(coverage.documents.map(d=>d.id),['P']);assert.ok(coverage.links.length>0);
      assert.ok(coverage.links.every(l=>l.state==='unfetched'));
      assert.ok(Object.values(detail.report.artifacts).some(a=>a.kind==='model_request'));
      assert.ok(!JSON.stringify(detail.report).includes('fixture-test-key'));
      context.diagnostic(JSON.stringify({source:isEvent?'HSA webinar':'HSA non-event',request_bytes:transport.requests.map(b=>Buffer.byteLength(b)),repeat_calls:transport.requests.length-before}));
    }finally{await db.close();}
  }
});

test('retained resolver inputs compile field-specific audit claims and optional comparisons without changing findings',async context=>{
  for(const actual of (await fixture('iucn-website.json.gz')).field_audit){const db=await database();try{
    const original=JSON.stringify(actual),{input,source:s}=actual,tracker=(await db.query('select id from scout.trackers limit 1')).rows[0];
    validateFinding(input.finding,packDocument(s,s.prepared,0,DOCUMENT_VERSION));
    const version=input.version,state={state:'pending',revision:0,cursor:s.prepared.text.length,findings:[{key:'retained',finding:input.finding}]};
    const source=(await db.query('insert into scout.evidence(id,tracker_id,url,content_hash,content,parsed) values($1,$2,$3,$4,$5,$6) returning *',
      [s.id,tracker.id,s.url,s.content_hash,s.prepared.text,JSON.stringify({document:{identity:'retained-field-audit:'+actual.name,processing_versions:{[version]:state}}})])).rows[0];
    const run=(await db.query('insert into scout.collection_runs(tracker_id) values($1) returning id',[tracker.id])).rows[0].id,trace=await startReport(db,run);
    const prepared=await supportDocuments(db,{source,prepared:s.prepared,trace,context:version.split('/').at(-1)});
    const transport=runModel(db,p=>({...resolve(p),outcome:'uncertain',record_id:null,reason:'Injected identity uncertainty; this check proves request construction only.'}));
    const result=await processDocument(db,{source,prepared,trace,deadline:Date.now()+100000,model:transport.makeModel(run,Date.now()+100000,trace)});
    assert.equal(result.state,'uncertain');assert.equal(transport.requests.length,1);assert.equal(result.created,0);
    const request=JSON.parse(transport.requests[0]),sent=JSON.parse(request.contents[0].parts[0].text)[0],before=JSON.parse(actual.baseline_request);
    assert.deepEqual(sent.finding,input.finding);assert.deepEqual(sent.field_audit.event,{anchor:input.finding.anchor,title:input.finding.candidate.title});
    const fields=[...CONTENT_FIELDS,'priority'].filter(k=>(k==='priority'?input.finding.priority:input.finding.candidate[k])!==null);
    assert.deepEqual(Object.keys(sent.field_audit.fields),fields);
    for(const key of fields){
      assert.deepEqual(sent.field_audit.fields[key],{claim:key==='priority'?{value:input.finding.priority,reason:input.finding.reason}:input.finding.candidate[key],
        quotes:input.finding.evidence[key].map(i=>input.finding.citations[i].quote)});
    }
    assert.equal(Object.hasOwn(sent.field_audit,'candidates'),false);
    const schema=request.generationConfig.responseJsonSchema,unbounded=structuredClone(schema);
    for(const [key,proof]of Object.entries(unbounded.properties.evidence.properties)){
      assert.deepEqual(proof.items,{type:'integer',minimum:0,maximum:input.finding.citations.length-1});delete proof.items.maximum;
      for(const i of [-1,input.finding.citations.length])assert.throws(()=>validateResolution(
        {...resolve(input),outcome:'uncertain',record_id:null,evidence:{[key]:[i]}},input.finding,input.candidates,prepared),/Resolution evidence/);
    }
    assert.equal(schema.required.includes('comparisons'),false);
    assert.deepEqual(schema.properties.comparisons.items.properties.citations.items,{type:'integer',minimum:0,maximum:input.finding.citations.length-1});
    assert.deepEqual(schema.properties.comparisons.items.required,['record_id','relation','citations','reason']);
    delete unbounded.properties.comparisons;
    assert.deepEqual(unbounded,before.generationConfig.responseJsonSchema);
    assert.match(request.systemInstruction.parts[0].text,/using ONLY its own quotes/);
    const compiled=requestBody(request.systemInstruction.parts[0].text,[{...input,field_audit:sent.field_audit}],schema);
    const after=JSON.parse(compiled);after.generationConfig.responseJsonSchema=unbounded;
    assert.deepEqual({...after,contents:before.contents,systemInstruction:before.systemInstruction},before);
    if(actual.name==='GFW conversation'){
      assert.equal(sent.field_audit.fields.description.claim,sent.field_audit.fields.description.quotes[0]);
      assert.match(sent.field_audit.fields.priority.quotes[0],/AI can reveal hidden activity at sea, support enforcement/);
    }else{
      assert.equal(sent.field_audit.fields.description.quotes.length,1);assert.equal(sent.field_audit.fields.priority.quotes.length,1);
      if(actual.name==='Unguja')assert.match(sent.field_audit.fields.status.quotes[0],/have launched/);
    }
    assert.equal(JSON.stringify(actual),original);
    const report=(await db.query('select report from scout.collection_runs where id=$1',[run])).rows[0].report;
    assert.deepEqual(Object.values(report.artifacts).find(a=>a.kind==='retrieval').data.finding,input.finding);
    context.diagnostic(JSON.stringify({case:actual.name,before_bytes:Buffer.byteLength(actual.baseline_request),after_bytes:Buffer.byteLength(compiled),semantic_validation:false}));
  }finally{await db.close();}}
});

test('exact HSA failures report every missing proof and date error; a new contract retries once without erasing history',async context=>{
  const saved=(await fixture('hsa-social-preparation.json.gz')).announcement_contract;
  const outputs=saved.responses.map(raw=>JSON.parse(JSON.parse(raw).candidates[0].content.parts.find(p=>p.text).text));
  const input=JSON.parse(JSON.parse(saved.requests[0]).contents[0].parts[0].text)[0];
  const repairBytes=[];
  for(const actual of (await fixture('iddri-website.json.gz')).field_proof_v74){
    const request=JSON.parse(actual.request),supplied=JSON.parse(request.contents[0].parts[0].text)[0];
    const rejected=JSON.parse(JSON.parse(actual.response).candidates[0].content.parts.find(p=>p.text).text),original=JSON.stringify(rejected);
    assert.deepEqual(rejected,actual.extracted.response);
    const old=request.generationConfig.responseJsonSchema.properties.findings.items.properties.evidence;
    assert.deepEqual(old.required,['kind','title','priority']);assert.equal(old.properties.priority.minItems,undefined);
    for(const [index,p] of rejected.findings.entries()){
      const expected=actual.request_artifact==='a15'?/citations\[0\]/:index===1?/anchor must be/:/Missing field evidence: description, location.*Invalid evidence for priority/;
      assert.throws(()=>validateFinding(p,supplied),expected);
    }
    assert.equal(JSON.stringify(rejected),original,'Actual IDDRI replies remain unchanged and rejected');
    const body=requestBody(DOCUMENT_INSTRUCTION,[supplied],DOCUMENT_SCHEMA);
    assert.deepEqual(JSON.parse(JSON.parse(body).contents[0].parts[0].text),[supplied]);
    context.diagnostic(JSON.stringify({source:'IDDRI actual v74 '+actual.request_artifact,previous_bytes:Buffer.byteLength(actual.request),request_bytes:Buffer.byteLength(body)}));
  }
  for(const actual of saved.octo_url_dates){
    const supplied=JSON.parse(JSON.parse(actual.request).contents[0].parts[0].text)[0];
    const rejected=JSON.parse(JSON.parse(actual.response).candidates[0].content.parts.find(p=>p.text).text);
    assert.throws(()=>validateFinding(rejected.findings[0],supplied),/cite the exact supplied HTTPS URL, not its title, or use null/);
  }
  for(const actual of saved.explicit_proof){
    const input=JSON.parse(JSON.parse(actual.request).contents[0].parts[0].text)[0];
    const rejected=JSON.parse(JSON.parse(actual.response).candidates[0].content.parts.find(p=>p.text).text);
    let message;assert.throws(()=>validateFinding(rejected.findings[0],input),error=>{message=error.message;return /Missing field evidence/.test(message);});
    const body=requestBody(DOCUMENT_INSTRUCTION,[{...input,repair:{rejected,errors:['finding 0: '+message]}}],DOCUMENT_SCHEMA);
    assert.deepEqual(JSON.parse(JSON.parse(body).contents[0].parts[0].text)[0].repair.rejected,rejected);
    context.diagnostic(JSON.stringify({source:actual.source+' exact v67 rejection',repair_bytes:Buffer.byteLength(body)}));
  }
  for(const raw of saved.nested_proof.responses){
    const rejected=JSON.parse(JSON.parse(raw).candidates[0].content.parts.find(p=>p.text).text),original=JSON.stringify(rejected);
    let message;assert.throws(()=>validateFinding(rejected.findings[0],input),error=>{message=error.message;return /Invalid evidence for kind, title/.test(message);});
    const body=requestBody(DOCUMENT_INSTRUCTION,[{...input,repair:{rejected,errors:['finding 0: '+message]}}],DOCUMENT_SCHEMA);
    repairBytes.push(Buffer.byteLength(body));assert.deepEqual(JSON.parse(JSON.parse(body).contents[0].parts[0].text)[0].repair.rejected,rejected);
    assert.equal(JSON.stringify(rejected),original,'Real failed output must remain intact');
  }
  context.diagnostic(JSON.stringify({source:'HSA exact empty proofs',repair_bytes:repairBytes}));
  for(const [i,response]of outputs.entries()){
    const original=JSON.stringify(response);
    assert.throws(()=>validateFinding(response.findings[0],input),error=>{
      assert.match(error.message,/Missing field evidence: kind, title, description, location, priority/);
      for(const field of ['starts_at','ends_at'])assert.ok(error.message.includes(field+': explicit cited year/date/clock/zone'));
      assert.match(error.message,/if absent use null/);
      if(i===2)for(const field of ['kind','title'])assert.ok(error.message.includes('evidence.candidate.'+field));
      return true;
    });
    assert.equal(JSON.stringify(response),original,'Validation must not rewrite real output');
  }
  const db=await database();try{
    const tracker=(await db.query('select * from scout.trackers where url=$1',['https://bsky.app/profile/'+HSA])).rows[0];
    const options={trackerId:tracker.id,validate:true,read:async url=>{
      assert.ok(url.startsWith('https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed'));
      return {url,status:200,headers:{'content-type':'application/json'},body:JSON.stringify({feed:[JSON.parse(saved.source.content)]})};
    }};
    const observed=await collectHSA(db,{...options,documents:true});
    const source=(await db.query('select * from scout.evidence where tracker_id=$1',[tracker.id])).rows[0];
    await db.query("update scout.evidence set parsed=jsonb_set(parsed,'{document,processing_versions}',$2::jsonb) where id=$1",
      [source.id,JSON.stringify({[saved.previous.version]:saved.previous.state})]);
    const oldStats={model_attempts:[{at:new Date(Date.now()-61000).toISOString(),input_bound:5099,output_bound:1024,model:'gemini-3.5-flash-lite'}]};
    await db.query('update scout.collection_runs set stats=$2::jsonb where id=$1',[observed.run_id,JSON.stringify(oldStats)]);
    let calls=0;
    const transport=runModel(db,supplied=>{
      assert.equal(supplied.stage,'extract');assert.ok(calls<outputs.length);
      if(calls){
        assert.deepEqual(supplied.repair.rejected,outputs[calls-1]);
        assert.match(supplied.repair.errors.join(';'),/Missing field evidence: kind, title, description, location, priority/);
        for(const field of ['starts_at','ends_at'])assert.ok(supplied.repair.errors.join(';').includes(field+': explicit cited year/date/clock/zone'));
      }
      return structuredClone(outputs[calls++]);
    });
    options.documents='process';options.makeModel=transport.makeModel;
    const first=await collectHSA(db,options);assert.equal(first.created,0);assert.equal(calls,2);assert.match(first.warnings.join(';'),/quota/);
    // Move only this isolated test's new reservations out of the minute window.
    await db.query("update scout.collection_runs set stats=jsonb_set(stats,'{model_attempts}',(select jsonb_agg(a||jsonb_build_object('at',(a->>'at')::timestamptz-interval '61 seconds')) from jsonb_array_elements(stats->'model_attempts') a)) where id=$1",[first.run_id]);
    const resumed=await collectHSA(db,options);assert.equal(resumed.created,0);assert.equal(calls,3);
    assert.match(resumed.warnings.join(';'),/Two extract repair attempts exhausted/);
    const repeated=await collectHSA(db,options);assert.equal(repeated.created,0);assert.equal(calls,3);
    assert.match(repeated.warnings.join(';'),/Two extract repair attempts exhausted/);
    const versions=(await db.query('select parsed from scout.evidence where id=$1',[source.id])).rows[0].parsed.document.processing_versions;
    assert.deepEqual(versions[saved.previous.version],saved.previous.state);
    assert.ok(Object.entries(versions).some(([key,state])=>key.startsWith(DOCUMENT_VERSION+'/')&&state.exhausted));
    assert.deepEqual((await db.query('select stats from scout.collection_runs where id=$1',[observed.run_id])).rows[0].stats,oldStats);
    const ledger=(await db.query('select stats from scout.collection_runs where id=any($1::uuid[])',[[first.run_id,resumed.run_id,repeated.run_id]])).rows;
    assert.equal(ledger.reduce((sum,r)=>sum+(r.stats.model_attempts?.length??0),0),3);
    assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,0);
    for(const body of transport.requests){
      const schema=JSON.parse(body).generationConfig.responseJsonSchema,evidence=schema.properties.findings.items.properties.evidence;
      assert.equal(evidence.additionalProperties,false);assert.deepEqual(evidence.required,['kind','title','priority']);
      assert.equal(evidence.properties['candidate.kind'],undefined);
      for(const field of [...CONTENT_FIELDS,'priority','identity','distinction','change'])assert.deepEqual(evidence.properties[field],{type:'array',minItems:1,items:{type:'integer',minimum:0}});
      assert.match(evidence.description,/EVERY non-null candidate field and priority/);
      assert.equal(schema.properties.findings.maxItems,undefined);
      assert.ok(!JSON.stringify(schema).includes('$ref'));assert.equal(schema.$defs,undefined);
      const properties=schema.properties.findings.items.properties;
      assert.equal(properties.citations.minItems,1);
      for(const field of ['starts_at','ends_at'])assert.equal(properties.dates.properties[field].properties.parts.properties.zone.minItems,1);
      assert.equal(properties.dates.additionalProperties,false);
      assert.deepEqual(properties.candidate.properties.status.enum,['scheduled','rescheduled','cancelled',null]);
    }
    context.diagnostic(JSON.stringify({source:'HSA exact invalid outputs',previous_bytes:saved.requests.map(b=>Buffer.byteLength(b)),request_bytes:transport.requests.map(b=>Buffer.byteLength(b)),repeat_calls:0,records:0}));
  }finally{await db.close();}
});
