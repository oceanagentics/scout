import { createClient } from '@supabase/supabase-js';
import { mountAccess } from './access.js';
import './style.css';

const status = document.querySelector('#status');
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  status.textContent = 'Scout is being prepared. Google Workspace sign-in will be available here once setup is complete.';
} else if (!key.startsWith('sb_publishable_')) {
  status.textContent = 'Scout access is temporarily unavailable. Please contact the project administrator.';
} else {
  const client = createClient(url, key, {
    db: { schema: 'scout' },
    auth: { flowType: 'pkce', persistSession: true, storage: {
      getItem: key => window.sessionStorage.getItem(key),
      removeItem: key => window.sessionStorage.removeItem(key),
      setItem(key,value) {
        if (key === 'scout-auth') {
          const session = JSON.parse(value);
          delete session.provider_token; delete session.provider_refresh_token;
          value = JSON.stringify(session);
        }
        window.sessionStorage.setItem(key,value);
      },
    },
      storageKey: 'scout-auth', detectSessionInUrl: true },
  });
  mountAccess(client, document);
}
