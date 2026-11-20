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
const finding={description:'HSA: Clearing-House Mechanism technical webinar',details:'A technical demonstration of information-sharing tools.',type:'event',priority:'high',organizations:['HSA'],date:'2099-12-10',starttime:null,timezone:null,enddate:null,endtime:null,supporting_urls:[]};
const create=fields=>({action:'create',id:null,fields,reason:null});
const update=(r,fields)=>({action:'update',id:r.id,fields,reason:null});
const answer=decisions=>({status:'complete',decisions});
const response=output=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(output)}]}]});
const rss=(entries=[['a',publication,'CHM webinar']])=>new Response('<rss version="2.0"><channel>'+entries.map(([id,url,title])=>`<item><guid>${id}</guid><link>${url}</link><title>${title}</title><description>Summary ${title}</description></item>`).join('')+'</channel></rss>',{headers:{'content-type':'application/rss+xml'}});
async function setup(t,{before=false}={}){
 const raw=new PGlite();t.after(()=>raw.close());
 await raw.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema vault;create table vault.secrets(name text,secret text);create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');create table auth.identities(user_id uuid,provider text,identity_data jsonb);create function auth.uid() returns uuid language sql as $$select null::uuid$$;`);
 for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort()){
  if(before&&name===(before===true?'20261118180000_scout_shared_ingestion.sql':before))break;
  await raw.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 }
 const db=database({unsafe:async(q,p=[])=>{const r=await raw.query(q,p);return Object.assign(r.rows,{count:r.affectedRows??r.rows.length});}});
 const tracker=(await raw.query("insert into scout.trackers(name,url,collector,cadence,enabled) values('HSA', $1,'web_index','1 day',true) returning *",[feedURL])).rows[0];
 return {raw,db,tracker};
}
const model=decide=>(item,{functions,readUrl})=>async(_instructions,input)=>decide({item,input,readUrl,search:args=>functions[0].run(args)});

test('root fetch failure returns HTTP diagnostics without discovery, model calls or acknowledged progress',async t=>{
 const {raw,db,tracker}=await setup(t);
 const result=await intake(db,{trackerId:tracker.id,sourceFetch:async()=>new Response('Do not return this body',{status:403}),modelFor:()=>assert.fail('Root retrieval failed before discovery')});
 assert.equal(result.state,'deferred');assert.equal(result.reason,'source_unavailable');assert.equal(result.processed,0);
 assert.deepEqual(result.diagnostics,[{url:feedURL,stage:'response',http_status:403,error_name:'Error',error_code:null,error_message:'source_unavailable',reason:'source_unavailable'}]);
 assert.equal(result.source.bytes,0);assert.equal(result.source.requests,1);assert.equal((await raw.query('select count(*)::int n from scout.source_items')).rows[0].n,0);
 const state=(await raw.query('select * from scout.trackers where id=$1',[tracker.id])).rows[0];
 assert.equal(state.failure_count,1);assert.equal(state.last_error,'source_unavailable');assert.equal(state.last_successful_check,null);assert.equal(state.discovery_checked_at,null);
 t.diagnostic(JSON.stringify({mocked_http:true,model_calls:0,cost:db.metrics}));
});

test('Page investigates the complete source, follows evidence links and skips unchanged repeats without discovery',async t=>{
 const {raw,db,tracker}=await setup(t);
 await raw.query("update scout.trackers set collector='web_page' where id=$1",[tracker.id]);
 const agenda='https://example.org/agenda';let calls=0;
 const run=()=>intake(db,{trackerId:tracker.id,sourceFetch:async url=>new Response(url===agenda?'<main>Workshop agenda: technical demonstration</main>':'<main>BBNJ implementation workshop on 10 December 2099. <a href="/agenda">Agenda</a></main>',{headers:{'content-type':'text/html'}}),modelFor:(item,{functions,readUrl})=>async(_instructions,input,schema)=>{
  calls++;assert.ok(!schema.properties.items);assert.equal(item.url,feedURL);assert.match(JSON.stringify(input),/BBNJ implementation workshop/);
  assert.match(JSON.stringify(await readUrl(agenda)),/technical demonstration/);
  await functions[0].run({queries:['HSA'],urls:[]});
  return answer([create({...finding,supporting_urls:[agenda]})]);
 }});
 const first=await run();assert.equal(first.state,'saved');assert.equal(first.created,1);assert.equal(calls,1);
 const record=(await raw.query('select * from scout.records')).rows[0];
 assert.deepEqual(record.sources,[{url:feedURL,role:'finding'},{url:agenda,role:'supporting'}]);
 assert.deepEqual((await raw.query('select item_key,pending from scout.source_items')).rows,[{item_key:feedURL,pending:false}]);
 const preview=await prepareMessages(db,{kind:'findings',ids:[record.id]});assert.ok(preview.payloads[0].text.includes('<'+feedURL+'|Read more>'));
 const cost={...db.metrics},repeat=await run();assert.equal(repeat.processed,0);assert.equal(calls,1);
 assert.deepEqual((await raw.query('select * from scout.records')).rows[0],record);
 t.diagnostic(JSON.stringify({mocked_model:true,page_sql_cost:cost,unchanged_sql_cost:Object.fromEntries(Object.keys(cost).map(k=>[k,db.metrics[k]-cost[k]]))}));
});

