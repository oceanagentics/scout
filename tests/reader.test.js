import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {database} from '../reader/database.js';
import {intake} from '../reader/intake.js';
import {readSource} from '../reader/sources.js';
import {INTAKE_INSTRUCTION,RESPONSE_SCHEMA} from '../reader/instructions.js';
import {hostedReader} from '../supabase/functions/scout-reader/index.ts';
import {hostedNotify} from '../supabase/functions/scout-notify/index.ts';

const migration='20261019200000_scout_reader.sql';
async function setup(t,{before=false}={}){
  const raw=new PGlite();t.after(()=>raw.close());
  await raw.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
    create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');create table auth.identities(user_id uuid,provider text,identity_data jsonb);
    create function auth.uid() returns uuid language sql as $$select null::uuid$$;`);
  for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort()){
    if(before&&name===migration)break;
    await raw.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
  }
  return raw;
}
const driver=raw=>({unsafe:async(q,p=[])=>{const r=await raw.query(q,p);r.rows.count=r.affectedRows??r.rows.length;return r.rows;},release(){}});
const tracker=async raw=>(await raw.query("insert into scout.trackers(name,url,collector,cadence,enabled) values('Tracker','https://example.org/list?raw=%2B','web','6 hours',true) returning *")).rows[0];
const due=raw=>raw.exec("update scout.trackers set last_checked_at=clock_timestamp()-cadence-interval '1 second'");
const event={description:'BBNJ implementation workshop',type:'event',priority:'high',organizations:['Ocean Institute'],date:'2026-10',starttime:null,timezone:null};
const answer=(records=[event])=>({status:records.length?'found':'none',records});
const secret='sb_secret_reader_test';

const feedURL='https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=example.test&limit=20';
const post=(key,at)=>({post:{uri:'at://did:plc:example/app.bsky.feed.post/'+key,indexedAt:at,
  author:{did:'did:plc:example',handle:'example.test'},record:{text:key,createdAt:at}}});
const feedTracker=async(raw,url=feedURL)=>{
  const tr=await tracker(raw);
  await raw.query("update scout.trackers set url=$2 where id=$1",[tr.id,url]);
  await raw.query("update scout.trackers set last_successful_check='2026-10-12T00:00:00Z' where id=$1",[tr.id]);
  return tr;
};

test('Bluesky paginates to the date, retains complete post context, and reads oldest first',async()=>{
  const a=post('a','2026-10-13T12:00:00.123Z'),b=post('b','2026-10-14T12:00:00Z'),c=post('c','2026-10-01T12:00:00Z');
  c.reason={$type:'app.bsky.feed.defs#reasonRepost',indexedAt:'2026-10-15T12:00:00Z'};
  a.post.embed={images:[{alt:'Event on October 20',fullsize:'https://example.org/full.png'}]};
  a.reply={parent:{record:{text:'Parent context'}}};
  const pages=[{feed:[c,b],cursor:'page2'},{feed:[],cursor:'page3'},
    {feed:[b,a,post('boundary','2026-10-12T00:00:00Z')],cursor:'do-not-fetch'}],urls=[];
  const items=await readSource({url:'https://bsky.app/profile/example.test',last_successful_check:new Date('2026-10-12T00:00:00Z')},
    {through:'2026-11-02T00:00:00Z',fetch:async url=>{urls.push(new URL(url));return Response.json(pages.shift());}});
  assert.deepEqual(items.map(i=>i.content.post.record.text),['a','b','c']);
  assert.deepEqual(items[0].content,a);assert.equal(items[2].at,c.reason.indexedAt.replace('Z','.000Z'));
  assert.equal(urls[0].searchParams.get('actor'),'example.test');assert.equal(urls[2].searchParams.get('cursor'),'page3');
  assert.equal(urls.length,3);
  const sameDate=await readSource({url:feedURL,last_successful_check:new Date(a.post.indexedAt)},
    {through:'2026-11-02T00:00:00Z',fetch:async()=>Response.json({feed:[a]})});
  assert.deepEqual(sameDate,[]); // Database Date values must retain their milliseconds.
});

test('a failed newer post resumes after committed dates; an unchanged feed makes no model calls',async t=>{
  const raw=await setup(t),tr=await feedTracker(raw),db=database(driver(raw));
  const feed=[post('newer','2026-10-15T12:00:00Z'),post('empty','2026-10-14T12:00:00Z'),post('older','2026-10-13T12:00:00.123Z')];
  let calls=[],broken=true;
  const run=()=>intake(db,{trackerId:tr.id,sourceFetch:async()=>Response.json({feed}),modelFor:source=>async(_p,input)=>{
    assert.equal(source.url,input.url);assert.deepEqual(input.content,feed.find(f=>f.post.record.text===input.content.post.record.text));
    const key=input.content.post.record.text;calls.push(key);
    if(key==='newer'&&broken)throw new Error('provider_unavailable');
    return answer(key==='empty'?[]:[{...event,description:key}]);
  }});
  const first=await run();assert.equal(first.processed,2);assert.equal(first.created,1);assert.equal(first.state,'deferred');
  const state=(await raw.query('select * from scout.trackers')).rows[0];
  assert.equal(new Date(state.last_successful_check).toISOString(),'2026-10-14T12:00:00.000Z');
  broken=false;calls=[];
  const resumed=await run();assert.deepEqual(calls,['newer']);assert.equal(resumed.processed,1);assert.equal(resumed.created,1);
  const records=(await raw.query('select sources from scout.records')).rows;
  assert.equal(records.length,2);assert.ok(records.every(r=>r.sources[0].includes('/post/')));
  calls=[];const before={...db.metrics};
  const empty=await run();assert.equal(empty.processed,0);assert.deepEqual(calls,[]);
  assert.equal(db.metrics.mutations-before.mutations,2);
  t.diagnostic(JSON.stringify({mocked_model:true,real_local_sql:true,empty_feed:{statements:db.metrics.statements-before.statements,mutations:2}}));
});

test('equal timestamps commit together and SQL or invalid-output failures cannot consume a post',async t=>{
  const raw=await setup(t),tr=await feedTracker(raw),db=database(driver(raw));
  const feed=[post('second','2026-10-13T12:00:00Z'),post('first','2026-10-13T12:00:00Z')];
  const initial=(await raw.query('select last_successful_check from scout.trackers')).rows[0].last_successful_check;
  const run=modelFor=>intake(db,{trackerId:tr.id,sourceFetch:async()=>Response.json({feed}),modelFor});
  let n=0;
  const failed=await run(()=>async()=>{if(++n===2)throw new Error('provider_unavailable');return answer();});
  assert.equal(failed.processed,0);
  assert.equal((await raw.query('select count(*)::int n from scout.records')).rows[0].n,0);
  assert.deepEqual((await raw.query('select last_successful_check from scout.trackers')).rows[0].last_successful_check,initial);
  const invalid=await run(()=>async()=>answer([event,{description:''}]));
  assert.equal(invalid.reason,'invalid_output');assert.equal(invalid.processed,0);
  await raw.exec("alter table scout.records add constraint fail_feed_fixture check(description<>'BBNJ implementation workshop')");
  const sqlFailure=await run(()=>async()=>answer());
  assert.equal(sqlFailure.reason,'database_operation');assert.equal(sqlFailure.processed,0);
  assert.deepEqual((await raw.query('select last_successful_check from scout.trackers')).rows[0].last_successful_check,initial);
  await raw.exec('alter table scout.records drop constraint fail_feed_fixture');
  const success=await run(()=>async()=>answer());
  assert.equal(success.processed,2);assert.equal(success.created,1);assert.equal(success.changed,1);
});

test('feed errors preserve the cutoff, and one tracker never consumes another tracker’s posts',async t=>{
  const raw=await setup(t),first=await feedTracker(raw),second=await feedTracker(raw,feedURL.replace('example.test','another.test')),db=database(driver(raw));
  const initial=(await raw.query('select last_successful_check from scout.trackers where id=$1',[first.id])).rows[0].last_successful_check;
  const broken=await intake(db,{trackerId:first.id,sourceFetch:async()=>Response.json({feed:[{post:{}}]}),modelFor:()=>assert.fail('Invalid feed must not reach model')});
  assert.equal(broken.reason,'source_invalid');
  assert.deepEqual((await raw.query('select last_successful_check from scout.trackers where id=$1',[first.id])).rows[0].last_successful_check,initial);
  let calls=0;
  for(const tr of [first,second]){
    const result=await intake(db,{trackerId:tr.id,sourceFetch:async()=>Response.json({feed:[post('item','2026-10-15T00:00:00Z')]}),
      modelFor:()=>async()=>{calls++;return answer([]);}});
    assert.equal(result.processed,1);
  }
  assert.equal(calls,2);
});

test('feed cutoff is backend-owned, starts three weeks back, and resets with URL changes',async t=>{
  const raw=await setup(t),tr=await tracker(raw);
  const age=Date.now()-new Date(tr.last_successful_check).getTime();
  assert.ok(Math.abs(age-21*86400000)<10000);
  await raw.query("update scout.trackers set last_successful_check='2026-01-01',last_checked_at=now() where id=$1",[tr.id]);
  await raw.query("update scout.trackers set url='https://example.org/new' where id=$1",[tr.id]);
  const state=(await raw.query('select * from scout.trackers')).rows[0];
  assert.equal(state.last_checked_at,null);assert.equal(state.enabled,false);
  assert.ok(Math.abs(Date.now()-new Date(state.last_successful_check).getTime()-21*86400000)<10000);
  await raw.exec('set role authenticated');
  await raw.query('select last_successful_check from scout.trackers');
  await assert.rejects(raw.exec('update scout.trackers set last_successful_check=now()'),{code:'42501'});
});
const env={url:'https://example.supabase.co',secretKeys:{default:secret},publishableKeys:{default:'sb_publishable_test'},jwks:null};
const request=query=>new Request('https://example.test/reader'+(query?'?'+query:''),{method:'POST',headers:{apikey:secret}});
const options=raw=>({env,databaseURL:'unused',apiKey:'test',connect:()=>({reserve:async()=>driver(raw),end:async()=>{}})});

test('tracker URL -> one model investigation -> finding and tracker state; due repeat writes no finding',async t=>{
  const raw=await setup(t),tr=await tracker(raw),db=database(driver(raw));let calls=0;
  const modelFor=selected=>async(prompt,input,schema)=>{
    calls++;assert.equal(selected.id,tr.id);assert.equal(prompt,INTAKE_INSTRUCTION);assert.equal(schema,RESPONSE_SCHEMA);
    assert.deepEqual(input,{url:tr.url,current_date:new Date().toISOString().slice(0,10)});return answer();
  };
  const first=await intake(db,{modelFor});assert.equal(first.created,1);assert.equal(calls,1);
  const saved=(await raw.query('select * from scout.records')).rows[0];
  for(const key of ['title','overrides','provenance','kind','version','details','date_span','identities','completeness','relevance'])assert.equal(Object.hasOwn(saved,key),false);
  assert.deepEqual(saved.sources,[tr.url]);
  const state=(await raw.query('select * from scout.trackers')).rows[0];
  assert.equal(state.failure_count,0);assert.equal(state.lease_id,null);assert.equal(state.last_error,null);
  assert.equal(Object.hasOwn(state,'next_check_at'),false);
  assert.deepEqual(state.last_successful_check,state.last_checked_at);
  assert.equal((await intake(db,{modelFor})).state,'idle');assert.equal(calls,1);
  const firstCost={...db.metrics};await due(raw);
  const repeat=await intake(db,{modelFor});assert.equal(repeat.created,0);assert.equal(repeat.changed,0);assert.equal(calls,2);
  assert.deepEqual((await raw.query('select * from scout.records')).rows[0],saved);
  assert.equal(db.metrics.mutations-firstCost.mutations,2);
  const storage=(await raw.query('select pg_column_size(t) bytes from scout.trackers t')).rows[0];
  t.diagnostic(JSON.stringify({mocked:true,first_and_idle:firstCost,repeat_mutations:2,tracker_row_bytes:storage.bytes}));
});

test('failed and crashed attempts stop at three, explicit retry works',async t=>{
  const raw=await setup(t),tr=await tracker(raw),db=database(driver(raw));let calls=0;
  const failure=()=>async()=>{calls++;throw Object.assign(new Error('provider_unknown'),{dispatched:true});};
  for(let n=1;n<=3;n++){
    await due(raw);const result=await intake(db,{modelFor:failure});assert.equal(result.state,n===3?'needs_attention':'deferred');
  }
  await due(raw);assert.equal((await intake(db,{modelFor:failure})).state,'idle');assert.equal(calls,3);
  assert.equal((await intake(db,{trackerId:tr.id,modelFor:()=>async()=>answer([])})).state,'no_findings');
  // A terminated worker still consumes its attempt, including the third one.
  await raw.exec("update scout.trackers set failure_count=3,lease_id=gen_random_uuid(),lease_until=now()-interval '1 second',last_checked_at=now()-cadence");
  assert.equal((await intake(db,{modelFor:failure})).state,'idle');assert.equal(calls,3);
});

test('all returned findings and their text/organizations survive without content or SQL caps',async t=>{
  const raw=await setup(t),tr=await tracker(raw);
  const records=Array.from({length:12},(_,i)=>({...event,description:'Development '+String.fromCharCode(65+i)}));
  records[0].description='A complete description '+ 'details '.repeat(50).trim();
  records[0].organizations=Array.from({length:15},(_,i)=>'Organization '+i);
  const db=database(driver(raw));
  // Earlier SQL work in the same invocation must not prevent a complete save.
  await db.query('select $1::text payload',['x'.repeat(270000)]);
  for(let i=0;i<97;i++)await db.query('select 1');
  const saved=await intake(db,{trackerId:tr.id,modelFor:()=>async()=>answer(records)});
  assert.equal(saved.created,12);
  const stored=(await raw.query('select description,organizations from scout.records')).rows;
  assert.equal(stored.length,12);
  const full=stored.find(r=>r.description===records[0].description);
  assert.equal(full.organizations.length,15);
});

test('multiple developments retain IDs, revised facts update once, and missing dates do not start another model pass',async t=>{
  const raw=await setup(t),tr=await tracker(raw),db=database(driver(raw));let calls=0;
  const records=[event,{...event,description:'Treaty ratification',type:'treaty_status',date:'2026-09-01'},{...event,description:'Implementation report',type:'announcement',date:null}];
  const run=values=>intake(db,{trackerId:tr.id,modelFor:()=>async()=>{calls++;return answer(values);}});
  assert.equal((await run(records)).created,3);
  const before=(await raw.query('select * from scout.records order by description')).rows;
  const revised=records.map((r,i)=>i===0?{...r,date:'2026-10-22',starttime:'13:30',timezone:'UTC'}:r);
  assert.equal((await run(revised)).changed,1);assert.equal(calls,2);
  const after=(await raw.query('select * from scout.records order by description')).rows;
  assert.deepEqual(after.map(r=>r.id),before.map(r=>r.id));
  assert.equal(after[0].modified.length,before[0].modified.length+1);assert.equal(after[0].date,'2026-10-22');assert.equal(after[0].starttime,'13:30');assert.equal(after[0].timezone,'UTC');
  assert.equal((await run(revised)).changed,0);
  await raw.exec('set role service_role');
  assert.equal((await raw.query("select * from scout.findings(p_type=>'treaty_status',p_from=>'2026-09-01',p_to=>'2026-09-01')")).rows.length,1);
});

test('live lease excludes overlapping requests; URL changes and expired leases cannot save findings',async t=>{
  const raw=await setup(t),tr=await tracker(raw),db=database(driver(raw));
  const result=await intake(db,{modelFor:()=>async()=>{
    assert.equal((await intake(db,{trackerId:tr.id,modelFor:()=>assert.fail('No overlapping model')})).state,'idle');
    await raw.query("update scout.trackers set url='unreadable input' where id=$1",[tr.id]);return answer();
  }});
  assert.equal(result.state,'stale');assert.equal((await raw.query('select count(*)::int n from scout.records')).rows[0].n,0);
  assert.equal((await raw.query('select failure_count from scout.trackers')).rows[0].failure_count,0);
  const expired=await intake(db,{trackerId:tr.id,modelFor:tr=>async(_p,input)=>{
    assert.equal(input.url,'unreadable input');assert.equal(tr.url,input.url);
    await raw.exec("update scout.trackers set lease_until=now()-interval '1 second'");return answer();
  }});
  assert.equal(expired.state,'stale');assert.equal((await raw.query('select count(*)::int n from scout.records')).rows[0].n,0);
});

test('finding failure rolls back the finding and successful tracker completion together',async t=>{
  const raw=await setup(t);await tracker(raw);
  await raw.exec("alter table scout.records add constraint fail_fixture check(description<>'BBNJ implementation workshop')");
  const result=await intake(database(driver(raw)),{modelFor:()=>async()=>answer()});
  assert.equal(result.state,'deferred');assert.equal((await raw.query('select count(*)::int n from scout.records')).rows[0].n,0);
  const state=(await raw.query('select * from scout.trackers')).rows[0];assert.equal(state.failure_count,1);assert.equal(state.last_error,'database_operation');
});

test('hosted reader works without quota policy and retains finite fallback without model accounting',async t=>{
  const raw=await setup(t),tr=await tracker(raw);let gemini=0,openai=0;
  const config={...options(raw),openaiApiKey:'test',modelFetch:async(url,init)=>{
    const body=JSON.parse(init.body);
    if(url.includes('googleapis')){gemini++;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'[]'}]}}]});}
    openai++;assert.deepEqual(JSON.parse(body.input),{input:{url:tr.url,current_date:new Date().toISOString().slice(0,10)},urls:[tr.url]});
    return Response.json({status:'completed',usage:{input_tokens:100,output_tokens:100},output:[
      {type:'web_search_call',status:'completed',action:{type:'open_page',url:tr.url}},
      {type:'message',content:[{type:'output_text',text:JSON.stringify({records:[event]})}]}]});
  }};
  assert.equal((await raw.query("select to_regclass('scout.quota_policy') name")).rows[0].name,null);
  const notification=await (await hostedNotify(request(),{...options(raw),post:()=>assert.fail('No findings to notify')})).json();
  assert.equal(notification.status,'no_change');
  await due(raw);const response=await hostedReader(request(),config);assert.equal(response.status,200);
  const saved=await response.json();assert.equal(saved.created,1);assert.equal(gemini,1);assert.equal(openai,1);
  assert.equal((await raw.query('select count(*)::int n from scout.records')).rows[0].n,1);
  const repeat=await (await hostedReader(request('tracker_id='+tr.id),{...config,modelFetch:async()=>Response.json({
    usageMetadata:{promptTokenCount:400,toolUsePromptTokenCount:1000,candidatesTokenCount:300,totalTokenCount:1700},
    candidates:[{finishReason:'STOP',urlContextMetadata:{urlMetadata:[{retrievedUrl:tr.url,urlRetrievalStatus:'URL_RETRIEVAL_STATUS_SUCCESS'}]},
      content:{parts:[{text:JSON.stringify([event])}]}}]})})).json();
  assert.equal(repeat.diagnostics.attempts.length,1);assert.equal(repeat.created,0);assert.equal(repeat.changed,0);
  t.diagnostic(JSON.stringify({mocked_providers:true,real_local_sql:true,fallback:saved.cost,primary_repeat:repeat.cost,attempts:saved.diagnostics.attempts.length}));
});

test('reader migration removes source state and correction metadata, preserves findings/accounting, and restricts state writes',async t=>{
  const raw=await setup(t,{before:true}),tr=await tracker(raw);
  await raw.exec(`insert into scout.records(kind,description,overrides,provenance,sources) values('announcement','Keep finding',
    '{"description":{"url":"https://example.org"}}','{"description":["https://example.org"]}',
    '[{"url":"https://example.org","relationship":"human_review"}]')`);
  await raw.query("insert into scout.source_state(tracker_id,identity,url) values($1,'old','https://example.org/article')",[tr.id]);
  const sql=await readFile(new URL('../supabase/migrations/'+migration,import.meta.url),'utf8');
  const quota=(await raw.query('select * from scout.quota_policy')).rows;
  await raw.exec('update scout.quota_policy set enabled=true');
  await assert.rejects(raw.exec(sql),/Pause Scout work/);await raw.exec('rollback;update scout.quota_policy set enabled=false');
  await raw.exec("update scout.source_state set lease_until=now()+interval '1 minute'");
  await assert.rejects(raw.exec(sql),/Pause Scout work/);await raw.exec('rollback;update scout.source_state set lease_until=null');
  await raw.exec(sql);
  assert.deepEqual((await raw.query('select * from scout.quota_policy')).rows,quota);
  assert.equal((await raw.query("select to_regclass('scout.source_state') name")).rows[0].name,null);
  const record=(await raw.query('select * from scout.records')).rows[0];
  assert.equal(record.description,'Keep finding');assert.deepEqual(record.sources,[{url:'https://example.org'}]);
  for(const key of ['overrides','provenance','title'])assert.equal(Object.hasOwn(record,key),false);
  await raw.query("update scout.trackers set url='not a URL' where id=$1",[tr.id]);
  await raw.exec('set role authenticated');
  for(const field of ['failure_count','lease_id','next_check_at','last_checked_at','last_error'])
    await assert.rejects(raw.query('update scout.trackers set '+field+'='+field),{code:'42501'});
  await assert.rejects(raw.query('select lease_id from scout.trackers'),{code:'42501'});
});
