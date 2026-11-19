import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {database} from '../reader/database.js';
import {intake} from '../reader/intake.js';
import {normalizeFinding,mergeFinding,searchFindings,applyDecisions} from '../reader/findings.js';
import {prepareMessages} from '../slackbot/slack.js';
import {rssItems} from '../reader/sources/rss.js';
import {trackerModel} from '../reader/models/gateway.js';

beforeEach(t=>t.mock.method(dns,'lookup',async()=>[{address:'93.184.216.34',family:4}]));
const publication='https://example.org/articles/chm',feedURL='https://example.org/feed/';
const finding={description:'HSA: Clearing-House Mechanism technical webinar',details:'A technical demonstration of information-sharing tools.',type:'event',priority:'high',organizations:['HSA'],date:'2099-12-10',deadline:null,starttime:null,timezone:null,enddate:null,endtime:null,supporting_urls:[]};
const create=fields=>({action:'create',id:null,expected_revision:null,fields,reason:null});
const update=(r,fields)=>({action:'update',id:r.id,expected_revision:r.revision,fields,reason:null});
const answer=decisions=>({status:'complete',decisions});
const response=output=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(output)}]}]});
const rss=(entries=[['a',publication,'CHM webinar']])=>new Response('<rss version="2.0"><channel>'+entries.map(([id,url,title])=>`<item><guid>${id}</guid><link>${url}</link><title>${title}</title><description>Summary ${title}</description></item>`).join('')+'</channel></rss>',{headers:{'content-type':'application/rss+xml'}});
async function setup(t,{before=false}={}){
 const raw=new PGlite();t.after(()=>raw.close());
 await raw.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema vault;create table vault.secrets(name text,secret text);create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');create table auth.identities(user_id uuid,provider text,identity_data jsonb);create function auth.uid() returns uuid language sql as $$select null::uuid$$;`);
 for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort()){
  if(before&&name==='20261118180000_scout_shared_ingestion.sql')break;
  await raw.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 }
 const db=database({unsafe:async(q,p=[])=>{const r=await raw.query(q,p);return Object.assign(r.rows,{count:r.affectedRows??r.rows.length});}});
 const tracker=(await raw.query("insert into scout.trackers(name,url,collector,cadence,enabled) values('HSA', $1,'web','1 day',true) returning *",[feedURL])).rows[0];
 return {raw,db,tracker};
}
const model=decide=>(item,{functions,readUrl})=>async(_instructions,input)=>decide({item,input,readUrl,search:args=>functions[0].run(args)});

test('RSS -> real provider-tool mechanics -> duplicate update -> specific Slack finding URL; stable repeat makes zero model calls',async t=>{
 const {raw,db,tracker}=await setup(t);
 const id=(await raw.query("insert into scout.records(description,type,priority,sources) values('HSA technical CHM webinar','event','high',$1::jsonb) returning id",[JSON.stringify([{url:feedURL,role:'unclassified'}])])).rows[0].id;
 let requests=0,searches=0;
 const run=()=>intake(db,{trackerId:tracker.id,sourceFetch:async()=>rss(),modelFor:(source,options)=>trackerModel({source,...options,openaiApiKey:'fixture',fetch:async(_url,request)=>{
  requests++;const body=JSON.parse(request.body);assert.equal(body.store,false);
  const output=body.input.find(i=>i.type==='function_call_output');
  if(!output){searches++;assert.ok(body.tools.some(f=>f.name==='search_findings'));return Response.json({status:'completed',output:[{type:'function_call',name:'search_findings',call_id:'lookup',arguments:JSON.stringify({queries:['HSA CHM'],urls:[]})}]});}
  const candidates=JSON.parse(output.output);assert.equal(candidates.records.length,1);
  return response(answer([update(candidates.records[0],finding)]));
 }})});
 const first=await run();assert.equal(first.changed,1);assert.equal(first.created,0);assert.equal(searches,1);
 const record=(await raw.query('select * from scout.records where id=$1',[id])).rows[0];
 assert.ok(record.sources.some(s=>s.role==='finding'&&s.url===publication));assert.equal(record.details,finding.details);
 const preview=await prepareMessages(db,{kind:'findings',ids:[id]});assert.match(preview.payloads[0].text,/<https:\/\/example.org\/articles\/chm\|Read more>/);
 const before=requests;const repeat=await run();assert.equal(repeat.processed,0);assert.equal(requests,before);
 assert.deepEqual((await raw.query('select * from scout.records where id=$1',[id])).rows[0],record);
 assert.equal((await raw.query('select pending from scout.source_items')).rows[0].pending,false);
 t.diagnostic(JSON.stringify({mocked_model:true,first_sql_cost:db.metrics,duplicate_searches:searches}));
});

