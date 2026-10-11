import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {dateInterval,normalizeDate,findingInterval,dateLabel} from '../src/finding.js';
import {processDocument,claimSource,packDocument} from '../collector/finding-jobs.js';
import {prepareResponse,prepareDocument,collectDocuments} from '../collector/octo-documents.js';
import {sourceURL} from '../collector/hsa.js';
import {database as boundary,hostedHSA} from '../collector/hosted-hsa.js';
import {gemini} from '../collector/model.js';
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
const verdict=input=>({
 input_hash:input.input_hash,occurrence:{status:'supported',reason:'Injected independent support verdict.',sources:input.finding.proposal.occurrence.sources},
 claims:input.claims.map(c=>({...c,status:'supported',reason:'Injected support verdict.'})),
 relevance:{priority:'normal',reason:'Substantive high seas MPA webinar.',fields:['proposed.title']}
});
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
  const result=packet.stage==='extract'?{complete:true,reason:'All considered.',findings:[proposal(packet)]}:verdict(packet);
  if(packet.stage!=='extract'&&counter.alternateReason)result.relevance.reason='Reworded relevance for the same accepted webinar facts.';
  return Response.json({usageMetadata:{promptTokenCount:4000,candidatesTokenCount:500},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(result)}]}}]});
 };
}

test('one E04 record through production readers, model accounting and final save; unchanged and irrelevant-change repeats',async t=>{
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
  assert.equal((await raw.query('select count(*)::int n from scout.evidence')).rows[0].n,0);
  assert.equal((await raw.query('select count(*)::int n from scout.collection_runs')).rows[0].n,0);
  const counts=async()=>Object.fromEntries(await Promise.all(['records','record_sources','record_identities','source_state','quota_reservations'].map(async name=>[name,(await raw.query('select count(*)::int n from scout.'+name)).rows[0].n])));
  const before=await counts();
  for(let i=0;i<100;i++){
   await raw.exec("update scout.source_state set due_at=now()-interval '1 second'");
   assert.equal((await run()).state,'unchanged');
  }
  assert.equal(counter.generations,2);assert.equal(totals.mutations-initial.mutations,200);assert.deepEqual(await counts(),before);
  assert.deepEqual((await raw.query('select updated_at from scout.records')).rows[0].updated_at,record.updated_at);
  const repeat={statements:(totals.statements-initial.statements)/100,mutations:2,submitted_bytes:(totals.submitted_bytes-initial.submitted_bytes)/100};
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

test('compatible conversion preserves IDs, final facts, URLs, priority, delivery and historical content',async()=>{
 const db=await setup(false);try{
  const tr=await tracker(db),r=(await db.query("insert into scout.records(kind,title,organization,event_url,priority,last_communicated_at) values('event','Legacy','IDDRI','https://example.org/event','normal','2026-01-01') returning *")).rows[0];
  const parsed={accepted_fields:{starts_on:{value:'2026-02-26',accepted_at:'2026-10-01',sources:[{url:'https://example.org/event',quote:'unchanged private proof'}]}},
   assessment:{priority_accepted:true,priority:'normal',reason:'Legacy accepted reason.',accepted_at:'2026-10-01'}};
  await db.query("insert into scout.evidence(record_id,tracker_id,url,content_hash,content,parsed) values($1,$2,'https://example.org/event','legacy','UNCHANGED HISTORICAL BODY',$3)",[r.id,tr.id,parsed]);
  await db.query("insert into scout.collection_runs(tracker_id,started_at,stats) values($1,now()-interval '10 days',$2)",[tr.id,{model_attempts:[{at:'2026-01-01T00:00:00Z',input_tokens:123}]}]);
  const oldAnnouncement=(await db.query("insert into scout.records(kind,title,priority) values('announcement','Legacy announcement','normal') returning id")).rows[0];
  await db.query("insert into scout.evidence(record_id,tracker_id,url,content_hash,content,parsed) values($1,$2,'https://example.org/legacy-announcement','legacy-news','UNCHANGED ANNOUNCEMENT BODY','{}')",[oldAnnouncement.id,tr.id]);
  const history=(await db.query('select * from scout.evidence')).rows;
  await db.exec(await readFile(new URL('../supabase/migrations/20261009190000_scout_findings.sql',import.meta.url),'utf8'));
  const converted=(await db.query('select * from scout.records where id=$1',[r.id])).rows[0];
  assert.equal(converted.id,r.id);assert.equal(converted.details.start.value,'2026-02-26');
  assert.deepEqual(converted.organizations,[{name:'IDDRI',role:'unspecified'}]);assert.equal(converted.canonical_url,r.event_url);
  assert.equal(converted.priority,'normal');assert.equal(converted.relevance.reason,'Legacy accepted reason.');
  assert.deepEqual(converted.last_communicated_at,r.last_communicated_at);assert.deepEqual(converted.updated_at,r.updated_at);
  assert.deepEqual((await db.query('select * from scout.evidence')).rows,history);
  assert.equal((await db.query('select count(*)::int n from scout.quota_reservations')).rows[0].n,0);
  const source={tracker_id:tr.id,identity:'legacy-announcement',url:'https://example.org/legacy-announcement'};
  const prepared=prepareDocument({url:source.url,title:'',html:'<p>Legacy announcement.</p>'});
  const sources=[{doc:'P',block:0,quote:'Legacy announcement.'}];
  const refresh=await processDocument(db,{source,prepared,model:async()=>({complete:true,findings:[{
    occurrence:{kind:'announcement',anchor:'Legacy announcement',title:'Legacy announcement',sources},description:null,canonical_url:null,organizations:[],
    details:{published:null,effective:null,subjects:null},identities:[],unknowns:{organizations:{reason:'not_announced',explanation:'Unknown.'},'details.published':{reason:'not_announced',explanation:'Unknown.'}}
  }],relevance:[{priority:'normal',reason:'Accepted substantive announcement.',fields:['title']}]})});
  assert.equal(refresh.created,0);assert.equal(refresh.state,'complete');
  assert.equal((await db.query("select id from scout.records where kind='announcement'")).rows[0].id,oldAnnouncement.id);
  assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,2);
  assert.deepEqual((await db.query('select * from scout.evidence')).rows,history);
  const nativePrepared=prepareDocument({url:source.url,title:'',html:'<p>Legacy announcement. UID:legacy-native</p>'});
  const nativeRefresh=await processDocument(db,{source:{...source,identity:'new-native-reader'},prepared:nativePrepared,model:async()=>({complete:true,findings:[{
    occurrence:{kind:'announcement',anchor:'Legacy announcement',title:'Legacy announcement',sources},description:null,canonical_url:null,organizations:[],
    details:{published:null,effective:null,subjects:null},identities:[{scheme:'calendar_uid',value:'legacy-native',sources:[{doc:'P',block:0,quote:'UID:legacy-native'}]}],
    unknowns:{organizations:{reason:'not_announced',explanation:'Unknown.'},'details.published':{reason:'not_announced',explanation:'Unknown.'}}
  }],relevance:[{priority:'normal',reason:'Accepted substantive announcement.',fields:['title']}]})});
  assert.equal(nativeRefresh.reason,'ambiguous_identity');assert.equal(nativeRefresh.created,0);
  assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,2);
  await db.exec('set role authenticated');
  await assert.rejects(db.query('select * from scout.evidence'),{code:'42501'});
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
  assert.equal(reads,3);
  const row=(await raw.query('select * from scout.source_state')).rows[0];assert.equal(row.state,'parked');assert.equal(row.processed_hash,null);assert.ok(!JSON.stringify(row).includes('PRIVATE'));
  const crash={...source,identity:'crash'};let last;
  for(let i=0;i<4;i++){
   await raw.exec("update scout.source_state set due_at=now()-interval '1 second',lease_until=now()-interval '1 second' where identity='crash'");
   last=await claimSource(db,crash);
  }
  assert.equal(last.state,'parked');assert.equal(last.attempts,3);
 }finally{await raw.close();}
});

