import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {PGlite} from '@electric-sql/pglite';
import {collectHSA,UNTC,sourceURL,DOCUMENT_TRACKERS} from '../collector/hsa.js';
import {gemini,MODEL_LIMITS} from '../collector/model.js';
import {CONTENT_FIELDS,PRIORITY_INSTRUCTION} from '../collector/assessment.js';
import {prepareDocument} from '../collector/octo-documents.js';
import {prepareAuthorItem} from '../collector/bluesky-documents.js';
import {packDocument,processDocument,validateFinding as validateCitedFinding,validateResolution,DOCUMENT_VERSION} from '../collector/document-records.js';
import {supportDocuments} from '../collector/octo-documents.js';
import {startReport} from '../collector/report.js';
import {hostedHSA} from '../collector/hosted-hsa.js';
import {stepState} from '../src/runs.js';
import {filterRecords} from '../src/records.js';
import {eligibleRecords,readRecords} from '../notifications/slack.js';

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
  return {facts:Object.fromEntries([...CONTENT_FIELDS.filter(k=>input.finding.candidate[k]!==null),'priority',...['starts_on','ends_on'].filter(k=>input.finding.dates[k])].map(k=>[k,'supported'])),
    ...input.missing_fields?{completion:null,unknowns:Object.fromEntries(input.missing_fields.map(k=>[k,'Fixture source does not establish this same-finding field.']))}:{},
    conflict:out.outcome==='update'?'correction':'none',...out,...input.missing_fields&&out.unknowns?{unknowns:{...Object.fromEntries(input.missing_fields.map(k=>[k,(out.completion??input.finding).dates[k]?.value??(out.completion??input.finding).candidate[k]?null:'Fixture source does not establish this same-finding field.'])),...out.unknowns}}:{},evidence};
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

test('citation grounding tolerates a typographic nonbreaking space without accepting changed source words or dates',()=>{
  const quote='First session will meet on October\u00a021, 2026.',prepared=prepareDocument({title:'First session',url:article.link,html:'<p>'+quote+'</p><p>Ocean Institute</p><p>Marine data standards workshop.</p>'});
  const input=packDocument({id:'typographic-space'},prepared,0,DOCUMENT_VERSION),p=proposal();p.candidate.starts_at=null;delete p.evidence.starts_at;p.evidence.identity=quote.replaceAll('\u00a0',' ');
  const finding=cited(p,input);assert.ok(prepared.text.includes(quote));assert.doesNotThrow(()=>validateCitedFinding(finding,input));
  for(const changed of ['First session will meet on October 22, 2026.','First session might meet on October 21, 2026.','first session will meet on October 21, 2026.']){
    const invalid=structuredClone(finding);invalid.citations[invalid.evidence.identity[0]].quote=changed;
    assert.throws(()=>validateCitedFinding(invalid,input),/must resolve literally/);
  }
});

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

test('missing-field review completes omitted source facts, retrieves again and updates the existing record',async()=>{
  const db=await setup(),occurrence='First session will meet on 2026-10-21T10:00:00Z.',post={...article,content:{rendered:'<h1>First session</h1><p>'+occurrence+'</p><p>Ocean Institute</p><p>Marine data standards workshop.</p>'}};
  try{
    const p=proposal();p.candidate.organization=null;p.candidate.starts_at=null;
    p.evidence.organization=p.evidence.title;delete p.evidence.starts_at;p.evidence.identity=occurrence;
    const existing=await seed(db,p),inputs=[];
    const source=runner(db,input=>{
      inputs.push(input);
      if(input.stage==='extract')return answer([p]);
      if(input.missing_fields){
        assert.deepEqual(input.missing_fields,['organization','starts_at','ends_at','starts_on','ends_on']);
        assert.match(input.source_context.segments[0].text,/Ocean Institute/);
        const completion=structuredClone(input.finding);
        for(const [field,value,quote]of [['organization','Ocean Institute','Ocean Institute'],['starts_at','2026-10-21T10:00:00Z',occurrence]]){
          completion.candidate[field]=value;completion.evidence[field]=[completion.citations.length];completion.citations.push({doc:'P',quote});
        }
        completion.dates.starts_at={local:'2026-10-21T10:00:00',zone:'UTC',parts:Object.fromEntries(['year','date','time','zone'].map(k=>[k,completion.evidence.starts_at]))};
        return {...resolution(input,'uncertain'),completion,unknowns:{organization:null,starts_at:null,starts_on:'UTC instant completed; a separate local-day claim is not required.',ends_at:'No same-session end time is supplied.'}};
      }
      assert.equal(input.finding.candidate.organization,'Ocean Institute');
      assert.equal(input.finding.candidate.starts_at,'2026-10-21T10:00:00Z');
      return {...resolution(input,'update',existing.id),conflict:'completion',evidence:{identity:input.finding.evidence.identity},
        comparisons:[{record_id:existing.id,relation:'possible_match',citations:input.finding.evidence.identity,reason:'Same explicitly scheduled session.'}]};
    },{post});
    const run=await source.run();assert.equal(run.changed,1,run.warnings.join(';'));assert.equal(run.created,0);assert.equal(inputs.length,3);
    const schema=JSON.parse(source.requests[1]).generationConfig.responseJsonSchema.properties.completion.anyOf[0];
    assert.ok(schema.properties.evidence.required.includes('description'));assert.ok(schema.properties.evidence.required.includes('event_url'));
    assert.deepEqual(schema.properties.candidate.properties.title.enum,['First session']);
    const [record]=await current(db);assert.equal(record.organization,'Ocean Institute');assert.equal(record.starts_at.toISOString(),'2026-10-21T10:00:00.000Z');assert.equal(record.ends_at,null);
    const saved=(await db.query('select parsed from scout.evidence where record_id=$1',[existing.id])).rows[0].parsed;
    assert.equal(saved.completeness.unknowns.ends_at,'No same-session end time is supplied.');assert.ok(saved.accepted_fields.organization);assert.ok(saved.accepted_fields.starts_at);
    await source.run();assert.equal(inputs.length,3,'Completed review is reused without another model call');
  }finally{await db.close();}
});

test('missing-field review is required and rejects unsupported or destructive completions',async()=>{
  for(const mode of ['missing-review','invented-date','changed-title','organizer-only-reason','organizer-plural-reason','organizer-leading-reason','organizer-conflict-reason','record-absence-reason','structured-date-reason','host-only-reason','standalone-affiliation-reason','formal-entity-reason','independent-entity-reason','final-resolution-reason']){
    const db=await setup();try{
      const p=proposal();p.candidate.starts_at=null;delete p.evidence.starts_at;
      if(mode.endsWith('-reason')){p.candidate.organization=null;delete p.evidence.organization;}
      const source=runner(db,input=>{
        if(input.stage==='extract')return answer([p]);
        const out=resolution(input);
        if(mode.endsWith('-reason'))return {...out,completion:null,unknowns:{organization:mode==='organizer-only-reason'?'No sole organizer is explicitly designated.':mode==='organizer-plural-reason'?'Inspected sources mention production companies like Impronta Films, but do not associate them as organizers or hosts of the theatrical screenings.':mode==='organizer-leading-reason'?'Organizer not explicitly detailed beyond partner mentions and hosting entity in conflicting ways across sources.':mode==='organizer-conflict-reason'?'Organizer details vary or conflict across sources.':mode==='host-only-reason'?'Organization is not explicitly named as a host.':mode==='standalone-affiliation-reason'?'Source names DOOS in the title but lacks standalone organizational affiliation details.':mode==='formal-entity-reason'?"The text mentions our DOSI Delegation but does not explicitly name DOSI as an independent formal organization entity in a structured manner.":mode==='independent-entity-reason'?'No independent organization entity is explicitly registered by the source.':['structured-date-reason','final-resolution-reason'].includes(mode)?'No same-event organization association is supplied.':'Organization not populated in finding data.',starts_at:'No complete same-event instant is stated.',ends_at:'No end time is stated.',starts_on:mode==='structured-date-reason'?'Specific calendar start date not extracted into structured dates.':mode==='final-resolution-reason'?'Final resolution cannot add new source citations.':'No same-event calendar day is stated.'}};
        if(mode==='missing-review')return {...out,completion:undefined,unknowns:undefined};
        const completion=structuredClone(input.finding);completion.candidate.starts_at='2026-10-21T10:00:00Z';
        const index=completion.citations.length;completion.citations.push({doc:'P',quote:mode==='invented-date'?'2027-10-21T10:00:00Z':'2026-10-21T10:00:00Z'});
        completion.evidence.starts_at=[index];completion.dates.starts_at={local:'2026-10-21T10:00:00',zone:'UTC',parts:Object.fromEntries(['year','date','time','zone'].map(k=>[k,[index]]))};
        if(mode==='changed-title')completion.candidate.title='Second session';
        return {...out,completion,unknowns:{starts_at:null,starts_on:'UTC instant completed; separate local-day claim not required.',ends_at:'No end time.'}};
      });
      const run=await source.run();assert.equal(run.created,0,mode);assert.equal((await current(db)).length,0);assert.ok(run.warnings.length);
    }finally{await db.close();}
  }
});