test('matched updates retain new source URLs and unchanged facts; identical updates consume progress without finding writes',async t=>{
 const {raw,db,tracker}=await setup(t);
 const id=(await raw.query('insert into scout.records(description,details,type,priority,organizations,date,sources) values($1,$2,$3,$4,$5,$6,$7::jsonb) returning id',
  [finding.description,finding.details,finding.type,finding.priority,finding.organizations,finding.date,JSON.stringify([{url:feedURL,role:'unclassified'}])])).rows[0].id;
 const original=(await raw.query('select * from scout.records where id=$1',[id])).rows[0];
 let version=0,requests=0,searches=0;
 const run=()=>intake(db,{trackerId:tracker.id,sourceFetch:async url=>url===feedURL?rss([['a',publication,'CHM webinar revision '+version]]):new Response('<main>Article revision '+version+'</main>',{headers:{'content-type':'text/html'}}),modelFor:(source,options)=>trackerModel({source,...options,openaiApiKey:'fixture',fetch:async(_url,request)=>{
  requests++;const body=JSON.parse(request.body),output=body.input.find(i=>i.type==='function_call_output');
  if(!output){searches++;return Response.json({status:'completed',output:[{type:'function_call',name:'search_findings',call_id:'lookup',arguments:JSON.stringify({queries:['HSA'],urls:[]})}]});}
  const candidates=JSON.parse(output.output);assert.equal(candidates.records.length,1);
  return response(answer([update(candidates.records[0],finding)]));
 }})});
 const first=await run();assert.equal(first.state,'saved');assert.equal(first.created,0);assert.equal(first.changed,1);assert.equal(first.processed,1);
 const record=(await raw.query('select * from scout.records where id=$1',[id])).rows[0];
 assert.deepEqual(record,{...original,sources:[...original.sources,{url:publication,role:'finding'}],modified:record.modified});
 assert.deepEqual(record.modified.slice(0,-1),original.modified);
 const firstCost={...db.metrics};version++;
 const second=await run();assert.equal(second.state,'saved');assert.equal(second.created,0);assert.equal(second.changed,0);assert.equal(second.saved,1);assert.equal(second.processed,1);
 assert.equal(searches,2);assert.equal(requests,4);
 assert.deepEqual((await raw.query('select * from scout.records where id=$1',[id])).rows[0],record);
 assert.equal((await raw.query('select pending from scout.source_items')).rows[0].pending,false);
 t.diagnostic(JSON.stringify({mocked_model:true,first_sql_cost:firstCost,identical_update_sql_cost:Object.fromEntries(Object.keys(firstCost).map(k=>[k,db.metrics[k]-firstCost[k]])),identical_finding_writes:0}));
});

test('timeout retains pending URL, earlier committed item survives, and resume never reinvestigates it',async t=>{
 const {raw,db,tracker}=await setup(t);const seen=[];let fail=true;
 const run=()=>intake(db,{trackerId:tracker.id,sourceFetch:async url=>url===feedURL?rss([['a',publication,'A'],['b',publication+'-b','B']]):new Response('<main>B article</main>',{headers:{'content-type':'text/html'}}),modelFor:model(async({item,search})=>{
  seen.push(item.url);if(item.url.endsWith('-b')&&fail)throw Object.assign(new Error('runtime_bound'),{reason:'runtime_bound'});
  await search({queries:['HSA'],urls:[]});return answer([create({...finding,description:item.url})]);
 })});
 const first=await run();assert.equal(first.processed,1);assert.equal(first.state,'deferred');
 assert.deepEqual((await raw.query('select pending from scout.source_items order by item_key')).rows.map(r=>r.pending),[false,true]);
 fail=false;seen.length=0;const second=await run();assert.equal(second.processed,1);assert.deepEqual(seen,[publication+'-b']);
 assert.equal((await raw.query('select count(*)::int n from scout.records')).rows[0].n,2);
 assert.ok((await raw.query('select * from scout.source_items')).rows.every(r=>!r.pending));
});

test('irrelevant and identity-skip items consume progress without finding writes; failed saves do not consume',async t=>{
 const {raw,db,tracker}=await setup(t);let mode='irrelevant';
 const run=()=>intake(db,{trackerId:tracker.id,sourceFetch:async()=>rss([['a',publication,mode]]),modelFor:model(async({search})=>{
  if(mode==='irrelevant')return answer([]);
  if(mode==='skip')return answer([{action:'skip',id:null,expected_revision:null,fields:null,reason:'identity_unresolved'}]);
  await search({queries:['HSA'],urls:[]});return answer([create({...finding,description:'Reject'})]);
 })});
 assert.equal((await run()).processed,1);mode='skip';assert.equal((await run()).ambiguous,1);
 await raw.exec("alter table scout.records add constraint reject_fixture check(description<>'Reject')");mode='fail';
 const failed=await run();assert.equal(failed.state,'deferred');assert.equal(failed.processed,0);
 assert.equal((await raw.query('select pending from scout.source_items')).rows[0].pending,true);
 assert.equal((await raw.query('select count(*)::int n from scout.records')).rows[0].n,0);
});

