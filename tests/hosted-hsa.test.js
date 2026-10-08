import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { verifyAuth } from '@supabase/server/core';
import { hostedHSA } from '../collector/hosted-hsa.js';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { DOCUMENT_TRACKERS } from '../collector/hsa.js';

const secret = 'sb_secret_scout_test_only';
const env = { url: 'https://example.supabase.co', secretKeys: { default: secret, other: 'sb_secret_other_test_only' },
  publishableKeys: { default: 'sb_publishable_test_only' }, jwks: null };
const request = (headers = { apikey: secret }, query = '', method = 'POST') => new Request(`https://example.test/collect${query}`, { method, headers });

test('missing, invalid, publishable, other secret and valid user JWT never open a database or collect', async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(publicKey), kid: 'test' };
  const jwt = await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'ES256', kid: 'test' })
    .setSubject('00000000-0000-0000-0000-000000000001').setIssuedAt().setExpirationTime('1h').sign(privateKey);
  const testEnv = { ...env, jwks: { keys: [jwk] } };
  assert.equal((await verifyAuth(request({ Authorization: `Bearer ${jwt}` }), { auth: 'user', env: testEnv })).error, null);
  let connects = 0, collections = 0;
  for (const headers of [{}, { apikey: 'invalid' }, { apikey: env.publishableKeys.default }, { apikey: env.secretKeys.other },
    { Authorization: `Bearer ${jwt}` }, { Authorization: `Bearer ${jwt}`, apikey: env.publishableKeys.default }]) {
    const response = await hostedHSA(request(headers, '?validate=true&tracker_id=00000000-0000-0000-0000-000000000001'), { env: testEnv, databaseURL: 'unused',
      connect: () => { connects++; }, collect: () => { collections++; } });
    assert.equal(response.status, 401);
  }
  assert.equal(connects, 0);
  assert.equal(collections, 0);
});

test('invalid authenticated requests do no database work', async () => {
  let connects = 0;
  for (const req of [request(),request(undefined, '', 'GET'), request(undefined, '?since=2026-02-30'),
    ...['next=false','next=true&next=true','next=true&tracker_id=00000000-0000-0000-0000-000000000001','next=true&max_attempts=1']
      .map(query=>request(undefined,'?'+query)),
    request(undefined, '?since=2026-09-01&since=2026-10-01'), request(undefined, '?sql=delete'),
    request(undefined, '?source_id=invalid'), request(undefined, '?source_id=00000000-0000-0000-0000-000000000001&source_id=00000000-0000-0000-0000-000000000002'),
    request(undefined, '?tracker_id=invalid'), request(undefined, '?tracker_id=00000000-0000-0000-0000-000000000001&tracker_id=00000000-0000-0000-0000-000000000002'),
    ...['true','false','','all','true&validate=true'].map(value=>request(undefined, `?validate=${value}`)),
    request(undefined, '?validate=false&tracker_id=00000000-0000-0000-0000-000000000001'),
    request(undefined, '?validate=true&tracker_id=all'),
    request(undefined, '?documents=true&validate=true&tracker_id=9dc6b107-5e12-4124-b4ce-583faf91e50d'),
    request(undefined, '?validate=true&tracker_id=9dc6b107-5e12-4124-b4ce-583faf91e50d'),
    ...['','&validate=true','&tracker_id=9dc6b107-5e12-4124-b4ce-583faf91e50d',
      '&validate=true&tracker_id=9dc6b107-5e12-4124-b4ce-583faf91e50d&documents=process',
      '&validate=true&tracker_id=9dc6b107-5e12-4124-b4ce-583faf91e50d&source_id=00000000-0000-0000-0000-000000000001',
      '&validate=true&tracker_id=9dc6b107-5e12-4124-b4ce-583faf91e50d&assess_only=true']
      .map(suffix=>request(undefined,'?documents=process'+suffix)),
    request(undefined, '?validate=true&validate=true&tracker_id=00000000-0000-0000-0000-000000000001'),
    ...['true','false','','true&assess_only=true'].map(value=>request(undefined, `?assess_only=${value}`)),
    request(undefined, '?assess_only=true&validate=true&tracker_id=00000000-0000-0000-0000-000000000001'),
    ...['-1','11','1.2','','2&max_attempts=3'].map(value=>request(undefined, `?max_attempts=${value}`)),
    ...['since=2026-02-30','max_attempts=11','max_attempts=1&max_attempts=2','validate=false','sql=delete']
      .map(value=>request(undefined,'?documents=process&validate=true&tracker_id=9dc6b107-5e12-4124-b4ce-583faf91e50d&'+value)),
    new Request('https://example.test', { method: 'POST', headers: { apikey: secret }, body: '{}' })]) {
    const response = await hostedHSA(req, { env, databaseURL: 'unused', connect: () => { connects++; } });
    assert.ok([400, 405].includes(response.status));
  }
  assert.equal(connects, 0);
});

