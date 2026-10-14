import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile(new URL('../supabase/migrations/20261001050000_scout_foundation.sql', import.meta.url), 'utf8');
const trackerSeed = await readFile(new URL('../supabase/seeds/trackers.sql', import.meta.url), 'utf8');
const migrations = await Promise.all((await readdir(new URL('../supabase/migrations/', import.meta.url))).sort()
  .map(async name => [name, await readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8')]));
const reader = '00000000-0000-0000-0000-000000000001';
const admin = '00000000-0000-0000-0000-000000000002';
const outsider = '00000000-0000-0000-0000-000000000003';

// Minimal Supabase Auth fixtures; these tests exercise PostgreSQL RLS, not GoTrue/PostgREST.
const auth = `
  create role anon;
  create role authenticated;
  create role service_role bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key, raw_app_meta_data jsonb default '{}', raw_user_meta_data jsonb default '{}');
  create table auth.identities (user_id uuid, provider text, identity_data jsonb);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  insert into auth.users (id) values ('${reader}'), ('${admin}'), ('${outsider}');
  insert into auth.identities select id, 'google', '{"iss":"https://accounts.google.com","email_verified":true,"custom_claims":{"hd":"oceanagentics.com"}}'::jsonb
    from auth.users where id in ('${reader}','${admin}');
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

test('final schema protects findings, operational state and tracker management in a shared database', async () => {
  const db = new PGlite();
  try {
    await db.exec(auth + fixture);
    const before = (await db.query(sharedState)).rows;
    for (const [name, sql] of migrations) {
      if (name === '20261001170000_scout_lean_schema.sql') {
        await db.query("insert into scout.memberships(user_id,role) values($1,'admin')", [admin]);
        await db.query("update auth.users set raw_app_meta_data='{\"other\":\"keep\",\"scout\":{\"preference\":\"keep\"}}' where id=$1", [admin]);
      }
      await db.exec(sql);
    }
    assert.deepEqual((await db.query('select raw_app_meta_data from auth.users where id=$1', [admin])).rows[0].raw_app_meta_data,
      { other: 'keep', scout: { preference: 'keep', admin: true } });
    const tracker = (await db.query("insert into scout.trackers(name,url,collector,cadence,enabled) values('Source','https://example.org','web','1 day',true) returning id")).rows[0].id;
    const record = (await db.query("insert into scout.records(kind,title) values('announcement','Private finding') returning id")).rows[0].id;
    await db.query("update scout.records set sources=$2 where id=$1", [record,[{url:'https://example.org/source',tracker_id:tracker,relationship:'source'}]]);
    await db.query("insert into scout.source_state(tracker_id,identity,url,state,reason) values($1,'item','https://example.org/source','parked','attempt_bound')", [tracker]);
    const publicReads = ['scout.records','scout.finding_reader','scout.findings()','scout.finding_jobs()','scout.tracker_status'];
    const privateTables = ['source_state','quota_policy','quota_reservations','delivery_state'];
    await db.exec('set role anon');
    for (const view of publicReads) await assert.rejects(db.query('select * from ' + view), { code: '42501' });
    await assert.rejects(db.query('select scout.access_role()'), { code: '42501' });
    await db.exec('reset role; set role authenticated');
    for (const [user, role] of [[outsider,null],[reader,'reader'],[admin,'admin']]) {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
      assert.equal((await db.query('select scout.access_role() role')).rows[0].role, role);
      assert.equal((await db.query('select * from otherservice.private_records')).rows.length, user === outsider ? 1 : 0);
      for (const view of publicReads) assert.equal((await db.query('select * from ' + view)).rows.length, role ? 1 : 0, view);
      for (const table of privateTables) {
        await assert.rejects(db.query('select * from scout.' + table), { code: '42501' });
        await assert.rejects(db.query('delete from scout.' + table), { code: '42501' });
      }
      await assert.rejects(db.query('select * from scout.expire_quota()'), { code: '42501' });
      await assert.rejects(db.query('select * from scout.reserve_model(gen_random_uuid(),gen_random_uuid(),null,2)'), { code: '42501' });
      await assert.rejects(db.query("insert into scout.records(kind,title) values('announcement','Forged')"), { code: '42501' });
      await assert.rejects(db.query("update scout.records set title='Forged'"), { code: '42501' });
      await assert.rejects(db.query('delete from scout.records'), { code: '42501' });
      await assert.rejects(db.query("update auth.users set raw_app_meta_data='{}'"), { code: '42501' });
      for (const enabled of [true,false]) {
        await assert.rejects(db.query('update scout.trackers set enabled=$1', [enabled]), { code: '42501' });
        await assert.rejects(db.query("insert into scout.trackers(name,url,collector,cadence,enabled) values('Forged','https://example.org/new','web','1 day',$1)", [enabled]), { code: '42501' });
      }
      assert.equal((await db.query("update scout.trackers set cadence='2 days' returning id")).rows.length, role === 'admin' ? 1 : 0);
      if (role !== 'admin') await assert.rejects(db.query("insert into scout.trackers(name,url,collector,cadence) values('Forged','https://example.org/new','web','1 day')"), { code: '42501' });
    }
    const finding = (await db.query('select * from scout.findings()')).rows[0];
    assert.deepEqual(finding.sources, [{ url:'https://example.org/source', tracker_id:tracker, relationship:'source' }]);
    await db.query("update scout.trackers set url='https://example.org/edited' where id=$1", [tracker]);
    assert.equal((await db.query('select enabled from scout.trackers where id=$1', [tracker])).rows[0].enabled, false);
    const inserted = (await db.query("insert into scout.trackers(name,url,collector,cadence) values('Unproven','https://example.org/new','web','1 day') returning enabled")).rows[0];
    assert.equal(inserted.enabled, false);
    await db.exec('reset role; set role service_role');
    await db.query('update scout.trackers set enabled=true where id=$1', [tracker]);
    assert.equal((await db.query('select enabled from scout.trackers where id=$1', [tracker])).rows[0].enabled, true);
    for (const edit of ["collector='bluesky_feed'","url=null"]) {
      await db.query('update scout.trackers set ' + edit + ',enabled=true where id=$1', [tracker]);
      assert.equal((await db.query('select enabled from scout.trackers where id=$1', [tracker])).rows[0].enabled, false);
    }
    for (const table of privateTables) {
      await db.query('select * from scout.' + table);
      for (const privilege of ['INSERT','UPDATE','DELETE']) assert.equal((await db.query("select has_table_privilege('service_role',$1,$2) allowed", ['scout.' + table,privilege])).rows[0].allowed, true);
    }
    assert.equal((await db.query('select * from scout.reserve_model(gen_random_uuid(),gen_random_uuid(),null,2)')).rows[0].allowed, false);
    await db.query('select * from scout.expire_quota()');
    await db.exec('reset role');
    assert.equal((await db.query("select bool_and(c.relrowsecurity) protected from pg_class c where c.relnamespace='scout'::regnamespace and c.relkind='r'")).rows[0].protected, true);
    await db.exec('create table scout.future_private_table(id integer)');
    for (const role of ['anon','authenticated']) assert.equal((await db.query("select has_table_privilege($1,'scout.future_private_table','SELECT') allowed", [role])).rows[0].allowed, false);
    assert.deepEqual((await db.query(sharedState)).rows, before);
  } finally { await db.close(); }
});

test('final Workspace access requires verified provider proof, never editable metadata', async () => {
  const db = new PGlite(), proof = { iss:'https://accounts.google.com', email_verified:true, custom_claims:{hd:'oceanagentics.com'} };
  try {
    await db.exec(auth);
    for (const [, sql] of migrations) await db.exec(sql);
    await db.exec("insert into scout.records(kind,title) values('announcement','Private finding')");
    await db.query('update auth.users set raw_user_meta_data=$1,raw_app_meta_data=$2 where id=$3', [proof, {scout:{admin:true}}, outsider]);
    for (const identity of [null,['email',proof],['other',proof],['google',{...proof,iss:'https://attacker.example'}],
      ['google',{...proof,custom_claims:{hd:'other.example'}}],['google',{...proof,email_verified:false}],
      ['google',{...proof,email_verified:'true'}],['google',{...proof,custom_claims:null}],['google',proof]]) {
      await db.query('delete from auth.identities where user_id=$1', [outsider]);
      if (identity) await db.query('insert into auth.identities values($1,$2,$3)', [outsider,...identity]);
      await db.exec('set role authenticated');
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [outsider]);
      const allowed = identity?.[0] === 'google' && identity[1] === proof;
      assert.equal((await db.query('select scout.access_role() role')).rows[0].role, allowed ? 'admin' : null);
      assert.equal((await db.query('select * from scout.findings()')).rows.length, allowed ? 1 : 0);
      await assert.rejects(db.query('update auth.identities set identity_data=$1', [proof]), {code:'42501'});
      await db.exec('reset role');
    }
    await db.query('delete from auth.identities where user_id=$1', [outsider]);
    await db.exec('set role authenticated');
    assert.equal((await db.query('select scout.access_role() role')).rows[0].role, null);
    assert.equal((await db.query('select * from scout.findings()')).rows.length, 0);
  } finally { await db.close(); }
});

test('tracker seeds preserve app edits and remain idempotent on the final schema', async () => {
  const db = new PGlite();
  try {
    await db.exec(auth);
    for (const [, sql] of migrations) await db.exec(sql);
    await db.exec(trackerSeed);
    const initial = (await db.query('select * from scout.trackers order by seed_key')).rows;
    assert.equal(initial.length, 41);
    assert.deepEqual(initial.filter(r=>r.enabled).map(r=>r.seed_key), [17,18,19,20].map(n=>'bbnj-trackers-2026-10-01:'+n));
    assert.ok(initial.filter(r=>!r.url).every(r=>!r.enabled));
    assert.ok((await db.query('select * from scout.tracker_status')).rows.every(r=>r.last_attempt_at===null&&r.last_success_at===null));
    await db.query("update auth.users set raw_app_meta_data='{\"scout\":{\"admin\":true}}' where id=$1", [admin]);
    await db.exec('set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [admin]);
    const feed = initial.find(r=>r.seed_key==='bbnj-trackers-2026-10-01:17');
    await db.query("update scout.trackers set name='Edited',url='https://example.org/edited',collector='web',coverage='Edited coverage',cadence='2 days' where id=$1", [feed.id]);
    await assert.rejects(db.query("update scout.trackers set seed_key='edited' where id=$1", [feed.id]), {code:'42501'});
    await db.exec('reset role');
    const edited = (await db.query('select * from scout.trackers order by id')).rows;
    await db.exec(trackerSeed);await db.exec(trackerSeed);
    assert.deepEqual((await db.query('select * from scout.trackers order by id')).rows, edited);
  } finally { await db.close(); }
});