test('read-only search crosses type/date and includes details; stale update or changed create searches roll back',async t=>{
 const {raw,db}=await setup(t);
 const id=(await raw.query("insert into scout.records(description,type,date,details,sources) values('Short label','announcement','2020','Specific technical tool version five','[]') returning id")).rows[0].id;
 const args={queries:['technical five'],urls:[]},lookup=await searchFindings(db,args);assert.equal(lookup.records[0].id,id);
 const item={url:publication};const investigation={decisions:[update(lookup.records[0],finding)],lookups:[{args,records:lookup.records}],invalid_scheduling:{}};
 await raw.query("update scout.records set modified=array_append(modified,clock_timestamp()) where id=$1",[id]);
 await assert.rejects(db.transaction(tx=>applyDecisions(tx,[{item,investigation}])),{reason:'stale_record'});
 const emptyArgs={queries:['brand new'],urls:[]},empty=await searchFindings(db,emptyArgs);
 await raw.query("insert into scout.records(description,sources) values('Brand new development','[]')");
 await assert.rejects(db.transaction(tx=>applyDecisions(tx,[{item,investigation:{decisions:[create(finding)],lookups:[{args:emptyArgs,records:empty.records}],invalid_scheduling:{}}}])),{reason:'stale_record'});
 assert.equal((await raw.query('select count(*)::int n from scout.records')).rows[0].n,2);
});

test('details preserve exact saved text without new facts, remain bounded by UTF-8 bytes, and ends retain compatible saved precision',()=>{
 const old={...normalizeFinding({...finding,details:'Established facts.',date:'2099-12-10',starttime:'09:00',timezone:'UTC',enddate:'2099-12-12',endtime:'17:00'},publication)};
 const merged=mergeFinding(normalizeFinding({...finding,details:null,date:'2099-12',starttime:null,timezone:null,enddate:null,endtime:null},publication),old);
 assert.equal(merged.details,old.details);assert.equal(merged.date,'2099-12-10');assert.equal(merged.starttime,'09:00');assert.equal(merged.enddate,'2099-12-12');
 assert.equal(normalizeFinding({...finding,details:'海'.repeat(1366)},publication).details,null);
 assert.equal(normalizeFinding({...finding,details:'x'.repeat(4096)},publication).details.length,4096);
 assert.equal(mergeFinding(normalizeFinding({...finding,details:'海'.repeat(1366)},publication),old).details,old.details);
});

test('migration preserves IDs, timestamps and source URLs; reset clears only operational item state and browser cannot read it',async t=>{
 const {raw,tracker}=await setup(t,{before:true});
 const old=(await raw.query("insert into scout.records(description,sources,modified) values('Preserve',array['https://example.org/old'],array['2020-01-01 00:00:00.000001+00'::timestamptz]) returning id,modified::text[] as modified")).rows[0];
 await raw.exec(await readFile(new URL('../supabase/migrations/20261118180000_scout_shared_ingestion.sql',import.meta.url),'utf8'));
 const current=(await raw.query('select *,modified::text[] as modified from scout.records')).rows[0];
 assert.equal(current.id,old.id);assert.deepEqual(current.modified,old.modified);assert.deepEqual(current.sources,[{url:'https://example.org/old',role:'unclassified'}]);assert.equal(current.details,null);
 await raw.query('insert into scout.source_items(tracker_id,item_key,url) values($1,$2,$3)',[tracker.id,'entry',publication]);
 await raw.exec('set role authenticated');await assert.rejects(raw.query('select * from scout.source_items'),{code:'42501'});await raw.exec('reset role');
 await raw.query('update scout.trackers set url=$2 where id=$1',[tracker.id,'https://example.org/new']);
 assert.equal((await raw.query('select count(*)::int n from scout.source_items')).rows[0].n,0);assert.equal((await raw.query('select count(*)::int n from scout.records')).rows[0].n,1);
});

