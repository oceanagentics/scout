import {test,beforeEach} from 'node:test';
import dns from 'node:dns/promises';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {database} from '../reader/database.js';
import {intake} from '../reader/intake.js';
import {readUrl} from '../reader/url.js';
import {discoverBluesky as readSource} from '../reader/sources/bluesky.js';
import {discoverSource} from '../reader/sources/index.js';
import {cbdRequest,prepareCBD} from '../reader/sources/cbd.js';
import {checkFreshness} from '../reader/freshness.js';
import {INTAKE_INSTRUCTION,RESPONSE_SCHEMA} from '../reader/instructions.js';
import {RANKING_INSTRUCTION} from '../shared/rankings.generated.js';
import {investigate} from '../reader/investigate.js';
import {hostedReader} from '../supabase/functions/scout-reader/index.ts';
import {hostedNotify} from '../supabase/functions/scout-notify/index.ts';
import {scoutDay} from '../shared/finding-dates.js';

beforeEach(t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-17T12:00:00Z')});
  t.mock.method(dns,'lookup',async()=>[{address:'93.184.216.34',family:4}]);
  t.mock.method(globalThis,'fetch',async()=>new Response('<main>BBNJ workshop</main>',{headers:{'content-type':'text/html'}}));
});

test('embedded ranking policy matches the editable Markdown and appears once',async()=>{
  assert.equal(RANKING_INSTRUCTION,await readFile(new URL('../shared/rankings.md',import.meta.url),'utf8'));
  assert.equal(INTAKE_INSTRUCTION.split(RANKING_INSTRUCTION).length,2);
});

test('investigation passes the collection cutoff and accepts only whole scores from zero through one hundred or null',async()=>{
  for(const score of [0,100,null,-1,101,75.5,'85',undefined]){
    const run=()=>investigate({query:async()=>({rows:[]})},{url:'https://example.org/finding',source_kind:'web',content:'Evidence'},
      {oldestDate:'2026-10-17',through:'2026-11-17T12:00:00Z',modelFor:(_item,{functions})=>async(_instruction,input)=>{
        assert.equal(input.oldest_date,'2026-10-17');
        await functions[0].run({queries:['Ocean Institute'],urls:[]});
        return {status:'complete',decisions:[{action:'create',id:null,reason:null,fields:{description:'A finding',score,organizations:[],supporting_urls:[]}}]};
      }});
    if(score===null||Number.isInteger(score)&&score>=0&&score<=100)assert.equal((await run()).decisions[0].fields.score,score);
    else await assert.rejects(run(),{reason:'invalid_output'});
  }
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

test('failed HTTP reads retain the redirected URL and status without reading the rejected body',async()=>{
 let cancelled=false;
 await assert.rejects(readUrl('https://example.org/list',{fetch:async url=>url.endsWith('/list')?
  new Response(null,{status:302,headers:{location:'/blocked'}}):new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:403})}),error=>{
  assert.equal(error.reason,'source_unavailable');
  assert.deepEqual(error.diagnostics,{url:'https://example.org/blocked',stage:'response',http_status:403,error_name:'Error',error_code:null,error_message:'source_unavailable'});return true;
 });
 assert.equal(cancelled,true);
});

test('transport and body-read failures retain distinct bounded diagnostics and existing timeout reasons',async()=>{
 const cause=Object.assign(new Error('certificate expired\n'+ 'sk-test_secret_123 '+ 'x'.repeat(600)),{code:'CERT_HAS_EXPIRED'});
 await assert.rejects(readUrl('https://example.org/list',{fetch:async()=>{throw new TypeError('fetch failed',{cause});}}),error=>{
  assert.equal(error.reason,'source_unavailable');assert.equal(error.diagnostics.stage,'fetch');assert.equal(error.diagnostics.http_status,null);
  assert.equal(error.diagnostics.error_name,'TypeError');assert.equal(error.diagnostics.error_code,'CERT_HAS_EXPIRED');
  assert.match(error.diagnostics.error_message,/fetch failed: certificate expired \[REDACTED\]/);
  assert.equal(error.diagnostics.error_message.length,512);assert.doesNotMatch(error.diagnostics.error_message,/sk-test_secret_123|\n/);return true;
 });
 await assert.rejects(readUrl('https://example.org/list',{fetch:async()=>new Response(new ReadableStream({start(controller){controller.error(new TypeError('connection closed'));}}))}),error=>{
  assert.equal(error.reason,'source_unavailable');assert.equal(error.diagnostics.stage,'body');assert.equal(error.diagnostics.http_status,200);
  assert.equal(error.diagnostics.error_message,'connection closed');return true;
 });
 const controller=new AbortController();
 await assert.rejects(readUrl('https://example.org/list',{signal:controller.signal,fetch:async()=>{controller.abort();throw controller.signal.reason;}}),error=>{
  assert.equal(error.reason,'runtime_bound');assert.equal(error.diagnostics.stage,'fetch');assert.equal(error.diagnostics.error_name,'AbortError');return true;
 });
});

