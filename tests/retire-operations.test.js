import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const cleanup=await readFile(new URL('../supabase/scout-retire-operations.sql',import.meta.url),'utf8');
const cutover=await readFile(new URL('../supabase/migrations/20261009190000_scout_findings.sql',import.meta.url),'utf8');
async function fixture(){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');
 create table auth.identities(user_id uuid,provider text,identity_data jsonb);
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create schema cron;create table cron.job(jobid int,jobname text,command text,active boolean);
 insert into cron.job values(1,'scout-collection','select scout.loop_tick()',false),(2,'unrelated','select 1',false);
 create table cron.job_run_details(jobid int,runid int,end_time timestamptz);
 insert into cron.job_run_details values(1,1,now()),(2,2,now());
 create schema net;create table net._http_response(id int,created timestamptz,content text);
 set pg_net.ttl='6 hours';
 insert into net._http_response values(1,now()-interval '7 hours','expired'),(2,now(),'keep shared response');`);
 for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort().filter(n=>n<'20261009190000'))
  await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
 const tr=(await db.query("insert into scout.trackers(name,url,collector,cadence) values('Fixture','https://example.org','web','6 hours') returning id")).rows[0].id;
 const record=(await db.query("insert into scout.records(kind,title,priority,organization,last_communicated_at) values('event','Keep me','normal','IDDRI',now()) returning *")).rows[0];
 const parsed={document:{prepared:{text:'DISCARD_BODY'}},finding:{quote:'DISCARD_BODY'},resolution:{history:['DISCARD_BODY']},
  accepted_fields:{starts_on:{value:'2026-02-26',accepted_at:'2026-01-01',sources:[{url:'https://example.org/registration',quote:'DISCARD_BODY'}],superseded:['DISCARD_BODY']}},
  assessment:{priority:'normal',priority_accepted:true,reason:'Keep accepted reason',accepted_at:'2026-01-01',traffic:'DISCARD_BODY'}};
 await db.query("insert into scout.evidence(tracker_id,record_id,url,content_hash,content,parsed,last_seen_at) values($1,$2,'https://example.org/event','linked','DISCARD_BODY',$3,now())",[tr,record.id,parsed]);
 await db.query("insert into scout.evidence(tracker_id,url,content_hash,content,parsed) values($1,'https://example.org/unused','unlinked','DISCARD_BODY','{}')",[tr]);
 await db.query("insert into scout.collection_runs(tracker_id,started_at,stats,report) values($1,now()-interval '10 days','{}','{\"body\":\"DISCARD_BODY\"}')",[tr]);
 return {db,tr,record};
}

test('cleanup preserves records and final facts/URLs, blocks owner writes, then supports the findings cutover',async()=>{
 const {db,tr,record}=await fixture();try{
  await db.exec(cleanup);
  assert.deepEqual((await db.query('select * from scout.records')).rows,[record]);
  assert.equal((await db.query('select count(*)::int n from scout.collection_runs')).rows[0].n,0);
  const evidence=(await db.query('select * from scout.evidence')).rows;assert.equal(evidence.length,1);
  assert.ok(!JSON.stringify(evidence).includes('DISCARD_BODY'));
  assert.deepEqual(evidence[0].parsed.accepted_fields.starts_on,{value:'2026-02-26',accepted_at:'2026-01-01',sources:[{url:'https://example.org/registration'}]});
  assert.equal(evidence[0].url,'https://example.org/event');
  assert.deepEqual((await db.query('select runid from cron.job_run_details')).rows,[{runid:2}]);
  assert.deepEqual((await db.query('select id from net._http_response')).rows,[{id:2}]);
  assert.equal((await db.query("select loop_state from scout.tracker_status where id=$1",[tr])).rows[0].loop_state,'Paused');
  await assert.rejects(db.query('insert into scout.collection_runs(tracker_id) values($1)',[tr]),{code:'23514'});
  await assert.rejects(db.exec("update scout.evidence set content='recreated payload'"),{code:'23514'});
  await db.exec(cutover);
  assert.equal((await db.query("select to_regclass('scout.evidence') name")).rows[0].name,null);
  const result=(await db.query('select * from scout.records')).rows[0];
  assert.equal(result.id,record.id);assert.equal(result.details.start.value,'2026-02-26');
  assert.deepEqual(result.updated_at,record.updated_at);assert.deepEqual(result.last_communicated_at,record.last_communicated_at);
  assert.deepEqual((await db.query('select url from scout.record_sources order by url')).rows.map(x=>x.url),['https://example.org/event','https://example.org/registration']);
 }finally{await db.close();}
});

test('active quotas, retry deadlines, unresolved deliveries and active schedules prevent cleanup',async()=>{
 const {db}=await fixture();try{
  for(const stats of [{model_attempts:[{at:new Date().toISOString(),state:'unknown'}]},
   {model_retry_at:new Date(Date.now()+3600000).toISOString()},{delivery:{status:'unknown'}}]){
   await db.query('update scout.collection_runs set stats=$1',[stats]);
   await assert.rejects(db.exec(cleanup),/accounting|notification/);await db.exec('rollback');
   assert.equal((await db.query('select count(*)::int n from scout.evidence')).rows[0].n,2);
  }
  await db.exec("update scout.collection_runs set stats='{}';update cron.job set active=true");
  await assert.rejects(db.exec(cleanup),/Pause Scout/);await db.exec('rollback');
  assert.equal((await db.query('select count(*)::int n from scout.collection_runs')).rows[0].n,1);
 }finally{await db.close();}
});

test('a failure after TRUNCATE rolls back all deletions and constraints',async()=>{
 const {db}=await fixture();try{
  const before=(await db.query('select * from scout.evidence order by id')).rows;
  await assert.rejects(db.exec(cleanup.replace('insert into scout.evidence select',"raise exception 'injected after truncate'; insert into scout.evidence select")),/injected after truncate/);
  await db.exec('rollback');
  assert.deepEqual((await db.query('select * from scout.evidence order by id')).rows,before);
  assert.equal((await db.query('select count(*)::int n from scout.collection_runs')).rows[0].n,1);
 }finally{await db.close();}
});

test('replacement scheduler bounds its own history without a policy table',async()=>{
 const {db}=await fixture();try{
  await db.exec(cleanup);await db.exec(cutover);
  for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort().filter(n=>n>'20261009190000_scout_findings.sql'))
    await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
  const scheduler=await readFile(new URL('../supabase/scout-loop.sql',import.meta.url),'utf8');
  await db.exec(scheduler.match(/create or replace function scout\.loop_tick[\s\S]+?end \$\$;/)[0]);
  await db.exec(`insert into cron.job_run_details select 1,n,now()-interval '2 days' from generate_series(3,102) n;
   insert into cron.job_run_details values(1,103,now());select scout.loop_tick('next');`);
  assert.equal((await db.query('select count(*)::int n from cron.job_run_details where jobid=1')).rows[0].n,53);
  assert.deepEqual((await db.query('select runid from cron.job_run_details where jobid=2')).rows,[{runid:2}]);
  assert.equal((await db.query('select count(*)::int n from scout.quota_reservations')).rows[0].n,0);
 }finally{await db.close();}
});