test('Index investigates linked publications without turning itself into a finding item',async t=>{
 const {raw,db,tracker}=await setup(t);let discoveries=0,investigations=0;
 const result=await intake(db,{trackerId:tracker.id,sourceFetch:async url=>new Response(url===publication?'<main>CHM technical webinar</main>':'<main><a href="'+publication+'">CHM webinar</a></main>',{headers:{'content-type':'text/html'}}),modelFor:(item,{functions})=>async(_instructions,_input,schema)=>{
  if(schema.properties.items){discoveries++;return {items:[{url:feedURL,summary:'Index'},{url:publication,summary:'CHM webinar'}]};}
  investigations++;assert.equal(item.url,publication);await functions[0].run({queries:['HSA'],urls:[]});return answer([create(finding)]);
 }});
 assert.equal(result.state,'saved');assert.equal(discoveries,1);assert.equal(investigations,1);
 assert.deepEqual((await raw.query('select item_key from scout.source_items')).rows,[{item_key:publication}]);
 assert.deepEqual((await raw.query('select sources from scout.records')).rows[0].sources,[{url:publication,role:'finding'}]);
});

test('a notification configuration failure preserves the saved finding, reports its reason and does not replay collection',async t=>{
 const {raw,db,tracker}=await setup(t);await raw.query("update scout.trackers set collector='web_page' where id=$1",[tracker.id]);
 let sends=0;
 const run=()=>intake(db,{trackerId:tracker.id,sourceFetch:async()=>new Response('<main>CHM technical webinar</main>',{headers:{'content-type':'text/html'}}),
  modelFor:model(async({search})=>{await search({queries:['HSA'],urls:[]});return answer([create(finding)]);}),
  notify:async()=>{sends++;throw Object.assign(new Error('Do not expose raw configuration'),{reason:'slack_configuration'});}});
 const first=await run();assert.equal(first.created,1);assert.equal(first.state,'saved');
 assert.deepEqual(first.notifications,[{status:'unknown',communicated:0,error:'slack_configuration'}]);
 assert.equal((await raw.query('select count(*)::int n from scout.records')).rows[0].n,1);
 assert.equal((await run()).created,0);assert.equal(sends,1);
});