test('a reviewed native-session calendar proof cannot excuse omitted UTC start or end components',async()=>{
  const db=await setup(),occurrence='First session 2026 is hosted by Ocean Institute.',start='$[0].start: 2026-10-21T10:00:00.000Z',end='$[0].end: 2026-10-21T11:00:00.000Z';
  try{
    const prepared=prepareDocument({title:'First session',url:article.link,html:'<p>'+occurrence+'</p><p>Marine data standards workshop.</p>'});
    const native=prepareDocument({title:'First session',url:'https://api.cbd.int/api/v2016/reservations/?q=session',html:'<pre>'+start+'\n'+end+'</pre>'});
    const source=(await db.query('insert into scout.evidence(tracker_id,url,content_hash,content,parsed,last_seen_at) values($1,$2,$3,$4,$5,clock_timestamp()) returning *',[fixture.tracker.id,article.link,'native-calendar',prepared.text,JSON.stringify({document:{identity:'native-calendar'}})])).rows[0];
    const support=(await db.query('insert into scout.evidence(tracker_id,url,content_hash,content,parsed,last_seen_at) values($1,$2,$3,$4,$5,clock_timestamp()) returning *',[fixture.tracker.id,native.url,'native-session',native.text,JSON.stringify({document:{identity:'support:'+native.url}})])).rows[0];
    const context={...prepared,documents:[{id:'P',capture_id:source.id,url:article.link,hash:source.content_hash,prepared,preparation_version:prepared.version},{id:'S1',capture_id:support.id,url:native.url,hash:support.content_hash,relationship:'support',prepared:native,preparation_version:native.version}]};
    const p=proposal();p.candidate.starts_at=null;delete p.evidence.starts_at;p.evidence.identity=occurrence;
    const finding=cited(p,packDocument(source,context,0,DOCUMENT_VERSION,prepared.text.length,true)),index=finding.citations.length;finding.citations.push({doc:'S1',quote:start});finding.dates.starts_on={value:'2026-10-21',citations:[index]};
    const record=await seed(db,p),run=(await db.query('insert into scout.collection_runs(tracker_id) values($1) returning id',[fixture.tracker.id])).rows[0].id,trace=await startReport(db,run);let repaired=false;
    await db.query('insert into scout.evidence(tracker_id,record_id,url,content_hash,content,parsed) values($1,$2,$3,$4,$5,$6)',[fixture.tracker.id,record.id,article.link,'native-accepted','{}',JSON.stringify({document:{identity:'native-calendar',sources:context.documents.map(({prepared,...d})=>d)},finding})]);
    const result=await processDocument(db,{source,prepared:context,trace,recordId:record.id,reassess:true,deadline:Date.now()+100000,model:async(_,inputs)=>{
      const input=inputs[0];if(input.missing_fields){
        if(!input.repair)return reviewed({...resolution(input,'uncertain'),completion:null,unknowns:{starts_at:'Start time is not a standalone parsed component.',ends_at:'End time components are absent.'}},input);
        assert.match(input.repair.errors.join(';'),/reviewed calendar proof.*explicit UTC timestamp/);repaired=true;
        const completion=structuredClone(input.finding);completion.citations.push({doc:'S1',quote:end});
        for(const [field,time,i]of [['starts_at','2026-10-21T10:00:00.000Z',index],['ends_at','2026-10-21T11:00:00.000Z',completion.citations.length-1]]){
          completion.candidate[field]=time;completion.evidence[field]=[i];completion.dates[field]={local:time.slice(0,19),zone:'UTC',parts:Object.fromEntries(['year','date','time','zone'].map(k=>[k,[i]]))};
        }
        return reviewed({...resolution(input,'uncertain'),completion,unknowns:{starts_at:null,ends_at:null}},input);
      }
      return reviewed({...resolution(input,'update',record.id),conflict:'completion',evidence:{identity:input.finding.evidence.identity},comparisons:[{record_id:record.id,relation:'possible_match',citations:input.finding.evidence.identity,reason:'Same explicitly identified session.'}]},input);
    }});
    assert.equal(result.state,'complete',result.error);assert.equal(result.changed,1);assert.equal(repaired,true);
    const saved=(await current(db))[0];assert.equal(saved.starts_at.toISOString(),'2026-10-21T10:00:00.000Z');assert.equal(saved.ends_at.toISOString(),'2026-10-21T11:00:00.000Z');
  }finally{await db.close();}
});

test('scoped completion compares retained variants, preserves occurrence proof and holds conflicting schedules independently of organizations',async()=>{
  for(const variant of [false,true,'stale'])for(const conflict of [false,true]){
    if(variant==='stale'&&conflict)continue;
    const db=await setup(),occurrence='First session 2026 is led by Ocean Institute.',date='First session is scheduled for October 21, 2026.';
    const post={...article,content:{rendered:'<h1>First session</h1><p>'+occurrence+'</p><p>'+date+'</p>'+(conflict&&!variant?'<p>First session is scheduled for October 22, 2026.</p>':'')+'<p>Marine data standards workshop.</p>'}};
    try{
      const p=proposal();p.candidate.organization=null;p.candidate.starts_at=null;delete p.evidence.starts_at;p.evidence.identity=p.evidence.title;
      const prepared=prepareDocument({title:post.title.rendered,url:post.link,html:post.content.rendered});
      const source=(await db.query('insert into scout.evidence(tracker_id,url,content_hash,content,parsed,last_seen_at) values($1,$2,$3,$4,$5,clock_timestamp()) returning *',
        [fixture.tracker.id,post.link,'scoped-identity',prepared.text,JSON.stringify({document:{identity:'test:scoped-identity',conflicted:Boolean(variant),preparation:{state:'complete',version:prepared.version},prepared_versions:{[prepared.version]:prepared}}})])).rows[0];
      if(variant){
        const older={...prepared,text:conflict?prepared.text.replace('October 21','October 22'):prepared.text};
        await db.query("insert into scout.evidence(tracker_id,url,content_hash,content,parsed,last_seen_at) values($1,$2,'older-wrapper','different retained raw wrapper',$3,$4::timestamptz-interval '1 hour')",
          [fixture.tracker.id,post.link,JSON.stringify({document:{identity:'test:scoped-identity',preparation:{state:'complete',version:older.version},prepared_versions:{[older.version]:older}}}),source.last_seen_at]);
        const queued=(await db.query('select queue_state from scout.source_queue where id=$1',[source.id])).rows[0];assert.equal(queued.queue_state,'awaiting_initial');
      }
      const finding=cited(p,packDocument(source,prepared,0,DOCUMENT_VERSION)),existing=await seed(db,p),trace=await startReport(db,(await db.query('insert into scout.collection_runs(tracker_id) values($1) returning id',[fixture.tracker.id])).rows[0].id);
      await db.query('insert into scout.evidence(tracker_id,record_id,url,content_hash,content,parsed) values($1,$2,$3,$4,$5,$6)',
        [fixture.tracker.id,existing.id,post.link,'accepted-scope','{}',JSON.stringify({document:{identity:'test:scoped-identity'},finding})]);
      const context=await supportDocuments(db,{source,prepared,trace});let repairs=0;
      const run=await processDocument(db,{source,prepared:context,trace,recordId:existing.id,reassess:true,deadline:Date.now()+100000,model:async(instruction,inputs,responseSchema)=>{
        const input=inputs[0];assert.equal(input.expected_record_id,existing.id);
        if(input.missing_fields){
          assert.equal(responseSchema.properties.completion.anyOf[0].properties.evidence.properties.identity.minItems,2);
          const completionSchema=responseSchema.properties.completion.anyOf[0].properties;
          assert.deepEqual(completionSchema.citations.prefixItems.map(c=>({doc:c.properties.doc.enum[0],quote:c.properties.quote.enum[0]})),input.finding.citations,'Retained citation replacements are excluded from the model contract');
          assert.deepEqual(completionSchema.evidence.properties.title.prefixItems.map(v=>v.enum[0]),input.finding.evidence.title);
          assert.equal(completionSchema.evidence.properties.organization.items.minimum,input.finding.citations.length,'New association proof cannot reuse the old excerpt that omitted its name');
          const completion=structuredClone(input.finding),i=completion.citations.length;
          completion.citations.push({doc:variant?'S1':'P',quote:occurrence});completion.candidate.organization='Ocean Institute';completion.evidence.organization=[i];
          if(conflict){
            if(input.repair){assert.match(input.repair.errors.join(';'),/completion needs a supplied occurrence/);repairs++;completion.evidence.identity=[...completion.evidence.identity,i];}
          }
          else{completion.citations.push({doc:'P',quote:date});completion.dates.starts_on={value:'2026-10-21',citations:[i+1]};}
          return reviewed({...resolution(input,'uncertain'),completion,unknowns:{organization:null,starts_at:'Clock and timezone are absent.',ends_at:'Clock and timezone are absent.',starts_on:conflict?'The source gives October 21 and October 22, 2026 for the same session.':null}},input);
        }
        assert.ok(input.source_context.segments[0].text.includes(date),'Full source remains present after completeness review');
        if(variant)assert.ok(input.source_context.segments.find(s=>s.doc==='S1').text.includes(conflict?'October 22':'October 21'));
        assert.ok(responseSchema.required.includes('comparisons'));
        const index=conflict?input.finding.evidence.identity.at(-1):input.finding.dates.starts_on.citations[0];
        assert.deepEqual(responseSchema.properties.evidence.properties.identity.items.enum,[index]);
        assert.equal(Boolean(input.finding.dates.starts_on),!conflict);
        assert.match(instruction,/Inspect source_context for contradictory same-finding claims/);
        if(variant==='stale')await db.query("insert into scout.evidence(tracker_id,url,content_hash,content,parsed,last_seen_at) values($1,$2,'new-observation','new raw source',$3,clock_timestamp()) on conflict(record_id,tracker_id,url,content_hash) do update set last_seen_at=excluded.last_seen_at",
          [fixture.tracker.id,post.link,JSON.stringify({document:{identity:'test:scoped-identity'}})]);
        return reviewed({...resolution(input,'update',existing.id),conflict:'completion',evidence:{identity:[index]},comparisons:[{record_id:existing.id,relation:'possible_match',citations:[index],reason:'Same explicitly identified occurrence.'}]},input);
      }});
      if(variant==='stale'){
        assert.equal(run.changed,0);assert.match(run.error,/Document observation is stale/);
        assert.equal((await current(db))[0].organization,null);continue;
      }
      assert.equal(run.changed,1,run.error);assert.equal(repairs,conflict?1:0);
      const [record]=await current(db);assert.equal(record.organization,'Ocean Institute');assert.equal(record.starts_at,null);
      const saved=(await db.query('select parsed from scout.evidence where record_id=$1 and content_hash=$2',[record.id,source.content_hash])).rows[0].parsed;
      assert.equal(Boolean(saved.accepted_fields.starts_on),!conflict);
      if(variant){
        assert.equal(saved.accepted_fields.organization.sources[0].hash,'older-wrapper');
        assert.equal(saved.document.sources[1].relationship,'source-variant');
        assert.equal((await db.query('select count(*)::int n from scout.evidence where record_id=$1',[record.id])).rows[0].n,2,'Historical captures are referenced without overwriting prior accepted evidence');
        if(!conflict){
          const wholeVersion=DOCUMENT_VERSION+'/'+prepared.version+'/joint-review';
          await db.query("update scout.evidence set parsed=jsonb_set(jsonb_set(parsed,'{document,processing}',jsonb_build_object('version',$2::text)),'{document,processing_versions}',coalesce(parsed#>'{document,processing_versions}','{}'::jsonb)||jsonb_build_object($2::text,$3::jsonb)) where id=$1",
            [source.id,wholeVersion,JSON.stringify({state:'complete',variant_captures:context.documents.slice(1).map(d=>d.capture_id)})]);
          assert.equal((await db.query('select queue_state from scout.source_queue where id=$1',[source.id])).rows[0].queue_state,'complete');
          await db.query("update scout.evidence set parsed=jsonb_set(parsed,'{document,preparation,state}','\"pending\"') where content_hash='older-wrapper'");
          await assert.rejects(supportDocuments(db,{source,prepared,trace}),/variant preparation is incomplete/);
          await db.query("update scout.evidence set parsed=jsonb_set(parsed,'{document,preparation,state}','\"complete\"') where content_hash='older-wrapper'");
          await db.query("insert into scout.evidence(tracker_id,url,content_hash,content,parsed,last_seen_at) select $1,$2,'variant-'||n,'raw wrapper '||n,$3::jsonb,$4::timestamptz-interval '1 hour' from generate_series(1,3) n",[fixture.tracker.id,post.link,JSON.stringify(source.parsed),source.last_seen_at]);
          assert.equal((await db.query('select queue_state from scout.source_queue where id=$1',[source.id])).rows[0].queue_state,'awaiting_initial','A new retained variant invalidates the old joint review');
          await assert.rejects(supportDocuments(db,{source,prepared,trace}),/two to four retained complete captures/);
        }
      }
    }finally{await db.close();}
  }
});

