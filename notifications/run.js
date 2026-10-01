import { PGlite } from '@electric-sql/pglite';
import { access, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { prepareMessage, sendMessage, webhookTransport } from './slack.js';
import { randomUUID } from 'node:crypto';
import { gemini } from '../collector/model.js';
import { managementDatabase } from '../collector/remote.js';

// Manual backend command. One local process; hosted records use the same model ledger.
const root = new URL('../', import.meta.url);
const cache = new URL('.cache/', root);
const args=process.argv.slice(2);
const hosted=args.includes('--hosted');
const [command,from,through,...extra]=args.filter(arg=>arg!=='--hosted');
if (!['findings','digest','send-findings','send-digest'].includes(command)||extra.length||
    (!command.endsWith('digest')&&(from||through))) throw new Error('Usage: npm run notify -- [--hosted] findings | digest FROM THROUGH | send-findings | send-digest FROM THROUGH');
await mkdir(cache,{recursive:true});
if (!hosted) await access(new URL('hsa-database/', cache));
process.loadEnvFile(new URL('.env.local',root));
const ledger=managementDatabase(process.env.SUPABASE_ACCESS_TOKEN);
const lockPath = new URL('hsa-collector.lock', cache);
const lock = await open(lockPath, 'wx').catch(() => { throw new Error('Local database is locked; check for a running collector or notifier.'); });
let db;
try {
  if (!hosted) {
    db = new PGlite(new URL('hsa-database/', cache).pathname);
    await db.exec('create table if not exists auth.identities (user_id uuid, provider text, identity_data jsonb)');
    await db.exec("alter table auth.users add column if not exists raw_app_meta_data jsonb default '{}'");
    const applied = new Set((await db.query('select name from public.scout_local_migrations')).rows.map(row => row.name));
    for (const name of (await readdir(new URL('supabase/migrations/', root))).filter(name => name.endsWith('.sql')).sort()) {
      if (applied.has(name)) continue;
      const sql = (await readFile(new URL(`supabase/migrations/${name}`, root), 'utf8')).replace(/commit;\s*$/i, `insert into public.scout_local_migrations values ('${name.replaceAll("'", "''")}');\ncommit;`);
      await db.exec(sql);
    }
  } else db=ledger;
  let runId;
  const model=async (...input)=>{
    if (!runId) {
      runId=randomUUID();
      await ledger.query(`insert into scout.collection_runs(id,tracker_id,stats)
        select $1,id,'{"purpose":"notification"}'::jsonb from scout.trackers where seed_key='bbnj-trackers-2026-10-01:17'`,[runId]);
    }
    return gemini({apiKey:process.env.GEMINI_API_KEY,ledger,runId})(...input);
  };
  try {
    const preview=await prepareMessage(db,{model,kind:command.endsWith('digest')?'digest':'findings',from,through});
    const result=command.startsWith('send-')?await sendMessage(db,preview,webhookTransport(process.env.SLACK_WEBHOOK_URL)):preview;
    console.log(JSON.stringify(result,null,2));
  } finally {
    if(runId) await ledger.query("update scout.collection_runs set finished_at=clock_timestamp(),outcome='partial',stats=stats||'{\"warnings\":[\"Notification selection only; no source collection\"]}'::jsonb where id=$1",[runId]);
  }
} finally {
  await db?.close?.();
  await lock.close();
  await unlink(lockPath);
}
