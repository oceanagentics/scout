import { PGlite } from '@electric-sql/pglite';
import { access, open, readFile, readdir, unlink } from 'node:fs/promises';
import { baseline, getDelivery, prepareDigest, prepareFindings, prepareVerification, recordReceipt, reprepareStale, sendDelivery, webhookTransport } from './slack.js';

// Local only; share the collector's process lock to protect the persistent database.
const root = new URL('../', import.meta.url);
const cache = new URL('.cache/', root);
await access(new URL('hsa-database/', cache));
const lockPath = new URL('hsa-collector.lock', cache);
const lock = await open(lockPath, 'wx').catch(() => { throw new Error('Local database is locked; check for a running collector or notifier.'); });
let db;
try {
  db = new PGlite(new URL('hsa-database/', cache).pathname);
  await db.exec('create table if not exists auth.identities (user_id uuid, provider text, identity_data jsonb)');
  const applied = new Set((await db.query('select name from public.scout_local_migrations')).rows.map(row => row.name));
  for (const name of (await readdir(new URL('supabase/migrations/', root))).filter(name => name.endsWith('.sql')).sort()) {
    if (applied.has(name)) continue;
    const sql = (await readFile(new URL(`supabase/migrations/${name}`, root), 'utf8')).replace(/commit;\s*$/i, `insert into public.scout_local_migrations values ('${name.replaceAll("'", "''")}');\ncommit;`);
    await db.exec(sql);
  }
  const [command, ...args] = process.argv.slice(2);
  let result;
  if (command === 'baseline' && !args.length) result = await baseline(db);
  else if (command === 'findings' && !args.length) result = await prepareFindings(db);
  else if (command === 'verification' && args.length === 1) result = await prepareVerification(db, args[0]);
  else if (command === 'digest' && args.length === 2) result = await prepareDigest(db, ...args);
  else if (command === 'show' && args.length === 1) result = await getDelivery(db, args[0]);
  else if (command === 'reprepare' && args.length === 1) result = await reprepareStale(db, args[0]);
  else if (command === 'send' && args.length === 1) {
    process.loadEnvFile(new URL('.env.local', root));
    result = await sendDelivery(db, args[0], webhookTransport(process.env.SLACK_WEBHOOK_URL));
  } else if (command === 'receipt' && args.length === 3) result = await recordReceipt(db, ...args);
  else throw new Error('Usage: npm run notify -- baseline | findings | verification RECORD_ID | digest FROM THROUGH | show ID | reprepare STALE_ID | send ID | receipt ID SLACK_TS "inspection note"');
  if (command !== 'show') {
    const compact = row => ({ id: row.id, kind: row.kind, status: row.status, attempts: row.attempts, records: row.snapshot?.records.length, slack_ts: row.slack_ts, error: row.error });
    result = Array.isArray(result) ? result.map(compact) : compact(result);
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await db?.close();
  await lock.close();
  await unlink(lockPath);
}
