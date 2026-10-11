import { loadScout, mountDashboard } from './dashboard.js';

export function mountAccess(client, root, mount = mountDashboard) {
  const status = root.querySelector('#status'), form = root.querySelector('#sign-in');
  const signOut = root.querySelector('#sign-out'), workspace = root.querySelector('#workspace');
  let generation = 0, signingOut = false, closeDashboard;

  async function showSession(session) {
    if (signingOut) session = null;
    const current = ++generation;
    closeDashboard?.(); closeDashboard = null;
    workspace.replaceChildren(); workspace.hidden = true;
    form.hidden = Boolean(session);
    signOut.hidden = !session;
    status.hidden = false;
    if (!session) {
      status.textContent = 'Use your Ocean Agentics Google Workspace account to sign in.';
      return;
    }
    status.textContent = 'Checking Scout access…';
    const access = await client.rpc('access_role');
    if (current !== generation) return;
    if (access.error) {
      status.textContent = 'Scout access could not be checked. Please try again later.';
      return;
    }
    if (!['reader', 'admin'].includes(access.data)) {
      status.textContent = 'Scout is available to verified oceanagentics.com Google Workspace accounts. Sign out to use a different account.';
      return;
    }
    status.hidden = true;
    const record = window.sessionStorage.getItem('scout-record');
    if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(record ?? '')) {
      const url = new URL(window.location.href);
      if (!url.searchParams.has('record')) url.searchParams.set('record', record);
      window.history.replaceState(null, '', url);
    }
    window.sessionStorage.removeItem('scout-record');
    closeDashboard = mount(workspace, options => loadScout(client,options));
  }

  client.auth.onAuthStateChange((_event, session) => { void showSession(session); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    status.textContent = 'Opening Google sign-in…';
    const record = new URLSearchParams(window.location.search).get('record');
    window.sessionStorage.removeItem('scout-record');
    if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(record ?? '')) window.sessionStorage.setItem('scout-record', record);
    const { error } = await client.auth.signInWithOAuth({ provider: 'google', options: {
      redirectTo: `${window.location.origin}/`, scopes: 'openid email profile',
      queryParams: { hd: 'oceanagentics.com', prompt: 'select_account' },
    } });
    button.disabled = false;
    if (error) status.textContent = 'Google sign-in is unavailable. Please try again later.';
  });
  signOut.addEventListener('click', async () => {
    signingOut = true;
    await showSession(null);
    try { await client.auth.signOut({ scope: 'local' }); }
    finally {
      window.sessionStorage.removeItem('scout-auth');
      window.sessionStorage.removeItem('scout-auth-code-verifier');
      window.sessionStorage.removeItem('scout-record');
      window.location.replace('/');
    }
  });
}