test('mentioned profiles retain raw responses, require matching IDs and participant proof, and cannot date events',async()=>{
  const db=await setup();try{
    const item=JSON.parse(await readFile(new URL('./fixtures/hsa-webinar.json',import.meta.url),'utf8')),did='did:plc:bzbqq3xierqt53aavlcvarby',label='@ceo.globalfishingwatch.org';
    const second='did:plc:i4kytxgsu3yfsrt2ml3o7tgq',secondLabel='@ai2.bsky.social',quote='At Climate Week '+label+' joined '+secondLabel+' at the marine data workshop.';
    item.post.record.text=quote;const byteStart=Buffer.byteLength(quote.slice(0,quote.indexOf(label)));
    item.post.record.facets=[{index:{byteStart,byteEnd:byteStart+Buffer.byteLength(label)},features:[{$type:'app.bsky.richtext.facet#mention',did}]}];
    const secondStart=Buffer.byteLength(quote.slice(0,quote.indexOf(secondLabel)));item.post.record.facets.push({index:{byteStart:secondStart,byteEnd:secondStart+Buffer.byteLength(secondLabel)},features:[{$type:'app.bsky.richtext.facet#mention',did:second}]});
    const native=prepareAuthorItem(item,{actor:item.post.author.handle,sourceURL}),prepared=native.prepared;
    const source=(await db.query('insert into scout.evidence(tracker_id,url,content_hash,content,parsed) values($1,$2,$3,$4,$5) returning *',[fixture.tracker.id,native.url,'mention-primary',native.raw,JSON.stringify({document:{identity:native.id}})])).rows[0];
    const run=(await db.query('insert into scout.collection_runs(tracker_id) values($1) returning id',[fixture.tracker.id])).rows[0].id,trace=await startReport(db,run),budget={requests:0,deadline:Date.now()+10000};
    const body=JSON.stringify({profiles:[{did,handle:'ceo.globalfishingwatch.org',displayName:'Tony Long',description:'Official CEO account of Global Fishing Watch. Founded 2026-10-21T10:00:00Z.',createdAt:'2026-10-21T10:00:00Z',followersCount:999},{did:second,handle:'ai2.bsky.social',displayName:'Ai2',description:'Ai2 research institute. <literal>'}]});
    const context=await supportDocuments(db,{source,prepared,trace,sourceURL,budget,limits:{pages:6,requests:24,bytes:524288},read:async(url,b)=>{b.requests++;return {url,status:200,headers:{'content-type':'application/json'},body};}});
    assert.equal(budget.requests,1);assert.equal(context.documents[1].relationship,'profile');
    assert.ok(!context.documents[1].prepared.text.includes('followersCount'));assert.ok(!context.documents[1].prepared.text.includes('createdAt'));
    assert.ok(context.documents[1].prepared.text.includes('<literal>'),'Native profile description is literal plain text, not HTML');
    assert.equal(JSON.parse((await db.query('select content from scout.evidence where id=$1',[context.documents[1].capture_id])).rows[0].content).body,body);
    assert.deepEqual(Object.keys(packDocument(source,context,0,DOCUMENT_VERSION).documents),['P']);
    const input=packDocument(source,context,0,DOCUMENT_VERSION,prepared.text.length,true),p={anchor:quote,urls:[],candidate:{...Object.fromEntries(CONTENT_FIELDS.map(k=>[k,null])),kind:'event',title:'Marine data workshop',organization:'Global Fishing Watch'},priority:'normal',reason:'Marine data workshop.',citations:[{doc:'P',quote},{doc:'S1',quote:'Official CEO account of Global Fishing Watch.'}],evidence:{kind:[0],title:[0],priority:[0],identity:[0],organization:[0,1]},dates:{}};
    validateCitedFinding(p,input);
    const unsupported=structuredClone(p);unsupported.evidence.organization=[1];assert.throws(()=>validateCitedFinding(unsupported,input),/cited native mention/);
    const wrongActor=structuredClone(p);wrongActor.citations.push({doc:'P',quote:secondLabel});wrongActor.evidence.organization=[1,2];assert.throws(()=>validateCitedFinding(wrongActor,input),/exact actor/);
    const wrongOccurrence=structuredClone(input);wrongOccurrence.segments.find(s=>s.doc==='P').source_fields.forEach(f=>{f.attribution.uri='at://did:plc:other/app.bsky.feed.post/other';});assert.throws(()=>validateCitedFinding(p,wrongOccurrence),/exact actor/);
    const dated=structuredClone(p);dated.citations.push({doc:'S1',quote:'2026-10-21T10:00:00Z'});dated.dates.starts_on={value:'2026-10-21',citations:[2]};assert.throws(()=>validateCitedFinding(dated,input),/profile information/);
    for(const profiles of [[{did:'did:plc:wrong',handle:'wrong.bsky.social'}],[],[{did,handle:'one'},{did,handle:'two'}]]){
      const wrong=await supportDocuments(db,{source,prepared,trace,sourceURL,budget:{requests:0,deadline:Date.now()+10000},limits:{pages:6,requests:24,bytes:524288},read:async(url,b)=>{b.requests++;return {url,status:200,headers:{'content-type':'application/json'},body:JSON.stringify({profiles})};}});
      assert.ok(wrong.coverage.some(c=>c.state==='failed'&&c.reason.includes('identity conflict')));assert.equal(wrong.documents.length,1);
    }
  }finally{await db.close();}
});