test('tracker modes preserve index progress, reset changed modes and replace Bloomberg without deleting findings',async t=>{
 const name='20261119180000_scout_tracker_modes.sql', {raw,tracker}=await setup(t,{before:name});
 await raw.query("update scout.trackers set collector='web',last_checked_at=now(),last_successful_check=now(),discovery_request_url=url,discovery_checked_at=now(),discovery_fingerprint='keep' where id=$1",[tracker.id]);
 await raw.query("insert into scout.source_items(tracker_id,item_key,url,pending) values($1,'keep',$2,false)",[tracker.id,publication]);
 const original=(await raw.query('select * from scout.trackers where id=$1',[tracker.id])).rows[0];
 const un='fa465a3b-c9d3-4810-9efb-cd6ab9dcc49c',bloomberg='b95f96b1-1252-43f5-93ea-e17cc8704b49';
 await raw.query("insert into scout.trackers(id,name,url,collector,cadence,enabled) values($1,'UN','https://treaties.un.org/status','web','1 day',true),($2,'Bloomberg','https://www.bloomberg.org/environment/protecting-the-oceans/','web','1 day',true)",[un,bloomberg]);
 await raw.query("update scout.trackers set last_checked_at=now(),last_successful_check=now(),lease_id=gen_random_uuid(),lease_until=now()+interval '1 minute',discovery_request_url=url,discovery_checked_at=now(),discovery_fingerprint='obsolete' where id=$1",[un]);
 await raw.query("insert into scout.source_items(tracker_id,item_key,url,pending) select id,'obsolete',url,true from scout.trackers where id in ($1,$2)",[un,bloomberg]);
 await raw.exec("insert into scout.records(description) values('Keep useful finding')");
 await raw.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 assert.deepEqual((await raw.query('select * from scout.trackers where id=$1',[tracker.id])).rows[0],{...original,collector:'web_index'});
 assert.equal((await raw.query('select item_key from scout.source_items where tracker_id=$1',[tracker.id])).rows[0].item_key,'keep');
 const page=(await raw.query('select * from scout.trackers where id=$1',[un])).rows[0];assert.equal(page.collector,'web_page');assert.equal(page.enabled,true);
 for(const key of ['last_checked_at','last_successful_check','lease_id','lease_until','discovery_request_url','discovery_checked_at','discovery_fingerprint'])assert.equal(page[key],null);
 assert.equal((await raw.query('select count(*)::int n from scout.source_items where tracker_id in ($1,$2)',[un,bloomberg])).rows[0].n,0);
 const press=(await raw.query('select * from scout.trackers where id=$1',[bloomberg])).rows[0];assert.equal(press.url,'https://www.bloomberg.org/press/');assert.equal(press.collector,'web_index');assert.equal(press.enabled,true);assert.equal(press.last_successful_check,null);
 const blog=(await raw.query("select * from scout.trackers where url='https://www.bloomberg.org/blog/'")).rows[0];assert.equal(blog.collector,'web_index');assert.equal(blog.enabled,true);assert.equal(blog.last_successful_check,null);
 await raw.query("update scout.trackers set enabled=false,collector='web_page' where id=$1",[tracker.id]);assert.equal((await raw.query('select enabled from scout.trackers where id=$1',[tracker.id])).rows[0].enabled,false);
 assert.equal((await raw.query('select count(*)::int n from scout.records')).rows[0].n,1);
 await assert.rejects(raw.query("update scout.trackers set collector='web' where id=$1",[tracker.id]),{code:'23514'});
});

