import { PGlite } from '@electric-sql/pglite';
import { mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { collectHSA } from './hsa.js';

// Deliberately local: this command cannot connect to or mutate a hosted database.
const root = new URL('../', import.meta.url);
const cache = new URL('.cache/', root);
await mkdir(cache, { recursive: true });
const lockPath = new URL('hsa-collector.lock', cache);
const lock = await open(lockPath, 'wx').catch(() => { throw new Error('A collector lock exists. Check for a running collector before removing .cache/hsa-collector.lock.'); });
let db;
try {
  const args = process.argv.slice(2);
  if (args.some(arg => !arg.startsWith('--since=')) || args.length > 1) throw new Error('Usage: npm run collect:hsa -- [--since=YYYY-MM-DD]');
  db = new PGlite(new URL('hsa-database/', cache).pathname);
  if (!(await db.query("select to_regnamespace('auth') as schema")).rows[0].schema) {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
      create table public.scout_local_migrations (name text primary key);`);
  }
  const applied = new Set((await db.query('select name from public.scout_local_migrations')).rows.map(row => row.name));
  for (const name of (await readdir(new URL('supabase/migrations/', root))).filter(name => name.endsWith('.sql')).sort()) {
    if (applied.has(name)) continue;
    // Record migration completion atomically with its SQL transaction.
    const sql = (await readFile(new URL(`supabase/migrations/${name}`, root), 'utf8')).replace(/commit;\s*$/i, `insert into public.scout_local_migrations values ('${name.replaceAll("'", "''")}');\ncommit;`);
    await db.exec(sql);
  }
  await db.exec(await readFile(new URL('supabase/seeds/trackers.sql', root), 'utf8'));
  const result = await collectHSA(db, { since: args[0]?.slice('--since='.length) });
  console.log(JSON.stringify({ storage: '.cache/hsa-database (local PostgreSQL)', ...result }, null, 2));
  if (!['success', 'no_change'].includes(result.outcome)) process.exitCode = 2;
} finally {
  await db?.close();
  await lock.close();
  await unlink(lockPath);
}