test('RSS handles GUIDs, entities and Atom links, while webpage discovery keeps observed specific URLs',async t=>{
 const atom=rssItems({url:feedURL,media_type:'application/atom+xml',content:'<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>stable</id><link href="https://example.org/article"/><title>A &amp; B</title><summary>Useful</summary></entry></feed>'});
 assert.equal(atom[0].key,'stable');assert.equal(atom[0].content.content.title,'A & B');
 const {raw,db,tracker}=await setup(t);let discoveries=0,investigations=0;
 const result=await intake(db,{trackerId:tracker.id,sourceFetch:async()=>new Response('<main><a href="/articles/chm">CHM news</a></main>',{headers:{'content-type':'text/html'}}),modelFor:(item,options)=>async(_p,_input,schema)=>{
  if(schema.properties.items){discoveries++;return {items:[{url:publication,summary:'CHM news'},{url:'https://example.org/invented',summary:'Unobserved'}]};}
  investigations++;await options.functions[0].run({queries:['HSA'],urls:[]});return answer([create(finding)]);
 }});
 assert.equal(discoveries,1);assert.equal(investigations,1);assert.equal(result.created,1);
 assert.equal(result.state,'deferred');assert.ok(result.diagnostics.some(d=>d.excluded_items===1));
 const progress=(await raw.query('select discovery_checked_at,discovery_fingerprint from scout.trackers where id=$1',[tracker.id])).rows[0];
 assert.equal(progress.discovery_checked_at,null);assert.equal(progress.discovery_fingerprint,null);
});

test('UN linked document index updates three existing findings with PDF message links; repeating makes no finding writes',async t=>{
 const {raw,db,tracker}=await setup(t);
 const root='https://www.un.org/bbnjagreement/en',index=root+'/COP/documents/first-meeting';
 const documents=['20261102BBNJCOP1CHMStudyAdvanceUnedited.pdf','20261103BBNJCOP1AnnotatedAgendaModalitiesAdvanceUnedited.pdf','20261102BBNJCOP1SecArrangementsAdvanceUnedited.pdf']
  .map((file,i)=>({url:'https://www.un.org/bbnjagreement/sites/default/files/2026-11/'+file,description:['United Nations: CHM study','United Nations: COP1 agenda and modalities','United Nations: Secretariat arrangements'][i]}));
 await raw.query('update scout.trackers set url=$2 where id=$1',[tracker.id,root]);
 for(const doc of documents)await raw.query("insert into scout.records(description,type,priority,sources) values($1,'announcement','high',$2::jsonb)",
  [doc.description,JSON.stringify([{url:index,role:'finding'},{url:doc.url,role:'finding'}])]);
 const ids=(await raw.query('select id from scout.records order by id')).rows.map(r=>r.id);
 let version=0,discoveries=0,investigations=0;
 const run=()=>intake(db,{trackerId:tracker.id,sourceFetch:async url=>new Response(url===root?`<main>Version ${version}<a href="${index}">COP1 documents</a></main>`:
  url===index?'<main>'+documents.map(doc=>`<a href="${doc.url}">${doc.description}</a>`).join('')+'</main>':'%PDF',
  {headers:{'content-type':documents.some(doc=>doc.url===url)?'application/pdf':'text/html'}}),modelFor:(item,options)=>async(_p,_input,schema)=>{
   if(schema.properties.items){
    discoveries++;const listing=await options.readUrl(index);
    assert.ok(documents.every(doc=>listing.content.includes(doc.url)));
    return {items:documents.map(doc=>({url:doc.url,summary:doc.description}))};
   }
   investigations++;assert.notEqual(item.url,index);await options.readUrl(index);
   const found=await options.functions[0].run({queries:[],urls:[item.url]});assert.equal(found.count,1);
   return answer([update(found.records[0],{...finding,description:found.records[0].description,type:'announcement',organizations:['United Nations'],supporting_urls:[index,item.url]})]);
  }});
 const first=await run();assert.equal(first.created,0);assert.equal(first.changed,3);assert.equal(first.processed,3);
 const records=(await raw.query('select * from scout.records order by id')).rows;
 assert.deepEqual(records.map(r=>r.id),ids);
 for(const record of records){
  const doc=documents.find(doc=>doc.description===record.description);
  assert.deepEqual(record.sources,[{url:index,role:'supporting'},{url:doc.url,role:'finding'}]);
 }
 const preview=await prepareMessages(db,{kind:'findings',ids});
 for(const [i,record] of preview.records.entries())assert.ok(preview.payloads[i].text.includes('<'+documents.find(doc=>doc.description===record.description).url+'|Read more>'));
 const firstCost={...db.metrics};version++;
 const second=await run();assert.equal(second.created,0);assert.equal(second.changed,0);assert.equal(second.processed,3);
 assert.deepEqual((await raw.query('select * from scout.records order by id')).rows,records);
 assert.deepEqual([discoveries,investigations],[2,6]);
 assert.deepEqual((await raw.query('select url from scout.source_items order by url')).rows.map(r=>r.url),documents.map(doc=>doc.url).sort());
 t.diagnostic(JSON.stringify({mocked_model:true,first_sql_cost:firstCost,repeat_sql_cost:Object.fromEntries(Object.keys(firstCost).map(k=>[k,db.metrics[k]-firstCost[k]])),finding_writes_on_repeat:0}));
});

