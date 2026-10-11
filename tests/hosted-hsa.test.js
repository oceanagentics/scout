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
      '&validate=true&tracker_id=9dc6b107-5e12-4124-b4ce-583faf91e50d&assess_only=true']
      .map(suffix=>request(undefined,'?documents=process'+suffix)),
    request(undefined, '?validate=true&validate=true&tracker_id=00000000-0000-0000-0000-000000000001'),
    ...['true','false','','true&assess_only=true'].map(value=>request(undefined, `?assess_only=${value}`)),
    request(undefined, '?assess_only=true&validate=true&tracker_id=00000000-0000-0000-0000-000000000001'),
    ...['-1','11','1.2','','2&max_attempts=3'].map(value=>request(undefined, `?max_attempts=${value}`)),
    ...['since=2026-02-30','max_attempts=11','max_attempts=1&max_attempts=2','validate=false','sql=delete','record_id=00000000-0000-0000-0000-000000000001','record_id=invalid&source_id=00000000-0000-0000-0000-000000000001','record_id=00000000-0000-0000-0000-000000000001&record_id=00000000-0000-0000-0000-000000000002&source_id=00000000-0000-0000-0000-000000000001']
      .map(value=>request(undefined,'?documents=process&validate=true&tracker_id=9dc6b107-5e12-4124-b4ce-583faf91e50d&'+value)),
    ...['support_url=https://example.org/a','source_id=00000000-0000-0000-0000-000000000001&record_id=00000000-0000-0000-0000-000000000002&support_url=http://example.org/a','source_id=00000000-0000-0000-0000-000000000001&record_id=00000000-0000-0000-0000-000000000002&support_url=https://example.org/a&support_url=https://example.org/b&support_url=https://example.org/c&support_url=https://example.org/d']
      .map(value=>request(undefined,'?documents=process&validate=true&tracker_id=9dc6b107-5e12-4124-b4ce-583faf91e50d&'+value)),
    new Request('https://example.test', { method: 'POST', headers: { apikey: secret }, body: '{}' })]) {
    const response = await hostedHSA(req, { env, databaseURL: 'unused', connect: () => { connects++; } });
    assert.ok([400, 405].includes(response.status));
  }
  assert.equal(connects, 0);
});


test('database failure rolls back and does not disclose connection or source details',async()=>{
 const {database}=await import('../collector/hosted-hsa.js'),queries=[];
 const db=database({unsafe:async q=>{queries.push(q);if(q==='broken')throw Object.assign(new Error('secret credential source text'),{code:'23505'});return[];}});
 await assert.rejects(db.transaction(tx=>tx.query('broken')),e=>e.message==='database_operation'&&!e.message.includes('secret'));
 assert.deepEqual(queries,['begin','broken','rollback']);
});
test('scheduler is hourly, paused, and has no report, notification or history-scanning health loop',async()=>{
 const text=await readFile(new URL('../supabase/scout-loop.sql',import.meta.url),'utf8');
 assert.match(text,/'0 \* \* \* \*'/);assert.match(text,/active:=false/);assert.ok(!text.includes('collection_runs'));
 assert.ok(!text.includes('loop_tick(\'notify\')'));assert.ok(!text.includes("s.state<>'parked'"));
});