test('linked missing-field evidence is captured within one hop and never becomes extraction input',async()=>{
  const db=await setup();try{
    const primary='https://octogroup.org/first-session/',registration='https://example.org/registration';
    const prepared=prepareDocument({title:'First session',url:primary,html:'<p>First session is a marine data workshop.</p><a href="https://example.org/unrelated">Other</a><a href="'+registration+'">Register</a><a href="https://example.org/two">Two</a><a href="https://example.org/three">Three</a><a href="https://example.org/four">Four</a>'});
    const source=(await db.query('insert into scout.evidence(tracker_id,url,content_hash,content,parsed,last_seen_at) values($1,$2,$3,$4,$5,clock_timestamp()) returning *',[fixture.tracker.id,primary,'primary-hash',prepared.text,JSON.stringify({document:{identity:'test:linked-completion'}})])).rows[0];
    const record=(await db.query("insert into scout.records(kind,title,registration_url,identity_key) values('event','First session',$1,'linked-completion') returning id",[registration])).rows[0];
    await db.query('insert into scout.evidence(tracker_id,record_id,url,content_hash,content,parsed) values($1,$2,$3,$4,$5,$6)',[fixture.tracker.id,record.id,primary,'accepted-hash','{}',JSON.stringify({document:{identity:'test:linked-completion'},finding:{candidate:{registration_url:registration},urls:[]}})]);
    const run=(await db.query('insert into scout.collection_runs(tracker_id) values($1) returning id',[fixture.tracker.id])).rows[0].id,trace=await startReport(db,run),fetched=[],budget={requests:0,deadline:Date.now()+10000};
    const context=await supportDocuments(db,{source,prepared,trace,sourceURL,budget,limits:{pages:6,requests:24,bytes:524288},read:async(url,b)=>{
      fetched.push(url);b.requests++;
      return {url,status:200,headers:{'content-type':'text/html'},body:'<title>First session registration</title><p>First session is hosted by Ocean Institute on October 21, 2026.</p><a href="https://example.org/second-hop">More</a>'};
    }});
    assert.equal(fetched[0],registration);assert.equal(fetched.length,3);assert.equal(budget.requests,3);
    assert.ok(!fetched.includes('https://example.org/second-hop'));assert.ok(context.coverage.some(l=>l.state==='deferred'));
    const extraction=packDocument(source,context,0,DOCUMENT_VERSION),completion=packDocument(source,context,0,DOCUMENT_VERSION,prepared.text.length,true);
    assert.deepEqual(Object.keys(extraction.documents),['P']);assert.equal(extraction.segments.some(s=>s.text.includes('hosted by Ocean Institute')),false);
    assert.ok(completion.segments.some(s=>s.doc==='S1'&&s.text.includes('hosted by Ocean Institute')));
    const support=(await db.query('select content,parsed from scout.evidence where id=$1',[context.documents[1].capture_id])).rows[0];
    assert.ok(JSON.parse(support.content).body.includes('October 21, 2026'));assert.equal(support.parsed.document.prepared_versions[context.documents[1].preparation_version].url,registration);
    const p={anchor:'First session',urls:[registration],candidate:{...Object.fromEntries(CONTENT_FIELDS.map(k=>[k,null])),kind:'event',title:'First session'},priority:'normal',reason:'Marine data workshop.',citations:[{doc:'P',quote:'First session is a marine data workshop.'}],evidence:{kind:[0],title:[0],priority:[0],identity:[0]},dates:{}};
    const initialReview=await processDocument(db,{source,prepared:context,trace,deadline:Date.now()+10000,model:async(_,inputs)=>{
      const input=inputs[0];if(input.stage==='extract')return answer([p]);
      if(input.missing_fields){
        const next=structuredClone(input.finding);next.candidate.organization='Ocean Institute';next.citations.push({doc:'S1',quote:'First session is hosted by Ocean Institute on October 21, 2026.'});
        next.evidence.organization=[1];next.dates.starts_on={value:'2026-10-21',citations:[1]};
        return {completion:next,unknowns:{organization:null,starts_on:null,ends_on:'No explicit session end day is supplied.',starts_at:'No explicit time or timezone.',ends_at:'No end time or timezone.'}};
      }
      return {outcome:'update',record_id:record.id,reason:'Same explicitly dated session.',conflict:'completion',evidence:{identity:[1],change:[1]},facts:Object.fromEntries(['kind','title','priority','organization','starts_on'].map(k=>[k,'supported'])),comparisons:[{record_id:record.id,relation:'possible_match',citations:[1],reason:'Same explicitly dated session.'}]};
    }});
    assert.equal(initialReview.state,'complete');assert.equal(initialReview.changed,1);
    const saved=(await db.query('select parsed from scout.evidence where record_id=$1 and content_hash=$2',[record.id,source.content_hash])).rows[0].parsed;
    assert.equal(saved.accepted_fields.organization.sources[0].capture_id,context.documents[1].capture_id);
    assert.equal(saved.accepted_fields.starts_on.value,'2026-10-21');
    const reader='00000000-0000-0000-0000-000000000001';await db.query('insert into auth.users(id) values($1)',[reader]);
    await db.query("insert into auth.identities values($1,'google',$2)",[reader,{iss:'https://accounts.google.com',email_verified:true,custom_claims:{hd:'oceanagentics.com'}}]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[reader]);await db.exec('set role authenticated');
    const visible=(await db.query('select url,calendar_dates from scout.source_details where record_id=$1',[record.id])).rows;
    assert.equal(visible.find(s=>s.url===registration).calendar_dates.starts_on.value,'2026-10-21','Linked programme proof remains reader-visible');
    assert.equal(filterRecords([{kind:'event',starts_at:null,sources:visible}],{from:'2026-10-21',to:'2026-10-21'}).length,1);
    await db.exec('reset role');
    const note='https://example.org/concept-note';prepared.links.push({tag:'a',target:note,context:'First session programme',relationship:'support'});
    fetched.length=0;
    await supportDocuments(db,{source,prepared,trace,recordId:record.id,sourceURL,budget:{requests:0,deadline:Date.now()+10000},limits:{pages:6,requests:24,bytes:524288},read:async(url,b)=>{
      fetched.push(url);b.requests++;return {url,status:200,headers:{'content-type':'text/html'},body:'<title>First session registration</title><p>First session is hosted by Ocean Institute on October 21, 2026.</p><a href="https://example.org/second-hop">More</a>'};
    }});
    assert.equal(fetched[0],registration);assert.equal(fetched[1],note,'Selected record brings its same-event concept note ahead of unrelated page links');
    await db.query("update scout.evidence set last_seen_at=clock_timestamp()-interval '1 day' where record_id=$1 and content_hash='accepted-hash'",[record.id]);
    const reordered={...context,context:'reordered-supports',documents:context.documents.map(d=>({...d,id:d.id==='S1'?'S2':d.id==='S2'?'S1':d.id}))};
    const rebound=await processDocument(db,{source,prepared:reordered,trace,recordId:record.id,reassess:true,deadline:Date.now()+10000,model:async(_,inputs)=>{
      const input=inputs[0];assert.equal(input.stage,'resolve');assert.equal(input.finding.citations[1].doc,'S2','Rebased citation follows the original source URL, even when another document contains the same quote');
      return reviewed({outcome:'evidence',record_id:record.id,reason:'Same explicitly dated session.',conflict:'none',evidence:{identity:[1]},comparisons:[{record_id:record.id,relation:'possible_match',citations:[1],reason:'Same dated session.'}]},input);
    }});
    assert.equal(rebound.state,'complete',rebound.error);
    const upgraded={...reordered,context:'support-reader-upgraded',documents:reordered.documents.map(d=>({...d,...d.url===registration?{preparation_version:'support-reader-upgraded-v1'}:{}}))};
    const currentReader=await processDocument(db,{source,prepared:upgraded,trace,recordId:record.id,reassess:true,deadline:Date.now()+10000,model:async(_,inputs)=>{
      const input=inputs[0];assert.equal(input.finding.citations[1].doc,'S2','A reader upgrade retains the same URL and literal quote; current source guards still validate it');
      return reviewed({outcome:'evidence',record_id:record.id,reason:'Same explicitly dated session.',conflict:'none',evidence:{identity:[1]},comparisons:[{record_id:record.id,relation:'possible_match',citations:[1],reason:'Same dated session.'}]},input);
    }});
    assert.equal(currentReader.state,'complete',currentReader.error);
    const unavailable=await processDocument(db,{source,prepared:{...reordered,context:'missing-original-support',documents:reordered.documents.filter(d=>d.url!==registration)},trace,recordId:record.id,reassess:true,deadline:Date.now()+10000,model:()=>{throw new Error('No model dispatch with an absent original citation source');}});
    assert.equal(unavailable.state,'failed');assert.match(unavailable.error,/unavailable:S2/,'Identical text in a different document cannot substitute for the original cited source');
    const reframed=await supportDocuments(db,{source,prepared,trace,sourceURL,budget:{requests:0,deadline:Date.now()+10000},limits:{pages:6,requests:24,bytes:524288},read:async(url,b)=>{b.requests++;return {url,status:200,headers:{'content-type':'text/html'},body:'<script>changed response nonce</script><title>First session registration</title><p>First session is hosted by Ocean Institute on October 21, 2026.</p><a href="https://example.org/second-hop">More</a>'};}});
    assert.equal(reframed.context,context.context);assert.notEqual(reframed.documents[1].hash,context.documents[1].hash,'Current raw proof capture changes without losing the same-text checkpoint');
    const destination='https://publisher.example.org/session';
    await db.query("insert into scout.evidence(tracker_id,url,content_hash,content,parsed,last_seen_at) values($1,$2,'observed-redirect',$3,$4,clock_timestamp())",[source.tracker_id,destination,
      JSON.stringify({url:destination,status:200,mime:'text/html',body:'<p>First session was listed on October 20, 2026.</p>'}),JSON.stringify({document:{identity:'support:'+registration}})]);
    const redirected=[];
    const recovered=await supportDocuments(db,{source,prepared:{...prepared,links:prepared.links.filter(l=>l.target===registration)},trace,sourceURL,budget:{requests:0,deadline:Date.now()+10000},limits:{pages:6,requests:24,bytes:524288},read:async(url,b)=>{
      b.requests++;redirected.push(url);if(url===registration)throw new Error('peer closed connection without sending TLS close_notify');
      return {url,status:200,headers:{'content-type':'text/html'},body:'<p>First session is hosted by Ocean Institute on October 21, 2026.</p>'};
    }});
    assert.deepEqual(redirected,[registration,'https://publisher.example.org/session']);
    assert.equal(recovered.coverage[0].redirect.rechecked,true);assert.equal(recovered.documents[1].url,'https://publisher.example.org/session');
    assert.ok(recovered.documents[1].prepared.text.includes('October 21, 2026'),'Observed destination is fetched afresh; retained body is not substituted');
    const companion='https://example.org/independent-official-programme',opened=[],bounded={requests:0,deadline:Date.now()+10000};
    const discovered=await supportDocuments(db,{source,prepared,trace,recordId:record.id,companions:[companion,companion],sourceURL,budget:bounded,limits:{pages:6,requests:24,bytes:524288},read:async(url,b)=>{
      opened.push(url);b.requests++;return {url,status:200,headers:{'content-type':'text/html'},body:'<p>Independent same-session programme.</p>'};
    }});
    assert.equal(opened.filter(url=>url===companion).length,1);assert.equal(bounded.requests,3);assert.ok(!prepared.links.some(l=>l.target===companion));
    const extra=discovered.documents.find(d=>d.url===companion);assert.equal(extra.relationship,'discovery');assert.match(extra.via.context,/Not a link in the primary source/);
    assert.notEqual(discovered.context,reframed.context,'An independently supplied source changes the review context');
  }finally{await db.close();}
});

test('publisher calendar exports supply event times, preserve raw proof and reject metadata dates',async()=>{
  const db=await setup();try{
    const primary='https://www.hubocean.earth/events-calendar/xrjtufmcl0z3m40det8a8xnznl6vbb',url=primary+'?format=ical';
    const title='Live Demo @16:00 CET | Getting Started on the Ocean Data Platform';
    const prepared=prepareDocument({url:primary,title,html:'<p>'+title+'</p><p>HUB Ocean live demo session.</p>'});
    prepared.links.push({tag:'api',relationship:'calendar-export',target:url,label:'Publisher calendar export'},
      {tag:'api',relationship:'support',target:primary+'?format=other',label:'Unrelated API'});
    const source=(await db.query('insert into scout.evidence(tracker_id,url,content_hash,content,parsed) values($1,$2,$3,$4,$5) returning *',
      [fixture.tracker.id,primary,'hub-calendar-primary',prepared.text,{document:{identity:'hub:item:696654692b171022676e4d40'}}])).rows[0];
    const run=(await db.query('insert into scout.collection_runs(tracker_id) values($1) returning id',[fixture.tracker.id])).rows[0].id,trace=await startReport(db,run);
    const body='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:696654692b171022676e4d40@squarespace.com\r\nDTSTAMP:20260113T144815Z\r\nDTSTART:20260128T150000Z\r\nDTEND:20260128T154500Z\r\nSUMMARY:'+title+'\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    for(const valid of [true,false]){
      const fetched=[],context=await supportDocuments(db,{source,prepared,trace,sourceURL,budget:{requests:0,deadline:Date.now()+10000},limits:{pages:6,requests:24,bytes:524288},read:async(target,b)=>{
        fetched.push(target);b.requests++;return {url:target,status:200,headers:{'content-type':'text/calendar'},body:valid?body:body.replace('END:VCALENDAR\r\n','')};
      }});
      assert.deepEqual(fetched,[url]);assert.ok(context.coverage.some(c=>c.label==='Unrelated API'&&c.state==='unsupported'));
      if(!valid){assert.match(context.coverage.find(c=>c.url===url).reason,/Incomplete ICS/);assert.equal(context.documents.length,1);continue;}
      const support=context.documents[1];assert.equal(support.preparation_version,'support-ical-v1');
      assert.equal(JSON.parse((await db.query('select content from scout.evidence where id=$1',[support.capture_id])).rows[0].content).body,body);
      assert.deepEqual(Object.keys(packDocument(source,context,0,DOCUMENT_VERSION).documents),['P']);
      const input=packDocument(source,context,0,DOCUMENT_VERSION,prepared.text.length,true);
      const finding={anchor:title,urls:[],candidate:{...Object.fromEntries(CONTENT_FIELDS.map(k=>[k,null])),kind:'event',title},priority:'normal',reason:'Live demo.',
        citations:[{doc:'P',quote:title},{doc:'P',quote:'HUB Ocean live demo session.'},{doc:'S1',quote:'DTSTART:20260128T150000Z'}],evidence:{kind:[1],title:[0],priority:[1]},dates:{starts_on:{value:'2026-01-28',citations:[2]}}};
      finding.candidate.starts_at='2026-01-28T15:00:00Z';finding.evidence.starts_at=[2];
      finding.dates.starts_at={local:'2026-01-28T15:00:00',zone:'UTC',parts:{year:[2],date:[2],time:[2],zone:[2]}};
      assert.equal(validateCitedFinding(finding,input),finding);
      finding.citations[2].quote='DTSTAMP:20260113T144815Z';finding.dates.starts_on.value='2026-01-13';
      assert.throws(()=>validateCitedFinding(finding,input),/Event dates require their own explicit calendar/);
    }
  }finally{await db.close();}
});

