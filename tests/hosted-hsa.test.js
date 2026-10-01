import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { verifyAuth } from '@supabase/server/core';
import { hostedHSA } from '../collector/hosted-hsa.js';

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
    const response = await hostedHSA(request(headers), { env: testEnv, databaseURL: 'unused',
      connect: () => { connects++; }, collect: () => { collections++; } });
    assert.equal(response.status, 401);
  }
  assert.equal(connects, 0);
  assert.equal(collections, 0);
});

test('invalid authenticated requests do no database work', async () => {
  let connects = 0;
  for (const req of [request(undefined, '', 'GET'), request(undefined, '?since=2026-02-30'),
    request(undefined, '?since=2026-09-01&since=2026-10-01'), request(undefined, '?sql=delete'),
    ...['-1','11','1.2','','2&max_attempts=3'].map(value=>request(undefined, `?max_attempts=${value}`)),
    new Request('https://example.test', { method: 'POST', headers: { apikey: secret }, body: '{}' })]) {
    const response = await hostedHSA(req, { env, databaseURL: 'unused', connect: () => { connects++; } });
    assert.ok([400, 405].includes(response.status));
  }
  assert.equal(connects, 0);
});

test('overlap skips collection; authorized work uses parameters/transactions and always closes', async () => {
  for (const acquired of [false, true]) {
    const queries = [];
    let collected = 0, closed = 0, transactions = 0;
    const tx = { unsafe: async (query, params) => { queries.push({ query, params }); if(query==='begin') transactions++; return [{ acquired }]; },
      release() {} };
    const req = new Request('https://example.test/collect?since=2026-09-01&max_attempts=0', {
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
  const response = await hostedHSA(request(), { env, databaseURL: 'unused',
    connect: () => ({ reserve: async () => tx,
      end: async () => { closed++; } }),
    collect: async db => db.transaction(async () => { throw new Error('private connection details'); }) });
  assert.equal(response.status, 500);
  assert.equal(rolledBack, 1);
  assert.equal(closed, 1);
  assert.ok(!(await response.text()).includes('private connection details'));
});
