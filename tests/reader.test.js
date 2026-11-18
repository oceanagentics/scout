import {test,beforeEach} from 'node:test';
import dns from 'node:dns/promises';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {database} from '../reader/database.js';
import {intake} from '../reader/intake.js';
import {readSource,readUrl} from '../reader/sources.js';
import {checkFreshness} from '../reader/freshness.js';
import {INTAKE_INSTRUCTION,RESPONSE_SCHEMA} from '../reader/instructions.js';
import {hostedReader} from '../supabase/functions/scout-reader/index.ts';
import {hostedNotify} from '../supabase/functions/scout-notify/index.ts';
import {scoutDay} from '../shared/finding-dates.js';

beforeEach(t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-17T12:00:00Z')});
  t.mock.method(dns,'lookup',async()=>[{address:'93.184.216.34',family:4}]);
  t.mock.method(globalThis,'fetch',async()=>new Response('<main>BBNJ workshop</main>',{headers:{'content-type':'text/html'}}));
});

test('HTTP freshness requires prior successful progress and positive unchanged evidence',async()=>{
  const prior='2026-11-16T12:00:00.123Z',old='Sun, 15 Nov 2026 12:00:00 GMT',newer='Tue, 17 Nov 2026 12:00:00 GMT';
  for(const [checkpoint,status,modified,unchanged] of [
    [null,200,old,false],[prior,304,null,true],[prior,200,old,true],[prior,200,newer,false],
    [prior,200,null,false],[prior,200,'invalid',false],[prior,503,old,false],[null,304,null,false],['invalid',200,old,false]
  ]){
    const response=new Response(status===200?'Source content':null,{status,headers:modified?{'last-modified':modified}:{}}),signal=AbortSignal.timeout(1000);
    const result=await checkFreshness('https://example.org/source',{lastSuccessfulCheck:checkpoint,signal,fetch:async(url,options)=>{
      assert.equal(url,'https://example.org/source');assert.equal(options.signal,signal);
      assert.equal(options.headers?.['If-Modified-Since'],checkpoint===prior?'Mon, 16 Nov 2026 12:00:00 GMT':undefined);
      return response;
    }});
    assert.equal(result.response,response);assert.equal(result.unchanged,unchanged);
    assert.equal(response.bodyUsed,status===200&&unchanged);
  }
});

test('web reading preserves schedule rows, relative links, images and published structured data',async()=>{
  const page=await readUrl('https://example.org/events/list',{fetch:async()=>new Response(`
    <nav>Unrelated navigation</nav><main><h1>Directory</h1><table><tr><td>Opening</td><td>09:30</td></tr>
    <tr><td>Event B</td><td><a href="../agenda">Programme</a><img src="flyer.jpg" alt="Event flyer"></td></tr></table></main>
    <script type="application/ld+json">{"startDate":"2026-10-24T09:30:00+04:00"}</script><script>privateCode()</script>`,{headers:{'content-type':'text/html'}})});
  assert.match(page.content,/Opening \| 09:30 \|/);assert.match(page.content,/\[Programme\]\(https:\/\/example.org\/agenda\)/);
  assert.match(page.content,/!\[Event flyer\]\(https:\/\/example.org\/events\/flyer.jpg\)/);
  assert.match(page.content,/2026-10-24T09:30:00\+04:00/);assert.doesNotMatch(page.content,/Unrelated navigation|privateCode/);
});

test('CBD reads the exact page articles, caches parallel reads, and retains the public source URL',async()=>{
  let requests=0;const cache=new Map(),url='https://www.cbd.int/conferences/2026/parallel-meetings/nature-culture-summit';
  const options={cache,fetch:async value=>{
    requests++;const parsed=new URL(value);
    assert.equal(parsed.pathname,'/api/v2017/articles');
    assert.deepEqual(JSON.parse(parsed.searchParams.get('q')),{adminTags:{$all:['conferences','2026','parallel-meetings','nature-culture-summit']}});
    return Response.json([{adminTags:['conferences','2026','parallel-meetings','nature-culture-summit'],title:{en:'Summit'},content:{en:'<table><tr><td>Opening</td><td>10:00</td></tr></table><a href="agenda.pdf">Agenda</a>'}}]);
  }};
  const [a,b]=await Promise.all([readUrl(url,options),readUrl(url+'#programme',options)]);
  assert.deepEqual(a,b);assert.equal(requests,1);assert.equal(a.url,url);assert.match(a.content[0].content,/10:00/);
  const unchanged=await readSource({url,last_successful_check:'2026-11-16T12:00:00Z'},
    {through:'2026-11-17T12:00:00Z',fetch:async(value,options)=>{
      assert.equal(new URL(value).pathname,'/api/v2017/articles');
      assert.equal(options.headers['If-Modified-Since'],'Mon, 16 Nov 2026 12:00:00 GMT');
      return new Response(null,{status:304});
    }});
  assert.deepEqual(unchanged,[]);
});

