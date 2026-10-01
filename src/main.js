import { createClient } from '@supabase/supabase-js';
import './style.css';

const status = document.querySelector('#status');
const form = document.querySelector('#sign-in');
const signOut = document.querySelector('#sign-out');
const records = document.querySelector('#records');
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  status.textContent = 'Scout is being prepared. Member access will be available here once setup is complete.';
} else if (!key.startsWith('sb_publishable_')) {
  status.textContent = 'Scout access is temporarily unavailable. Please contact the project administrator.';
} else {
  const client = createClient(url, key, {
    db: { schema: 'scout' },
    auth: { persistSession: false, detectSessionInUrl: false },
  });
  let generation = 0;

  async function showSession(session) {
    const current = ++generation;
    records.replaceChildren();
    records.hidden = true;
    form.hidden = Boolean(session);
    signOut.hidden = !session;
    if (!session) {
      status.textContent = 'Sign in with your existing account. Scout membership is required.';
      return;
    }
    status.textContent = 'Checking Scout access…';
    const membership = await client.from('memberships').select('role').eq('user_id', session.user.id).maybeSingle();
    if (current !== generation) return;
    if (membership.error) {
      status.textContent = 'Scout access could not be checked. Please try again later.';
      return;
    }
    if (!membership.data) {
      status.textContent = 'Your account does not have Scout access. Contact the project administrator to request membership.';
      return;
    }
    const result = await client.from('records')
      .select('id, kind, title, organization, summary, updated_at, sources(url)')
      .order('updated_at', { ascending: false }).limit(50);
    if (current !== generation) return;
    if (result.error) {
      status.textContent = 'Records could not be loaded. Please try again later.';
      return;
    }
    status.textContent = result.data.length ? 'Latest records' : 'No records yet. Collected findings will appear here with their sources.';
    for (const record of result.data) {
      const article = document.createElement('article');
      for (const [tag, text] of [['small', record.kind.replaceAll('_', ' ')], ['h3', record.title], ['p', record.organization], ['p', record.summary]]) {
        if (!text) continue;
        const element = document.createElement(tag);
        element.textContent = text;
        article.append(element);
      }
      for (const source of record.sources) {
        const parsed = new URL(source.url);
        if (!['https:', 'http:'].includes(parsed.protocol)) continue;
        const link = document.createElement('a');
        link.href = parsed.href;
        link.textContent = `Source · ${parsed.hostname}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        article.append(link);
      }
      records.append(article);
    }
    records.hidden = false;
  }

  client.auth.onAuthStateChange((_event, session) => { void showSession(session); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    status.textContent = 'Signing in…';
    const data = new FormData(form);
    const { error } = await client.auth.signInWithPassword({ email: data.get('email'), password: data.get('password') });
    form.elements.password.value = '';
    button.disabled = false;
    if (error) status.textContent = 'Sign-in failed. Check your details and try again.';
  });
  signOut.addEventListener('click', async () => {
    await client.auth.signOut({ scope: 'local' });
  });
}