test('linked PDF text and native CBD host references are retained as support, with unreadable PDFs explicit',async()=>{
  const db=await setup();try{
    const text='First session is hosted by Ocean Institute on October 21, 2026.',stream='BT /F1 12 Tf 40 700 Td ('+text+') Tj ET';
    const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Length '+stream.length+' >>\nstream\n'+stream+'\nendstream'];
    let pdf='%PDF-1.4\n';const offsets=[0];
    for(const [i,object]of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=(i+1)+' 0 obj\n'+object+'\nendobj\n';}
    const xref=Buffer.byteLength(pdf);pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF';
    const url='https://api.cbd.int/api/v2016/reservations/?q=%7B%7D',host='5b9980b29a41700001e5d3bf';
    const prepared=prepareDocument({title:'First session',url,html:'<p>First session</p><a href="https://example.org/programme.pdf">Programme</a><a href="https://example.org/flyer.pdf">Flyer</a>'});
    const start=prepared.text.length;prepared.text+='\n\n'+host;prepared.blocks.push({source_paths:['$[0].sideEvent.hostOrgs[0]'],value_range:[start+2,prepared.text.length]});
    const source=(await db.query('insert into scout.evidence(tracker_id,url,content_hash,content,parsed) values($1,$2,$3,$4,$5) returning *',[fixture.tracker.id,url,'pdf-primary',prepared.text,JSON.stringify({document:{identity:'pdf-test'}})])).rows[0];
    const run=(await db.query('insert into scout.collection_runs(tracker_id) values($1) returning id',[fixture.tracker.id])).rows[0].id,trace=await startReport(db,run),requests=[];
    const context=await supportDocuments(db,{source,prepared,trace,sourceURL,budget:{requests:0,deadline:Date.now()+10000},limits:{pages:6,requests:24,bytes:524288},read:async(url,b)=>{
      requests.push(url);b.requests++;
      if(url.includes('/inde-orgs?'))return {url,status:200,headers:{'content-type':'application/json'},body:JSON.stringify([{_id:host,title:'Ocean Institute'}])};
      const body=url.endsWith('/flyer.pdf')?pdf.replace(text,' '.repeat(text.length)):pdf;
      return {url,status:200,headers:{'content-type':'application/pdf'},body:Buffer.from(body).toString('base64'),encoding:'base64'};
    }});
    assert.equal(requests.length,3);assert.ok(requests[0].includes('/inde-orgs?'));assert.ok(context.documents.some(d=>d.prepared.version==='support-pdf-v1'&&d.prepared.text.includes(text)));
    assert.ok(context.coverage.some(c=>c.url.endsWith('/flyer.pdf')&&c.state==='failed'&&c.reason.includes('no readable text layer')));
    assert.equal(packDocument(source,context,0,DOCUMENT_VERSION).segments.some(s=>s.text.includes('hosted by Ocean Institute')),false);
    const support=context.documents.find(d=>d.prepared.version==='support-pdf-v1'),stored=(await db.query('select content,parsed from scout.evidence where id=$1',[support.capture_id])).rows[0];
    assert.equal(Buffer.from(JSON.parse(stored.content).body,'base64').toString(),pdf);assert.equal(stored.parsed.document.prepared_versions['support-pdf-v1'].text,support.prepared.text);
  }finally{await db.close();}
});

test('literal CBD side-event links use the existing session API and reject a different returned session',async()=>{
  const db=await setup();try{
    const url='https://example.org/side-events/',prepared=prepareDocument({title:'First session',url,html:'<a href="https://www.cbd.int/side-events/6915">First session</a><a href="https://www.cbd.int/side-events/6916">Second session</a>'});
    const source=(await db.query('insert into scout.evidence(tracker_id,url,content_hash,content,parsed) values($1,$2,$3,$4,$5) returning *',[fixture.tracker.id,url,'session-primary',prepared.text,JSON.stringify({document:{identity:'session-support'}})])).rows[0];
    const run=(await db.query('insert into scout.collection_runs(tracker_id) values($1) returning id',[fixture.tracker.id])).rows[0].id,trace=await startReport(db,run),requests=[];
    const context=await supportDocuments(db,{source,prepared,trace,sourceURL,budget:{requests:0,deadline:Date.now()+10000},limits:{pages:6,requests:24,bytes:524288},read:async(url,b)=>{
      requests.push(url);b.requests++;return {url,status:200,headers:{'content-type':'application/json'},body:JSON.stringify([{_id:'65f9f3c74c01cd734497f701',start:'2026-07-29T10:15:00.000Z',sideEvent:{id:6915,title:'First session',description:'<p>First session is hosted by Ocean Institute.</p>'}}])};
    }});
    assert.equal(requests.length,2);assert.ok(requests.every(url=>url.startsWith('https://api.cbd.int/api/v2016/reservations/')));
    assert.ok(context.documents[1].prepared.text.includes('$[0].start: 2026-07-29T10:15:00.000Z'));assert.equal(context.documents[1].preparation_version,'support-cbd-session-v1');
    assert.ok(context.coverage.some(c=>c.session_id==='6915'&&c.source_reference==='https://www.cbd.int/side-events/6915'&&c.state==='fetched'));
    assert.ok(context.coverage.some(c=>c.session_id==='6916'&&c.state==='failed'&&c.reason.includes('session identity')));
    assert.equal(packDocument(source,context,0,DOCUMENT_VERSION).segments.some(s=>s.text.includes('2026-07-29T10:15')),false);
  }finally{await db.close();}
});

test('CBD session conference references supply verified identity and cannot update another meeting occurrence',async()=>{
  const db=await setup();try{
    const meeting='65ba9cca85ae8044fbf24c41',host='5b9980b29a41700001e5d3bf',url='https://example.org/events/',session='https://www.cbd.int/side-events/5378';
    const prepared=prepareDocument({title:'BBNJ session',url,html:'<p>BBNJ session at CBD COP16 in Cali, Colombia.</p><a href="'+session+'">Session</a>'});
    const source=(await db.query('insert into scout.evidence(tracker_id,url,content_hash,content,parsed) values($1,$2,$3,$4,$5) returning *',[fixture.tracker.id,url,'meeting-primary',prepared.text,JSON.stringify({document:{identity:'meeting-support'}})])).rows[0];
    const run=(await db.query('insert into scout.collection_runs(tracker_id) values($1) returning id',[fixture.tracker.id])).rows[0].id,trace=await startReport(db,run),requests=[];
    const context=await supportDocuments(db,{source,prepared,trace,sourceURL,budget:{requests:0,deadline:Date.now()+10000},limits:{pages:6,requests:24,bytes:524288},read:async(url,b)=>{
      requests.push(url);b.requests++;
      return {url,status:200,headers:{'content-type':'application/json'},body:JSON.stringify(url.includes('/conferences?')?[{_id:meeting,Title:{en:'SBSTTA-26 / SBI-04'},Venue:{en:'Nairobi, Kenya'}}]:url.includes('/inde-orgs?')?[{_id:host,title:'Ocean Institute'}]:[{_id:'65f9f3c74c01cd734497f701',sideEvent:{id:5378,conference:meeting,hostOrgs:[host],description:'<p>BBNJ session in Nairobi.</p>'},location:{conference:meeting}}])};
    }});
    assert.equal(requests.length,3);assert.ok(requests[1].includes('/conferences?'));assert.ok(requests[2].includes('/inde-orgs?'));
    assert.ok(context.documents.find(d=>d.relationship==='organizer').prepared.text.includes('Ocean Institute'));
    const referenced=context.documents.find(d=>d.relationship==='meeting');assert.equal(referenced.prepared.meeting_identity.title,'SBSTTA-26 / SBI-04');assert.equal(referenced.via.source_reference,session);
    const quote=prepared.text.split('\n')[0],p={anchor:'BBNJ session',urls:[session],candidate:{...Object.fromEntries(CONTENT_FIELDS.map(k=>[k,null])),kind:'event',title:'BBNJ session'},priority:'normal',reason:'Substantive session.',citations:[{doc:'P',quote}],evidence:{kind:[0],title:[0],priority:[0],identity:[0]},dates:{}};
    const old={id:'old',kind:'event',title:'BBNJ session',description:'Side event at CBD COP16',anchors:['BBNJ session'],fact_evidence:{}};
    const response={outcome:'evidence',record_id:old.id,reason:'Same session.',facts:{kind:'supported',title:'supported',priority:'supported'},conflict:'none',evidence:{identity:[0]},comparisons:[{record_id:old.id,relation:'possible_match',citations:[0],reason:'Same session.'}]};
    assert.throws(()=>validateResolution(response,p,[old],context),/Referenced CBD meeting conflicts/);
    assert.equal(validateResolution({...response,outcome:'uncertain',record_id:null},p,[old],context).outcome,'uncertain');
    assert.equal(validateResolution(response,{...p,citations:[{doc:'S1',quote:'BBNJ session in Nairobi.'}]},[{...old,description:'Side event at CBD SBI4'}],context).outcome,'evidence','SBI-04 and SBI4 are the same meeting code');
    const packed=packDocument(source,context,0,DOCUMENT_VERSION,context.text.length,true);assert.equal(packed.support_coverage.length,3);
    const wrong=await supportDocuments(db,{source,prepared,trace,sourceURL,budget:{requests:0,deadline:Date.now()+10000},limits:{pages:6,requests:24,bytes:524288},read:async(url,b)=>{b.requests++;return {url,status:200,headers:{'content-type':'application/json'},body:JSON.stringify(url.includes('/conferences?')?[{_id:'wrong',Title:{en:'COP16'}}]:url.includes('/inde-orgs?')?[{_id:'wrong',title:'Wrong host'}]:[{sideEvent:{id:5378,conference:meeting,hostOrgs:[host],description:'<p>BBNJ session.</p>'}}])};}});
    assert.ok(wrong.coverage.some(c=>c.relationship==='meeting'&&c.state==='failed'&&c.reason.includes('identity')));
    assert.ok(wrong.coverage.some(c=>c.relationship==='organizer'&&c.state==='failed'&&c.reason.includes('identity')));
  }finally{await db.close();}
});