test('fingerprints compare prepared content per resource and per caller, after HTTP checks',async()=>{
 const url='https://example.org/article?q=one',cache=new Map();let reads=0;
 const fetch=async()=>{reads++;return new Response('<main>Published article</main>',{headers:{'content-type':'text/html'}});};
 const first=await readUrl(url,{fetch,cache});assert.equal(first.unchanged,false);
 const repeat=await readUrl(url,{fetch,cache,previousFingerprint:first.fingerprint});assert.equal(repeat.unchanged,true);assert.equal(reads,1);
 assert.equal((await readUrl(url,{fetch,cache})).unchanged,false);
 assert.equal((await readUrl(url,{fetch,cache,previousRequestURL:url.replace('one','two'),previousFingerprint:first.fingerprint})).unchanged,false);
 const redirect=await readUrl('https://example.org/redirect',{previousFingerprint:first.fingerprint,fetch:async target=>target.endsWith('/redirect')?
  new Response(null,{status:302,headers:{location:url}}):fetch()});assert.equal(redirect.unchanged,false);
 const httpCache=new Map(),checkpoint='2026-11-16T12:00:00Z';let conditionalReads=0;
 const conditional=async(_url,options)=>{
  conditionalReads++;assert.equal(options.headers['User-Agent'],'Scout/0.1');
  return options.headers['If-Modified-Since']?new Response(null,{status:304}):fetch();
 };
 const unchanged=await readUrl(url,{cache:httpCache,fetch:conditional,lastSuccessfulCheck:checkpoint,previousFingerprint:first.fingerprint});
 assert.equal(unchanged.unchanged,true);assert.equal(unchanged.fingerprint,first.fingerprint);assert.equal(unchanged.content,undefined);
 const unread=await readUrl(url,{cache:httpCache,fetch:conditional});assert.equal(unread.unchanged,false);assert.ok(unread.content);assert.equal(conditionalReads,2);
 const native=await readUrl(url,{previousFingerprint:first.fingerprint,fetch:async()=>new Response(null,{headers:{'content-type':'application/pdf'}})});
 assert.equal(native.fingerprint,undefined);assert.equal(native.unchanged,undefined);
});

test('CBD reads the exact page articles, caches parallel reads, and retains the public source URL',async()=>{
  let requests=0;const cache=new Map(),url='https://www.cbd.int/conferences/2026/parallel-meetings/nature-culture-summit';
  const options={cache,fetch:async value=>{
    requests++;const parsed=new URL(value);
    assert.equal(parsed.pathname,'/api/v2017/articles');
    assert.deepEqual(JSON.parse(parsed.searchParams.get('q')),{adminTags:{$all:['conferences','2026','parallel-meetings','nature-culture-summit']}});
    return Response.json([{adminTags:['conferences','2026','parallel-meetings','nature-culture-summit'],title:{en:'Summit'},content:{en:'<table><tr><td>Opening</td><td>10:00</td></tr></table><a href="agenda.pdf">Agenda</a>'}}]);
  }};
  const [a,b]=await Promise.all([readUrl(cbdRequest(url),options),readUrl(cbdRequest(url),options)]);
  assert.deepEqual(a,b);assert.equal(requests,1);assert.equal(prepareCBD(a,url).url,url);assert.match(prepareCBD(a,url).content[0].content,/10:00/);
  const fetch=async(value,options)=>{assert.equal(new URL(value).pathname,'/api/v2017/articles');return new Response(null,{status:304});};
  const unchanged=await discoverSource({url,discovery_checked_at:'2026-11-16T12:00:00Z',discovery_request_url:cbdRequest(url)},
   {readUrl:(value,options)=>readUrl(value,{...options,fetch})});
  assert.deepEqual(unchanged.items,[]);
});

