import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('model-accounting removal drops the ledger/functions and preserves findings and delivery state',async t=>{
  const raw=new PGlite();t.after(()=>raw.close());
  await raw.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
    create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');
    create table auth.identities(user_id uuid,provider text,identity_data jsonb);
    create function auth.uid() returns uuid language sql as $$select null::uuid$$;`);
  const removal='20261019220000_scout_remove_model_accounting.sql';
  for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort().filter(n=>n<removal))
    await raw.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
  const record=(await raw.query("insert into scout.records(kind,description) values('announcement','Keep useful finding') returning *")).rows;
  await raw.exec(`insert into scout.quota_reservations(id,invocation,input_tokens,state,provider,model,cost_usd)
    values(gen_random_uuid(),gen_random_uuid(),1050000,'unknown','openai','gpt-6-luna',0.3885);`);
  await raw.query("insert into scout.delivery_state(record_id,version,status) values($1,1,'sent')",[record[0].id]);
  const delivery=(await raw.query('select * from scout.delivery_state')).rows;
  await raw.exec(await readFile(new URL('../supabase/migrations/'+removal,import.meta.url),'utf8'));
  assert.equal((await raw.query("select to_regclass('scout.quota_reservations') name")).rows[0].name,null);
  assert.deepEqual((await raw.query('select * from scout.records')).rows,record);
  assert.deepEqual((await raw.query('select * from scout.delivery_state')).rows,delivery);
  assert.equal((await raw.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='scout' and (p.proname in ('reserve_provider','settle_provider','expire_quota')
      or p.prosrc ilike '%quota_reservations%')`)).rows.length,0);
});
