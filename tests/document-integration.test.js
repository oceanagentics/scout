import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {PGlite} from '@electric-sql/pglite';
import {collectHSA,HSA,GFW_WEB,sourceURL} from '../collector/hsa.js';
import {gemini,requestBody} from '../collector/model.js';
import {CONTENT_FIELDS} from '../collector/assessment.js';
import {collectDocuments,prepareDocument,supportDocuments} from '../collector/octo-documents.js';
import {prepareDosiDocument} from '../collector/dosi-documents.js';
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
    evidence:{distinction:[0]},facts:{kind:'supported',title:'supported',priority:'supported'},conflict:'none'};
  assert.equal(validateResolution(review,findings[1],[existing],prepared).outcome,'new');
  assert.throws(()=>validateResolution(review,findings[0],[existing],prepared),/distinct cited label/);
  assert.throws(()=>validateResolution({...review,facts:{...review.facts,title:'unsupported'}},findings[1],[],prepared),/Unsupported\/conflicting/);
  const rejectedKind={...review,facts:{...review.facts,kind:'unsupported'}};
  assert.throws(()=>validateResolution(rejectedKind,findings[1],[],prepared),/Unsupported\/conflicting/);
  assert.equal(validateResolution({...rejectedKind,outcome:'uncertain'},findings[1],[],prepared).outcome,'uncertain');
  const actual=(await fixture('hsa-social-preparation.json.gz')).announcement_contract.distinction_failure;
  const {finding,candidates}=actual.input;
  assert.ok(finding.anchor.endsWith('.'));assert.ok(!finding.citations[0].quote.endsWith('.'));
  assert.equal(validateResolution(actual.response,finding,candidates,prepared).outcome,'new');
  for(const label of [finding.anchor,finding.anchor.slice(0,-1)]){
    const duplicate={...candidates[0],title:label,anchors:[label]};
    assert.throws(()=>validateResolution(actual.response,finding,[duplicate],prepared),/distinct cited label/);
  }
  const mpa=(await fixture('hsa-social-preparation.json.gz')).announcement_contract.mpa_distinction_failure;
  const supplied=JSON.parse(JSON.parse(mpa.request).contents[0].parts[0].text)[0];
  const decision=JSON.parse(JSON.parse(mpa.response).candidates[0].content.parts.find(p=>p.text).text),p=supplied.finding;
  const before=JSON.stringify(supplied);assert.equal(validateResolution(decision,p,supplied.candidates,prepared).outcome,'new');
  assert.equal(JSON.stringify(supplied),before,'Retained presenter anchor, finding and progress are not rewritten');
  for(const label of [p.candidate.title,p.candidate.title+'.',p.anchor]){
    const duplicate={...supplied.candidates[0],title:label,anchors:[label]};
    assert.throws(()=>validateResolution(decision,p,[duplicate],prepared),/distinct cited label/);
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
      if(input.stage==='resolve')return {...resolve(input),outcome:'new',record_id:null};
      if(input.documents.P.url!==saved.newsletter.url)return answer([]);
      newsletter=input;assert.equal(input.range[0],0);assert.equal(input.segments.length,1);
      assert.equal(input.range[1],39565);assert.deepEqual(input.omitted_ranges,[]);
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
    const options={trackerId:tracker.id,validate:true,documents:'process',makeModel:transport.makeModel,read:async url=>{
      reads.push(url);if(url===saved.feed.url)return saved.feed;
      const s=retained.get(url);if(!s)throw new Error('Fixture intentionally lacks other articles');
      return {url,status:200,headers:{'content-type':'text/html'},body:prefix+s.content};
    }};
    const first=await collectHSA(db,options);
    assert.deepEqual(reads.slice(0,3),[saved.home.url,saved.feed.url,newsletter.url]);
    assert.equal(first.created,1,first.warnings.join(';'));assert.equal(transport.requests.length,2);
    const records=(await db.query('select * from scout.records')).rows;assert.equal(records[0].title,title);assert.equal(records[0].starts_at,null);
    const association=(await db.query('select * from scout.evidence where record_id is not null')).rows[0];
    prefix='<!-- another injected UI framing change -->';
    // Isolate completed-capture rechecks from the deliberately unavailable older articles above.
    const repeat=await collectDocuments(db,{tracker,sourceURL,now:()=>new Date().toISOString(),deadline:Date.now()+100000,
      limits:{seconds:100,requests:4,pages:4},process:true,path:'dosi',makeModel:transport.makeModel,
      retrieve:async()=>({documents:[churn,newsletter].map(s=>prepareDosiDocument({url:s.url,status:200,headers:{'content-type':'text/html'},body:prefix+s.content},{sourceURL})),coverage:[]})});
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
    context.diagnostic(JSON.stringify({retained_repair_round:1,whole_chars:pending.input.range[1],model_calls:2,repeat_calls:0,historical_runs_unchanged:2}));
  }finally{await db.close();}
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

test('exact HSA failures report every missing proof and date error; a new contract retries once without erasing history',async context=>{
  const saved=(await fixture('hsa-social-preparation.json.gz')).announcement_contract;
  const outputs=saved.responses.map(raw=>JSON.parse(JSON.parse(raw).candidates[0].content.parts.find(p=>p.text).text));
  const input=JSON.parse(JSON.parse(saved.requests[0]).contents[0].parts[0].text)[0];
  const repairBytes=[];
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
      for(const field of [...CONTENT_FIELDS,'priority','identity','distinction','change'])assert.deepEqual(evidence.properties[field],{type:'array',items:{type:'integer'}});
      assert.equal(schema.properties.findings.maxItems,undefined);
      assert.ok(!JSON.stringify(schema).includes('$ref'));assert.equal(schema.$defs,undefined);
      const properties=schema.properties.findings.items.properties;
      for(const field of ['starts_at','ends_at'])assert.equal(properties.dates.properties[field].properties.parts.properties.zone.minItems,1);
      assert.equal(properties.dates.additionalProperties,false);
      assert.deepEqual(properties.candidate.properties.status.enum,['scheduled','rescheduled','cancelled',null]);
    }
    context.diagnostic(JSON.stringify({source:'HSA exact invalid outputs',previous_bytes:saved.requests.map(b=>Buffer.byteLength(b)),request_bytes:transport.requests.map(b=>Buffer.byteLength(b)),repeat_calls:0,records:0}));
  }finally{await db.close();}
});
