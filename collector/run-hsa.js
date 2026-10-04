import { PGlite } from '@electric-sql/pglite';
import { mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { collectHSA } from './hsa.js';
import { gemini } from './model.js';
import { managementDatabase } from './remote.js';

// Records stay local. --assess uses hosted accounting so it shares production caps.
const root = new URL('../', import.meta.url);
const cache = new URL('.cache/', root);
await mkdir(cache, { recursive: true });
const lockPath = new URL('hsa-collector.lock', cache);
const lock = await open(lockPath, 'wx').catch(() => { throw new Error('A collector lock exists. Check for a running collector before removing .cache/hsa-collector.lock.'); });
let db;
try {
  const args = process.argv.slice(2);
  if (args.some(arg => !arg.startsWith('--since=') && arg!=='--assess') || args.length>2) throw new Error('Usage: npm run collect:hsa -- [--since=YYYY-MM-DD] [--assess]');
  db = new PGlite(new URL('hsa-database/', cache).pathname);
  if (!(await db.query("select to_regnamespace('auth') as schema")).rows[0].schema) {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
      create table public.scout_local_migrations (name text primary key);`);
  }
  await db.exec('create table if not exists auth.identities (user_id uuid, provider text, identity_data jsonb)');
  await db.exec("alter table auth.users add column if not exists raw_app_meta_data jsonb default '{}'");
  const applied = new Set((await db.query('select name from public.scout_local_migrations')).rows.map(row => row.name));
  for (const name of (await readdir(new URL('supabase/migrations/', root))).filter(name => name.endsWith('.sql')).sort()) {
    if (applied.has(name)) continue;
    // Record migration completion atomically with its SQL transaction.
    const sql = (await readFile(new URL(`supabase/migrations/${name}`, root), 'utf8')).replace(/commit;\s*$/i, `insert into public.scout_local_migrations values ('${name.replaceAll("'", "''")}');\ncommit;`);
    await db.exec(sql);
  }
  await db.exec(await readFile(new URL('supabase/seeds/trackers.sql', root), 'utf8'));
  let makeModel, ledger, ledgerRun;
  if (args.includes('--assess')) {
    process.loadEnvFile(new URL('.env.local',root));
    ledger=managementDatabase(process.env.SUPABASE_ACCESS_TOKEN);
    makeModel=(runId,deadline,trace)=>async (...input)=>{
      if (!ledgerRun) {
        await ledger.query(`insert into scout.collection_runs(id,tracker_id,stats)
          select $1,id,'{"purpose":"local_assessment"}'::jsonb from scout.trackers where seed_key='bbnj-trackers-2026-10-01:17'`,[runId]);
        ledgerRun=runId;
      }
      return gemini({apiKey:process.env.GEMINI_API_KEY,ledger,runId,deadline,trace})(...input);
    };
  }
  const result = await collectHSA(db, { since: args.find(arg=>arg.startsWith('--since='))?.slice('--since='.length), makeModel });
  if (ledgerRun) await ledger.query("update scout.collection_runs set finished_at=clock_timestamp(),outcome='partial',stats=stats||$2::jsonb where id=$1",[ledgerRun,{warnings:['Local record assessment only; no hosted source collection'],local_outcome:result.outcome}]);
  console.log(JSON.stringify({ storage: '.cache/hsa-database (local PostgreSQL)', ...result }, null, 2));
  if (!['success', 'no_change'].includes(result.outcome)) process.exitCode = 2;
} finally {
  await db?.close();
  await lock.close();
  await unlink(lockPath);
}
