import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {PGlite} from '@electric-sql/pglite';
import {collectHSA,HSA,GFW_WEB} from '../collector/hsa.js';
import {gemini} from '../collector/model.js';
import {CONTENT_FIELDS} from '../collector/assessment.js';
import {prepareDocument} from '../collector/octo-documents.js';
import {packDocument,validateFinding,validateResolution,DOCUMENT_VERSION} from '../collector/document-records.js';

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

function runModel(db,respond){
  const requests=[];
  const makeModel=(runId,deadline,trace)=>{
    const model=gemini({apiKey:'fixture-test-key',ledger:db,runId,deadline,trace,fetch:async(_url,request)=>{
      requests.push(request.body);assert.ok(Buffer.byteLength(request.body)<=8000);
      const input=JSON.parse(JSON.parse(request.body).contents[0].parts[0].text)[0];
      const out=await respond(input);
      return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(out)}]}}]});
    }});
    return model;
  };
  return {makeModel,requests};
}

const base=(title,citations)=>({anchor:title,urls:[],candidate:{...Object.fromEntries(CONTENT_FIELDS.map(k=>[k,null])),kind:'event',title},
  priority:'normal',reason:'Substantive public source finding.',citations,evidence:Object.fromEntries(['kind','title','priority'].map(k=>[k,{refs:[0],rationale:'Cited source finding.'}])),dates:{}});

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
    dated.evidence.starts_at={refs:[0],rationale:'Assumed year.'};
    dated.dates.starts_at={local:'2026-10-20T16:00:00',zone:'UTC',parts:{year:[],date:[0],time:[0],zone:[0]}};
    assert.throws(()=>validateFinding(dated,input),/year\/date\/clock\/zone/);
  }
});

test('retained GFW event saves before the final range, resumes under quota, and keeps an oversized repair intact',async context=>{
  const saved=await fixture('gfw-live-repair.json.gz'),post=JSON.parse(saved.artifacts.a2.data.body);
  const card=saved.artifacts.a1.data.body.match(/<article id="post-74977"[\s\S]*?<\/article>/)[0];
  const listing='<html><head><link rel="canonical" href="'+GFW_WEB+'"><link rel="https://api.w.org/" href="https://globalfishingwatch.org/wp-json/"></head><body>'+card+'</body></html>';
  for(const rejected of [false,true]){
    const db=await database();try{
      const tracker=(await db.query('select * from scout.trackers where url=$1',[GFW_WEB])).rows[0],reads=[];
      const decision=structuredClone(saved.artifacts.a24.data.response);
      if(!rejected){
        decision.findings[0].evidence=Object.fromEntries(Object.entries(decision.findings[0].evidence).map(([k,v])=>[k.replace(/^candidate\./,''),v]));
        for(const field of ['organization','description']){decision.findings[0].candidate[field]=null;delete decision.findings[0].evidence[field];}
      }
      const transport=runModel(db,input=>input.stage==='resolve'?resolve(input):input.range[0]?answer([]):decision);
      const options={trackerId:tracker.id,validate:true,documents:'process',makeModel:transport.makeModel,read:async url=>{
        reads.push(url);
        assert.ok([GFW_WEB,saved.artifacts.a2.data.url].includes(url),'Incidental link must not be requested: '+url);
        return {url,status:200,headers:{'content-type':url===GFW_WEB?'text/html':'application/json'},body:url===GFW_WEB?listing:saved.artifacts.a2.data.body};
      }};
      const first=await collectHSA(db,options);
      assert.equal(first.processed,0);assert.equal(reads.length,2);assert.equal(first.requests,2);
      const source=(await db.query('select * from scout.evidence where tracker_id=$1 and record_id is null',[tracker.id])).rows[0];
      const state=Object.values(source.parsed.document.processing_versions)[0];
      if(rejected){
        assert.equal(transport.requests.length,1);assert.equal(first.created,0);assert.equal(state.cursor,0);
        assert.deepEqual(state.pending.repair.rejected,saved.artifacts.a24.data.response);
        assert.match(first.warnings.join(';'),/Repair request exceeds 8000 bytes/);
        const repeated=await collectHSA(db,options);
        assert.equal(repeated.processed,0);assert.equal(transport.requests.length,1);
        assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,0);
        context.diagnostic(JSON.stringify({source:'GFW retained rejection',request_bytes:transport.requests.map(b=>Buffer.byteLength(b)),deferred:first.warnings.find(w=>w.includes('Repair request'))}));
      }else{
        assert.equal(first.created,1);assert.equal(transport.requests.length,2);assert.match(first.warnings.join(';'),/quota/);
        const prepared=Object.values(source.parsed.document.prepared_versions)[0];
        assert.ok(state.cursor>0&&state.cursor<prepared.text.length);assert.ok(state.findings[0].record_id);
        const record=(await db.query('select * from scout.records')).rows[0];assert.equal(record.title,decision.findings[0].candidate.title);
        assert.equal(record.starts_at,null);assert.equal(record.organization,null);
        // Simulate the next minute only in this isolated ledger; keep both reservations.
        await db.query("update scout.collection_runs set stats=jsonb_set(stats,'{model_attempts}',(select jsonb_agg(a||jsonb_build_object('at',(a->>'at')::timestamptz-interval '61 seconds')) from jsonb_array_elements(stats->'model_attempts') a)) where id=$1",[first.run_id]);
        const resumed=await collectHSA(db,options);assert.equal(resumed.processed,1,resumed.warnings.join(';'));assert.equal(resumed.created,0);
        assert.equal(transport.requests.length,3);
        const lastInput=JSON.parse(JSON.parse(transport.requests.at(-1)).contents[0].parts[0].text)[0];assert.equal(lastInput.range[0],state.cursor);
        const repeated=await collectHSA(db,options);assert.equal(repeated.processed,1);assert.equal(transport.requests.length,3);
        assert.deepEqual((await db.query('select * from scout.records')).rows,[record]);
        const ledger=(await db.query('select stats from scout.collection_runs where id=any($1::uuid[])',[ [first.run_id,resumed.run_id] ])).rows;
        assert.equal(ledger.reduce((sum,r)=>sum+r.stats.model_attempts.length,0),3);
        context.diagnostic(JSON.stringify({source:'GFW injected event',request_bytes:transport.requests.map(b=>Buffer.byteLength(b)),saved_at_cursor:state.cursor,primary_characters:prepared.text.length}));
      }
      assert.equal(reads.length,rejected?4:6);
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