test('three unsuccessful attempts stop automatic retries, explicit retry recovers, and retirement prevents collection',async t=>{
 const {raw,db,tracker}=await setup(t);let calls=0,broken=true;
 const options={sourceFetch:async()=>rss(),modelFor:model(async()=>{calls++;if(broken)throw Object.assign(new Error('provider_unavailable'),{reason:'provider_unavailable'});return answer([]);})};
 for(let i=1;i<=3;i++)assert.equal((await intake(db,options)).state,i===3?'needs_attention':'deferred');
 assert.equal(calls,3);assert.equal((await intake(db,options)).state,'idle');
 broken=false;assert.equal((await intake(db,{...options,trackerId:tracker.id})).processed,1);
 await raw.query("update scout.trackers set retire_on=(clock_timestamp() at time zone 'America/New_York')::date where id=$1",[tracker.id]);
 assert.equal((await intake(db,{...options,trackerId:tracker.id})).state,'idle');
});

test('tied native posts see proposed facts before commit and retain both specific post URLs',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-17T12:00:00Z')});
 const {raw,db,tracker}=await setup(t);
 const feed='https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=example.test';
 await raw.query('update scout.trackers set url=$2 where id=$1',[tracker.id,feed]);
 const post=key=>({post:{uri:'at://did:plc:example/app.bsky.feed.post/'+key,indexedAt:'2026-11-17T12:00:00Z',record:{text:key,createdAt:'2026-11-17T12:00:00Z'}}});
 let calls=0;
 const result=await intake(db,{trackerId:tracker.id,sourceFetch:async()=>Response.json({feed:[post('a'),post('b')]}),modelFor:model(async({search})=>{
  const found=await search({queries:['HSA'],urls:[]});calls++;
  return answer([found.count?update(found.records[0],{...finding,details:found.records[0].details+' Fact B.'}):create({...finding,details:'Fact A.'})]);
 })});
 assert.equal(calls,2);assert.equal(result.created,1);assert.equal(result.changed,1);assert.equal(result.processed,2);
 const records=(await raw.query('select * from scout.records')).rows;assert.equal(records.length,1);assert.equal(records[0].details,'Fact A. Fact B.');
 assert.deepEqual(records[0].sources.map(s=>s.url).sort(),['https://bsky.app/profile/did:plc:example/post/a','https://bsky.app/profile/did:plc:example/post/b']);
});

test('Bluesky parent announcements keep their own URLs when the following replies are consumed',async t=>{
 const {raw,db,tracker}=await setup(t),did='did:plc:sy46sp7hq6g5rtgagijggqeg';
 await raw.query('update scout.trackers set url=$2 where id=$1',[tracker.id,'https://bsky.app/profile/'+did]);
 const cases=[
  {key:'3myuxaiw4i22l',phrase:'NBSAP Accelerator Action Account',organization:'UNDP',description:'UNDP announces the NBSAP Accelerator Action Account and IKI-UNDP Nature Pledge Flagship Fund.'},
  {key:'3myxd26zhn22p',phrase:'16 landscapes in 15 countries',organization:'Earth Negotiations Bulletin',description:'Earth Negotiations Bulletin reports that LLF supports 16 landscapes in 15 countries and has disbursed over USD 60 million.'}
 ];
 const posts=[
  [cases[0].key,cases[0].description],['3myuxdj4p4s2l','BIOFIN discusses the Yerevan Biodiversity Finance Challenge.'],
  [cases[1].key,cases[1].description],['3myxd64ej5k2p','Barry Gold discusses a less fragmented conservation finance landscape.']
 ].map(([key,text],i)=>{const at=new Date(Date.now()-60000+i*1000).toISOString();return {post:{uri:'at://'+did+'/app.bsky.feed.post/'+key,indexedAt:at,record:{text,createdAt:at}}};});
 posts[1].reply={parent:posts[0].post,root:posts[0].post};posts[3].reply={parent:posts[2].post,root:posts[2].post};
 let calls=0;
 const run=()=>intake(db,{trackerId:tracker.id,sourceFetch:async()=>Response.json({feed:posts}),modelFor:model(async({input,search})=>{
  calls++;const decisions=[];
  // Reproduce the observed model behavior: use any announcement supplied in context.
  for(const source of cases.filter(c=>JSON.stringify(input.content).includes(c.phrase))){
   const found=await search({queries:[source.organization],urls:[]});
   const fields={...finding,description:source.description,type:'announcement',organizations:[source.organization],date:null,details:null};
   decisions.push(found.count?update(found.records[0],fields):create(fields));
  }
  return answer(decisions);
 })});
 const first=await run();assert.equal(first.created,2);assert.equal(first.changed,0);assert.equal(first.processed,4);assert.equal(calls,4);
 const records=(await raw.query('select * from scout.records order by id')).rows;
 for(const source of cases)assert.deepEqual(records.find(r=>r.description===source.description).sources,[{url:'https://bsky.app/profile/'+did+'/post/'+source.key,role:'finding'}]);
 const preview=await prepareMessages(db,{kind:'findings',ids:records.map(r=>r.id)});
 assert.equal(preview.payloads.length,2);
 for(const source of cases)assert.ok(preview.payloads.some(p=>p.text.includes('<https://bsky.app/profile/'+did+'/post/'+source.key+'|Read more>')));
 const cost={...db.metrics};const repeat=await run();assert.equal(repeat.processed,0);assert.equal(calls,4);
 assert.deepEqual((await raw.query('select * from scout.records order by id')).rows,records);
 t.diagnostic(JSON.stringify({mocked_model:true,sql_cost:cost,repeat_model_calls:0}));
});

