import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {loadReview,submitReview} from '../website/review.js';

test('review feedback is private, durable, independent of model rankings and counted once per reviewer/finding',async()=>{
  const db=new PGlite();
  const reviewer='00000000-0000-0000-0000-000000000001',other='00000000-0000-0000-0000-000000000002',outsider='00000000-0000-0000-0000-000000000003';
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
      create schema auth;create schema vault;create table vault.secrets(name text,secret text);
      create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}',raw_user_meta_data jsonb default '{}');
      create table auth.identities(user_id uuid,provider text,identity_data jsonb);
      create function auth.uid() returns uuid language sql stable as
       $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to anon,authenticated,service_role;
      grant execute on function auth.uid() to anon,authenticated,service_role;
      insert into auth.users(id) values('${reviewer}'),('${other}'),('${outsider}');
      insert into auth.identities select id,'google','{"iss":"https://accounts.google.com","email_verified":true,"custom_claims":{"hd":"oceanagentics.com"}}'
       from auth.users where id in ('${reviewer}','${other}');`);
    for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())
      await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
    await db.exec(`insert into scout.records(description,priority,sources)
      select 'Finding '||n,case when n=1 then null else 'normal' end,'[{"url":"https://example.org/finding","role":"finding"}]'::jsonb
      from generate_series(1,25) n;`);
    const before=(await db.query('select * from scout.records order by id')).rows;
    await db.exec('set role anon');
    await assert.rejects(db.query('select scout.review_queue()'),{code:'42501'});
    await assert.rejects(db.query('select * from scout.finding_reviews'),{code:'42501'});
    await db.exec('reset role;set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[outsider]);
    await assert.rejects(db.query('select scout.review_queue()'),{code:'42501'});
    await assert.rejects(db.query("select scout.submit_review($1,now(),'high','forged')",[before[0].id]),{code:'42501'});
    assert.deepEqual((await db.query('select * from scout.finding_reviews')).rows,[]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[reviewer]);
    let state=(await db.query('select scout.review_queue() state')).rows[0].state;
    assert.equal(state.reviewed_count,0);
    const first=state.record;
    const params=[first.id,first.modified,'high','A volunteer’s independent assessment'];
    state=(await db.query('select scout.submit_review($1,$2,$3,$4) state',params)).rows[0].state;
    assert.equal(state.reviewed_count,1);assert.notEqual(state.record.id,first.id);
    const retry=(await db.query('select scout.submit_review($1,$2,$3,$4) state',params)).rows[0].state;
    assert.deepEqual(retry,state);
    const saved=(await db.query('select * from scout.finding_reviews')).rows[0];
    assert.equal(saved.priority,'high');assert.equal(saved.model_priority,first.priority);
    assert.equal(saved.notes,params[3]);assert.equal(saved.reviewer_id,reviewer);
    await assert.rejects(db.query("update scout.finding_reviews set priority='low'"),{code:'42501'});
    await assert.rejects(db.query('delete from scout.finding_reviews'),{code:'42501'});
    await assert.rejects(db.query("insert into scout.finding_reviews(reviewer_id,record_id,priority) values($1,$2,'high')",[other,state.record.id]),{code:'42501'});
    await assert.rejects(db.query("select scout.submit_review($1,$2,'urgent','')",[state.record.id,state.record.modified]),{code:'22023'});
    await assert.rejects(db.query("select scout.submit_review($1,$2,null,'')",[state.record.id,state.record.modified]),{code:'22023'});
    for(const notes of [null,'','   ','\t\n\r'])
      await assert.rejects(db.query("select scout.submit_review($1,$2,'high',$3)",[state.record.id,state.record.modified,notes]),{code:'22023',message:'Explain why you chose this ranking'});
    await assert.rejects(db.query("select scout.submit_review($1,null,'high','Substantive treaty update')",[state.record.id]),{code:'40001'});
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[other]);
    assert.equal((await db.query('select scout.review_queue() state')).rows[0].state.reviewed_count,0);
    assert.deepEqual((await db.query('select * from scout.finding_reviews')).rows,[]);
    await db.query('select scout.submit_review($1,$2,$3,$4)',params);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[reviewer]);
    for(let n=2;n<=25;n++) {
      state=(await db.query("select scout.submit_review($1,$2,'low','Limited relevance to BBNJ implementation') state",[state.record.id,state.record.modified])).rows[0].state;
      assert.equal(state.reviewed_count,n);
      if(n===12||n===24)assert.equal((await db.query('select scout.review_queue() state')).rows[0].state.reviewed_count,n);
    }
    assert.equal(state.record,null);
    assert.equal((await db.query('select count(*)::int n from scout.finding_reviews')).rows[0].n,25);
    await db.exec('reset role');
    assert.deepEqual((await db.query('select * from scout.records order by id')).rows,before);
    await db.query('update auth.users set raw_app_meta_data=$1 where id=$2',[{scout:{admin:true}},reviewer]);
    await db.exec('set role authenticated');
    assert.equal((await db.query('select count(*)::int n from scout.finding_reviews')).rows[0].n,26);
    await db.exec('reset role');
    await db.exec("insert into scout.records(description,priority) values('Changed finding','normal')");
    await db.exec('set role authenticated');
    state=(await db.query('select scout.review_queue() state')).rows[0].state;
    await db.exec('reset role');
    await db.query("update scout.records set priority='low',modified=array_append(modified,now()) where id=$1",[state.record.id]);
    await db.exec('set role authenticated');
    await assert.rejects(db.query("select scout.submit_review($1,$2,'high','outdated')",[state.record.id,state.record.modified]),{code:'40001'});
    assert.equal((await db.query('select scout.review_queue() state')).rows[0].state.reviewed_count,25);
  } finally {await db.close();}
});

test('browser review calls preserve the exact finding revision and propagate save failures',async()=>{
  const record={id:'finding',modified:'2026-11-19T01:00:00.123456+00:00'};
  const failure={code:'40001',message:'This finding changed.'};
  const calls=[];
  const client={rpc:async(name,params)=>{calls.push({name,params});return name==='review_queue'?{data:{record,reviewed_count:11}}:{error:failure};}};
  assert.equal((await loadReview(client)).reviewed_count,11);
  await assert.rejects(submitReview(client,record,'low','My notes'),error=>error===failure);
  assert.deepEqual(calls,[{name:'review_queue',params:undefined},{name:'submit_review',params:{p_record_id:record.id,p_modified:record.modified,p_priority:'low',p_notes:'My notes'}}]);
});