test('rotation reviews missing fields per record after whole-document completion and retains the scoped checkpoint',async()=>{
  const db=await setup();try{
    const p=proposal();p.candidate.organization=null;p.candidate.starts_at=null;delete p.evidence.organization;delete p.evidence.starts_at;
    await runner(db,stages([p])).run();
    const [record]=await current(db),before=await progress(db,article.id);
    await db.query('update scout.trackers set enabled=true where id=$1',[fixture.tracker.id]);
    await db.query("update scout.collection_runs set stats=stats-'model_attempts'"); // Isolated fixture quota only.
    let calls=0;
    const connect=()=>({reserve:async()=>({unsafe:async(q,p=[])=>/pg_try_advisory_lock|pg_advisory_unlock/.test(q)?[{acquired:true}]:(await db.query(q,p)).rows,release(){}}),end:async()=>{}});
    const env={url:'https://example.supabase.co',secretKeys:{default:'test-secret'},publishableKeys:{},jwks:null};
    const invoke=()=>hostedHSA(new Request('https://example.test/collect?next=true',{method:'POST',headers:{apikey:'test-secret'}}),{env,databaseURL:'unused',connect,collect:async(database,{runId})=>{await database.query("update scout.collection_runs set outcome='no_change',finished_at=now() where id=$1",[runId]);return {outcome:'no_change'};},apiKey:'test-model',modelFetch:async(url,request)=>{
      if(url.endsWith(':countTokens'))return Response.json({totalTokens:200});
      calls++;const input=JSON.parse(JSON.parse(request.body).contents[0].parts[0].text)[0];assert.equal(input.stage,'resolve');assert.equal(input.expected_record_id,record.id);
      const response=reviewed({...resolution(input,'uncertain'),comparisons:[]},input);
      return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(response)}]}}]});
    }});
    const result=await (await invoke()).json();assert.equal(result.review.state,'uncertain',JSON.stringify(result));assert.equal(calls,1);
    const after=await progress(db,article.id);assert.deepEqual(after.processing,before.processing);assert.ok(Object.keys(after.processing_versions).some(key=>key.endsWith('/record:'+record.id)));
    await invoke();assert.equal(calls,1,'Completed scoped review is not silently repeated');
    const version=Object.keys(after.processing_versions).find(key=>key.endsWith('/record:'+record.id)),interrupted=structuredClone(after.processing_versions[version]);interrupted.state='running';delete interrupted.findings[0].resolution;
    await db.query("update scout.evidence set parsed=jsonb_set(parsed,array['document','processing_versions',$2::text],$3::jsonb) where parsed#>>'{document,id}'=$1",[String(article.id),version,JSON.stringify(interrupted)]);
    assert.equal((await (await invoke()).json()).review.state,'uncertain');assert.equal(calls,2,'An interrupted record checkpoint resumes through automatic rotation');
  }finally{await db.close();}
});

test('organization uncertainty can distinguish a named organizer associated with another event',async()=>{
  const db=await setup(),p=proposal();p.candidate.organization=null;delete p.evidence.organization;
  const reason='Another event names an organizer, but no organization is explicitly associated with this session.';
  const post={...article,content:{rendered:article.content.rendered.replace('<p>Ocean Institute</p>','<p>Second session is hosted by Ocean Institute.</p>')}};
  try{
    const source=runner(db,input=>input.stage==='extract'?answer([p]):{...resolution(input),completion:null,unknowns:{organization:reason,ends_at:'No same-session end time is supplied.'}},{post});
    const result=await source.run();assert.equal(result.created,1,result.warnings.join(';'));
    const saved=(await db.query('select parsed from scout.evidence where record_id is not null')).rows[0].parsed;
    assert.equal(saved.completeness.unknowns.organization,reason);
  }finally{await db.close();}
});

test('same-event date-only completion retains reviewed source dates without manufacturing timestamps',async()=>{
  const db=await setup(),quote='First session takes place on October 21–22, 2026.',post={...article,content:{rendered:'<h1>First session</h1><p>'+quote+'</p><p>Ocean Institute</p><p>Marine data standards workshop.</p>'}};
  try{
    const p=proposal();p.candidate.starts_at=null;delete p.evidence.starts_at;p.evidence.identity=quote;
    const source=runner(db,input=>{
      if(input.stage==='extract')return answer([p]);
      if(input.missing_fields){
        const completion=structuredClone(input.finding),index=completion.citations.length;completion.citations.push({doc:'P',quote});
        completion.dates={starts_on:{value:'2026-10-21',citations:[index]},ends_on:{value:'2026-10-22',citations:[index]}};
        return {...resolution(input,'uncertain'),completion,unknowns:{starts_on:null,starts_at:'The same-event dates are stated but no clock time or timezone.',ends_at:'No end clock time or timezone.'}};
      }
      assert.equal(input.field_audit.fields.starts_on.claim,'2026-10-21');
      return resolution(input);
    },{post});
    const result=await source.run();assert.equal(result.created,1,result.warnings.join(';'));
    const [record]=await current(db);assert.equal(record.starts_at,null);assert.equal(record.ends_at,null);
    const saved=(await db.query('select parsed from scout.evidence where record_id=$1',[record.id])).rows[0].parsed;
    assert.equal(saved.resolution.facts.starts_on,'supported');assert.equal(saved.accepted_fields.starts_on.value,'2026-10-21');
    await db.query("insert into scout.evidence(record_id,tracker_id,url,content_hash,content,parsed,last_seen_at) values($1,$2,$3,'later-calendar-omission','{}','{}',clock_timestamp()+interval '1 second')",[record.id,fixture.tracker.id,post.link]);
    const reader='00000000-0000-0000-0000-000000000001';await db.query('insert into auth.users(id) values($1)',[reader]);
    await db.query("insert into auth.identities values($1,'google',$2)",[reader,{iss:'https://accounts.google.com',email_verified:true,custom_claims:{hd:'oceanagentics.com'}}]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[reader]);await db.exec('set role authenticated');
    const visible=(await db.query('select calendar_dates from scout.source_details where record_id=$1',[record.id])).rows[0];
    assert.equal(visible.calendar_dates.starts_on.value,'2026-10-21','A later unknown capture preserves the accepted source-backed calendar date');await db.exec('reset role');
    const input=packDocument({id:'test'},prepareDocument({title:post.title.rendered,url:post.link,html:post.content.rendered}),0,DOCUMENT_VERSION);
    const invalid=structuredClone(saved.finding);invalid.dates.starts_on.value='2026-02-30';assert.throws(()=>validateCitedFinding(invalid,input),/real calendar date/);
    invalid.dates.starts_on={value:'2027-10-21',citations:invalid.dates.starts_on.citations};assert.throws(()=>validateCitedFinding(invalid,input),/explicit cited year/);
  }finally{await db.close();}
});

test('scoped calendar review completes an omitted range end when its start day is already retained',async()=>{
  const db=await setup(),quote='First session will take place on October 21–22, 2026.',prepared=prepareDocument({title:'First session',url:article.link,html:'<p>'+quote+'</p><p>Ocean Institute</p><p>Marine data standards workshop.</p>'});
  try{
    const p=proposal();p.candidate.starts_at=null;delete p.evidence.starts_at;p.evidence.identity=quote;
    const source=(await db.query('insert into scout.evidence(tracker_id,url,content_hash,content,parsed,last_seen_at) values($1,$2,$3,$4,$5,clock_timestamp()) returning *',[fixture.tracker.id,article.link,'calendar-range',prepared.text,JSON.stringify({document:{identity:'range-review'}})])).rows[0];
    const context={...prepared,documents:[{id:'P',url:article.link,capture_id:source.id,hash:source.content_hash,relationship:'primary',preparation_version:prepared.version,prepared}]};
    const finding=cited(p,packDocument(source,context,0,DOCUMENT_VERSION)),index=finding.evidence.identity[0];finding.dates.starts_on={value:'2026-10-21',citations:[index]};
    const record=await seed(db,p);await db.query('insert into scout.evidence(tracker_id,record_id,url,content_hash,content,parsed) values($1,$2,$3,$4,$5,$6)',[fixture.tracker.id,record.id,article.link,'old-range','{}',JSON.stringify({document:{identity:'range-review'},finding})]);
    const runId=(await db.query('insert into scout.collection_runs(tracker_id) values($1) returning id',[fixture.tracker.id])).rows[0].id,trace=await startReport(db,runId);let calls=0;
    const result=await processDocument(db,{source,prepared:context,trace,recordId:record.id,reassess:true,deadline:Date.now()+10000,model:async(_,inputs)=>{
      calls++;const input=inputs[0];if(input.missing_fields){assert.deepEqual(input.missing_fields,['starts_at','ends_at','ends_on']);const completion=structuredClone(input.finding);completion.dates.ends_on={value:'2026-10-22',citations:[index]};return reviewed({completion,unknowns:{starts_at:'No explicit clock or timezone.',ends_at:'No explicit clock or timezone.',ends_on:null},...resolution(input,'uncertain')},input);}
      return reviewed({...resolution(input,'evidence',record.id),evidence:{identity:[index]},comparisons:[{record_id:record.id,relation:'possible_match',citations:[index],reason:'Same explicitly dated two-day session.'}]},input);
    }});
    assert.equal(result.state,'complete',result.error);assert.equal(calls,2);
    const saved=(await db.query('select parsed from scout.evidence where record_id=$1 and content_hash=$2',[record.id,source.content_hash])).rows[0].parsed;
    assert.equal(saved.accepted_fields.starts_on.value,'2026-10-21');assert.equal(saved.accepted_fields.ends_on.value,'2026-10-22');assert.equal((await current(db))[0].ends_at,null);
  }finally{await db.close();}
});

test('relative event wording cannot borrow calendar or clock components from a typed post timestamp',()=>{
  for(const doc of ['P','S1']){
  const stamp='2026-07-16T07:00:45.655Z',own='Marine session on July 16, 2026';
  const prepared=prepareDocument({title:'Marine session',url:'https://example.org/post',html:'<p>Happening today!</p><p>'+stamp+'</p><p>'+own+'</p>'});
  const start=prepared.text.indexOf(stamp);prepared.blocks.push({tag:'source-field',field:'createdAt',start,end:start+stamp.length,attribution:{relationship:'post'}});
  const input=packDocument({id:'post'},{...prepared,documents:[{id:'S1',url:prepared.url,relationship:'source-variant',prepared}]},0,DOCUMENT_VERSION,prepared.text.length,true);
  const p={anchor:'Marine session',urls:[],candidate:{...Object.fromEntries(CONTENT_FIELDS.map(k=>[k,null])),kind:'event',title:'Marine session'},priority:'normal',reason:'Ocean science session.',citations:[{doc,quote:stamp},{doc,quote:own}],evidence:{kind:[1],title:[1],priority:[1]},dates:{starts_on:{value:'2026-07-16',citations:[0]}}};
  for(const relationship of ['post','quote','reply-parent','reply-root']){
    input.segments.find(s=>s.doc===doc).source_fields[0].attribution.relationship=relationship;
    assert.throws(()=>validateCitedFinding(p,input),/post createdAt timestamp/,relationship);
  }
  p.dates={starts_at:{local:stamp.slice(0,19),zone:'UTC',parts:Object.fromEntries(['year','date','time','zone'].map(k=>[k,[0]]))}};p.candidate.starts_at=stamp;p.evidence.starts_at=[0];
  assert.throws(()=>validateCitedFinding(p,input),/post createdAt timestamp/);
  p.candidate.starts_at=null;delete p.evidence.starts_at;p.dates={starts_on:{value:'2026-07-16',citations:[1]}};
  assert.doesNotThrow(()=>validateCitedFinding(p,input));
  p.citations.push({doc,quote:'2026-07-16'});p.dates.starts_on.citations=[2];
  assert.throws(()=>validateCitedFinding(p,input),/post createdAt timestamp/);
  const relative='Happening today! Join the 2026 IDSSD session.';
  input.segments.find(s=>s.doc===doc).text+='\n'+relative;p.citations.push({doc,quote:relative});p.dates.starts_on.citations=[3];
  assert.throws(()=>validateCitedFinding(p,input),/explicit calendar month\/day/);
  const mixed=stamp+'\nThe webinar is on February 26 at 12 pm EST.';
  const segment=input.segments.find(s=>s.doc===doc),mixedStart=segment.range[0]+segment.text.length+1;
  segment.source_fields.push({field:'createdAt',range:[mixedStart,mixedStart+stamp.length],attribution:{relationship:'post'}});
  segment.text+='\n'+mixed;p.citations.push({doc,quote:mixed});p.dates.starts_on={value:'2026-02-26',citations:[4]};
  assert.throws(()=>validateCitedFinding(p,input),/never infer from publication/);
  const explicit='Event begins '+stamp;
  input.segments.find(s=>s.doc===doc).text+='\n'+explicit;p.citations.push({doc,quote:explicit});p.dates.starts_on={value:'2026-07-16',citations:[5]};
  assert.doesNotThrow(()=>validateCitedFinding(p,input));
  }
});