test('expired original posts, including recent reposts, make zero model calls and no per-post SQL writes',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-17T12:00:00Z')});
 const {raw,db,tracker}=await setup(t),feed='https://bsky.app/profile/example.test';
 await raw.query('update scout.trackers set url=$2 where id=$1',[tracker.id,feed]);
 const costs=[];
 for(const count of [1,40]){
  // Re-run from a stale checkpoint fixture so the shared ingestion gate sees each recent repost.
  await raw.query("update scout.trackers set last_successful_check='2024-01-01' where id=$1",[tracker.id]);
  const expired=Array.from({length:count},(_,i)=>({post:{uri:'at://did:plc:example/app.bsky.feed.post/old'+i,indexedAt:'2026-10-17T03:59:59.999Z',record:{text:'Expired original',createdAt:'2026-10-17T03:59:59.999Z'}},
   reason:{$type:'app.bsky.feed.defs#reasonRepost',indexedAt:'2026-11-17T10:00:00Z'}}));
  const before={...db.metrics};
  const result=await intake(db,{trackerId:tracker.id,sourceFetch:async()=>Response.json({feed:expired}),modelFor:()=>assert.fail('Expired originals must never reach a model')});
  assert.equal(result.state,'no_findings');assert.equal(result.processed,0);
  const cost={statements:db.metrics.statements-before.statements,mutations:db.metrics.mutations-before.mutations};costs.push(cost);
  assert.equal(cost.mutations,2);
  const state=(await raw.query('select last_successful_check,last_checked_at from scout.trackers where id=$1',[tracker.id])).rows[0];
  assert.deepEqual(state.last_successful_check,state.last_checked_at);
 }
 assert.deepEqual(costs[0],costs[1]);
 assert.equal((await raw.query('select count(*)::int n from scout.source_items')).rows[0].n,0);
 assert.equal((await raw.query('select count(*)::int n from scout.records')).rows[0].n,0);
 t.diagnostic(JSON.stringify({mocked_feed:true,real_local_sql:true,expired_posts:[1,40],sql_cost_per_check:costs[0],model_calls:0,retained_post_rows:0}));
 await raw.query('update scout.trackers set last_successful_check=null where id=$1',[tracker.id]);
 const boundary={post:{uri:'at://did:plc:example/app.bsky.feed.post/boundary',indexedAt:'2026-10-17T04:00:00Z',record:{text:'Cutoff day',createdAt:'2026-10-17T04:00:00Z'}}};let calls=0;
 const included=await intake(db,{trackerId:tracker.id,sourceFetch:async()=>Response.json({feed:[boundary]}),modelFor:()=>async()=>{calls++;return answer([]);}});
 assert.equal(included.processed,1);assert.equal(calls,1);
});