test('RSS -> real provider-tool mechanics -> duplicate update -> specific Slack finding URL; stable repeat makes zero model calls',async t=>{
 const {raw,db,tracker}=await setup(t);
 const id=(await raw.query("insert into scout.records(description,type,priority,sources) values('HSA technical CHM webinar','event','high',$1::jsonb) returning id",[JSON.stringify([{url:feedURL,role:'unclassified'}])])).rows[0].id;
 let requests=0,searches=0;
 const run=()=>intake(db,{trackerId:tracker.id,sourceFetch:async()=>rss(),modelFor:(source,options)=>trackerModel({source,...options,openaiApiKey:'fixture',fetch:async(_url,request)=>{
  requests++;const body=JSON.parse(request.body);assert.equal(body.store,false);
  const output=body.input.find(i=>i.type==='function_call_output');
  if(!output){searches++;assert.ok(body.tools.some(f=>f.name==='search_findings'));return Response.json({status:'completed',output:[{type:'function_call',name:'search_findings',call_id:'lookup',arguments:JSON.stringify({queries:['HSA CHM'],urls:[]})}]});}
  const candidates=JSON.parse(output.output);assert.equal(candidates.records.length,1);
  for(const key of ['revision','modified','pending','slack_channel_post'])assert.equal(Object.hasOwn(candidates.records[0],key),false);
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

test('attempted timeout commits a skip, unattempted items stay pending, and resume moves forward',async t=>{
 const {raw,db,tracker}=await setup(t);const seen=[];
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const run=()=>intake(db,{trackerId:tracker.id,sourceFetch:async url=>url===feedURL?rss([['a',publication,'A'],['b',publication+'-b','B'],['c',publication+'-c','C']]):new Response('<main>Article</main>',{headers:{'content-type':'text/html'}}),modelFor:model(async({item,search})=>{
  seen.push(item.url);if(item.url.endsWith('-b')){t.mock.timers.tick(100001);throw Object.assign(new Error('runtime_bound'),{reason:'runtime_bound'});}
  await search({queries:['HSA'],urls:[]});return answer([create({...finding,description:item.url})]);
 })});
 const first=await run();assert.equal(first.processed,2);assert.equal(first.skipped,1);assert.equal(first.state,'deferred');
 assert.deepEqual((await raw.query('select pending,last_error from scout.source_items order by item_key')).rows,[{pending:false,last_error:null},{pending:false,last_error:'runtime_bound'},{pending:true,last_error:null}]);
 assert.equal((await raw.query("select request_checked_at from scout.source_items where item_key='b'")).rows[0].request_checked_at,null);
 t.mock.timers.reset();seen.length=0;const second=await run();assert.equal(second.processed,1);assert.deepEqual(seen,[publication+'-c']);
 assert.equal((await raw.query('select count(*)::int n from scout.records')).rows[0].n,2);
 assert.ok((await raw.query('select * from scout.source_items')).rows.every(r=>!r.pending));
});

test('an unavailable pending link is reported and consumed without a model call, preserving its last successful read while the next item saves',async t=>{
 const {raw,db,tracker}=await setup(t),bad=publication+'-bad';const seen=[];
 await raw.query("insert into scout.source_items(tracker_id,item_key,url,request_url,request_checked_at,request_fingerprint) values($1,'a',$2,$2,now()-interval '1 day','prior'),($1,'b',$3,null,null,null)",[tracker.id,bad,publication]);
 const prior=(await raw.query("select * from scout.source_items where item_key='a'")).rows[0],before={...db.metrics};
 const result=await intake(db,{trackerId:tracker.id,sourceFetch:async url=>{if(url===bad)throw new Error('Unavailable');return new Response('<main>CHM webinar</main>',{headers:{'content-type':'text/html'}});},modelFor:model(async({item,search})=>{
  seen.push(item.url);await search({queries:['HSA'],urls:[]});return answer([create(finding)]);
 })});
 assert.equal(result.state,'saved');assert.equal(result.created,1);assert.equal(result.processed,2);assert.equal(result.skipped,1);assert.deepEqual(seen,[publication]);
 assert.ok(result.diagnostics.some(d=>d.url===bad&&d.reason==='source_unavailable'));
 const skipped=(await raw.query("select * from scout.source_items where item_key='a'")).rows[0];
 assert.equal(skipped.pending,false);assert.equal(skipped.last_error,'source_unavailable');assert.ok(skipped.consumed_at);
 for(const key of ['request_url','request_checked_at','request_fingerprint'])assert.deepEqual(skipped[key],prior[key]);
 const parent=(await raw.query('select * from scout.trackers where id=$1',[tracker.id])).rows[0];assert.equal(parent.failure_count,0);assert.equal(parent.last_error,null);assert.deepEqual(parent.last_successful_check,parent.last_checked_at);
 t.diagnostic(JSON.stringify({mocked_model:true,unavailable_link_model_calls:0,unavailable_then_success_sql:Object.fromEntries(Object.keys(before).map(k=>[k,db.metrics[k]-before[k]])),warning_column_bytes:(await raw.query("select pg_column_size(last_error) n from scout.source_items where item_key='a'")).rows[0].n}));
});

test('unreadable and incomplete items do not block later work, and successful rediscovery clears their warnings',async t=>{
 const {raw,db,tracker}=await setup(t);let broken=false,version=0;const seen=[];
 const run=()=>intake(db,{trackerId:tracker.id,sourceFetch:async url=>url===feedURL?rss([['a',publication+'-a','A'+version],['b',publication+'-b','B'+version],['c',publication+'-c','C'+version]]):new Response('<main>Article '+version+'</main>',{headers:{'content-type':'text/html'}}),modelFor:model(async({item})=>{
  seen.push(item.url);if(broken&&!item.url.endsWith('-c'))throw Object.assign(new Error('item failure'),{reason:item.url.endsWith('-a')?'model_unreadable':'output_incomplete'});return answer([]);
 })});
 assert.equal((await run()).processed,3);
 const prior=(await raw.query('select request_checked_at,request_fingerprint from scout.source_items order by item_key')).rows;
 version++;broken=true;seen.length=0;const skipped=await run();assert.equal(skipped.state,'no_findings');assert.equal(skipped.processed,3);assert.equal(skipped.skipped,2);assert.equal(seen.length,3);
 const rows=(await raw.query('select * from scout.source_items order by item_key')).rows;
 assert.deepEqual(rows.map(r=>r.last_error),['model_unreadable','output_incomplete',null]);assert.ok(rows.every(r=>!r.pending));
 for(let i=0;i<2;i++){assert.deepEqual(rows[i].request_checked_at,prior[i].request_checked_at);assert.equal(rows[i].request_fingerprint,prior[i].request_fingerprint);}
 seen.length=0;assert.equal((await run()).processed,0);assert.equal(seen.length,0);
 version++;broken=false;assert.equal((await run()).processed,3);
 assert.ok((await raw.query('select * from scout.source_items')).rows.every(r=>!r.pending&&r.last_error===null&&r.request_fingerprint!==prior[0].request_fingerprint));
});

test('ignored web items survive changed listings, pruning and tracker resets without item reads',async t=>{
 const {raw,db,tracker}=await setup(t),ignoredURL='https://portals.iucn.org/library/sites/library/files/resrecfiles/WCC_2020_RES_128_EN.pdf';
 await raw.query("insert into scout.source_items(tracker_id,item_key,url,pending,ignored,last_error) values($1,$2,$2,false,true,'model_unreadable')",[tracker.id,ignoredURL]);
 const original=(await raw.query('select * from scout.source_items where ignored')).rows[0];
 let version=0,discoveries=0;const reads=[],investigations=[];
 const run=()=>intake(db,{trackerId:tracker.id,sourceFetch:async url=>{
  reads.push(url);assert.notEqual(url,ignoredURL);
  return new Response(url===feedURL?'<main>Index '+version+' '+(version===1?'':`<a href="${ignoredURL}">Ignored resolution</a>`)+`<a href="${publication}">Allowed article</a></main>`:`<main>Allowed article ${version}</main>`,{headers:{'content-type':'text/html'}});
 },modelFor:item=>async(_instructions,_input,schema)=>{
  if(schema.properties.items){discoveries++;return {items:(version===1?[publication]:[ignoredURL,publication]).map(url=>({url,summary:'Listed article'}))};}
  investigations.push(item.url);assert.equal(item.url,publication);return answer([]);
 }});
 for(;version<3;version++){
  assert.equal((await run()).processed,1);
  assert.deepEqual((await raw.query('select * from scout.source_items where ignored')).rows,[original]);
 }
 assert.equal(discoveries,3);assert.deepEqual(investigations,[publication,publication,publication]);
 assert.deepEqual(reads,[feedURL,publication,feedURL,publication,feedURL,publication]);
 await assert.rejects(raw.query('update scout.source_items set pending=true where ignored'),{code:'23514'});
 await raw.query("update scout.trackers set collector='web_page' where id=$1",[tracker.id]);
 assert.deepEqual((await raw.query('select * from scout.source_items')).rows,[original]);
 await raw.query('update scout.trackers set url=$2 where id=$1',[tracker.id,'https://example.org/new']);
 assert.deepEqual((await raw.query('select * from scout.source_items')).rows,[original]);
 t.diagnostic(JSON.stringify({mocked_http_and_models:true,changed_indexes:3,ignored_item_reads:0,ignored_item_investigations:0,cost:db.metrics}));
});

test('irrelevant and reasoned-skip items consume progress without finding writes; failed saves do not consume',async t=>{
 const {raw,db,tracker}=await setup(t);let mode='irrelevant';
 const run=()=>intake(db,{trackerId:tracker.id,sourceFetch:async()=>rss([['a',publication,mode]]),modelFor:model(async({search})=>{
  if(mode==='irrelevant')return answer([]);
  if(mode==='skip')return answer([{action:'skip',id:null,fields:null,reason:'The development is confirmed old.'}]);
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

test('details preserve exact saved text without new facts, retain multibyte text, and missing dates retain saved scheduling facts',()=>{
 const old={...normalizeFinding({...finding,details:'Established facts.',date:'2099-12-10',starttime:'09:00',timezone:'UTC',enddate:'2099-12-12',endtime:'17:00'},publication)};
 const merged=mergeFinding(normalizeFinding({...finding,details:null,date:null,starttime:null,timezone:null,enddate:null,endtime:null},publication),old);
 assert.equal(merged.details,old.details);assert.equal(merged.date,'2099-12-10');assert.equal(merged.starttime,'09:00');assert.equal(merged.enddate,'2099-12-12');
 assert.equal(normalizeFinding({...finding,details:'海'.repeat(1366)},publication).details,'海'.repeat(1366));
 assert.equal(normalizeFinding({...finding,details:'x'.repeat(4096)},publication).details.length,4096);
 assert.equal(mergeFinding(normalizeFinding({...finding,details:'海'.repeat(1366)},publication),old).details,'海'.repeat(1366));
});

test('rescheduled dates and less precise corrections save their source before consumption; identical repeats make no finding write',async t=>{
 const {raw,db,tracker}=await setup(t);
 await raw.query("update scout.trackers set collector='web_page' where id=$1",[tracker.id]);
 const original=(await raw.query("insert into scout.records(description,details,type,priority,organizations,date,starttime,timezone,enddate,endtime,sources) values($1,$2,$3,$4,$5,$6,'09:00','UTC',$7,'17:00',$8::jsonb) returning *",
  [finding.description,finding.details,finding.type,finding.priority,finding.organizations,finding.date,'2099-12-12',JSON.stringify([{url:publication,role:'finding'}])])).rows[0];
 let version=0,modelCalls=0,fields={...finding,date:'2100-01-08',starttime:'10:00',enddate:'2100-01-09',endtime:'18:00',timezone:'UTC'};
 const run=()=>intake(db,{trackerId:tracker.id,sourceFetch:async()=>new Response('<main>Rescheduled HSA workshop version '+version+'</main>',{headers:{'content-type':'text/html'}}),modelFor:model(async({search})=>{
  modelCalls++;const found=await search({queries:['HSA'],urls:[]});
  return answer([update(found.records[0],fields)]);
 })});
 const first=await run();
 assert.equal(first.state,'saved');assert.equal(first.changed,1);assert.equal(first.created,0);assert.equal(first.ambiguous,0);assert.equal(first.processed,1);
 const exact=(await raw.query('select * from scout.records where id=$1',[original.id])).rows[0];
 assert.equal(exact.date,fields.date);assert.equal(exact.starttime,fields.starttime);assert.equal(exact.enddate,fields.enddate);assert.equal(exact.endtime,fields.endtime);
 assert.deepEqual(exact.sources,[{url:publication,role:'finding'},{url:feedURL,role:'finding'}]);
 assert.deepEqual(exact.modified.slice(0,-1),original.modified);
 assert.equal((await raw.query('select pending from scout.source_items where tracker_id=$1',[tracker.id])).rows[0].pending,false);
 fields={...finding,date:'2100-02',enddate:'2100-03'};version++;
 const second=await run();
 assert.equal(second.changed,1);assert.equal(second.created,0);assert.equal(second.ambiguous,0);assert.equal(second.processed,1);
 const partial=(await raw.query('select * from scout.records where id=$1',[original.id])).rows[0];
 assert.equal(partial.date,'2100-02');assert.equal(partial.enddate,'2100-03');assert.equal(partial.endtime,null);
 assert.deepEqual(partial.sources,exact.sources);assert.deepEqual(partial.modified.slice(0,-1),exact.modified);
 const cost={...db.metrics};version++;
 const repeat=await run();
 assert.equal(repeat.changed,0);assert.equal(repeat.saved,1);assert.equal(repeat.processed,1);assert.equal(modelCalls,3);
 assert.deepEqual((await raw.query('select * from scout.records')).rows,[partial]);
 assert.equal((await raw.query('select pending from scout.source_items where tracker_id=$1',[tracker.id])).rows[0].pending,false);
 t.diagnostic(JSON.stringify({mocked_model:true,real_local_sql:true,identical_finding_writes:0,repeat_cost:Object.fromEntries(Object.keys(cost).map(k=>[k,db.metrics[k]-cost[k]]))}));
});

test('text limits clip Unicode, avoid identical repeat writes and validate existing descriptions',async t=>{
 const name='20261119230000_scout_text_limits.sql',{raw,db}=await setup(t,{before:name});
 const legacy=(await raw.query('insert into scout.records(description,details) values($1,$2) returning *,modified::text[] as modified',
  ['海'.repeat(281),'Established facts.'])).rows[0];
 await raw.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 assert.deepEqual((await raw.query('select *,modified::text[] as modified from scout.records where id=$1',[legacy.id])).rows[0],legacy);
 for(const [description,details] of [['x'.repeat(281),null],['Short label','🐟'.repeat(4097)]])
  await assert.rejects(raw.query('insert into scout.records(description,details) values($1,$2)',[description,details]),{code:'23514'});
 const incoming={...finding,description:'🐟'.repeat(281),details:'🐟'.repeat(4097)},item={url:publication},args={queries:['HSA'],urls:[publication]};
 const first=await searchFindings(db,args);
 assert.equal((await db.transaction(tx=>applyDecisions(tx,[{item,investigation:{decisions:[create(incoming)],lookups:[{args,records:first.records}],invalid_fields:{}}}]))).created,1);
 const saved=(await searchFindings(db,args)).records[0];
 assert.equal(saved.description,'🐟'.repeat(280));assert.equal(saved.details,'🐟'.repeat(4096));
 const repeated=await db.transaction(tx=>applyDecisions(tx,[{item,investigation:{decisions:[update(saved,incoming)],lookups:[{args,records:[saved]}],invalid_fields:{}}}]));
 assert.equal(repeated.saved,1);assert.equal(repeated.changed,0);
 assert.deepEqual((await searchFindings(db,args)).records[0],saved);
 await raw.exec(await readFile(new URL('../supabase/migrations/20261119234000_scout_validate_description_limit.sql',import.meta.url),'utf8'));
 const clipped=(await raw.query('select *,modified::text[] as modified from scout.records where id=$1',[legacy.id])).rows[0];
 assert.equal(clipped.description,'海'.repeat(280));assert.equal(clipped.details,legacy.details);
 assert.deepEqual(clipped.modified.slice(0,-1),legacy.modified);
 assert.equal((await raw.query("select convalidated from pg_constraint where conrelid='scout.records'::regclass and conname='records_description_length'")).rows[0].convalidated,true);
 assert.deepEqual((await searchFindings(db,args)).records[0],saved);
});

test('field removal preserves facts, reviews and progress, and rolls back if a deadline cannot fit',async t=>{
 const name='20261119190000_scout_finding_contract.sql',{raw,tracker}=await setup(t,{before:name});
 const sql=await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
 const treaty=(await raw.query("insert into scout.records(description,type,date,deadline,details,sources) values('Official ratification','treaty_status','2026-11-15','2026-12','Established facts.',$1::jsonb) returning id",
  [JSON.stringify([{url:publication,role:'finding'}])])).rows[0].id;
 const overflow=(await raw.query("insert into scout.records(description,type,date,deadline,details) values('Application call','announcement','2026-11-16','2026-12-01',$1) returning id",['海'.repeat(1365)])).rows[0].id;
 await raw.exec("insert into scout.records(description,type) values('Unaffected finding','event')");
 const reviewer='00000000-0000-0000-0000-000000000001';
 await raw.query('insert into auth.users(id) values($1)',[reviewer]);
 await raw.query("insert into scout.finding_reviews(reviewer_id,record_id,priority,notes) values($1,$2,'high','Consequential treaty development')",[reviewer,treaty]);
 await raw.query("insert into scout.source_items(tracker_id,item_key,url,pending) values($1,'committed',$2,false)",[tracker.id,publication]);
 const before=(await raw.query('select *,modified::text[] as modified from scout.records order by id')).rows;
 const reviews=(await raw.query('select * from scout.finding_reviews')).rows;
 const progress=(await raw.query('select * from scout.source_items')).rows;
 await assert.rejects(raw.exec(sql),{code:'23514'});
 await raw.exec('rollback');
 assert.deepEqual((await raw.query('select *,modified::text[] as modified from scout.records order by id')).rows,before);
 await raw.query('update scout.records set details=null where id=$1',[overflow]);
 const started=performance.now();await raw.exec(sql);
 t.diagnostic(JSON.stringify({in_memory_database:true,migration_ms:Math.round(performance.now()-started),converted_rows:2,model_calls:0}));
 const records=(await raw.query('select *,modified::text[] as modified from scout.records order by id')).rows;
 for(const record of records){
  const old=before.find(r=>r.id===record.id);
  assert.equal(Object.hasOwn(record,'deadline'),false);
  assert.equal(record.date,old.date);assert.deepEqual(record.sources,old.sources);
  if(record.id===treaty||record.id===overflow){
   assert.deepEqual(record.modified.slice(0,-1),old.modified);
   assert.equal(record.modified.length,old.modified.length+1);
  }else{
   const {deadline,...unchanged}=old;assert.deepEqual(record,unchanged);
  }
 }
 assert.equal(records.find(r=>r.id===treaty).type,'announcement');
 assert.equal(records.find(r=>r.id===treaty).details,'Established facts. Submission deadline: 2026-12.');
 assert.equal(records.find(r=>r.id===overflow).details,'Submission deadline: 2026-12-01.');
 assert.deepEqual((await raw.query('select * from scout.finding_reviews')).rows,reviews);
 assert.deepEqual((await raw.query('select * from scout.source_items')).rows,progress);
 assert.deepEqual((await raw.query('select * from scout.trackers where id=$1',[tracker.id])).rows[0],tracker);
 assert.equal((await raw.query("select count(*)::int n from pg_proc where pronamespace='scout'::regnamespace and proname='findings'")).rows[0].n,1);
 assert.equal((await raw.query("select to_regclass('scout.records_deadlines') name")).rows[0].name,null);
 await assert.rejects(raw.query("insert into scout.records(description,type) values('Obsolete type','treaty_status')"),{code:'23514'});
 await raw.exec('set role anon');
 await assert.rejects(raw.query('select * from scout.findings()'),{code:'42501'});
 await raw.exec('reset role;set role authenticated');
 assert.deepEqual((await raw.query('select * from scout.findings()')).rows,[]);
 await raw.exec('reset role;set role service_role');
 assert.equal((await raw.query("select * from scout.findings(p_search=>'Submission deadline',p_from=>'2026-11-15',p_to=>'2026-11-15')")).rows[0].id,treaty);
 await raw.exec('reset role');
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
   investigations++;assert.equal(input.current_date,'2026-11-17');assert.equal(Object.hasOwn(input,'oldest_date'),false);
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
  investigations++;if(broken)throw Object.assign(new Error('provider_unavailable'),{reason:'provider_unavailable'});
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
  if(failure==='model')throw Object.assign(new Error('provider_unavailable'),{reason:'provider_unavailable'});
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
 const item=(await raw.query('select * from scout.source_items')).rows[0];assert.equal(item.pending,false);assert.equal(item.request_checked_at,null);assert.equal(item.last_error,'source_unavailable');assert.equal(result.skipped,0);
 assert.ok(result.diagnostics.some(d=>d.url===publication&&d.stage==='fetch'&&d.http_status===null&&d.error_message==='Unavailable'));
});

test('CBD discovery and item investigation reuse the API response while retaining the public finding URL',async t=>{
 const {raw,db,tracker}=await setup(t),publicURL='https://www.cbd.int/conferences/2026/parallel-meetings/ocean';let reads=0;
 await raw.query("update scout.trackers set url=$2,collector='web_page' where id=$1",[tracker.id,publicURL]);
 const result=await intake(db,{trackerId:tracker.id,sourceFetch:async url=>{reads++;assert.equal(new URL(url).pathname,'/api/v2017/articles');return Response.json([{title:{en:'CHM webinar'},content:{en:'<p>Technical information-sharing webinar</p>'}}]);},modelFor:(_item,options)=>async(_p,input,schema)=>{
  if(schema.properties.items)return {items:[{url:publicURL,summary:'CHM webinar'}]};
  assert.equal(input.content.content[0].title,'CHM webinar');assert.match(input.content.content[0].content,/Technical information-sharing/);
  await options.functions[0].run({queries:['HSA'],urls:[]});return answer([create(finding)]);
 }});
 assert.equal(reads,1);assert.equal(result.created,1);assert.deepEqual((await raw.query('select sources from scout.records')).rows[0].sources,[{url:publicURL,role:'finding'}]);
});
