import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile(new URL('../supabase/migrations/20261001050000_scout_foundation.sql', import.meta.url), 'utf8');
const reader = '00000000-0000-0000-0000-000000000001';
const admin = '00000000-0000-0000-0000-000000000002';
const outsider = '00000000-0000-0000-0000-000000000003';

// Minimal Supabase Auth fixtures; these tests exercise PostgreSQL RLS, not GoTrue/PostgREST.
const auth = `
  create role anon;
  create role authenticated;
  create role service_role bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  insert into auth.users values ('${reader}'), ('${admin}'), ('${outsider}');
`;
const fixture = `
  create schema otherservice;
  create table otherservice.private_records (id integer primary key, owner_id uuid, body text);
  insert into otherservice.private_records values (1, '${outsider}', 'Other service private record');
  grant usage on schema otherservice to authenticated;
  grant select on otherservice.private_records to authenticated;
  alter table otherservice.private_records enable row level security;
  create policy own_records on otherservice.private_records to authenticated using (owner_id = auth.uid());
  alter default privileges in schema otherservice grant select on tables to authenticated;
`;
const sharedState = `
  select c.relname, c.relacl::text, c.relrowsecurity, pg_get_userbyid(c.relowner) as owner,
    (select jsonb_agg(t) from otherservice.private_records t) as data,
    (select jsonb_agg(p) from pg_policies p where schemaname = 'otherservice') as policies,
    (select jsonb_agg(d) from pg_default_acl d where defaclnamespace = 'otherservice'::regnamespace) as defaults
  from pg_class c where c.relnamespace = 'otherservice'::regnamespace order by c.relname;
`;

test('unsafe global defaults stop the migration without changing another service', async () => {
  const db = new PGlite();
  try {
    await db.exec(auth + fixture);
    await db.exec('alter default privileges grant select on tables to authenticated');
    const before = (await db.query(sharedState)).rows;
    await assert.rejects(db.exec(migration), /Global client table defaults require review/);
    await db.exec('rollback');
    assert.deepEqual((await db.query(sharedState)).rows, before);
    assert.equal((await db.query("select to_regnamespace('scout') as schema")).rows[0].schema, null);
  } finally {
    await db.close();
  }
});

for (const shared of [false, true]) {
  test(`foundation migration and access policies in ${shared ? 'shared' : 'empty'} database`, async () => {
    const db = new PGlite();
    try {
      await db.exec(auth);
      if (shared) await db.exec(fixture);
      const before = shared ? (await db.query(sharedState)).rows : null;
      await db.exec(migration);
      if (shared) assert.deepEqual((await db.query(sharedState)).rows, before);
      assert.equal((await db.query("select count(*)::int n from pg_class where relnamespace = 'scout'::regnamespace and relkind = 'r' and relrowsecurity")).rows[0].n, 6);
      await db.exec(`
        insert into scout.memberships (user_id, role) values ('${reader}', 'reader'), ('${admin}', 'admin');
        insert into scout.trackers (name, url, channel, method, cadence) values ('Fixture source', 'https://example.org', 'web', 'http', '1 day');
        insert into scout.records (kind, title, start_on, collected_at) values ('event', 'Local foundation sample', '2026-10-08', '2026-10-01T04:00:00Z');
        insert into scout.sources (record_id, url, published_on) select id, 'https://example.org/source', '2026-09-30' from scout.records;
        insert into scout.sources (record_id, url) select id, 'https://example.org/correction' from scout.records;
      `);
      await db.exec('set role anon');
      await assert.rejects(db.query('select * from scout.records'), { code: '42501' });
      await db.exec('reset role; set role authenticated');
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [outsider]);
      assert.equal((await db.query('select * from scout.records')).rows.length, 0);
      assert.equal((await db.query('select * from scout.memberships')).rows.length, 0);
      await assert.rejects(db.query("insert into scout.trackers (name,url,channel,method,cadence) values ('Bad','https://example.org/bad','web','http','1 day')"), { code: '42501' });
      if (shared) assert.equal((await db.query('select * from otherservice.private_records')).rows.length, 1);
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [reader]);
      assert.equal((await db.query('select * from scout.records')).rows.length, 1);
      assert.equal((await db.query('select * from scout.sources')).rows.length, 2);
      assert.equal((await db.query('select * from scout.memberships')).rows.length, 1);
      assert.equal((await db.query("update scout.trackers set enabled = false returning id")).rows.length, 0);
      await assert.rejects(db.query("insert into scout.records (kind,title) values ('announcement','Not allowed')"), { code: '42501' });
      await assert.rejects(db.query("update scout.memberships set role = 'admin'"), { code: '42501' });
      await assert.rejects(db.query('select * from scout.deliveries'), { code: '42501' });
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [admin]);
      assert.equal((await db.query("update scout.trackers set enabled = false returning id")).rows.length, 1);
      await assert.rejects(db.query('update scout.trackers set last_success_at = now()'), { code: '42501' });
      await assert.rejects(db.query("insert into scout.memberships (user_id,role) values ($1,'admin')", [outsider]), { code: '42501' });
      await assert.rejects(db.query("insert into scout.records (kind,title) values ('announcement','Not allowed')"), { code: '42501' });
      if (shared) assert.equal((await db.query('select * from otherservice.private_records')).rows.length, 0);
      await db.exec('reset role; set role service_role');
      await db.exec("insert into scout.records (kind,title) values ('announcement','Backend sample')");
      assert.equal((await db.query('select * from scout.records')).rows.length, 2);
      await db.exec('reset role');
      const sample = (await db.query("select * from scout.records where kind = 'event'")).rows[0];
      assert.equal(sample.starts_at, null);
      assert.equal(sample.time_zone, null);
      assert.equal(sample.published_on, null);
      await assert.rejects(db.query("insert into scout.records (kind,title,starts_at) values ('event','Unknown zone','2026-10-08T12:00:00Z')"), { code: '23514' });
      await assert.rejects(db.query("insert into scout.records (kind,title,start_on,end_on) values ('event','Reversed','2026-10-09','2026-10-08')"), { code: '23514' });
      await db.exec('create table scout.future_private_table (id integer)');
      const privileges = (await db.query("select has_table_privilege('authenticated', 'scout.future_private_table', 'SELECT') as auth, has_table_privilege('anon', 'scout.future_private_table', 'SELECT') as anon")).rows[0];
      assert.deepEqual(privileges, { auth: false, anon: false });
      if (shared) assert.deepEqual((await db.query(sharedState)).rows, before);
    } finally {
      await db.close();
    }
  });
}