test('old web and RSS publication hints permit new and changed content; confirmed old findings remain unsaved',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-17T12:00:00Z')});
 for(const kind of ['web','rss']){
  const {raw,db,tracker}=await setup(t);let version=0,investigations=0;
  const run=()=>intake(db,{trackerId:tracker.id,sourceFetch:async url=>{
   if(url===feedURL&&kind==='rss')return new Response(`<rss version="2.0"><channel><item><guid>stable</guid><link>${publication}</link><title>Webinar ${version}</title><pubDate>Sat, 01 Jan 2000 12:00:00 GMT</pubDate></item></channel></rss>`,{headers:{'content-type':'application/rss+xml'}});
   return new Response(`<main><time datetime="2000-01-01">Published January 1, 2000</time>`+(url===feedURL?`<a href="${publication}">Webinar ${version}</a>`:`Updated webinar ${version}`)+'</main>',{headers:{'content-type':'text/html'}});
  },modelFor:(_item,options)=>async(_p,input,schema)=>{
   if(schema.properties.items)return {items:[{url:publication,summary:'Published January 1, 2000; updated webinar'}]};
   investigations++;assert.equal(input.oldest_date,'2026-10-17');
   const found=await options.functions[0].run({queries:['HSA'],urls:[]}),fields={...finding,details:'Revision '+version};
   return answer([found.count?update(found.records[0],fields):create(fields),create({...finding,description:'Old report',type:'announcement',date:'2000-01-01'})]);
  }});
  assert.equal((await run()).created,1);version++;assert.equal((await run()).changed,1);
  const records=(await raw.query('select description,details from scout.records')).rows;
  assert.deepEqual(records,[{description:finding.description,details:'Revision 1'}]);assert.equal(investigations,2);
  assert.equal((await run()).processed,0);assert.equal(investigations,2);
 }
});

test('web freshness gates discovery and article investigation separately, while pending articles resume',async t=>{
 const {raw,db,tracker}=await setup(t);let indexUnchanged=false,articleUnchanged=false,broken=false,indexReads=0,articleReads=0,discoveries=0,investigations=0;
 const run=()=>intake(db,{trackerId:tracker.id,sourceFetch:async(url,options)=>{
  const index=url===feedURL;if(index)indexReads++;else articleReads++;
  const unchanged=index?indexUnchanged:articleUnchanged;
  if(unchanged){assert.ok(options.headers?.['If-Modified-Since']);return new Response(null,{status:304});}
  return new Response(index?`<main><a href="/articles/chm">CHM news ${indexReads}</a></main>`:`<main>Technical CHM webinar ${articleReads}</main>`,{headers:{'content-type':'text/html'}});
 },modelFor:(_item,options)=>async(_p,_input,schema)=>{
  if(schema.properties.items){discoveries++;return {items:[{url:publication,summary:'CHM news'}]};}
  investigations++;if(broken)throw Object.assign(new Error('runtime_bound'),{reason:'runtime_bound'});
  return answer([]);
 }});
 assert.equal((await run()).processed,1);assert.deepEqual([discoveries,investigations,indexReads,articleReads],[1,1,1,1]);
 indexUnchanged=true;assert.equal((await run()).processed,0);assert.deepEqual([discoveries,investigations,indexReads,articleReads],[1,1,2,1]);
 indexUnchanged=false;articleUnchanged=true;assert.equal((await run()).processed,1);assert.deepEqual([discoveries,investigations,indexReads,articleReads],[2,1,3,2]);
 articleUnchanged=false;broken=true;assert.equal((await run()).state,'deferred');
 assert.equal((await raw.query('select pending from scout.source_items')).rows[0].pending,true);
 indexUnchanged=true;broken=false;assert.equal((await run()).processed,1);assert.deepEqual([discoveries,investigations,indexReads,articleReads],[3,3,4,4]);
});

