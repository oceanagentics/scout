import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { verifyAuth } from '@supabase/server/core';
import { hostedReader } from '../supabase/functions/scout-reader/index.ts';
import { readFile } from 'node:fs/promises';

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
  let connects = 0;
  for (const headers of [{}, { apikey: 'invalid' }, { apikey: env.publishableKeys.default }, { apikey: env.secretKeys.other },
    { Authorization: `Bearer ${jwt}` }, { Authorization: `Bearer ${jwt}`, apikey: env.publishableKeys.default }]) {
    const response = await hostedReader(request(headers, '?next=true'), { env: testEnv, databaseURL: 'unused',
      connect: () => { connects++; }, read: () => assert.fail('No source HTTP'), modelFetch: () => assert.fail('No model HTTP') });
    assert.equal(response.status, 401);
  }
  assert.equal(connects, 0);
});

test('invalid authenticated requests do no database work', async () => {
  let connects = 0;
  const tracker='00000000-0000-0000-0000-000000000001',source='https://example.org/event';
  const invalid=['tracker_id=invalid','source_url='+source,'tracker_id=invalid&source_url='+source,
    'tracker_id='+tracker+'&source_url=','tracker_id='+tracker+'&source_url='+source+'&extra=true',
    'tracker_id='+tracker+'&tracker_id='+tracker+'&source_url='+source,
    'tracker_id='+tracker+'&source_url='+source+'&source_url='+source,
    'documents=process&validate=true&tracker_id='+tracker];
  for(const route of ['next','notify','correct'])invalid.push(route+'=false',route+'=true&'+route+'=true',route+'=true&extra=true');
  for (const req of [...invalid.map(query=>request(undefined,'?'+query)),request(undefined,'?next=true','GET')]) {
    const response = await hostedReader(req, { env, databaseURL: 'unused', connect: () => { connects++; } });
    assert.equal(response.status,req.method==='GET'?405:400);
  }
  assert.equal(connects, 0);
});


test('database failure rolls back and does not disclose connection or source details',async()=>{
 const {database}=await import('../reader/database.js'),queries=[];
 const db=database({unsafe:async q=>{queries.push(q);if(q==='broken')throw Object.assign(new Error('secret credential source text'),{code:'23505'});return[];}});
 await assert.rejects(db.transaction(tx=>tx.query('broken')),e=>e.message==='database_operation'&&!e.message.includes('secret'));
 assert.deepEqual(queries,['begin','broken','rollback']);
});
test('scheduler is hourly, paused, and has no report, notification or history-scanning health loop',async()=>{
 const text=await readFile(new URL('../supabase/scout-loop.sql',import.meta.url),'utf8');
 assert.match(text,/'0 \* \* \* \*'/);assert.match(text,/active:=false/);assert.ok(!text.includes('collection_runs'));
 assert.ok(!text.includes('loop_tick(\'notify\')'));assert.ok(!text.includes("s.state<>'parked'"));
});