test('HTML publication dates remain literal metadata and cannot date the described event',()=>{
  const date='7th September 2026',own='The webinar takes place on 7th September 2026.';
  const html='<article class="type-post"><div class="date"><span>Date:</span> '+date+'</div><div><span class="label">News</span> <span class="date">15 Jun, 2026</span></div><div class="entry-content"><p>Expressions of Interest for a future two-hour webinar.</p><div class="date"><p>'+own+'</p></div></div><time class="entry-date published" datetime="2026-09-07T10:55:27Z">'+date+'</time></article>'+
    '<script type="application/ld+json">{"@type":"Article","datePublished":"2026-09-07T10:55:27Z","dateModified":"2026-09-07T15:55:29Z"}</script>';
  const prepared=prepareDocument({title:'Webinar',url:'https://highseasalliance.org/news/webinar/',html});
  assert.ok(prepared.text.includes(date));assert.ok(prepared.text.includes(own));
  for(const doc of ['P','S1']){
    const input=packDocument({id:'publication'},{...prepared,documents:[{id:'S1',url:prepared.url,relationship:'support',prepared}]},0,DOCUMENT_VERSION,prepared.text.length,true);
    const fields=input.segments.find(s=>s.doc===doc).source_fields;
    assert.ok(fields.some(f=>f.field==='datePublished'&&prepared.text.slice(...f.range)===date));
    assert.ok(fields.some(f=>f.field==='datePublished'&&prepared.text.slice(...f.range)==='15 Jun, 2026'));
    const p={anchor:'Webinar',urls:[],candidate:{...Object.fromEntries(CONTENT_FIELDS.map(k=>[k,null])),kind:'event',title:'Webinar'},priority:'normal',reason:'Ocean webinar.',citations:[{doc,quote:date},{doc,quote:own},{doc,quote:'"datePublished": "2026-09-07T10:55:27Z"'}],evidence:{kind:[1],title:[1],priority:[1]},dates:{starts_on:{value:'2026-09-07',citations:[0]}}};
    assert.throws(()=>validateCitedFinding(p,input),/publication|createdAt/);
    p.dates.starts_on.citations=[2];assert.throws(()=>validateCitedFinding(p,input),/publication|createdAt/);
    p.dates.starts_on.citations=[1];assert.doesNotThrow(()=>validateCitedFinding(p,input));
  }
});

test('parent conference ranges cannot date a side session; independent programme dates can',()=>{
  for(const relationship of ['side','satellite']){
    const parent='First session, a '+relationship+' event at Ocean Conference, Barcelona, 10-12 April 2024',own='First session programme: 11 April 2024';
    const source={id:'calendar-test'},prepared=prepareDocument({title:'First session',url:'https://example.org/session',html:'<p>'+parent+'</p><p>'+own+'</p>'}),input=packDocument(source,prepared,0,DOCUMENT_VERSION);
    const p={anchor:'First session',urls:[],candidate:{...Object.fromEntries(CONTENT_FIELDS.map(k=>[k,null])),kind:'event',title:'First session'},priority:'normal',reason:'Ocean science session.',citations:[{doc:'P',quote:parent},{doc:'P',quote:own}],evidence:{kind:[0],title:[0],priority:[0],identity:[0]},dates:{starts_on:{value:'2024-04-10',citations:[0]},ends_on:{value:'2024-04-12',citations:[0]}}};
    assert.throws(()=>validateCitedFinding(p,input),/parent-meeting context/);
    p.dates={starts_on:{value:'2024-04-11',citations:[1]}};assert.doesNotThrow(()=>validateCitedFinding(p,input));
  }
});

test('a reviewed calendar date within the literal event label establishes occurrence; an undated title does not',()=>{
  const anchor='2026 International Conference on BBNJ: Science and Governance (5 November 2026)';
  const p={anchor,urls:[],candidate:{...Object.fromEntries(CONTENT_FIELDS.map(k=>[k,null])),kind:'event',title:'2026 International Conference on BBNJ: Science and Governance'},priority:'normal',reason:'Substantive BBNJ conference.',citations:[{doc:'P',quote:anchor}],evidence:{kind:[0],title:[0],priority:[0],identity:[0]},dates:{starts_on:{value:'2026-11-05',citations:[0]}}};
  const old={...p.candidate,id:'existing',anchors:[anchor],fact_evidence:{},same_source:true};
  const response={outcome:'evidence',record_id:old.id,reason:'Same dated conference occurrence.',evidence:{identity:[0]},facts:{kind:'supported',title:'supported',priority:'supported',starts_on:'supported'},conflict:'none',comparisons:[{record_id:old.id,relation:'possible_match',citations:[0],reason:'Same dated conference occurrence.'}]};
  assert.equal(validateResolution(response,p,[old],{}).outcome,'evidence');
  const split=structuredClone(p);split.citations=[{doc:'P',quote:'2026 International Conference on BBNJ: Science and Governance'},{doc:'P',quote:'5 November 2026'}];split.dates.starts_on.citations=[1];
  const selected={...response,evidence:{identity:[0,1]},comparisons:[{...response.comparisons[0],citations:[0,1]}]};
  assert.equal(validateResolution(selected,split,[old],{}).outcome,'evidence');
  const undated=structuredClone(p);undated.dates={};const facts={...response.facts};delete facts.starts_on;
  assert.throws(()=>validateResolution({...response,facts},undated,[old],{}),/title-only evidence/);
});

test('scoped completion preserves unsupported old claims and accepts occurrence sentences also used as anchors',async()=>{
  for(const identityOnly of [false,true,'association-proof']){
    const db=await setup();try{
      const title='Marine workshop',occurrence='Marine workshop in Busan is convened by Ocean Institute.',url='https://example.org/workshop';
      const prepared=prepareDocument({title,url,html:'<p>'+title+'</p><p>'+occurrence+'</p><p>Ocean Institute ambassadors attended a different meeting.</p>'});
      const p={anchor:identityOnly?title:occurrence,urls:[],candidate:{...Object.fromEntries(CONTENT_FIELDS.map(k=>[k,null])),kind:'event',title,location:'Busan',organization:identityOnly?'Ocean Institute':null,description:'Old unsupported claim.'},priority:'high',reason:'Old unsupported priority claim.',citations:identityOnly?[{doc:'P',quote:title},{doc:'P',quote:occurrence}]:[{doc:'P',quote:occurrence}],evidence:{kind:[0],title:[0],identity:[0],location:[identityOnly?1:0],description:[0],priority:[0],...identityOnly?{organization:[1]}:{}},dates:{}};
      if(identityOnly==='association-proof'){p.citations.push({doc:'P',quote:'Ocean Institute ambassadors'});p.evidence.organization=[2];}
      const source=(await db.query('insert into scout.evidence(tracker_id,url,content_hash,content,parsed,last_seen_at) values($1,$2,$3,$4,$5,clock_timestamp()) returning *',[fixture.tracker.id,url,'scoped-capture',prepared.text,JSON.stringify({document:{identity:'scoped-completion'}})])).rows[0];
      const record=(await db.query('insert into scout.records(kind,title,location,organization,description,priority,identity_key) values($1,$2,$3,$4,$5,$6,$7) returning *',['event',title,'Busan',p.candidate.organization,p.candidate.description,p.priority,'scoped-workshop'])).rows[0];
      await db.query('insert into scout.evidence(tracker_id,record_id,url,content_hash,content,parsed) values($1,$2,$3,$4,$5,$6)',[fixture.tracker.id,record.id,url,'old-capture','{}',JSON.stringify({document:{identity:'scoped-completion'},finding:p})]);
      const runId=(await db.query('insert into scout.collection_runs(tracker_id) values($1) returning id',[fixture.tracker.id])).rows[0].id,trace=await startReport(db,runId);
      const context={...prepared,documents:[{id:'P',url,hash:source.content_hash,capture_id:source.id,relationship:'primary',preparation_version:prepared.version,prepared}]};
      let calls=0;
      const result=await processDocument(db,{source,prepared:context,trace,recordId:record.id,reassess:true,deadline:Date.now()+10000,model:async(instruction,inputs,schema)=>{
        calls++;const input=inputs[0];assert.equal(input.completion_only,record.id);assert.match(schema.properties.outcome.description,/unrelated unchanged existing fields/);
        if(input.missing_fields){
          assert.deepEqual(schema.properties.completion.anyOf[0].properties.reason.enum,[p.reason]);
          const next=structuredClone(input.finding);
          assert.ok(instruction.startsWith('Before identity resolution'),'Missing-field review precedes the final audit');
          if(identityOnly==='association-proof'){
            const i=next.citations.length;next.citations.push({doc:'P',quote:occurrence});next.evidence.organization.push(i);next.evidence.identity.push(i);
            const proof=schema.properties.completion.anyOf[0].properties.evidence.properties.organization;
            assert.equal(proof.maxItems,undefined);assert.deepEqual(proof.prefixItems.map(v=>v.enum[0]),[2]);
          }else if(identityOnly)next.evidence.identity.push(1);else{next.candidate.organization='Ocean Institute';next.evidence.organization=[0];}
          return {completion:next,unknowns:Object.fromEntries(input.missing_fields.map(k=>[k,k==='organization'?null:'No same-event calendar day, clock or timezone is supplied.']))};
        }
        const index=identityOnly==='association-proof'?3:identityOnly?1:0;
        return reviewed({outcome:identityOnly?'evidence':'update',record_id:record.id,reason:'Same workshop occurrence; complete only the supported association.',conflict:identityOnly?'none':'completion',facts:{kind:'supported',title:'supported',location:'supported',organization:'supported',description:'unsupported',priority:'unsupported'},evidence:{identity:[index]},comparisons:[{record_id:record.id,relation:'possible_match',citations:[index],reason:'Same named workshop in Busan with its convening organization.'}]},input);
      }});
      assert.equal(result.state,'complete',result.error);assert.equal(result.changed,identityOnly?0:1);assert.equal(calls,2);
      const after=(await current(db))[0];assert.equal(after.organization,'Ocean Institute');assert.equal(after.priority,record.priority);assert.equal(after.description,record.description);
      const saved=(await db.query('select parsed from scout.evidence where record_id=$1 and content_hash=$2',[record.id,source.content_hash])).rows[0].parsed;
      if(identityOnly==='association-proof'){assert.deepEqual(saved.finding.evidence.organization,[2,3]);assert.deepEqual(saved.finding.citations.slice(0,p.citations.length),p.citations);}
      assert.equal(saved.resolution.facts.priority,'unsupported');assert.equal(saved.assessment.priority_accepted,false);assert.equal(saved.accepted_fields.priority,undefined);assert.equal(saved.accepted_fields.description,undefined);assert.equal(saved.accepted_fields.organization.value,'Ocean Institute');
      const rejected={...saved.resolution,facts:{...saved.resolution.facts,organization:'unsupported'}};
      assert.throws(()=>validateResolution(rejected,{...saved.finding,candidate:{...saved.finding.candidate,organization:'Different organization'}},[{...record,anchors:[p.anchor],fact_evidence:{}}],context,record.id),/Unsupported\/conflicting/);
      assert.throws(()=>validateResolution(saved.resolution,saved.finding,[{...record,anchors:[p.anchor],fact_evidence:{}}],context),/Unsupported\/conflicting/,'Fresh extraction retains its full factual-review requirement');
    }finally{await db.close();}
  }
});