test('content fingerprints skip unchanged indexes and articles and advance only after successful processing',async t=>{
 const {raw,db,tracker}=await setup(t);let indexVersion=0,articleVersion=0,noise=0,failure=null,discoveries=0,investigations=0,indexReads=0;
 const run=()=>intake(db,{trackerId:tracker.id,sourceFetch:async url=>{
  const index=url===feedURL;if(index)indexReads++;
  return new Response(`<nav>${noise}</nav><script>noise(${noise})</script><main>`+(index?
   `<a href="/articles/chm">CHM news ${indexVersion}</a>`:`Technical CHM webinar ${articleVersion}`)+'</main>',{headers:{'content-type':'text/html'}});
 },modelFor:(_item,options)=>async(_p,_input,schema)=>{
  if(schema.properties.items){discoveries++;return {items:[{url:publication,summary:'CHM news'}]};}
  investigations++;
  if(failure==='model')throw Object.assign(new Error('runtime_bound'),{reason:'runtime_bound'});
  if(failure==='save'){await options.functions[0].run({queries:['HSA'],urls:[]});return answer([create({...finding,description:'Reject'})]);}
  return answer([]);
 }});
 assert.equal((await run()).processed,1);
 const initial=(await raw.query('select request_fingerprint from scout.source_items')).rows[0].request_fingerprint;
 assert.match(initial,/^[a-f0-9]{64}$/);
 const before={...db.metrics};noise++;assert.equal((await run()).processed,0);
 assert.deepEqual([discoveries,investigations],[1,1]);
 t.diagnostic(JSON.stringify({unchanged_index_sql:Object.fromEntries(Object.keys(before).map(k=>[k,db.metrics[k]-before[k]]))}));
 indexVersion++;assert.equal((await run()).processed,1);assert.deepEqual([discoveries,investigations],[2,1]);
 indexVersion++;articleVersion++;failure='model';assert.equal((await run()).state,'deferred');
 let item=(await raw.query('select * from scout.source_items')).rows[0];assert.equal(item.pending,true);assert.equal(item.request_fingerprint,initial);
 const reads=indexReads;failure=null;assert.equal((await run()).processed,1);assert.equal(indexReads,reads);
 item=(await raw.query('select * from scout.source_items')).rows[0];assert.equal(item.pending,false);assert.notEqual(item.request_fingerprint,initial);
 const committed=item.request_fingerprint;
 await raw.exec("alter table scout.records add constraint reject_fingerprint_fixture check(description<>'Reject')");
 indexVersion++;articleVersion++;failure='save';assert.equal((await run()).state,'deferred');
 item=(await raw.query('select * from scout.source_items')).rows[0];assert.equal(item.pending,true);assert.equal(item.request_fingerprint,committed);
 failure=null;assert.equal((await run()).processed,1);
 item=(await raw.query('select * from scout.source_items')).rows[0];assert.equal(item.pending,false);assert.notEqual(item.request_fingerprint,committed);
 const bytes=(await raw.query('select pg_column_size(discovery_fingerprint) n from scout.trackers where id=$1',[tracker.id])).rows[0].n;
 assert.equal(bytes,65);t.diagnostic(JSON.stringify({fingerprint_column_bytes:bytes,findings:(await raw.query('select count(*)::int n from scout.records')).rows[0].n}));
 await raw.exec('set role authenticated');await assert.rejects(raw.query('select discovery_fingerprint from scout.trackers'),{code:'42501'});await raw.exec('reset role');
 await raw.query('update scout.trackers set url=$2 where id=$1',[tracker.id,'https://example.org/new']);
 assert.equal((await raw.query('select discovery_fingerprint from scout.trackers')).rows[0].discovery_fingerprint,null);
 assert.equal((await raw.query('select count(*)::int n from scout.source_items')).rows[0].n,0);
});

test('an empty duplicate search permits a new finding and commits progress',async t=>{
 const {raw,db,tracker}=await setup(t);
 const result=await intake(db,{trackerId:tracker.id,sourceFetch:async()=>rss(),modelFor:model(async({search})=>{
  await search({queries:['HSA unusual title phrase'],urls:[]});return answer([create(finding)]);
 })});
 assert.equal(result.state,'saved');assert.equal(result.created,1);assert.equal(result.processed,1);
 assert.equal((await raw.query('select count(*)::int n from scout.records')).rows[0].n,1);
 assert.equal((await raw.query('select pending from scout.source_items')).rows[0].pending,false);
});

test('inconclusive article freshness still investigates available feed material without acknowledging the failed read',async t=>{
 const {raw,db,tracker}=await setup(t);let calls=0;
 const result=await intake(db,{trackerId:tracker.id,sourceFetch:async url=>{if(url===feedURL)return rss();throw new Error('Unavailable');},modelFor:model(async({item,input})=>{
  calls++;assert.equal(item.url,publication);assert.equal(input.content.content.title,'CHM webinar');return answer([]);
 })});
 assert.equal(calls,1);assert.equal(result.processed,1);assert.equal(result.state,'no_findings');
 const item=(await raw.query('select * from scout.source_items')).rows[0];assert.equal(item.pending,false);assert.equal(item.request_checked_at,null);
});

test('CBD discovery and item investigation reuse the API response while retaining the public finding URL',async t=>{
 const {raw,db,tracker}=await setup(t),publicURL='https://www.cbd.int/conferences/2026/parallel-meetings/ocean';let reads=0;
 await raw.query('update scout.trackers set url=$2 where id=$1',[tracker.id,publicURL]);
 const result=await intake(db,{trackerId:tracker.id,sourceFetch:async url=>{reads++;assert.equal(new URL(url).pathname,'/api/v2017/articles');return Response.json([{title:{en:'CHM webinar'},content:{en:'<p>Technical information-sharing webinar</p>'}}]);},modelFor:(_item,options)=>async(_p,input,schema)=>{
  if(schema.properties.items)return {items:[{url:publicURL,summary:'CHM webinar'}]};
  assert.equal(input.content.content[0].title,'CHM webinar');assert.match(input.content.content[0].content,/Technical information-sharing/);
  await options.functions[0].run({queries:['HSA'],urls:[]});return answer([create(finding)]);
 }});
 assert.equal(reads,1);assert.equal(result.created,1);assert.deepEqual((await raw.query('select sources from scout.records')).rows[0].sources,[{url:publicURL,role:'finding'}]);
});
