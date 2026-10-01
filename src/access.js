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
    status.textContent = 'Signed in · Ocean Agentics Workspace access';
    closeDashboard = mount(workspace, () => loadScout(client));
  }

  client.auth.onAuthStateChange((_event, session) => { void showSession(session); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    status.textContent = 'Opening Google sign-in…';
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
      window.location.replace('/');
    }
  });
}