test('native-file metadata reads cancel bodies and private redirect targets are rejected',async()=>{
  let cancelled=false;
  const page=await readUrl('https://example.org/programme.pdf',{fetch:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'application/pdf'}})});
  assert.equal(page.url,'https://example.org/programme.pdf');assert.equal(page.media_type,'application/pdf');assert.equal(cancelled,true);
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
const tracker=async raw=>(await raw.query("insert into scout.trackers(name,url,collector,cadence,enabled) values('Tracker','https://example.org/list?raw=%2B','web_page','1 day',true) returning *")).rows[0];
const due=raw=>raw.exec("update scout.trackers set last_checked_at=clock_timestamp()-cadence-interval '1 second'");
const event={description:'BBNJ implementation workshop',type:'event',score:85,organizations:['Ocean Institute'],date:'2026-10',starttime:null,timezone:null};
const answer=(records=[event])=>({status:'complete',decisions:records.map(fields=>({action:'create',id:null,fields:{...fields,organizations:fields.organizations??[],supporting_urls:[]},reason:null}))});
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

test('Bluesky preserves the current post and attachments without parent/root bodies, and reads oldest first',async()=>{
  const a=post('a','2026-10-13T12:00:00.123Z'),b=post('b','2026-10-14T12:00:00Z'),c=post('c','2026-10-01T12:00:00Z');
  c.reason={$type:'app.bsky.feed.defs#reasonRepost',indexedAt:'2026-10-15T12:00:00Z'};
  a.post.embed={images:[{alt:'Event on October 20',fullsize:'https://example.org/full.png'}]};
  a.reply={parent:{record:{text:'Parent context'}},root:{record:{text:'Root context'}}};
  a.post.record.reply={parent:{uri:'at://did:plc:example/app.bsky.feed.post/parent'},root:{uri:'at://did:plc:example/app.bsky.feed.post/root'}};
  const pages=[{feed:[c,b],cursor:'page2'},{feed:[],cursor:'page3'},
    {feed:[b,a,post('boundary','2026-10-12T00:00:00Z')],cursor:'do-not-fetch'}],urls=[];
  const items=await readSource({url:'https://bsky.app/profile/example.test',last_successful_check:new Date('2026-10-12T00:00:00Z'),oldest_date:'2026-10-02'},
    {through:'2026-11-02T00:00:00Z',fetch:async url=>{urls.push(new URL(url));return Response.json(pages.shift());}});
  assert.deepEqual(items.map(i=>i.content.post.record.text),['a','b','c']);
  assert.deepEqual(items[0].content,{post:a.post});assert.deepEqual(items[2].content,{post:c.post,reason:c.reason});
  assert.equal(items[2].at,c.reason.indexedAt.replace('Z','.000Z'));
  assert.equal(items[2].published_at,'2026-10-01T12:00:00.000Z');
  assert.equal(urls[0].searchParams.get('actor'),'example.test');assert.equal(urls[2].searchParams.get('cursor'),'page3');
  assert.equal(urls.length,3);
  const sameDate=await readSource({url:feedURL,last_successful_check:new Date(a.post.indexedAt),oldest_date:'2026-10-02'},
    {through:'2026-11-02T00:00:00Z',fetch:async()=>Response.json({feed:[a]})});
  assert.deepEqual(sameDate,[]); // Database Date values must retain their milliseconds.
});

test('first and stale-checkpoint feeds stop at the age boundary in Scout time, excluding pins and future posts',async()=>{
  const old=post('old','2026-10-02T03:59:59.999Z'),boundary=post('boundary','2026-10-02T04:00:00Z'),recent=post('recent','2026-11-01T00:00:00Z');
  const pin=post('pin','2019-01-01T00:00:00Z');pin.reason={$type:'app.bsky.feed.defs#reasonPin'};
  for(const checkpoint of [null,'2024-01-01T00:00:00Z']){
    const pages=[{feed:[post('future','2026-11-03T00:00:00Z'),recent,pin],cursor:'older'},
      {feed:[boundary,old],cursor:'do-not-fetch'}],urls=[];
    const items=await readSource({url:feedURL,last_successful_check:checkpoint,oldest_date:'2026-10-02'},
      {through:'2026-11-02T00:00:00Z',fetch:async url=>{urls.push(new URL(url));assert.ok(pages.length);return Response.json(pages.shift());}});
    assert.deepEqual(items.map(i=>i.content.post.record.text),['boundary','recent']);
    assert.equal(urls[1].searchParams.get('cursor'),'older');assert.equal(urls.length,2);
  }
  for(const cutoff of [{last_successful_check:'invalid',oldest_date:'2026-10-02'},{last_successful_check:null},{last_successful_check:null,oldest_date:'invalid'}]){
    await assert.rejects(readSource({url:feedURL,...cutoff},
      {through:'2026-11-02T00:00:00Z',fetch:()=>assert.fail('An invalid cutoff must not restart history')}),{reason:'source_cutoff_invalid'});
  }
  const invalidRepost=post('invalid','invalid');invalidRepost.reason={$type:'app.bsky.feed.defs#reasonRepost',indexedAt:recent.post.indexedAt};
  await assert.rejects(readSource({url:feedURL,last_successful_check:null,oldest_date:'2026-10-02'},
    {through:'2026-11-02T00:00:00Z',fetch:async()=>Response.json({feed:[invalidRepost]})}),{reason:'source_invalid'});
});

