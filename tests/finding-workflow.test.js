import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {dateInterval,normalizeDate,findingInterval,dateLabel} from '../src/finding.js';
import {processDocument,claimSource,packDocument} from '../collector/finding-jobs.js';
import {prepareResponse,prepareDocument,supportDocuments,collectDocuments} from '../collector/octo-documents.js';
import {sourceURL} from '../collector/hsa.js';
import {database as boundary,hostedHSA} from '../collector/hosted-hsa.js';
import {gemini} from '../collector/model.js';
import {IMPORTANT_FIELDS} from '../collector/finding-contract.js';
import {correctFinding} from '../collector/corrections.js';
import {randomUUID} from 'node:crypto';
import {gunzipSync} from 'node:zlib';

async function setup(cutover=true){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');create table auth.identities(user_id uuid,provider text,identity_data jsonb);
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;`);
 for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort().filter(n=>cutover||n!=='20261009190000_scout_findings.sql'))
  await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 return db;
}
async function tracker(db){
 return (await db.query("insert into scout.trackers(name,url,collector,cadence) values('Fixture','https://example.org/list','web','6 hours') returning *")).rows[0];
}
async function enable(db){
 await db.exec("update scout.quota_policy set enabled=true,verified_until=now()+interval '1 hour',verified_rpm=15,verified_rpd=500,verified_tpm=250000,database_bytes=10000000,database_verified_until=now()+interval '1 hour'");
}
function driver(raw,inspect=()=>{}){
 return {unsafe:async(q,p=[])=>{inspect(q,p);const r=await raw.query(q,p);r.rows.count=r.affectedRows??r.rows.length;return r.rows;}};
}
const verdict=(input,proposals)=>{
 const findings=structuredClone(proposals);
 for(const f of findings)for(const field of IMPORTANT_FIELDS[f.occurrence.kind]){
  const value=field.split('.').reduce((v,k)=>v?.[k],f);
  if((value==null||Array.isArray(value)&&!value.length)&&!f.unknowns[field])f.unknowns[field]={reason:'not_announced',explanation:'Injected fixture completeness check.'};
 }
 return {input_hash:input.input_hash,complete:true,checked_documents:input.documents.map(d=>d.id),findings,
 checks:findings.map(f=>({checked_fields:IMPORTANT_FIELDS[f.occurrence.kind],occurrence:{status:'supported',reason:'Injected final occurrence support.'}})),
 relevance:findings.map(()=>({priority:'normal',reason:'Substantive high seas MPA webinar.',fields:['title']}))};
};

function proposal(packet){
 const doc=packet.documents[0],ref=text=>{
  const block=doc.blocks.find(b=>b.text.includes(text));assert.ok(block,'Present in real prepared source: '+text);
  return {doc:doc.id,block:block.id,quote:text};
 },title='Making MPAs work in the High Seas: Sharing Lessons Learned from Established Large-Scale Protected Areas';
 const date=[ref('26'),ref('FEB 2026'),ref('12pm EST')],org=[ref('Speaker'),ref('IDDRI')];
 const registration='https://us06web.zoom.us/webinar/register/WN_4MbKkHaqRWG20n3YivEmdQ';
 return {occurrence:{kind:'event',anchor:title,title,sources:[ref(title)]},description:null,canonical_url:{value:doc.url,sources:[ref(title)]},
 organizations:[{name:'IDDRI',role:'participant',sources:org}],details:{start:{value:'2026-02-26',precision:'day',time:'12:00',zone:'-05:00',sources:date},
 end:null,occurrence:null,parent:null,location:null,mode:null,registration_url:{value:registration,sources:[ref(registration)]},status:null},
 identities:[],unknowns:{'details.end':{reason:'not_announced',explanation:'No supported end time in this fixture.'}}};
}
function provider(counter){
 return async(url,options)=>{
  counter.http++;
  if(url.endsWith(':countTokens'))return Response.json({totalTokens:4000});
  counter.generations++;
  const packet=JSON.parse(JSON.parse(options.body).contents[0].parts[0].text)[0];
  const result=packet.stage==='extract'?{understanding:'A high seas MPA webinar is announced.',research:{requests:[]}}:verdict(packet,[proposal(packet)]);
  if(packet.stage!=='extract'&&counter.alternateReason)result.relevance[0].reason='Reworded relevance for the same accepted webinar facts.';
  return Response.json({usageMetadata:{promptTokenCount:4000,candidatesTokenCount:500},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(result)}]}}]});
 };
}

test('E04 packet bounds redundant link previews while preserving every source block and distinct supporting URL',async t=>{
 const fixture=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/iddri-website.json.gz',import.meta.url)))).event;
 const prepared=await prepareResponse(fixture,{sourceURL}),original=structuredClone(prepared),packet=packDocument({url:fixture.url},prepared),doc=packet.documents[0];
 assert.equal(Buffer.byteLength(prepared.text),3813);assert.deepEqual(prepared,original);
 for(const [i,b] of doc.blocks.entries())assert.deepEqual(b,{...prepared.blocks[i],text:prepared.text.slice(b.start,b.end)});
 assert.deepEqual(doc.links.map(l=>l.url),[...new Set(prepared.links.map(l=>sourceURL(l.target)))].filter(url=>url!==sourceURL(fixture.url)));
 assert.ok(doc.links.every(l=>l.label.length<=160&&l.context.length<=320));
 assert.ok(doc.links.some(l=>l.url===proposal(packet).details.registration_url.value));
 assert.ok(doc.links.some(l=>l.label&&l.context));
 const bytes=Buffer.byteLength(JSON.stringify(packet));assert.ok(bytes<4*Buffer.byteLength(prepared.text));
 const contextual=packDocument({url:'https://example.org/main'},{url:'https://example.org/main',text:'Complete source.',links:[
  {target:'https://example.org/main#section',label:'Self'},
  {target:'https://example.org/programme',label:'Programme',context:'Unrelated navigation. '.repeat(100)+'Dates and hosts: Programme includes the schedule. '+'Footer. '.repeat(100)},
  {target:'https://example.org/programme?utm_source=duplicate',label:'Duplicate'}
 ]}).documents[0].links;
 assert.equal(contextual.length,1);assert.equal(contextual[0].url,'https://example.org/programme');assert.ok(contextual[0].context.includes('Dates and hosts: Programme includes the schedule.'));
 t.diagnostic(JSON.stringify({case:'E04',prepared_text_bytes:3813,packet_bytes:bytes,links_bytes:Buffer.byteLength(JSON.stringify(doc.links)),links:doc.links.length,model_calls:0}));
});

test('mocked E04 facts survive readers, model accounting and save; unchanged and irrelevant-change repeats',async t=>{
 const raw=await setup();try{
  const tr=await tracker(raw);await enable(raw);
  const sourceFixture=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/iddri-website.json.gz',import.meta.url))));
  const fixture={url:sourceFixture.event.url,response:sourceFixture.event};
  let body=fixture.response.body,fetches=0;
  const source={tracker_id:tr.id,identity:fixture.url,url:fixture.url},counter={http:0,generations:0};
  const queries=[];let db=boundary(driver(raw,(q,p)=>{queries.push({q,bytes:Buffer.byteLength(JSON.stringify(p))});assert.ok(!JSON.stringify(p).includes('IRRELEVANT_PRIVATE_SENTINEL'));}));
  const read=async()=>{fetches++;return prepareResponse({...fixture.response,url:fixture.url,body},{sourceURL});};
  const totals={statements:0,mutations:0,submitted_bytes:0,result_bytes:0};
  const run=async()=>{
   db=boundary(driver(raw,(_q,p)=>assert.ok(!JSON.stringify(p).includes('IRRELEVANT_PRIVATE_SENTINEL'))));
   const result=await processDocument(db,{source,read,model:gemini({apiKey:'test',ledger:db,fetch:provider(counter)})});
   for(const key of Object.keys(totals))totals[key]+=db.metrics[key];return result;
  };
  const first=await run();assert.deepEqual(first,{state:'complete',created:1,changed:0});
  const record=(await raw.query('select * from scout.records')).rows[0];
  assert.equal(record.kind,'event');assert.deepEqual(record.organizations,[{name:'IDDRI',role:'participant'}]);
  assert.equal(record.details.start.utc,'2026-02-26T17:00:00.000Z');assert.equal(record.details.start.value,'2026-02-26');assert.equal(record.details.end,null);
  assert.equal(record.details.registration_url,'https://us06web.zoom.us/webinar/register/WN_4MbKkHaqRWG20n3YivEmdQ');
  assert.equal(record.accepted_version,1);assert.equal(counter.generations,2);assert.equal(db.metrics.mutations,11);
  const initial={...db.metrics};
  // Measurement reads are outside the invocation counters. These are row representations, not disk/WAL.
  const retained={};
  for(const table of ['records','record_sources','record_identities','source_state','quota_reservations'])retained[table]=(await raw.query(`select count(*)::int rows,
    coalesce(sum(octet_length(to_jsonb(t)::text)),0)::int logical_json_bytes,coalesce(sum(pg_column_size(t)),0)::int row_bytes from scout.${table} t`)).rows[0];
  assert.deepEqual((await raw.query("select to_regclass('scout.evidence') evidence,to_regclass('scout.collection_runs') runs")).rows[0],{evidence:null,runs:null});
  const counts=async()=>Object.fromEntries(await Promise.all(['records','record_sources','record_identities','source_state','quota_reservations'].map(async name=>[name,(await raw.query('select count(*)::int n from scout.'+name)).rows[0].n])));
  const before=await counts();
  for(let i=0;i<2;i++){
   await raw.exec("update scout.source_state set due_at=now()-interval '1 second'");
   assert.equal((await run()).state,'unchanged');
  }
  assert.equal(counter.generations,2);assert.equal(totals.mutations-initial.mutations,4);assert.deepEqual(await counts(),before);
  assert.deepEqual((await raw.query('select updated_at from scout.records')).rows[0].updated_at,record.updated_at);
  const repeat={statements:(totals.statements-initial.statements)/2,mutations:2,submitted_bytes:(totals.submitted_bytes-initial.submitted_bytes)/2};
  body=body.replace('</body>','<p>IRRELEVANT_PRIVATE_SENTINEL '+('unrelated '.repeat(1500))+'</p></body>');
  counter.alternateReason=true;
  await raw.exec("update scout.source_state set due_at=now()-interval '1 second';update scout.quota_reservations set reserved_at=now()-interval '61 seconds'");
  const previous=totals.mutations;assert.deepEqual(await run(),{state:'complete',created:0,changed:0});
  assert.equal(totals.mutations-previous,8);assert.equal((await raw.query('select version from scout.records')).rows[0].version,1);
  const saved=(await raw.query("select jsonb_agg(to_jsonb(r)) rows from scout.records r")).rows[0].rows;
  assert.ok(!JSON.stringify(saved).includes('IRRELEVANT_PRIVATE_SENTINEL'));
  assert.ok(!JSON.stringify(saved).includes('quote'));
  t.diagnostic(JSON.stringify({case:'E04',mocked_model:true,first:initial,retained,unchanged_repeat:repeat,token_count_http_first:2,generation_http_first:2,first_source_bytes:Buffer.byteLength(fixture.response.body),fetches,wal:'unverified'}));
 }finally{await raw.close();}
});

test('compatible conversion preserves IDs, final facts, URLs, priority and delivery while retiring history',async()=>{
 const db=await setup(false);try{
  const tr=await tracker(db),r=(await db.query("insert into scout.records(kind,title,organization,event_url,priority,last_communicated_at) values('event','Legacy','IDDRI','https://example.org/event','normal','2026-01-01') returning *")).rows[0];
  const parsed={accepted_fields:{starts_on:{value:'2026-02-26',accepted_at:'2026-10-01',sources:[{url:'https://example.org/event',quote:'unchanged private proof'}]}},
   assessment:{priority_accepted:true,priority:'normal',reason:'Legacy accepted reason.',accepted_at:'2026-10-01'}};
  await db.query("insert into scout.evidence(record_id,tracker_id,url,content_hash,content,parsed) values($1,$2,'https://example.org/event','legacy','UNCHANGED HISTORICAL BODY',$3)",[r.id,tr.id,parsed]);
  await db.query("insert into scout.collection_runs(tracker_id,started_at,stats) values($1,now()-interval '10 days',$2)",[tr.id,{model_attempts:[{at:'2026-01-01T00:00:00Z',input_tokens:123}]}]);
  const oldAnnouncement=(await db.query("insert into scout.records(kind,title,priority) values('announcement','Legacy announcement','normal') returning id")).rows[0];
  await db.query("insert into scout.evidence(record_id,tracker_id,url,content_hash,content,parsed) values($1,$2,'https://example.org/legacy-announcement','legacy-news','UNCHANGED ANNOUNCEMENT BODY','{}')",[oldAnnouncement.id,tr.id]);
  const timed=(await db.query("insert into scout.records(kind,title,description,identity_key,starts_at,ends_at) values('event','Timed legacy','Keep description','timed-legacy','2026-10-15T12:00Z','2026-10-15T13:00Z') returning *")).rows[0];
  await db.query("insert into scout.evidence(record_id,tracker_id,url,content_hash,content,parsed) values($1,$2,'https://example.org/event','timed','PRIVATE TIMED BODY','{}')",[timed.id,tr.id]);
  const noURL=(await db.query("insert into scout.trackers(name,url,collector,cadence) values('Configured without URL',null,'web','6 hours') returning *")).rows[0];
  await db.exec(await readFile(new URL('../supabase/migrations/20261009190000_scout_findings.sql',import.meta.url),'utf8'));
  assert.deepEqual((await db.query('select * from scout.trackers where id=$1',[noURL.id])).rows[0],noURL);
  assert.equal((await db.query('select count(*)::int n from scout.source_state where tracker_id=$1',[noURL.id])).rows[0].n,0);
  const converted=(await db.query('select * from scout.records where id=$1',[r.id])).rows[0];
  assert.equal(converted.id,r.id);assert.equal(converted.details.start.value,'2026-02-26');
  assert.deepEqual(converted.organizations,[{name:'IDDRI',role:'unspecified'}]);assert.equal(converted.canonical_url,r.event_url);
  assert.equal(converted.priority,'normal');assert.equal(converted.relevance.reason,'Legacy accepted reason.');
  assert.deepEqual(converted.last_communicated_at,r.last_communicated_at);assert.deepEqual(converted.updated_at,r.updated_at);
  const convertedTimed=(await db.query('select * from scout.records where id=$1',[timed.id])).rows[0];
  assert.equal(convertedTimed.description,timed.description);assert.deepEqual(convertedTimed.updated_at,timed.updated_at);
  for(const field of ['start','end'])assert.equal(Date.parse(convertedTimed.details[field].utc),timed[field==='start'?'starts_at':'ends_at'].getTime());
  assert.deepEqual((await db.query('select identity,record_id from scout.record_identities')).rows,[{identity:'legacy:timed-legacy',record_id:timed.id}]);
  assert.deepEqual(new Set((await db.query("select record_id from scout.record_sources where url='https://example.org/event'")).rows.map(s=>s.record_id)),new Set([r.id,timed.id]));
  assert.equal((await db.query('select status from scout.delivery_state where record_id=$1',[r.id])).rows[0].status,'sent');
  assert.equal((await db.query("select to_regclass('scout.evidence') name")).rows[0].name,null);
  assert.equal((await db.query('select count(*)::int n from scout.quota_reservations')).rows[0].n,0);
  const source={tracker_id:tr.id,identity:'legacy-announcement',url:'https://example.org/legacy-announcement'};
  const prepared=prepareDocument({url:source.url,title:'',html:'<p>Legacy announcement.</p>'});
  const sources=[{doc:'P',block:0,quote:'Legacy announcement.'}];
  const refresh=await processDocument(db,{source,prepared,model:async(_,[input])=>input.stage==='extract'?{understanding:'An announcement.',research:{requests:[]}}:verdict(input,[{
    occurrence:{kind:'announcement',anchor:'Legacy announcement',title:'Legacy announcement',sources},description:null,canonical_url:null,organizations:[],
    details:{published:null,effective:null,subjects:null},identities:[],unknowns:{organizations:{reason:'not_announced',explanation:'Unknown.'},'details.published':{reason:'not_announced',explanation:'Unknown.'}}
  }])});
  assert.equal(refresh.created,0);assert.equal(refresh.state,'complete');
  assert.equal((await db.query("select id from scout.records where kind='announcement'")).rows[0].id,oldAnnouncement.id);
  assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,3);
  const nativePrepared=prepareDocument({url:source.url,title:'',html:'<p>Legacy announcement. UID:legacy-native</p>'});
  const nativeRefresh=await processDocument(db,{source:{...source,identity:'new-native-reader'},prepared:nativePrepared,model:async(_,[input])=>input.stage==='extract'?{understanding:'An announcement.',research:{requests:[]}}:verdict(input,[{
    occurrence:{kind:'announcement',anchor:'Legacy announcement',title:'Legacy announcement',sources},description:null,canonical_url:null,organizations:[],
    details:{published:null,effective:null,subjects:null},identities:[{scheme:'calendar_uid',value:'legacy-native',sources:[{doc:'P',block:0,quote:'UID:legacy-native'}]}],
    unknowns:{organizations:{reason:'not_announced',explanation:'Unknown.'},'details.published':{reason:'not_announced',explanation:'Unknown.'}}
  }])});
  assert.equal(nativeRefresh.reason,'ambiguous_identity');assert.equal(nativeRefresh.created,0);
  assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,3);
  await db.exec('set role authenticated');
  await assert.rejects(db.query('select * from scout.record_sources'),{code:'42501'});
  assert.equal((await db.query('select * from scout.findings()')).rows.length,0);
 }finally{await db.close();}
});

test('finite retries include acquisition failures and crash recovery; failed inputs are never processed',async()=>{
 const raw=await setup();try{
  const tr=await tracker(raw),db=boundary(driver(raw)),source={tracker_id:tr.id,identity:'broken',url:'https://example.org/broken'};
  let reads=0;
  for(let i=0;i<4;i++){
   await raw.exec("update scout.source_state set due_at=now()-interval '1 second'");
   await processDocument(db,{source,read:async()=>{reads++;throw new Error('PRIVATE SOURCE FAILURE');}});
  }
  assert.equal(reads,4);
  const row=(await raw.query('select * from scout.source_state')).rows[0];assert.equal(row.state,'parked');assert.equal(row.processed_hash,null);assert.ok(!JSON.stringify(row).includes('PRIVATE'));
  const crash={...source,identity:'crash'};let last;
  for(let i=0;i<4;i++){
   await raw.exec("update scout.source_state set due_at=now()-interval '1 second',lease_until=now()-interval '1 second' where identity='crash'");
   last=await claimSource(db,crash);
  }
  assert.equal(last.state,'parked');assert.equal(last.attempts,3);
  await raw.exec("update scout.source_state set due_at=now()-interval '1 second',lease_until=now()-interval '1 second' where identity='crash'");
  const parked=await processDocument(db,{source:crash,prepared:prepareDocument({url:crash.url,title:'',html:'<p>First recoverable read.</p>'}),model:()=>assert.fail('An exhausted crash must not dispatch before observing a change')});
  assert.equal(parked.state,'parked');assert.equal((await raw.query("select attempts from scout.source_state where identity='crash'")).rows[0].attempts,3);
 }finally{await raw.close();}
});

test('human overrides survive page refresh and optimistic corrections reject stale versions',async()=>{
 const raw=await setup();try{
  const tr=await tracker(raw),db=boundary(driver(raw)),source={tracker_id:tr.id,identity:'simple',url:'https://example.org/simple'};
  let text='Ocean announcement.',calls=0;
  const read=()=>prepareDocument({url:source.url,title:'',html:'<p>'+text+'</p>'});
  const model=async(_,[input])=>{calls++;return input.stage==='extract'?{understanding:'An ocean announcement.',research:{requests:[]}}:verdict(input,[{occurrence:{kind:'announcement',anchor:'Ocean announcement',title:'Ocean announcement',sources:[{doc:'P',block:0,quote:'Ocean announcement.'}]},description:null,canonical_url:null,organizations:[],details:{published:null,effective:null,subjects:null},identities:[],unknowns:{organizations:{reason:'not_announced',explanation:'Unknown.'},'details.published':{reason:'not_announced',explanation:'Unknown.'}}}]);};
  assert.equal((await processDocument(db,{source,read,model})).created,1);
  const r=(await raw.query('select * from scout.records')).rows[0];
  await correctFinding(db,{record_id:r.id,version:1,field:'title',value:'Human title',url:source.url});
  await assert.rejects(correctFinding(db,{record_id:r.id,version:1,field:'title',value:'Stale title',url:source.url}),{status:409});
  text+=' Updated footer.';
  await processDocument(db,{source,read,model});
  assert.equal((await raw.query('select title from scout.records')).rows[0].title,'Human title');assert.equal(calls,4);
 }finally{await raw.close();}
});

test('no due work performs one read, zero mutations and no HTTP',async()=>{
 const raw=await setup();try{
  const sql=driver(raw),connect=()=>({reserve:async()=>({...sql,release(){}}),end:async()=>{}});
  const response=await hostedHSA(new Request('https://example.test/?next=true',{method:'POST',headers:{apikey:'sb_secret_test'}}),
   {env:{url:'https://example.supabase.co',secretKeys:{default:'sb_secret_test'},publishableKeys:{},jwks:null},databaseURL:'unused',connect,read:()=>assert.fail('No HTTP'),modelFetch:()=>assert.fail('No model HTTP')});
  const result=await response.json();assert.equal(result.outcome,'idle');assert.equal(result.cost.statements,1);assert.equal(result.cost.mutations,0);
 }finally{await raw.close();}
});

test('manual and scheduled intake recover omitted facts, fetching only first-pass requests',async t=>{
 for(const scheduled of [false,true])for(const requested of [false,true])await t.test(`${scheduled?'scheduled':'manual'} / ${requested?'programme':'main only'}`,async t=>{
  const raw=await setup();try{
   const tr=await tracker(raw);await enable(raw);await raw.query('update scout.trackers set enabled=true where id=$1',[tr.id]);
   const url='https://example.org/event',programme='https://example.org/programme',timeline=[];
   const facts='Institute A hosts Ocean workshop on 15 October 2026.';
   const main='<p>Ocean workshop about ocean governance.</p>'+(requested?'':'<p>'+facts+'</p>')+
    '<p>The programme contains the dates and hosts: <a href="/programme">Programme</a></p><p><a href="/registration">Register</a></p><p><a href="/unrelated">Unrelated</a></p>';
   if(scheduled)await raw.query('insert into scout.source_state(tracker_id,identity,url) values($1,$2,$2)',[tr.id,url]);
   const read=async(target,budget)=>{timeline.push(target);budget.requests++;
    assert.ok([url,programme].includes(target),'No unrequested, registration or recursive read');
    return {url:target,status:200,headers:{'content-type':'text/html'},body:target===url?main:'<p>'+facts+'</p><a href="/never-read">More</a><p>PRIVATE_SOURCE_SENTINEL</p>'};};
   const wire=[];
   const modelFetch=async(target,options)=>{
    const sent=JSON.parse(options.body),body=target.endsWith(':countTokens')?sent.generateContentRequest:sent,input=JSON.parse(body.contents[0].parts[0].text)[0];
    assert.equal(body.generationConfig.responseMimeType,'application/json');assert.ok(!Object.hasOwn(body.generationConfig,'responseJsonSchema'));
    if(target.endsWith(':countTokens'))return Response.json({totalTokens:4000});
    wire.push(body.systemInstruction.parts[0].text);timeline.push(input.stage);
    let result;
    if(input.stage==='extract'){
     assert.deepEqual(timeline,[url,'extract']);
     assert.ok(input.documents[0].links.some(l=>l.url===programme&&l.label==='Programme'&&l.context.includes('dates and hosts')));
     result={understanding:'An ocean workshop is announced. Dates and hosts remain to be checked.',
      research:{requests:requested?[{url:programme,needed_for:['details.start','organizations'],reason:'Programme lists the schedule and hosts.'}]:[]}};
    }else{
     assert.equal(input.stage,'complete');assert.equal(input.documents.length,requested?2:1);
     const doc=input.documents.find(d=>d.blocks.some(b=>b.text.includes(facts))),block=doc.blocks.find(b=>b.text.includes(facts));
     const sources=[{doc:doc.id,block:block.id,quote:facts}],occurrenceSources=[{doc:'P',block:0,quote:'Ocean workshop about ocean governance.'}];
     assert.equal(input.understanding,'An ocean workshop is announced. Dates and hosts remain to be checked.');
     result=verdict(input,[{occurrence:{kind:'event',anchor:'Ocean workshop',title:'Ocean workshop',sources:occurrenceSources},description:{value:'Ocean workshop about ocean governance.',sources:occurrenceSources},canonical_url:null,
      organizations:[{name:'Institute A',role:'host',sources}],details:{start:{value:'2026-10-15',precision:'day',sources},end:null,occurrence:null,parent:null,location:null,mode:null,registration_url:null,status:null},identities:[],unknowns:{}}]);
    }
    return Response.json({usageMetadata:{promptTokenCount:4000,candidatesTokenCount:500},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(result)}]}}]});
   };
   const sql=driver(raw,(_q,p)=>assert.ok(!JSON.stringify(p).includes('PRIVATE_SOURCE_SENTINEL'))),connect=()=>({reserve:async()=>({...sql,release(){}}),end:async()=>{}});
   const request=()=>new Request('https://example.test/?'+(scheduled?'next=true':new URLSearchParams({tracker_id:tr.id,source_url:url})),{method:'POST',headers:{apikey:'sb_secret_test'}});
   const options={env:{url:'https://example.supabase.co',secretKeys:{default:'sb_secret_test'},publishableKeys:{},jwks:null},databaseURL:'unused',apiKey:'test',connect,read,modelFetch};
   const result=await (await hostedHSA(request(),options)).json();assert.equal(result.state,'complete');assert.equal(result.created,1);assert.equal(wire.length,2);
   assert.ok(wire.every(s=>s.startsWith('Scout helps people discover')));assert.ok(!wire[0].includes('Finding JSON contract')&&!wire[0].includes('Relevance rubric:'));
   assert.ok(wire[1].indexOf('Record types and important information')<wire[1].indexOf('Finding JSON contract'));assert.ok(wire[1].includes('Relevance rubric:'));
   assert.deepEqual(timeline,requested?[url,'extract',programme,'complete']:[url,'extract','complete']);
   const record=(await raw.query('select * from scout.records')).rows[0];assert.equal(record.details.start.value,'2026-10-15');assert.deepEqual(record.organizations,[{name:'Institute A',role:'host'}]);
   const state=(await raw.query('select * from scout.source_state where tracker_id=$1',[tr.id])).rows[0];assert.ok(state.processed_hash);assert.equal(state.research.supports.length,requested?1:0);
   await raw.exec("update scout.source_state set due_at=now()-interval '1 second'");timeline.length=0;
   const repeat=await (await hostedHSA(request(),options)).json();assert.equal(repeat.state,'unchanged');assert.equal(wire.length,2);assert.equal(repeat.cost.mutations,2);
   assert.deepEqual(timeline,requested?[url,programme]:[url]);assert.deepEqual((await raw.query('select * from scout.records')).rows[0],record);
   await raw.exec("update scout.source_state set state='parked',reason='attempt_bound',attempts=3,due_at=now()-interval '1 second'");timeline.length=0;
   const parked=await (await hostedHSA(request(),options)).json();assert.equal(parked.state,'parked');assert.equal(wire.length,2);assert.equal(parked.cost.mutations,2);
   assert.deepEqual(timeline,requested?[url,programme]:[url]);assert.equal((await raw.query('select attempts from scout.source_state where tracker_id=$1',[tr.id])).rows[0].attempts,3);
   t.diagnostic(JSON.stringify({scheduled,requested,first:result.cost,repeat:repeat.cost,retained_source_bytes:Buffer.byteLength(JSON.stringify(state)),mocked_model:true,wal:'unverified'}));
  }finally{await raw.close();}
 });
});

test('bounded understanding reaches final validation; only final source-backed facts save',async()=>{
 const raw=await setup();try{
  const tr=await tracker(raw),variants=[
   {name:'empty',notes:''},
   {name:'misleading',notes:'PRIVATE_NOTE_SENTINEL: Tool Q organizes the workshop in 2099.'},
   {name:'maximum',notes:'x'.repeat(6000)},
   {name:'description',change:f=>{f.description='A bare description';}}
  ];
  for(const variant of variants){
   const title='Ocean workshop '+variant.name,text='Institute A hosts '+title+' online on 15 October 2026. Tool Q is demonstrated.';
   const source={tracker_id:tr.id,identity:title,url:'https://example.org/'+variant.name};
   const prepared=prepareDocument({url:source.url,html:'<p>'+text+'</p>'}),sources=[{doc:'P',block:0,quote:text}],notes=variant.notes??'PRIVATE_NOTE_SENTINEL';
   const final={occurrence:{kind:'event',anchor:title,title,sources},description:{value:'An online ocean workshop.',sources},canonical_url:{value:source.url,sources},
    organizations:[{name:'Institute A',role:'host',sources}],details:{start:{value:'2026-10-15',precision:'day',sources},end:null,occurrence:null,parent:null,location:null,
    mode:{value:'online',sources},registration_url:null,status:null},identities:[],unknowns:{}};
   let calls=0;const before=(await raw.query('select count(*)::int n from scout.records')).rows[0].n;
   const model=async(_,[input])=>{
    calls++;assert.ok(calls<=2);
    assert.equal((await raw.query('select count(*)::int n from scout.records')).rows[0].n,before,'No saves before the final response');
    if(input.stage==='extract')return {understanding:notes,research:{requests:[]}};
    assert.equal(input.understanding,notes);
    const result=verdict(input,[final]);variant.change?.(result.findings[0]);return result;
   };
   const inspect=(_q,p)=>assert.ok(!JSON.stringify(p).includes('PRIVATE_NOTE_SENTINEL'));
   const db=boundary(driver(raw,inspect)),result=await processDocument(db,{source,prepared,model});assert.equal(calls,2);
   const state=(await raw.query('select * from scout.source_state where tracker_id=$1 and identity=$2',[tr.id,source.identity])).rows[0];
   if(variant.change){
    assert.deepEqual(result,{state:'deferred',reason:'invalid_output',created:0,changed:0});assert.equal(state.processed_hash,null);assert.equal(state.attempts,1);
    assert.equal((await raw.query('select count(*)::int n from scout.records')).rows[0].n,before);continue;
   }
   assert.deepEqual(result,{state:'complete',created:1,changed:0});assert.ok(state.processed_hash);
   const record=(await raw.query('select * from scout.records where title=$1',[title])).rows[0];
   assert.equal(record.description,'An online ocean workshop.');assert.equal(record.canonical_url,source.url);assert.equal(record.details.start.value,'2026-10-15');assert.equal(record.details.mode,'online');
   assert.deepEqual(record.organizations,[{name:'Institute A',role:'host'}]);
   await raw.query("update scout.source_state set due_at=now()-interval '1 second' where tracker_id=$1 and identity=$2",[tr.id,source.identity]);
   const repeat=boundary(driver(raw,inspect));assert.deepEqual(await processDocument(repeat,{source,prepared,model}),{state:'unchanged',created:0,changed:0});
   assert.equal(calls,2);assert.equal(repeat.metrics.mutations,2);assert.deepEqual((await raw.query('select * from scout.records where id=$1',[record.id])).rows[0],record);
  }
  const badResponses=[{understanding:'x'.repeat(6001),research:{requests:[]}},{understanding:null,research:{requests:[]}},{understanding:'\uD800',research:{requests:[]}},
   {understanding:'Notes',research:{requests:[]},findings:[]},{understanding:'Notes'}];
  for(const [i,response]of badResponses.entries()){
   const source={tracker_id:tr.id,identity:'invalid-notes-'+i,url:'https://example.org/invalid-'+i};let calls=0;
   const result=await processDocument(raw,{source,prepared:prepareDocument({url:source.url,html:'<p>Workshop.</p>'}),model:async()=>{assert.equal(++calls,1);return response;}});
   assert.equal(result.state,'deferred');assert.equal(result.created,0);assert.equal(calls,1);
  }
 }finally{await raw.close();}
});

test('failed requested sources park finitely, keep checking, and reopen on support recovery or change',async()=>{
 const db=await setup();try{
  const tr=await tracker(db),source={tracker_id:tr.id,identity:'research',url:'https://example.org/event'};
  let available=false,append='',calls=0,reads=0,incomplete=false,exhausted=false;
  const prepared=prepareDocument({url:source.url,title:'',html:'<p>Ocean workshop.</p><a href="/programme">Programme</a>'});
  const sources=[{doc:'P',block:0,quote:'Ocean workshop.'}],draft={occurrence:{kind:'event',anchor:'Ocean workshop',title:'Ocean workshop',sources},description:null,canonical_url:null,organizations:[],details:{start:null,end:null,occurrence:null,parent:null,location:null,mode:null,registration_url:null,status:null},identities:[],unknowns:{}};
  const model=async(_,[input])=>{calls++;if(input.stage==='extract')return {understanding:'Workshop date needs the programme.',research:{requests:[{url:'https://example.org/programme',needed_for:['details.start'],reason:'Read schedule.'}]}};
   const f=structuredClone(draft),doc=input.documents[1];
   if(doc){f.details.start={value:'2026-10-15',precision:'day',sources:[{doc:doc.id,block:0,quote:'Ocean workshop on 15 October 2026.'}]};}
   const answer=verdict(input,[f]);if(incomplete)answer.checks[0].checked_fields=[];return answer;
  };
  const run=async()=>{await db.exec("update scout.source_state set due_at=now()-interval '1 second'");const budget={requests:exhausted?6:0,deadline:Date.now()+100000};
   return processDocument(db,{source,prepared,model,support:requests=>supportDocuments(db,{source,prepared,sourceURL,budget,limits:{requests:6},requests,
    read:async url=>{reads++;return {url,status:available?200:503,headers:{'content-type':'text/html'},body:'<p>Ocean workshop on 15 October 2026.</p>'+append};}})});};
  for(let i=0;i<3;i++){const result=await run();assert.equal(result.state,i===2?'parked':'deferred');assert.equal(result.reason,'research_unresolved');}
  const parked=(await db.query('select * from scout.source_state')).rows[0];assert.equal(parked.attempts,3);assert.equal(parked.processed_hash,null);assert.equal(calls,6);assert.equal(reads,3);
  const saved=(await db.query('select * from scout.records')).rows;
  for(let i=0;i<3;i++){assert.equal((await run()).state,'parked');assert.equal((await db.query('select attempts from scout.source_state')).rows[0].attempts,3);}
  assert.equal(calls,6);assert.equal(reads,6);assert.deepEqual((await db.query('select * from scout.records')).rows,saved);
  available=true;assert.equal((await run()).state,'complete');assert.equal(calls,8);assert.equal((await db.query('select details from scout.records')).rows[0].details.start.value,'2026-10-15');
  assert.equal((await run()).state,'unchanged');assert.equal(calls,8);
  append='<p>Programme updated.</p>';assert.equal((await run()).state,'complete');assert.equal(calls,10);
  available=false;assert.equal((await run()).state,'deferred');assert.equal((await db.query('select processed_hash from scout.source_state')).rows[0].processed_hash,null);
  available=true;assert.equal((await run()).state,'complete');assert.equal(calls,14);
  assert.equal((await db.query('select completeness from scout.records')).rows[0].completeness.unknowns.research,undefined);
  const state=(await db.query('select * from scout.source_state')).rows[0];assert.equal(state.attempts,0);assert.ok(state.processed_hash);assert.ok(!JSON.stringify(state).includes('Programme updated'));
  incomplete=true;append='<p>Another source change.</p>';for(let i=0;i<3;i++)await run();assert.equal(calls,20);
  exhausted=true;assert.equal((await run()).state,'parked');exhausted=false;assert.equal((await run()).state,'parked');assert.equal(calls,20);
  assert.equal((await db.query('select attempts from scout.source_state')).rows[0].attempts,3);
 }finally{await db.close();}
});

test('only checked genuine unknowns qualify for completion; missing coverage and rejected facts remain unresolved',async()=>{
 const db=await setup();try{
  const tr=await tracker(db),prepared=prepareDocument({url:'https://example.org/unknown',title:'',html:'<p>Ocean workshop.</p>'});
  const sources=[{doc:'P',block:0,quote:'Ocean workshop.'}],draft={occurrence:{kind:'event',anchor:'Ocean workshop',title:'Ocean workshop',sources},description:null,canonical_url:null,organizations:[],
   details:{start:null,end:null,occurrence:null,parent:null,location:null,mode:null,registration_url:null,status:null},identities:[],unknowns:{}};
  for(const condition of ['genuine','unchecked','missing_start','missing_organizations','missing_registration','inaccessible','invalid_fact','stale','document_coverage','occurrence','unsupported','missing_reason','extra_check','bad_status']){
   const source={tracker_id:tr.id,identity:condition,url:'https://example.org/'+condition};let calls=0;
   const result=await processDocument(db,{source,prepared:{...prepared,url:source.url},model:async(_,[input])=>{
    calls++;if(input.stage==='extract')return {understanding:'',research:{requests:[]}};
    const final=structuredClone(draft);
    if(condition==='inaccessible')final.unknowns['details.start']={reason:'inaccessible_source',explanation:'The schedule is not available.'};
    if(condition==='invalid_fact')final.details.start={value:'2026-10-15',precision:'day',sources:[{doc:'P',block:0,quote:'This quote is absent.'}]};
    const response=verdict(input,[final]);if(condition==='unchecked')response.checks[0].checked_fields=[];
    const omitted={missing_start:'details.start',missing_organizations:'organizations',missing_registration:'details.registration_url'}[condition];
    if(omitted)response.checks[0].checked_fields=response.checks[0].checked_fields.filter(f=>f!==omitted);
    if(condition==='stale')response.input_hash='stale';if(condition==='document_coverage')response.checked_documents=[];
    if(condition==='occurrence')response.checks[0].occurrence.status='uncertain';if(condition==='unsupported')response.checks[0].occurrence.status='unsupported';
    if(condition==='missing_reason')delete response.checks[0].occurrence.reason;if(condition==='extra_check')response.checks[0].claims=[];
    if(condition==='bad_status')response.checks[0].occurrence.status='probably';return response;
   }});
   const state=(await db.query('select * from scout.source_state where identity=$1',[condition])).rows[0];
   assert.equal(calls,2);assert.equal(result.state,condition==='genuine'?'complete':['occurrence','unsupported'].includes(condition)?'parked':'deferred',condition);assert.equal(Boolean(state.processed_hash),condition==='genuine');
   if(['missing_reason','extra_check','bad_status'].includes(condition)){assert.equal(result.reason,'invalid_output');assert.equal(state.attempts,1);}
  }
 }finally{await db.close();}
});

test('completion recovers announcement and treaty dates with their distinct meanings and organization roles',async()=>{
 const db=await setup();try{
  const tr=await tracker(db);
  for(const kind of ['announcement','treaty_status']){
   const title=kind==='announcement'?'Ocean policy announced':'Ocean treaty ratification',url=kind==='announcement'?'https://example.org/policy':'https://treaties.un.org/action';
   const text=kind==='announcement'?'Ocean Council issued Ocean policy announced on 1 October 2026, effective 15 October 2026.':'United Nations recorded Ocean treaty ratification by Example State on 1 October 2026, effective 15 October 2026.';
   const prepared=prepareDocument({url,title:'',html:'<p>'+text+'</p>'}),sources=[{doc:'P',block:0,quote:text}],claim=value=>({value,sources});
   const details=kind==='announcement'?{published:null,effective:null,subjects:null}:{treaty:claim('Ocean treaty'),jurisdiction:claim('Example State'),action:claim('ratification'),action_date:null,effective:null};
   const draft={occurrence:{kind,anchor:title,title,sources},description:null,canonical_url:null,organizations:[],details,identities:[],unknowns:{}};
   const source={tracker_id:tr.id,identity:kind,url};let calls=0;
   const result=await processDocument(db,{source,prepared,support:()=>assert.fail('No requested support'),model:async(_,[input])=>{
    calls++;if(input.stage==='extract')return {understanding:'A development with dates to check.',research:{requests:[]}};
    const final=structuredClone(draft);final.organizations=[{name:kind==='announcement'?'Ocean Council':'United Nations',role:kind==='announcement'?'issuer':'authority',sources}];
    final.details[kind==='announcement'?'published':'action_date']={value:'2026-10-01',precision:'day',sources};
    final.details.effective={value:'2026-10-15',precision:'day',sources};return verdict(input,[final]);
   }});
   assert.equal(result.state,'complete');assert.equal(calls,2);
   const saved=(await db.query('select * from scout.records where kind=$1',[kind])).rows[0];
   assert.equal(saved.details[kind==='announcement'?'published':'action_date'].value,'2026-10-01');assert.equal(saved.details.effective.value,'2026-10-15');
   assert.deepEqual(saved.organizations,[{name:kind==='announcement'?'Ocean Council':'United Nations',role:kind==='announcement'?'issuer':'authority'}]);
  }
 }finally{await db.close();}
});

test('changed parked input refused before generation reopens with zero consumed attempts',async()=>{
 const db=await setup();try{
  const tr=await tracker(db),source={tracker_id:tr.id,identity:'parked-quota',url:'https://example.org/parked-quota'};
  await db.query("insert into scout.source_state(tracker_id,identity,url,state,attempts,observed_hash,reason) values($1,$2,$3,'parked',3,'previous','attempt_bound')",[tr.id,source.identity,source.url]);
  let calls=0;
  const result=await processDocument(db,{source,prepared:prepareDocument({url:source.url,title:'',html:'<p>Changed source.</p>'}),model:()=>{
   calls++;throw Object.assign(new Error('quota'),{reason:'quota',dispatched:false,deferred:{retry_at:new Date(Date.now()+3600000).toISOString()}});
  }});
  assert.equal(result.state,'deferred');assert.equal(result.reason,'quota');assert.equal(calls,1);
  const state=(await db.query('select * from scout.source_state')).rows[0];assert.equal(state.attempts,0);assert.equal(state.processed_hash,null);assert.ok(state.due_at.getTime()>=Date.now()+3500000);
 }finally{await db.close();}
});

test('requested URLs are explicit, deduplicated and bounded across all findings and redirects',async()=>{
 const db=await setup();try{
  const tr=await tracker(db),url='https://example.org/main',prepared=prepareDocument({url,title:'',html:'<p>Ocean workshop and Ocean announcement.</p>'+[1,2,3,4].map(n=>'<a href="/support'+n+'">Source '+n+'</a>').join('')});
  const sources=[{doc:'P',block:0,quote:'Ocean workshop and Ocean announcement.'}];
  const findings=[{occurrence:{kind:'event',anchor:'Ocean workshop',title:'Ocean workshop',sources},description:null,canonical_url:null,organizations:[],details:{start:null,end:null,occurrence:null,parent:null,location:null,mode:null,registration_url:null,status:null},identities:[],unknowns:{}},
   {occurrence:{kind:'announcement',anchor:'Ocean announcement',title:'Ocean announcement',sources},description:null,canonical_url:null,organizations:[],details:{published:null,effective:null,subjects:null},identities:[],unknowns:{}}];
  const cases=[{name:'duplicate',urls:['support1','support1','support2'],reads:2,state:'complete'},
   {name:'three',urls:['support1','support2','support3'],reads:3,state:'complete'},
   {name:'four',urls:['support1','support2','support3','support4'],reads:0,state:'deferred'},
   {name:'unsupplied',urls:['other'],reads:0,state:'deferred'},
   {name:'unsafe',urls:['http://example.org/support1'],reads:0,state:'deferred'},
   {name:'credentials',urls:['https://user:pass@example.org/support1'],reads:0,state:'deferred'},
   {name:'private_ip',urls:['https://127.0.0.1/support1'],reads:0,state:'deferred'},
   {name:'declared_fields',urls:['support1'],reads:1,state:'complete',fields:['details.start.time','details.currency','details.occurrence']},
   {name:'invented_field',urls:['support1'],reads:0,state:'deferred',fields:['details.invented']},
   {name:'non_date_clock',urls:['support1'],reads:0,state:'deferred',fields:['details.location.time']},
   {name:'redirect_budget',urls:['support1','support2','support3'],reads:2,state:'deferred',charge:2}];
  for(const example of cases){
   const source={tracker_id:tr.id,identity:example.name,url:'https://example.org/'+example.name},main={...prepared,url:source.url},reads=[],budget={requests:0,deadline:Date.now()+100000};let calls=0;
   const result=await processDocument(db,{source,prepared:main,model:async(_,[input])=>{
    calls++;if(input.stage==='extract')return {understanding:'Notes may mention details.invented without extending allowed request fields.',
     research:{requests:example.urls.map(u=>({url:u.includes(':')?u:'https://example.org/'+u,needed_for:example.fields??['organizations'],reason:'Check named participants.'}))}};
    return verdict(input,findings);
   },support:requests=>supportDocuments(db,{source,prepared:main,sourceURL,budget,limits:{requests:4},requests,read:async(target,shared)=>{
    shared.requests+=example.charge??1;reads.push(target);return {url:target,status:200,body:'<p>No additional details.</p><a href="/recursive">Do not fetch</a>',headers:{'content-type':'text/html'}};
   }})});
   assert.equal(result.state,example.state,example.name);assert.equal(reads.length,example.reads,example.name);assert.ok(calls<=2);
   assert.ok(!reads.some(u=>u.includes('recursive')));assert.ok(budget.support_reads<=3||!budget.support_reads);
  }
 }finally{await db.close();}
});

test('typed dates preserve calendar precision, unknown zones and DST ambiguity',()=>{
  assert.deepEqual(dateInterval({value:'2024-02',precision:'month'}),['2024-02-01','2024-02-29']);
  assert.equal(dateInterval({value:'2026-02-30',precision:'day'}),null);
  assert.deepEqual(normalizeDate({value:'2026-10-15',precision:'day',time:'00:30',zone:'+08:00'}),
    {value:'2026-10-15',precision:'day',time:'00:30',zone:'+08:00',utc:'2026-10-14T16:30:00.000Z'});
  assert.equal(normalizeDate({value:'2026-11-01',precision:'day',time:'01:30',zone:'America/New_York'}).utc,undefined);
  assert.equal(normalizeDate({value:'2026-03-08',precision:'day',time:'02:30',zone:'America/New_York'}).utc,undefined);
  assert.equal(normalizeDate({value:'2026-10-15',precision:'day',time:'15:00',zone:'Europe/Paris'}).utc,'2026-10-15T13:00:00.000Z');
  assert.equal(normalizeDate({value:'2026-10-15',precision:'day',time:'15:00'}).utc,undefined);
  assert.throws(()=>normalizeDate({value:'2026-10',precision:'month',time:'12:00'}));
  for(const [zone,utc] of [['UTC','2028-02-29T23:59:59.000Z'],['Z','2028-02-29T23:59:59.000Z'],['+14:00','2028-02-29T09:59:59.000Z'],['-14:00','2028-03-01T13:59:59.000Z']])
    assert.equal(normalizeDate({value:'2028-02-29',precision:'day',time:'23:59:59',zone}).utc,utc);
  for(const time of ['3PM','15:0','24:00','23:59:60'])assert.throws(()=>normalizeDate({value:'2028-02-29',precision:'day',time}));
  for(const zone of ['CEST','UTC+02:00','+24:00'])assert.throws(()=>normalizeDate({value:'2028-02-29',precision:'day',time:'15:00',zone}));
  for(const date of [{value:'0000',precision:'year'},{value:'2028-13',precision:'month'},{value:'2028-02',precision:'day'}])assert.throws(()=>normalizeDate(date));
  assert.deepEqual(findingInterval({kind:'announcement',details:{published:{value:'2026-03',precision:'month'},effective:{value:'2027',precision:'year'}}}),['2026-03-01','2026-03-31']);
  assert.equal(dateLabel({value:'2026-03',precision:'month'}),'2026-03 · month precision');
});
