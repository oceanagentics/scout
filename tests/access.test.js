import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountAccess } from '../website/access.js';

test('Workspace UI trusts the server role, handles auth races and clears data before sign-out completes', async () => {
  const nodes = Object.fromEntries(['status', 'sign-in', 'sign-out', 'workspace', 'button'].map(id => [id, {
    hidden: true, textContent: '', events: {}, addEventListener(name, handler) { this.events[name] = handler; },
    querySelector() { return nodes.button; }, replaceChildren() { this.textContent = ''; },
  }]));
  const previousWindow = globalThis.window;
  const storage = new Map([['scout-auth', 'test session'], ['scout-auth-code-verifier', 'test verifier']]);
  const record = '11111111-1111-4111-8111-111111111111';
  let authChanged, role = null, renders = 0, closeCount = 0, oauth, redirected, finishSignOut;
  globalThis.window = { location: { origin: 'https://bbnj-scout.web.app', href: 'https://bbnj-scout.web.app/', search: '?record=https://example.com', replace(path) { redirected = path; } },
    history: { replaceState(_state, _title, url) { window.location.href = String(url); window.location.search = url.search; } },
    sessionStorage: { removeItem(key) { storage.delete(key); }, getItem(key) { return storage.get(key) ?? null; }, setItem(key, value) { storage.set(key, value); } } };
  const client = { rpc: async name => { assert.equal(name, 'access_role'); return { data: role }; }, auth: {
    onAuthStateChange(callback) { authChanged = callback; },
    signInWithOAuth: async options => { oauth = options; return { error: null }; },
    signOut: async options => { assert.deepEqual(options, { scope: 'local' }); await new Promise(resolve => { finishSignOut = resolve; }); },
  } };
  const tick = () => new Promise(setImmediate);
  const session = { user: { id: 'test', user_metadata: { hd: 'oceanagentics.com', role: 'admin' } } };
  try {
    mountAccess(client, { querySelector: selector => nodes[selector.slice(1)] }, root => {
      renders++; root.hidden = false; root.textContent = 'private findings'; return () => { closeCount++; };
    });
    authChanged('INITIAL_SESSION', null);
    assert.equal(nodes['sign-in'].hidden, false);
    await nodes['sign-in'].events.submit({ preventDefault() {} });
    assert.equal(oauth.provider, 'google');
    assert.equal(oauth.options.redirectTo, 'https://bbnj-scout.web.app/');
    assert.equal(oauth.options.queryParams.hd, 'oceanagentics.com');
    assert.equal(storage.has('scout-record'), false); // A selection is a UUID, never a redirect destination.
    window.location.search = `?record=${record}`;
    await nodes['sign-in'].events.submit({ preventDefault() {} });
    assert.equal(storage.get('scout-record'), record);
    assert.equal(oauth.options.redirectTo, 'https://bbnj-scout.web.app/'); // Keep the exact approved callback.
    window.location.search = '?code=test'; window.location.href = 'https://bbnj-scout.web.app/?code=test';
    authChanged('SIGNED_IN', session); await tick();
    assert.equal(renders, 0); // Forged browser metadata is ignored.
    assert.equal(nodes.workspace.hidden, true);
    role = 'reader'; authChanged('SIGNED_IN', session); await tick();
    assert.equal(renders, 1);
    assert.equal(nodes.workspace.textContent, 'private findings');
    assert.equal(new URL(window.location.href).searchParams.get('record'), record);
    assert.equal(storage.has('scout-record'), false);
    let resolveAccess;
    client.rpc = () => new Promise(resolve => { resolveAccess = resolve; });
    authChanged('TOKEN_REFRESHED', session);
    authChanged('SIGNED_OUT', null);
    resolveAccess({ data: 'reader' }); await tick();
    assert.equal(renders, 1); // Late access responses cannot restore signed-out data.
    client.rpc = async () => ({ data: 'reader' });
    authChanged('SIGNED_IN', session); await tick();
    const logout = nodes['sign-out'].events.click(); await tick();
    assert.equal(nodes.workspace.hidden, true);
    assert.equal(nodes.workspace.textContent, '');
    authChanged('TOKEN_REFRESHED', session); await tick();
    assert.equal(renders, 2);
    finishSignOut(); await logout;
    assert.equal(storage.size, 0);
    assert.equal(redirected, '/');
    assert.equal(closeCount, 2);
  } finally { globalThis.window = previousWindow; }
});