test('a first feed check resumes after committed dates; an unchanged feed makes no model calls',async t=>{
  const raw=await setup(t),tr=await tracker(raw),db=database(driver(raw));
  await raw.query('update scout.trackers set url=$2 where id=$1',[tr.id,feedURL]);
  assert.equal((await raw.query('select last_successful_check from scout.trackers')).rows[0].last_successful_check,null);
  const feed=[post('newer','2026-10-25T12:00:00Z'),post('empty','2026-10-24T12:00:00Z'),post('older','2026-10-23T12:00:00.123Z')];
  let calls=[],broken=true;
  const run=()=>intake(db,{trackerId:tr.id,sourceFetch:async()=>Response.json({feed}),modelFor:(source,{functions})=>async(_p,input)=>{
    assert.equal(source.url,input.url);assert.deepEqual(input.content,feed.find(f=>f.post.record.text===input.content.post.record.text));
    const key=input.content.post.record.text;calls.push(key);
    if(key==='newer'&&broken)throw new Error('provider_unavailable');
    if(key!=='empty')await functions[0].run({queries:['Ocean Institute'],urls:[]});
    return answer(key==='empty'?[]:[{...event,description:key}]);
  }});
  const first=await run();assert.equal(first.processed,2);assert.equal(first.created,1);assert.equal(first.state,'deferred');
  const state=(await raw.query('select * from scout.trackers')).rows[0];
  assert.equal(new Date(state.last_successful_check).toISOString(),'2026-10-24T12:00:00.000Z');
  broken=false;calls=[];
  const resumed=await run();assert.deepEqual(calls,['newer']);assert.equal(resumed.processed,1);assert.equal(resumed.created,1);
  const records=(await raw.query('select sources from scout.records')).rows;
  assert.equal(records.length,2);assert.ok(records.every(r=>r.sources[0].url.includes('/post/')));
  calls=[];const before={...db.metrics};
  const empty=await run();assert.equal(empty.processed,0);assert.deepEqual(calls,[]);
  assert.equal(db.metrics.mutations-before.mutations,2);
  t.diagnostic(JSON.stringify({mocked_model:true,real_local_sql:true,empty_feed:{statements:db.metrics.statements-before.statements,mutations:2}}));
});

test('equal timestamps commit together and SQL or invalid-output failures cannot consume a post',async t=>{
  const raw=await setup(t),tr=await feedTracker(raw),db=database(driver(raw));
  const feed=[post('second','2026-10-23T12:00:00Z'),post('first','2026-10-23T12:00:00Z')];
  const initial=(await raw.query('select last_successful_check from scout.trackers')).rows[0].last_successful_check;
  const run=modelFor=>intake(db,{trackerId:tr.id,sourceFetch:async()=>Response.json({feed}),modelFor:(source,options)=>async(...args)=>{const result=await modelFor(source,options)(...args);if(result.decisions?.some(d=>d.action==='create'))await options.functions[0].run({queries:['Ocean Institute'],urls:[]});return result;}});
  let n=0;
  const failed=await run(()=>async()=>{if(++n===2)throw new Error('provider_unavailable');return answer();});
  assert.equal(failed.processed,0);
  assert.equal((await raw.query('select count(*)::int n from scout.records')).rows[0].n,0);
  assert.deepEqual((await raw.query('select last_successful_check from scout.trackers')).rows[0].last_successful_check,initial);
  const invalid=await run(()=>async()=>({status:'complete',decisions:[{action:'invalid'}]}));
  assert.equal(invalid.reason,'invalid_output');assert.equal(invalid.processed,0);
  await raw.exec("alter table scout.records add constraint fail_feed_fixture check(description<>'BBNJ implementation workshop')");
  const sqlFailure=await run(()=>async()=>answer());
  assert.equal(sqlFailure.reason,'database_operation');assert.equal(sqlFailure.processed,0);
  assert.deepEqual((await raw.query('select last_successful_check from scout.trackers')).rows[0].last_successful_check,initial);
  await raw.exec('alter table scout.records drop constraint fail_feed_fixture');
  const success=await run(()=>async()=>answer());
  assert.equal(success.processed,2);assert.equal(success.created,1);assert.equal(success.changed,0);
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
    const result=await intake(db,{trackerId:tr.id,sourceFetch:async()=>Response.json({feed:[post('item','2026-10-25T00:00:00Z')]}),
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
