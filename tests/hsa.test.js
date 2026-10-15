import {test,mock} from 'node:test';
import dns from 'node:dns';
import {syncBuiltinESMExports} from 'node:module';
import assert from 'node:assert/strict';
import {sourceURL,readPublic} from '../collector/discovery/hsa.js';

test('HTTP transport rejects private and mixed DNS answers before opening a source socket', async () => {
  for (const addresses of [[{ address: '127.0.0.1', family: 4 }], [{ address: 'fd00::1', family: 6 }],
    [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }]]) {
    const resolver = mock.method(dns, 'lookup', (_host, _options, callback) => callback(null, addresses));
    syncBuiltinESMExports();
    try {
      await assert.rejects(readPublic('https://example.test/source', { requests: 0, deadline: Date.now() + 1000 }), /Non-public source address/);
    } finally { resolver.mock.restore(); syncBuiltinESMExports(); }
  }
});

test('source URLs reject local/IP/credential URLs before network access', () => {
  for (const url of ['http://example.org', 'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://user:password@example.org']) assert.throws(() => sourceURL(url));
  assert.equal(sourceURL('https://example.org/event?utm_source=bluesky&id=1#top'), 'https://example.org/event?id=1');
});