test('native-file metadata reads cancel bodies and private redirect targets are rejected',async()=>{
  let cancelled=false;
  const page=await readUrl('https://example.org/programme.pdf',{fetch:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'application/pdf'}})});
  assert.deepEqual(page,{url:'https://example.org/programme.pdf',media_type:'application/pdf'});assert.equal(cancelled,true);
  let calls=0;
  await assert.rejects(readUrl('https://example.org/redirect',{fetch:async()=>{calls++;return new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}});}}),{reason:'source_invalid'});
  assert.equal(calls,1);
  for(const url of ['http://169.254.169.254/latest','http://[::1]/','http://user:password@example.org/']){
    await assert.rejects(readUrl(url,{fetch:()=>assert.fail('Private sources must not be fetched')}),{reason:'source_invalid'});
  }
});

const migration='20261019200000_scout_reader.sql';
async function setup(t,{before=false}={}){
  const raw=new PGlite();t.after(()=>raw.close());
  await raw.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
    create schema vault;create table vault.secrets(name text,secret text);
    create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');create table auth.identities(user_id uuid,provider text,identity_data jsonb);
    create function auth.uid() returns uuid language sql as $$select null::uuid$$;`);
  for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort()){
    if(before&&name===migration)break;
    await raw.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
  }
  return raw;
}
const driver=raw=>({unsafe:async(q,p=[])=>{const r=await raw.query(q,p);r.rows.count=r.affectedRows??r.rows.length;return r.rows;},release(){}});
const tracker=async raw=>(await raw.query("insert into scout.trackers(name,url,collector,cadence,enabled) values('Tracker','https://example.org/list?raw=%2B','web','1 day',true) returning *")).rows[0];
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

test('a feed without a checkpoint reads all available history, excluding pins and posts after the attempt starts',async()=>{
  const old=post('old','2020-01-01T00:00:00Z'),recent=post('recent','2026-11-01T00:00:00Z');
  const pin=post('pin','2019-01-01T00:00:00Z');pin.reason={$type:'app.bsky.feed.defs#reasonPin'};
  const pages=[{feed:[post('future','2026-11-03T00:00:00Z'),recent,pin],cursor:'older'},
    {feed:[old]}],urls=[];
  const items=await readSource({url:feedURL,last_successful_check:null},
    {through:'2026-11-02T00:00:00Z',fetch:async url=>{urls.push(new URL(url));return Response.json(pages.shift());}});
  assert.deepEqual(items.map(i=>i.content.post.record.text),['old','recent']);
  assert.equal(urls[1].searchParams.get('cursor'),'older');
  await assert.rejects(readSource({url:feedURL,last_successful_check:'invalid'},
    {through:'2026-11-02T00:00:00Z',fetch:()=>assert.fail('An invalid checkpoint must not restart history')}),{reason:'source_cutoff_invalid'});
});

test('a first feed check resumes after committed dates; an unchanged feed makes no model calls',async t=>{
  const raw=await setup(t),tr=await tracker(raw),db=database(driver(raw));
  await raw.query('update scout.trackers set url=$2 where id=$1',[tr.id,feedURL]);
  assert.equal((await raw.query('select last_successful_check from scout.trackers')).rows[0].last_successful_check,null);
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
  const raw=await setup(t),first=await tracker(raw),db=database(driver(raw));
  await raw.query('update scout.trackers set url=$2 where id=$1',[first.id,feedURL]);
  const second=await feedTracker(raw,feedURL.replace('example.test','another.test'));
  const initial=(await raw.query('select last_successful_check from scout.trackers where id=$1',[first.id])).rows[0].last_successful_check;
  assert.equal(initial,null);
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

test('feed checkpoint is backend-owned, starts empty, preserves committed progress on migration, and resets with URL changes',async t=>{
  const raw=await setup(t),tr=await tracker(raw);
  assert.equal(tr.last_successful_check,null);
  await raw.query("update scout.trackers set last_successful_check='2026-01-01',last_checked_at=now() where id=$1",[tr.id]);
  const committed=(await raw.query('select * from scout.trackers')).rows;
  await raw.exec(await readFile(new URL('../supabase/migrations/20261118040000_scout_checkpoints.sql',import.meta.url),'utf8'));
  assert.deepEqual((await raw.query('select * from scout.trackers')).rows,committed);
  await raw.query("update scout.trackers set url='https://example.org/new' where id=$1",[tr.id]);
  const state=(await raw.query('select * from scout.trackers')).rows[0];
  assert.equal(state.last_checked_at,null);assert.equal(state.enabled,false);
  assert.equal(state.last_successful_check,null);
  await raw.exec('set role authenticated');
  await raw.query('select last_successful_check from scout.trackers');
  await assert.rejects(raw.exec('update scout.trackers set last_successful_check=now()'),{code:'42501'});
});
const env={url:'https://example.supabase.co',secretKeys:{default:secret},publishableKeys:{default:'sb_publishable_test'},jwks:null};
const request=query=>new Request('https://example.test/reader'+(query?'?'+query:''),{method:'POST',headers:{apikey:secret}});
const options=raw=>({env,databaseURL:'unused',apiKey:'test',connect:()=>({reserve:async()=>driver(raw),end:async()=>{}})});

test('web freshness skips repeat model work, checks linked URLs independently, and preserves progress after failure',async t=>{
  const raw=await setup(t),tr=await tracker(raw),db=database(driver(raw));let calls=0,mode='initial',requests=0;
  const run=()=>intake(db,{trackerId:tr.id,sourceFetch:async(url,options)=>{
    requests++;
    if(url==='https://example.org/detail'){
      assert.equal(options.headers?.['If-Modified-Since'],undefined);
      return new Response('<main>Detail content</main>',{headers:{'content-type':'text/html','last-modified':'Thu, 01 Jan 2026 00:00:00 GMT'}});
    }
    assert.equal(options.headers?.['If-Modified-Since'],mode==='initial'?undefined:'Tue, 17 Nov 2026 12:00:00 GMT');
    if(mode==='304')return new Response(null,{status:304});
    const modified=mode==='initial'||mode==='old'?'Thu, 01 Jan 2026 00:00:00 GMT':'Wed, 18 Nov 2026 12:00:00 GMT';
    return new Response('<main>Source content</main>',{headers:{'content-type':'text/html','last-modified':modified}});
  },modelFor:(_source,{readUrl})=>async()=>{
    calls++;if(mode==='fail')throw new Error('provider_unavailable');
    assert.equal((await readUrl('https://example.org/detail')).content,'Detail content');
    return answer([]);
  }});
  assert.equal((await run()).processed,1);assert.equal(calls,1);
  for(mode of ['304','old']){
    const before={...db.metrics},sourceRequests=requests;
    const result=await run();assert.equal(result.state,'no_findings');assert.equal(result.processed,0);assert.equal(calls,1);
    assert.equal(requests-sourceRequests,1);assert.equal(db.metrics.statements-before.statements,5);assert.equal(db.metrics.mutations-before.mutations,2);
    const state=(await raw.query('select * from scout.trackers')).rows[0];
    assert.deepEqual(state.last_successful_check,state.last_checked_at);assert.equal(state.last_error,null);assert.equal(state.failure_count,0);
  }
  mode='changed';assert.equal((await run()).processed,1);assert.equal(calls,2);
  const checkpoint=(await raw.query('select last_successful_check from scout.trackers')).rows[0].last_successful_check;
  mode='fail';assert.equal((await run()).state,'deferred');assert.equal(calls,3);
  const state=(await raw.query('select * from scout.trackers')).rows[0];
  assert.deepEqual(state.last_successful_check,checkpoint);assert.equal(state.last_error,'provider_unavailable');
});

test('tracker URL -> one model investigation -> finding and tracker state; due repeat writes no finding',async t=>{
  const raw=await setup(t),tr=await tracker(raw),db=database(driver(raw));let calls=0;
  const modelFor=selected=>async(prompt,input,schema)=>{
    calls++;assert.equal(selected.id,tr.id);assert.equal(prompt,INTAKE_INSTRUCTION);assert.equal(schema,RESPONSE_SCHEMA);
    assert.equal(input.url,tr.url);assert.equal(input.current_date,scoutDay());assert.equal(input.source_kind,'web');
    assert.equal(input.content.content,'BBNJ workshop');return answer();
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

test('capture cutoff excludes only confirmed-old dates for every type and completes an all-old check',async t=>{
  const raw=await setup(t),tr=await tracker(raw),db=database(driver(raw));let expected,old;
  const result=await intake(db,{trackerId:tr.id,modelFor:()=>async(prompt,input)=>{
    assert.match(prompt,/Keep findings with unresolved or future dates/);
    assert.equal(input.oldest_date,(await raw.query(`select
      ((last_checked_at at time zone 'America/New_York')::date-interval '1 month')::date::text as cutoff
      from scout.trackers where id=$1`,[tr.id])).rows[0].cutoff);
    const cutoff=input.oldest_date,previous=new Date(Date.parse(cutoff+'T00:00:00Z')-86400000).toISOString().slice(0,10);
    const previousMonth=new Date(Date.parse(cutoff.slice(0,7)+'-01T00:00:00Z')-86400000).toISOString().slice(0,7);
    const cases=[['Old day',previous,false],['Boundary',cutoff,true],['Unknown',null,true],
      ['Future','2099-12-01',true],['Partial month',cutoff.slice(0,7),true],['Old month',previousMonth,false],
      ['Partial year',input.current_date.slice(0,4),true],['Old year',String(Number(cutoff.slice(0,4))-1),false]];
    const findings=['event','announcement','treaty_status',null].flatMap(type=>cases.map(([label,date,keep])=>({
      finding:{...event,type,date,deadline:'2099-12-31',description:label+' '+(type??'unclassified')},keep})));
    expected=findings.filter(f=>f.keep).map(f=>f.finding);old=findings.filter(f=>!f.keep).map(f=>f.finding);
    return answer(findings.map(f=>f.finding));
  }});
  assert.equal(result.state,'saved');assert.equal(result.created,expected.length);
  const stored=(await raw.query('select description,type,date from scout.records order by description')).rows;
  assert.deepEqual(stored,expected.map(({description,type,date})=>({description,type,date})).sort((a,b)=>a.description.localeCompare(b.description)));
  const before={...db.metrics};
  const allOld=await intake(db,{trackerId:tr.id,modelFor:()=>async()=>answer(old),
    notify:()=>assert.fail('Old findings must not notify'),publishCalendar:()=>assert.fail('Old findings must not publish')});
  assert.equal(allOld.state,'no_findings');assert.equal(allOld.created,0);assert.equal(allOld.changed,0);
  assert.equal((await raw.query('select count(*)::int n from scout.records')).rows[0].n,expected.length);
  const state=(await raw.query('select * from scout.trackers')).rows[0];
  assert.deepEqual(state.last_successful_check,state.last_checked_at);assert.equal(state.last_error,null);assert.equal(state.failure_count,0);
  assert.equal(db.metrics.mutations-before.mutations,2);
  const oldCost={statements:db.metrics.statements-before.statements,mutations:db.metrics.mutations-before.mutations};
  assert.equal((await intake(db,{modelFor:()=>assert.fail('A completed old-only source must not replay')})).state,'idle');
  t.diagnostic(JSON.stringify({mocked_model:true,real_local_sql:true,all_old:oldCost}));
});

test('optional ends survive collection, omission preserves them, and unusable ends never block saving',async t=>{
  const raw=await setup(t),tr=await tracker(raw),db=database(driver(raw));let calls=0;
  const timed={...event,description:'Published webinar',date:'2026-10-24',starttime:'10:00',timezone:'UTC',enddate:'2026-10-24',endtime:'11:30'};
  const records=[timed,{...timed,description:'Multi-day summit',enddate:'2026-10-25',endtime:null},
    {...timed,description:'Finish unknown',enddate:null,endtime:null},
    {...timed,description:'Conflicting final date',enddate:'2026-10-23'},
    {...timed,description:'Changing final day',endtime:'13:00'},{...timed,description:'Timezone shift'}];
  const run=records=>intake(db,{trackerId:tr.id,modelFor:()=>async()=>{calls++;return answer(records);}});
  const first=await run(records);assert.equal(first.created,6);assert.equal(first.state,'saved');assert.equal(calls,1);
  const saved=(await raw.query('select * from scout.records order by description')).rows;
  assert.equal(saved.find(r=>r.description===timed.description).endtime,'11:30');
  assert.equal(saved.find(r=>r.description==='Multi-day summit').enddate,'2026-10-25');
  for(const description of ['Finish unknown','Conflicting final date']){
    const record=saved.find(r=>r.description===description);assert.equal(record.enddate,null);assert.equal(record.endtime,null);
  }
  const before={...db.metrics};
  const repeated=await run(records.map(({enddate,endtime,...r})=>r));
  assert.equal(repeated.changed,0);assert.equal(calls,2);assert.equal(db.metrics.mutations-before.mutations,2);
  assert.deepEqual((await raw.query('select * from scout.records order by description')).rows,saved);
  const changed=await run([{...timed,starttime:'12:00',enddate:null,endtime:null},
    {...records[4],enddate:'2026-10-25',endtime:null},
    {...records[5],starttime:'08:00',timezone:'-02:00',enddate:null,endtime:null}]);
  assert.equal(changed.changed,3);assert.equal(calls,3);
  for(const row of (await raw.query("select endtime from scout.records where description in ('Published webinar','Changing final day','Timezone shift')")).rows)
    assert.equal(row.endtime,null);
  t.diagnostic(JSON.stringify({mocked_model:true,real_local_sql:true,first_and_repeat:before,repeat_finding_writes:0}));
});

test('retirement blocks automatic and explicit checks on the New York date without changing saved state',async t=>{
  const raw=await setup(t),tr=await tracker(raw);
  await raw.exec("insert into scout.records(description,sources) values('Preserved finding',array['https://example.org/saved'])");
  const records=(await raw.query('select * from scout.records')).rows;
  for(const days of [-1,0]){
    await raw.query("update scout.trackers set retire_on=(clock_timestamp() at time zone 'America/New_York')::date+$1::int where id=$2",[days,tr.id]);
    const before=(await raw.query('select * from scout.trackers')).rows;
    for(const query of ['', 'tracker_id='+tr.id]){
      const result=await (await hostedReader(request(query),{...options(raw),
        sourceFetch:()=>assert.fail('Retired source must not be read'),modelFetch:()=>assert.fail('Retired tracker must not call a model')})).json();
      assert.equal(result.state,'idle');assert.equal(result.cost.statements,1);assert.equal(result.cost.mutations,0);
    }
    assert.deepEqual((await raw.query('select * from scout.trackers')).rows,before);
  }
  for(const retirement of ["(clock_timestamp() at time zone 'America/New_York')::date+1",'null']){
    await raw.exec('update scout.trackers set retire_on='+retirement);
    assert.equal((await intake(database(driver(raw)),{trackerId:tr.id,modelFor:()=>async()=>answer([])})).state,'no_findings');
  }
  assert.deepEqual((await raw.query('select * from scout.records')).rows,records);
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

test('daily scheduling skips completed checks, resumes partial checks and retries failures without waiting a day',async t=>{
  const raw=await setup(t);await tracker(raw);
  const db=database(driver(raw));let calls=0;
  const modelFor=()=>async()=>{calls++;return answer([]);};
  assert.equal((await intake(db,{modelFor})).state,'no_findings');
  assert.equal((await intake(db,{modelFor})).state,'idle');assert.equal(calls,1);
  // The prior New York day's final millisecond is due even before 24 hours pass.
  await raw.exec(`update scout.trackers set last_checked_at=
    (date_trunc('day',clock_timestamp() at time zone 'America/New_York') at time zone 'America/New_York')-interval '1 millisecond';
    update scout.trackers set last_successful_check=last_checked_at`);
  assert.equal((await intake(db,{modelFor})).state,'no_findings');assert.equal(calls,2);
  // A worker can commit part of a feed today and then die with no stored error.
  await raw.exec(`update scout.trackers set last_successful_check=last_checked_at-interval '1 millisecond',
    lease_id=gen_random_uuid(),lease_until=clock_timestamp()-interval '1 second'`);
  assert.equal((await intake(db,{modelFor})).state,'no_findings');assert.equal(calls,3);
  await raw.exec("update scout.trackers set last_successful_check=last_checked_at-interval '1 millisecond'");
  assert.equal((await intake(db,{modelFor:()=>async()=>{throw new Error('provider_unavailable');}})).state,'deferred');
  assert.equal((await intake(db,{modelFor})).state,'no_findings');assert.equal(calls,4);
  assert.equal((await intake(db,{modelFor})).state,'idle');assert.equal(calls,4);
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

test('exact matches beyond twenty older source-page findings retain IDs without finding writes',async t=>{
  const raw=await setup(t);
  for(const [url,description,date] of [
    ['https://globalfishingwatch.org/mediacenter/','A New Course for Panama: How Data Is Transforming Fisheries Management','2026-11-04'],
    ['https://www.minderoo.org/media/','Minderoo commits $10 million to accelerate protection of nature across the Commonwealth','2026-11-03']]){
    const tr=await tracker(raw);await raw.query('update scout.trackers set url=$2 where id=$1',[tr.id,url]);
    for(let i=0;i<21;i++)await raw.query(`insert into scout.records(description,type,date,sources,modified)
      values($1,'announcement','2020-01-01',array[$2],array['2020-01-01'::timestamptz])`,['Older unrelated finding '+i,url]);
    const saved=(await raw.query(`insert into scout.records(description,type,priority,date,sources)
      values($1,'announcement','normal',$2,array[$3]) returning *`,[description,date,url])).rows[0];
    const db=database(driver(raw));let calls=0;
    const result=await intake(db,{trackerId:tr.id,modelFor:()=>async()=>{calls++;return answer([
      {description,type:'announcement',priority:'normal',date}
    ]);},notify:()=>assert.fail('An existing finding must not notify')});
    assert.equal(calls,1);assert.equal(result.created,0);assert.equal(result.changed,0);assert.equal(result.saved,1);
    assert.equal(db.metrics.mutations,2);
    assert.deepEqual((await raw.query('select * from scout.records where id=$1',[saved.id])).rows[0],saved);
  }
});

test('conflicting dates and deadlines skip the affected finding and advance progress',async t=>{
  const raw=await setup(t),tr=await tracker(raw),db=database(driver(raw));
  const cop1={...event,description:'First Conference of the Parties to the BBNJ Agreement (BBNJ COP1)',date:'2027-01-11',deadline:'2026-12-18'};
  await intake(db,{trackerId:tr.id,modelFor:()=>async()=>answer([cop1])});
  const saved=(await raw.query('select * from scout.records')).rows;
  for(const records of [[{...cop1,date:'2027-01-01'}],[{...cop1,deadline:'2026-12-17'}],[cop1,{...cop1,date:'2027-01-01'}]]){
    const result=await intake(db,{trackerId:tr.id,modelFor:()=>async()=>answer(records),notify:()=>assert.fail('A conflict must not notify')});
    assert.equal(result.ambiguous,1);assert.equal(result.created,0);assert.equal(result.changed,0);
    assert.deepEqual((await raw.query('select * from scout.records')).rows,saved);
    const state=(await raw.query('select * from scout.trackers where id=$1',[tr.id])).rows[0];
    assert.deepEqual(state.last_successful_check,state.last_checked_at);assert.equal(state.last_error,null);
  }
});

test('partial evidence and malformed optional fields save while a conflicting existing record stays unchanged',async t=>{
  const raw=await setup(t),tr=await tracker(raw),db=database(driver(raw));
  const original={...event,description:'Existing event',date:'2026-10-24',starttime:'10:00',timezone:'UTC'};
  await intake(db,{trackerId:tr.id,modelFor:()=>async()=>answer([original])});
  const saved=(await raw.query('select * from scout.records')).rows[0];
  const result=await intake(db,{trackerId:tr.id,sourceFetch:async url=>url.endsWith('/broken.pdf')?new Response(null,{status:404}):new Response('<main><a href="/broken.pdf">Missing programme</a><a href="/another">Another event</a></main>',{headers:{'content-type':'text/html'}}),
    modelFor:(_source,{readUrl})=>async()=>{
      await assert.rejects(readUrl('https://example.org/broken.pdf'),{reason:'source_unavailable'});
      return answer([{...original,date:'2026-10-25'},
        {...event,description:'New useful event',date:'2026-12-01',starttime:null},
        {...event,type:'announcement',description:'Useful announcement with malformed scheduling',date:'2026-02-30',starttime:'9:00 AM',timezone:'not/a-zone'}]);
    }});
  assert.equal(result.created,2);assert.equal(result.ambiguous,1);assert.equal(result.changed,0);
  assert.deepEqual((await raw.query('select * from scout.records where id=$1',[saved.id])).rows[0],saved);
  const malformed=(await raw.query("select date,starttime,timezone from scout.records where type='announcement'")).rows[0];
  assert.deepEqual(malformed,{date:null,starttime:null,timezone:null});assert.deepEqual(result.diagnostics.invalid_scheduling,{date:1,starttime:1,timezone:1});
  const state=(await raw.query('select * from scout.trackers')).rows[0];assert.deepEqual(state.last_successful_check,state.last_checked_at);assert.equal(state.last_error,null);
});

test('a past gathering keeps its existing ID when corrected from announcement to event',async t=>{
  const raw=await setup(t),tr=await tracker(raw),db=database(driver(raw));
  const webinar={...event,description:'From Development to Implementation: Making Management Procedures More Efficient Webinar',date:'2026-11-04'};
  await intake(db,{trackerId:tr.id,modelFor:()=>async()=>answer([{...webinar,type:'announcement'}])});
  const original=(await raw.query('select * from scout.records')).rows[0];
  const corrected=await intake(db,{trackerId:tr.id,modelFor:()=>async()=>answer([webinar])});
  assert.equal(corrected.created,0);assert.equal(corrected.changed,1);
  const stored=(await raw.query('select * from scout.records')).rows[0];
  assert.equal(stored.id,original.id);assert.equal(stored.type,'event');assert.equal(stored.date,original.date);
  const repeated=await intake(db,{trackerId:tr.id,modelFor:()=>async()=>answer([webinar])});
  assert.equal(repeated.created,0);assert.equal(repeated.changed,0);
  const publication=await intake(db,{trackerId:tr.id,modelFor:()=>async()=>answer([
    {...webinar,type:'announcement',description:'Publication of the webinar recording',date:'2026-11-05'}
  ])});
  assert.equal(publication.created,1);
  assert.deepEqual((await raw.query('select * from scout.records where id=$1',[original.id])).rows[0],stored);
});

test('a compatible partial date cannot downgrade a saved day, deadline, clock or timezone',async t=>{
  const raw=await setup(t),tr=await tracker(raw),db=database(driver(raw));
  const cop1={...event,description:'BBNJ COP1',date:'2027-01-11',deadline:'2026-12-18',starttime:'10:00',timezone:'America/New_York'};
  await intake(db,{trackerId:tr.id,modelFor:()=>async()=>answer([cop1])});
  const saved=(await raw.query('select * from scout.records')).rows,before=db.metrics.mutations;
  const result=await intake(db,{trackerId:tr.id,modelFor:()=>async()=>answer([
    {...cop1,date:'2027-01',deadline:'2026-12',starttime:'09:00',timezone:'UTC'}
  ])});
  assert.equal(result.created,0);assert.equal(result.changed,0);assert.equal(db.metrics.mutations-before,2);
  assert.deepEqual((await raw.query('select * from scout.records')).rows,saved);
});

test('similarly named gatherings on different dates remain separate and repeat without writes',async t=>{
  const raw=await setup(t),tr=await tracker(raw),db=database(driver(raw));
  const title='Towards living in harmony with the ocean from coasts to areas beyond national jurisdiction: Synergies between the BBNJ Agreement and the work under the CBD, a side event at ';
  const first={...event,description:title+'CBD SBSTTA-26',date:'2026-11-13'},second={...event,description:title+'CBD COP16',date:'2026-11-21'};
  await intake(db,{trackerId:tr.id,modelFor:()=>async()=>answer([first])});
  const original=(await raw.query('select * from scout.records')).rows[0];
  assert.equal((await intake(db,{trackerId:tr.id,modelFor:()=>async()=>answer([second])})).created,1);
  const stored=(await raw.query('select * from scout.records order by date')).rows;
  assert.equal(stored.length,2);assert.deepEqual(stored[0],original);
  const repeat=await intake(db,{trackerId:tr.id,modelFor:()=>async()=>answer([first,second])});
  assert.equal(repeat.created,0);assert.equal(repeat.changed,0);
  assert.deepEqual((await raw.query('select * from scout.records order by date')).rows,stored);
});

test('multiple developments retain IDs, revised facts update once, and missing dates do not start another model pass',async t=>{
  const raw=await setup(t),tr=await tracker(raw),db=database(driver(raw));let calls=0;
  const records=[event,{...event,description:'Treaty ratification',type:'treaty_status',date:'2026-11-01'},{...event,description:'Implementation report',type:'announcement',date:null}];
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
  assert.equal((await raw.query("select * from scout.findings(p_type=>'treaty_status',p_from=>'2026-11-01',p_to=>'2026-11-01')")).rows.length,1);
});

test('live lease excludes overlapping requests; URL changes and expired leases cannot save findings',async t=>{
  const raw=await setup(t),tr=await tracker(raw),db=database(driver(raw));
  const result=await intake(db,{modelFor:()=>async()=>{
    assert.equal((await intake(db,{trackerId:tr.id,modelFor:()=>assert.fail('No overlapping model')})).state,'idle');
    await raw.query("update scout.trackers set url='https://example.org/changed' where id=$1",[tr.id]);return answer();
  }});
  assert.equal(result.state,'stale');assert.equal((await raw.query('select count(*)::int n from scout.records')).rows[0].n,0);
  assert.equal((await raw.query('select failure_count from scout.trackers')).rows[0].failure_count,0);
  const expired=await intake(db,{trackerId:tr.id,modelFor:tr=>async(_p,input)=>{
    assert.equal(input.url,'https://example.org/changed');assert.equal(tr.url,input.url);
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

test('hosted web reader uses OpenAI directly without model accounting',async t=>{
  const raw=await setup(t),tr=await tracker(raw);let gemini=0,openai=0,posts=0;
  const config={...options(raw),openaiApiKey:'test',post:async()=>{posts++;return {status:200,body:'ok'};},modelFetch:async(url,init)=>{
    const body=JSON.parse(init.body);
    if(url.includes('googleapis')){gemini++;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'[]'}]}}]});}
    openai++;const supplied=JSON.parse(body.input[0].content[0].text);assert.equal(supplied.input.url,tr.url);
    assert.equal(supplied.input.source_kind,'web');assert.equal(supplied.input.content.content,'BBNJ workshop');
    return Response.json({status:'completed',usage:{input_tokens:100,output_tokens:100},output:[
      {type:'web_search_call',status:'completed',action:{type:'open_page',url:tr.url}},
      {type:'message',content:[{type:'output_text',text:JSON.stringify({status:'found',records:[event]})}]}]});
  }};
  assert.equal((await raw.query("select to_regclass('scout.quota_policy') name")).rows[0].name,null);
  const notification=await (await hostedNotify(request('kind=weekly'),{...options(raw),post:()=>assert.fail('No findings to notify')})).json();
  assert.equal(notification.status,'no_change');
  await due(raw);const response=await hostedReader(request(),config);assert.equal(response.status,200);
  const saved=await response.json();assert.equal(saved.created,1);assert.deepEqual(saved.notifications,[{status:'sent',communicated:1}]);assert.equal(posts,1);assert.equal(gemini,0);assert.equal(openai,1);
  assert.equal((await raw.query('select count(*)::int n from scout.records')).rows[0].n,1);
  const repeat=await (await hostedReader(request('tracker_id='+tr.id),config)).json();
  assert.equal(repeat.diagnostics.attempts.length,1);assert.equal(repeat.created,0);assert.equal(repeat.changed,0);assert.equal(posts,1);
  t.diagnostic(JSON.stringify({mocked_providers:true,real_local_sql:true,initial:saved.cost,repeat:repeat.cost,attempts:saved.diagnostics.attempts.length}));
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

test('Slack and calendar delivery follow committed saves and failures cannot replay collection',async t=>{
 const raw=await setup(t),tr=await tracker(raw),db=database(driver(raw));let sends=0,publishes=0;
 const run=records=>intake(db,{trackerId:tr.id,modelFor:()=>async()=>answer(records),notify:async ids=>{
   sends++;assert.equal((await raw.query('select id from scout.records where id=any($1::uuid[])',[ids])).rows.length,ids.length);
   throw new Error('Slack timeout');
 },publishCalendar:async ids=>{
   publishes++;assert.equal((await raw.query('select id from scout.records where id=any($1::uuid[])',[ids])).rows.length,ids.length);
   assert.equal((await raw.query('select lease_id from scout.trackers')).rows[0].lease_id,null);
   throw new Error('Google timeout');
 }});
 const first=await run([event]);assert.equal(first.created,1);assert.equal(first.state,'saved');
 assert.deepEqual(first.notifications,[{status:'unknown',communicated:0}]);assert.equal(sends,1);
 assert.deepEqual(first.calendar,[{status:'failed'}]);assert.equal(publishes,1);
 assert.equal((await run([event])).created,0);assert.equal(sends,1);assert.equal(publishes,1);
 assert.equal((await run([{...event,priority:'low'}])).changed,1);assert.equal(sends,1);assert.equal(publishes,2);
 assert.equal((await run([{...event,type:'announcement',priority:'low'}])).changed,1);assert.equal(publishes,3);
 await raw.exec("alter table scout.records add constraint fail_notification_fixture check(description<>'Rollback finding')");
 assert.equal((await run([{...event,description:'Rollback finding',type:'announcement'}])).state,'deferred');assert.equal(sends,1);assert.equal(publishes,3);
});
