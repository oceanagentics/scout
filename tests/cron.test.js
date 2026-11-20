import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {loadCron} from '../website/dashboard.js';

test('cron exposes live scheduler metadata to verified Scout users without granting direct cron access',async()=>{
  const db=new PGlite();
  const reader='00000000-0000-0000-0000-000000000001',admin='00000000-0000-0000-0000-000000000002',outsider='00000000-0000-0000-0000-000000000003';
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role;
      create schema auth;create schema scout;create schema cron;
      create table auth.users(id uuid,raw_app_meta_data jsonb,raw_user_meta_data jsonb);
      create table auth.identities(user_id uuid,provider text,identity_data jsonb);
      create function auth.uid() returns uuid language sql stable as
       $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema scout to anon,authenticated,service_role;
      insert into auth.users values('${reader}','{}','{"scout":{"admin":true}}'),
       ('${admin}','{"scout":{"admin":true}}','{}'),('${outsider}','{"scout":{"admin":true}}','{}');
      insert into auth.identities select id,'google','{"iss":"https://accounts.google.com","email_verified":true,"custom_claims":{"hd":"oceanagentics.com"}}'
       from auth.users where id in ('${reader}','${admin}');
      create table cron.job(jobid bigint,jobname text,schedule text,active boolean,command text);
      create table cron.job_run_details(jobid bigint,runid bigint,status text,start_time timestamptz,end_time timestamptz,return_message text);
      insert into cron.job values(1,'collection','*/6 * * * *',true,'PRIVATE_COMMAND'),(2,'paused','0 8 * * *',false,'PRIVATE_COMMAND');
      insert into cron.job_run_details values(1,1,'succeeded','2026-11-20T10:00Z','2026-11-20T10:00:01Z','1 row'),
       (1,2,'failed','2026-11-20T11:00Z','2026-11-20T11:00:01Z','connection failed');`);
    const access=await readFile(new URL('../supabase/migrations/20261001170000_scout_lean_schema.sql',import.meta.url),'utf8');
    await db.exec(access.match(/create or replace function scout\.access_role\(\)[\s\S]+?\$\$;/)[0]);
    await db.exec(await readFile(new URL('../supabase/migrations/20261120020000_scout_cron.sql',import.meta.url),'utf8'));
    const before=(await db.query('select * from cron.job order by jobid')).rows;
    for(const role of ['anon','service_role']){
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query('select * from scout.cron()'),{code:'42501'});
      await db.exec('reset role');
    }
    await db.exec('set role authenticated');
    for(const user of ['',outsider]){
      await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);
      await assert.rejects(db.query('select * from scout.cron()'),{code:'42501'});
    }
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[reader]);
    await assert.rejects(db.query('select * from cron.job'),{code:'42501'});
    const rows=(await db.query('select * from scout.cron()')).rows;
    assert.equal(rows.length,2);
    assert.equal(rows[0].status,'failed');assert.equal(rows[0].message,'connection failed');
    assert.equal(rows[0].enabled,true);assert.equal(rows[0].schedule,'*/6 * * * *');
    assert.equal(rows[1].enabled,false);assert.equal(rows[1].status,null);assert.equal(rows[1].started_at,null);
    assert.ok(!JSON.stringify(rows).includes('PRIVATE_COMMAND'));
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[admin]);
    assert.deepEqual((await db.query('select * from scout.cron()')).rows,rows);
    await db.exec('reset role');
    assert.deepEqual((await db.query('select * from cron.job order by jobid')).rows,before);
    await db.exec(`insert into cron.job values(3,'new schedule','0 * * * *',true,'PRIVATE_COMMAND');
      insert into cron.job_run_details values(3,3,'running',now(),null,null);set role authenticated;`);
    const discovered=(await db.query('select * from scout.cron()')).rows;
    assert.equal(discovered.length,3);
    assert.equal(discovered.find(row=>row.name==='new schedule').status,'running');
    assert.equal(discovered.find(row=>row.name==='new schedule').finished_at,null);
  } finally {await db.close();}
});

test('browser cron uses a read-only HTTP RPC and surfaces failures',async()=>{
  const rows=[{job_id:1,name:'collection',enabled:true}],calls=[];
  const failure=new Error('Unavailable');let fail=false;
  const client={rpc:async(...args)=>{calls.push(args);return fail?{error:failure}:{data:rows};}};
  assert.deepEqual(await loadCron(client),rows);
  assert.deepEqual(calls,[['cron',undefined,{get:true}]]);
  fail=true;await assert.rejects(loadCron(client),error=>error===failure);
});