test('private targeted review reuses accepted findings under the new contract and makes no fetch or repeat model calls',async()=>{
  const db=await setup();try{
    const source=runner(db,stages([proposal()]));await source.run({documentVersion:'scout-findings-1/resolve-5/rubric-2'});
    const capture=(await db.query('select * from scout.evidence where record_id is null')).rows[0];let calls=0;
    await db.query("update scout.evidence set parsed=jsonb_set(parsed,'{document,conflicted}','true') where id=$1",[capture.id]);
    await db.query("insert into scout.evidence(tracker_id,url,content_hash,content,parsed,last_seen_at) values($1,$2,'pin-wrapper','retained wrapper variant',$3,$4::timestamptz-interval '1 hour')",[capture.tracker_id,capture.url,JSON.stringify(capture.parsed),capture.last_seen_at]);
    const record=(await current(db))[0],originalProcessing=capture.parsed.document.processing;
    const secret='sb_secret_scout_test_only',env={url:'https://example.supabase.co',secretKeys:{default:secret},publishableKeys:{default:'sb_publishable_test_only'},jwks:null};
    const connect=()=>({reserve:async()=>({unsafe:async(q,p=[])=>/pg_try_advisory_lock|pg_advisory_unlock/.test(q)?[{acquired:true}]:(await db.query(q,p)).rows,release(){}}),end:async()=>{}});
    const invoke=()=>hostedHSA(new Request('https://example.test/collect?documents=process&validate=true&tracker_id='+fixture.tracker.id+'&source_id='+capture.id+'&record_id='+record.id,{method:'POST',headers:{apikey:secret}}),{env,databaseURL:'unused',apiKey:'fixture',connect,collect:()=>{throw new Error('No source fetching during targeted review');},modelFetch:async(url,request)=>{
      if(url.endsWith(':countTokens'))return Response.json({totalTokens:200});calls++;
      const input=JSON.parse(JSON.parse(request.body).contents[0].parts[0].text)[0];assert.equal(input.stage,'resolve');assert.equal(input.expected_record_id,record.id);
      const out=reviewed({...resolution(input,'uncertain'),reason:'Fixture has no positive occurrence passage for a safe existing-target association.'},input);
      return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(out)}]}}]});
    }});
    const result=await (await invoke()).json();assert.equal(result.state,'uncertain',JSON.stringify(result));assert.equal(calls,1);
    await invoke();assert.equal(calls,1,'Retained uncertain review is reused without resetting repair or quota allowance');
    const progress=(await db.query('select parsed from scout.evidence where id=$1',[capture.id])).rows[0].parsed.document;
    assert.deepEqual(progress.processing,originalProcessing,'A record review must not mark the whole document complete or replace its existing checkpoint');
    assert.ok(Object.keys(progress.processing_versions).some(key=>key.endsWith('/record:'+record.id)));
    assert.equal((await current(db)).length,1);assert.equal(source.requests.length,2);
    const wrong=await hostedHSA(new Request('https://example.test/collect?documents=process&validate=true&tracker_id='+fixture.tracker.id+'&source_id=00000000-0000-0000-0000-000000000001',{method:'POST',headers:{apikey:secret}}),{env,databaseURL:'unused',connect});assert.equal(wrong.status,400);
    const unrelated=await hostedHSA(new Request('https://example.test/collect?documents=process&validate=true&tracker_id='+fixture.tracker.id+'&source_id='+capture.id+'&record_id=00000000-0000-0000-0000-000000000001',{method:'POST',headers:{apikey:secret}}),{env,databaseURL:'unused',connect});assert.equal(unrelated.status,400);assert.equal(calls,1);
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

test('publications, funder updates and advocacy save as rated announcements without event fields',async()=>{
  const db=await setup(),items=[
    ['ChM architecture update','Published BBNJ Clearing-House Mechanism data standards.','high'],
    ['Ocean funding call','A funder opened grants for ocean conservation.','high'],
    ['BBNJ paper','A new paper examines BBNJ marine genetic resources.','normal'],
    ['Ocean advocacy','General ocean conservation advocacy.','low'],
  ];
  const findings=items.map(([title,description,priority])=>({anchor:title,urls:[],
    candidate:{...Object.fromEntries(CONTENT_FIELDS.map(k=>[k,null])),kind:'announcement',title,description},
    priority,reason:description,evidence:{kind:description,title,description,priority:description}}));
  const source=runner(db,stages(findings,input=>({...resolution(input),comparisons:input.candidates.map(r=>({
    record_id:r.id,relation:'distinct',citations:[1],reason:'A separate stated update from '+r.title}))})),
    {post:{...article,title:{rendered:'Ocean updates'},content:{rendered:items.map(([t,d])=>'<h2>'+t+'</h2><p>'+d+'</p>').join('')}}});
  try{
    const run=await source.run();assert.equal(run.created,4,run.warnings.join(';'));
    const records=await current(db);assert.equal(records.length,4);
    for(const [title,,priority] of items){const record=records.find(r=>r.title===title);assert.equal(record.kind,'announcement');assert.equal(record.priority,priority);
      for(const key of ['location','event_url','registration_url','starts_at','ends_at','status'])assert.equal(record[key],null);}
    assert.equal(eligibleRecords(await readRecords(db)).length,2);assert.deepEqual(eligibleRecords(records,{kind:'digest',from:'2026-10-01',through:'2026-10-31'}),[]);
    for(const request of source.requests)assert.ok(JSON.parse(request).systemInstruction.parts[0].text.includes(PRIORITY_INSTRUCTION));
    const calls=source.requests.length;await source.run();assert.equal(source.requests.length,calls);assert.deepEqual(await current(db),records);
    const prepared=prepareDocument({url:article.link,title:'Ocean updates',html:items.map(([t,d])=>'<h2>'+t+'</h2><p>'+d+'</p>').join('')});
    const input=packDocument({id:'source'},prepared,0,DOCUMENT_VERSION),invalid=cited(findings[0],input);
    invalid.candidate.location='Online';assert.throws(()=>validateCitedFinding(invalid,input),/Inapplicable event field/);
    invalid.candidate.location=null;invalid.candidate.kind='treaty_status';assert.throws(()=>validateCitedFinding(invalid,input),/Official UN treaty evidence/);
  }finally{await db.close();}
});

test('UN Treaty document collection saves separate official actions with source proofs and a zero-call repeat',async()=>{
  const saved=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/un-treaty.json.gz',import.meta.url)))),db=await setup();
  const tracker=(await db.query("insert into scout.trackers(name,url,collector,cadence,enabled) values('UN Treaty',$1,'web','7 days',false) returning *",[UNTC])).rows[0];
  assert.ok(DOCUMENT_TRACKERS.some(t=>t.url===UNTC));
  const source=runner(db,input=>{
    if(input.stage==='resolve')return {...resolution(input),comparisons:input.candidates.map(r=>({record_id:r.id,relation:'distinct',citations:[0],reason:'A separate country/action occurrence from '+r.title}))};
    const text=input.segments.map(s=>s.text).join(''),header=input.table_headers[0];
    return answer([['Albania','Algeria','Ratification','9 Jun 2025'],['Armenia','Australia','Approval','25 Feb 2026']].map(([country,next,action,date])=>{
      const row=text.slice(text.indexOf(country),text.indexOf(next,text.indexOf(country))).trim();
      return {anchor:country,urls:[],candidate:{...Object.fromEntries(CONTENT_FIELDS.map(k=>[k,null])),kind:'treaty_status',title:country+' · '+action+' · '+date,organization:country},
        priority:'high',reason:'Officially verified BBNJ '+action.toLowerCase()+'.',citations:[{doc:'P',quote:row},{doc:'P',quote:header},{doc:'P',quote:country}],
        evidence:{kind:[0,1],title:[0,1],organization:[2],priority:[0,1],identity:[0]},dates:{}};
    }));
  });
  const options={trackerId:tracker.id,read:async url=>{assert.equal(url,sourceURL(UNTC));return {...saved.html,status:200,headers:{'content-type':'text/html'}};}};
  try{
    const run=await source.run(options);assert.equal(run.created,2,run.warnings.join(';'));
    const records=await current(db);assert.equal(records.length,2);assert.ok(records.every(r=>r.kind==='treaty_status'&&r.priority==='high'&&r.starts_at===null));
    const captures=(await db.query('select * from scout.evidence where tracker_id=$1',[tracker.id])).rows;
    assert.equal(captures.find(e=>e.record_id===null).content,saved.html.body);
    assert.equal(captures.filter(e=>e.record_id!==null).length,2);assert.ok(captures.filter(e=>e.record_id!==null).every(e=>e.parsed.accepted_fields.kind.sources[0].url===sourceURL(UNTC)));
    const calls=source.requests.length;await source.run(options);assert.equal(source.requests.length,calls);assert.deepEqual(await current(db),records);
  }finally{await db.close();}
});

test('background collection holds older completed rubric versions without reopening their review',async()=>{
  const db=await setup(),source=runner(db,stages([]));
  try{
    await source.run({documentVersion:'announcement-events-6/resolve-4/rubric-1'});
    const before=await progress(db);assert.equal(before.processing.state,'complete');
    await db.query('update scout.trackers set enabled=true where id=$1',[fixture.tracker.id]);
    await source.run({documents:true,rotation:true,validate:false});
    const queue=(await db.query('select queue_state from scout.source_queue')).rows;
    assert.deepEqual(queue,[{queue_state:'version_held'}]);assert.equal(source.requests.length,1);
    assert.deepEqual((await progress(db)).processing_versions,before.processing_versions);
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