test('human overrides survive page refresh and optimistic corrections reject stale versions',async()=>{
 const raw=await setup();try{
  const tr=await tracker(raw),db=boundary(driver(raw)),source={tracker_id:tr.id,identity:'simple',url:'https://example.org/simple'};
  let text='Ocean announcement.',calls=0;
  const read=()=>prepareDocument({url:source.url,title:'',html:'<p>'+text+'</p>'});
  const model=async()=>{calls++;return {complete:true,findings:[{occurrence:{kind:'announcement',anchor:'Ocean announcement',title:'Ocean announcement',sources:[{doc:'P',block:0,quote:'Ocean announcement.'}]},description:null,canonical_url:null,organizations:[],details:{published:null,effective:null,subjects:null},identities:[],unknowns:{organizations:{reason:'not_announced',explanation:'Unknown.'},'details.published':{reason:'not_announced',explanation:'Unknown.'}}}],relevance:[{priority:'low',reason:'General ocean announcement.',fields:['title']}]};};
  assert.equal((await processDocument(db,{source,read,model})).created,1);
  const r=(await raw.query('select * from scout.records')).rows[0];
  await correctFinding(db,{record_id:r.id,version:1,field:'title',value:'Human title',url:source.url});
  await assert.rejects(correctFinding(db,{record_id:r.id,version:1,field:'title',value:'Stale title',url:source.url}),{status:409});
  text+=' Updated footer.';
  await processDocument(db,{source,read,model});
  assert.equal((await raw.query('select title from scout.records')).rows[0].title,'Human title');assert.equal(calls,2);
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
