import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {loadJobs} from '../website/dashboard.js';

test('jobs discovers Supabase functions and cron jobs for verified Scout users without exposing credentials or commands',async()=>{
  const db=new PGlite();
  const reader='00000000-0000-0000-0000-000000000001',admin='00000000-0000-0000-0000-000000000002',outsider='00000000-0000-0000-0000-000000000003';
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role;
      create schema auth;create schema scout;create schema cron;create schema vault;create schema extensions;
      create table auth.users(id uuid,raw_app_meta_data jsonb,raw_user_meta_data jsonb);
      create table auth.identities(user_id uuid,provider text,identity_data jsonb);
      create function auth.uid() returns uuid language sql stable as
       $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema scout to anon,authenticated,service_role;
      insert into auth.users values('${reader}','{}','{"scout":{"admin":true}}'),
       ('${admin}','{"scout":{"admin":true}}','{}'),('${outsider}','{"scout":{"admin":true}}','{}');
      insert into auth.identities select id,'google','{"iss":"https://accounts.google.com","email_verified":true,"custom_claims":{"hd":"oceanagentics.com"}}'
       from auth.users where id in ('${reader}','${admin}');
      create table vault.decrypted_secrets(name text,decrypted_secret text);
      insert into vault.decrypted_secrets values('scout_functions_read_key','PRIVATE_READ_TOKEN');
      create type extensions.http_header as(field varchar,value varchar);
      create type extensions.http_request as(method varchar,uri varchar,headers extensions.http_header[],content_type varchar,content varchar);
      create function extensions.http_header(varchar,varchar) returns extensions.http_header language sql immutable as
       $$select row($1,$2)::extensions.http_header$$;
      create table extensions.mock_response(status int,content varchar);
      insert into extensions.mock_response values(200,'[{"slug":"scout-reader","status":"ACTIVE","version":48,"updated_at":1795200000000,"entrypoint_path":"PRIVATE_PATH"},{"slug":"mimi-mcp","status":"ACTIVE"}]');
      create function extensions.http(request extensions.http_request) returns table(status int,content varchar) language plpgsql stable as $$
       begin
        if request.method<>'GET' or request.uri<>'https://api.supabase.com/v1/projects/vhlfumeyhkeospnemukq/functions'
         or request.headers<>array[extensions.http_header('Authorization','Bearer PRIVATE_READ_TOKEN')]
         or request.content is not null then raise exception 'Invalid inventory request';end if;
        return query select r.status,r.content from extensions.mock_response r;
       end$$;
      create table cron.job(jobid bigint,jobname text,schedule text,active boolean,command text);
      create table cron.job_run_details(jobid bigint,runid bigint,status text,start_time timestamptz,end_time timestamptz,return_message text);
      insert into cron.job values(1,'collection','*/6 * * * *',true,'PRIVATE_COMMAND'),(2,'paused','0 8 * * *',false,'PRIVATE_COMMAND');
      insert into cron.job_run_details values(1,1,'succeeded','2026-11-20T10:00Z','2026-11-20T10:00:01Z','1 row'),
       (1,2,'failed','2026-11-20T11:00Z','2026-11-20T11:00:01Z','connection failed');`);
    const access=await readFile(new URL('../supabase/migrations/20261001170000_scout_lean_schema.sql',import.meta.url),'utf8');
    await db.exec(access.match(/create or replace function scout\.access_role\(\)[\s\S]+?\$\$;/)[0]);
    await db.exec(await readFile(new URL('../supabase/migrations/20261120020000_scout_cron.sql',import.meta.url),'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/20261120030000_scout_jobs.sql',import.meta.url),'utf8'));
    assert.equal((await db.query("select to_regprocedure('scout.cron()') as old_rpc")).rows[0].old_rpc,null);
    const before=(await db.query('select * from cron.job order by jobid')).rows;
    for(const role of ['anon','service_role']){
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query('select scout.jobs()'),{code:'42501'});
      await db.exec('reset role');
    }
    await db.exec('set role authenticated');
    for(const user of ['',outsider]){
      await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);
      await assert.rejects(db.query('select scout.jobs()'),{code:'42501'});
    }
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[reader]);
    await assert.rejects(db.query('select * from cron.job'),{code:'42501'});
    await assert.rejects(db.query('select * from vault.decrypted_secrets'),{code:'42501'});
    await db.exec('begin read only');
    const result=(await db.query('select scout.jobs() as jobs')).rows[0].jobs;
    await db.exec('commit');
    const rows=result.cron;
    assert.deepEqual(result.functions,[{name:'scout-reader',status:'ACTIVE',version:48,updated_at:1795200000000}]);
    assert.equal(rows.length,2);
    assert.equal(rows[0].status,'failed');assert.equal(rows[0].message,'connection failed');
    assert.equal(rows[0].enabled,true);assert.equal(rows[0].schedule,'*/6 * * * *');
    assert.equal(rows[1].enabled,false);assert.equal(rows[1].status,null);assert.equal(rows[1].started_at,null);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[admin]);
    assert.deepEqual((await db.query('select scout.jobs() as jobs')).rows[0].jobs,result);
    await db.exec('reset role');
    assert.deepEqual((await db.query('select * from cron.job order by jobid')).rows,before);
    await db.exec(`insert into cron.job values(3,'new schedule','0 * * * *',true,'PRIVATE_COMMAND');
      insert into cron.job_run_details values(3,3,'running',now(),null,null);
      update extensions.mock_response set content=(content::jsonb||'[{"slug":"scout-new","status":"ACTIVE","version":1,"updated_at":1795200000000}]')::text;
      set role authenticated;`);
    const discovered=(await db.query('select scout.jobs() as jobs')).rows[0].jobs;
    assert.equal(discovered.cron.length,3);
    assert.equal(discovered.cron.find(row=>row.name==='new schedule').status,'running');
    assert.equal(discovered.cron.find(row=>row.name==='new schedule').finished_at,null);
    assert.deepEqual(discovered.functions.map(fn=>fn.name),['scout-new','scout-reader']);
    await db.exec('reset role');
    for(const [status,content] of [[403,'PRIVATE_REMOTE_ERROR'],[200,'null'],[200,'PRIVATE_INVALID_JSON']]){
      await db.query('update extensions.mock_response set status=$1,content=$2',[status,content]);
      await db.exec('set role authenticated');
      await assert.rejects(db.query('select scout.jobs()'),{message:'Function inventory unavailable'});
      await db.exec('reset role');
    }
    await db.exec('delete from vault.decrypted_secrets;set role authenticated');
    await assert.rejects(db.query('select scout.jobs()'),{message:'Function inventory access is not configured'});
  } finally {await db.close();}
});

test('browser jobs loads both live lists through a read-only HTTP RPC and surfaces failures',async()=>{
  const rows={cron:[{job_id:1,name:'collection',enabled:true}],functions:[{name:'scout-reader',status:'ACTIVE'}]},calls=[];
  const failure=new Error('Unavailable');let fail=false;
  const client={rpc:async(...args)=>{calls.push(args);return fail?{error:failure}:{data:rows};}};
  assert.deepEqual(await loadJobs(client),rows);
  assert.deepEqual(calls,[['jobs',undefined,{get:true}]]);
  fail=true;await assert.rejects(loadJobs(client),error=>error===failure);
});