test('rotation uses persisted oldest attempts, skips ineligible trackers, backs off failures and recovers expired claims', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
      create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');create table auth.identities(user_id uuid,provider text,identity_data jsonb);
      create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;`);
    for (const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())
      await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
    const ids = [1,2,3,4].map(n=>'00000000-0000-0000-0000-00000000000'+n);
    for (const [i,id] of ids.entries()) await db.query(
      "insert into scout.trackers(id,name,url,collector,cadence,enabled) values($1,'Fixture',$2,$3,'365 days',$4)",
      [id,i===3?'https://unsupported.test/':DOCUMENT_TRACKERS[i].url,DOCUMENT_TRACKERS[i].collector,i!==2]);
    // Notification calls must not hide a never-collected tracker.
    await db.query("insert into scout.collection_runs(tracker_id,outcome,finished_at,stats) values($1,'no_change',now(),'{\"purpose\":\"notifications\"}')",[ids[0]]);
    const selections=[];
    let fail=false;
    const connect=()=>({reserve:async()=>({unsafe:async(q,p=[])=>
      /pg_try_advisory_lock|pg_advisory_unlock/.test(q)?[{acquired:true}]:(await db.query(q,p)).rows,release(){}}),end:async()=>{}});
    const collect=async(database,options)=>{
      assert.equal(options.rotation,true);assert.equal(options.validate,false);
      selections.push(options.trackerId);
      if(fail)throw new Error('private source failure');
      await database.query("update scout.collection_runs set outcome='partial',finished_at=clock_timestamp() where id=$1",[options.runId]);
      return {run_id:options.runId,outcome:'partial',failed:0};
    };
    const invoke=()=>hostedHSA(request(undefined,'?next=true'),{env,databaseURL:'unused',connect,collect});
    const first=await (await invoke()).json();
    assert.deepEqual(selections,[ids[0]]);
    const second=await (await invoke()).json();
    assert.deepEqual(selections,[ids[0],ids[1]]);
    assert.equal((await (await invoke()).json()).outcome,'idle');
    assert.equal(selections.length,2);
    await db.query("update scout.collection_runs set stats=stats||jsonb_build_object('retry_at',now()-interval '1 second') where id=$1",[first.run_id]);
    fail=true;
    assert.equal((await invoke()).status,500);
    const failed=(await db.query("select * from scout.collection_runs where tracker_id=$1 order by started_at desc limit 1",[ids[0]])).rows[0];
    assert.equal(failed.outcome,'failed');assert.equal(failed.stats.failure_count,1);
    assert.ok(Date.parse(failed.stats.retry_at)>Date.now());
    await db.query("update scout.collection_runs set stats=stats||jsonb_build_object('retry_at',now()-interval '1 second') where id=$1",[second.run_id]);
    fail=false;await invoke();assert.equal(selections.at(-1),ids[1]);
    const retained={version:1,operations:{fixture:{state:'running'}},artifacts:{}};
    const stale=(await db.query("insert into scout.collection_runs(tracker_id,started_at,stats,report) values($1,now(),jsonb_build_object('rotation',true,'turn_expires_at',now()-interval '1 second'),$2) returning id",[ids[0],retained])).rows[0].id;
    await invoke();
    const recovered=(await db.query('select outcome,report,stats from scout.collection_runs where id=$1',[stale])).rows[0];
    assert.equal(recovered.outcome,'failed');assert.deepEqual(recovered.report,retained);
    assert.equal(selections.at(-1),ids[0]);
    // Shared quota prevents collection or even claiming another source.
    const before=(await db.query('select count(*)::int n from scout.collection_runs')).rows[0].n;
    await db.query("update scout.collection_runs set stats=stats||jsonb_build_object('model_retry_at',now()+interval '2 minutes') where id=$1",[stale]);
    const deferred=await (await invoke()).json();assert.equal(deferred.outcome,'deferred');assert.equal(deferred.reason,'provider');
    assert.equal((await db.query('select count(*)::int n from scout.collection_runs')).rows[0].n,before);
    // An unexpired claim remains exclusive even after losing its session.
    await db.query("update scout.collection_runs set stats=stats-'model_retry_at'");
    await db.query("insert into scout.collection_runs(tracker_id,stats) values($1,jsonb_build_object('rotation',true,'turn_expires_at',now()+interval '2 minutes'))",[ids[0]]);
    const count=selections.length;assert.equal((await (await invoke()).json()).outcome,'idle');assert.equal(selections.length,count);
  } finally { await db.close(); }
});

test('overlap skips collection; authorized work uses parameters/transactions and always closes', async () => {
  for (const acquired of [false, true]) {
    const queries = [];
    let collected = 0, closed = 0, transactions = 0;
    const tx = { unsafe: async (query, params) => { queries.push({ query, params }); if(query==='begin') transactions++; return [{ acquired }]; },
      release() {} };
    const req = new Request('https://example.test/collect?documents=process&validate=true&since=2026-09-01&max_attempts=0&tracker_id=00000000-0000-0000-0000-000000000002', {
      method: 'POST', headers: { apikey: secret }, body: new ReadableStream({ start(controller) { controller.close(); } }), duplex: 'half' });
    const response = await hostedHSA(req, { env, databaseURL: 'unused',
      connect: (_url, options) => {
        assert.equal(options.max, 1);
        assert.equal(options.types.json.serialize({ proof: true }), '{"proof":true}');
        assert.equal(options.types.json.serialize('{"proof":true}'), '{"proof":true}');
        return { reserve: async () => tx, end: async () => { closed++; } };
      }, collect: async (db, options) => {
        collected++;
        assert.equal(options.since, '2026-09-01T00:00:00Z');
        assert.equal(options.sourceId, null);
        assert.equal(options.trackerId, '00000000-0000-0000-0000-000000000002');
        assert.equal(options.validate, true);
        assert.equal(options.assessOnly, false);
        assert.equal(options.documents, 'process');
        await assert.rejects(options.makeModel('unused')(), /Observation-only run/);
        assert.ok(options.deadline <= Date.now() + 100000);
        await db.transaction(inner => inner.query('select $1::jsonb, $2::text', [{ proof: true }, "quote'; --"]));
        return { outcome: 'no_change', models: 0 };
      } });
    assert.equal(response.status, acquired ? 200 : 409);
    assert.equal(collected, acquired ? 1 : 0);
    assert.equal(transactions, acquired ? 1 : 0);
    assert.equal(closed, 1);
    if (acquired) assert.deepEqual(queries[2], { query: 'select $1::jsonb, $2::text', params: [{ proof: true }, "quote'; --"] });
  }
});

test('database failure rolls back through the driver without returning connection details', async () => {
  let closed = 0, rolledBack = 0;
  const tx = { unsafe: async query => { if(query==='rollback') rolledBack++; return [{ acquired:true }]; }, release() {} };
  const response = await hostedHSA(request(undefined,'?documents=process&validate=true&tracker_id=00000000-0000-0000-0000-000000000002'), { env, databaseURL: 'unused',
    connect: () => ({ reserve: async () => tx,
      end: async () => { closed++; } }),
    collect: async db => db.transaction(async () => { throw new Error('private connection details'); }) });
  assert.equal(response.status, 500);
  assert.equal(rolledBack, 1);
  assert.equal(closed, 1);
  assert.ok(!(await response.text()).includes('private connection details'));
});
