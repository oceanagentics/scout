import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile(new URL('../supabase/migrations/20261001050000_scout_foundation.sql', import.meta.url), 'utf8');
const trackerMigration = await readFile(new URL('../supabase/migrations/20261001060000_scout_tracker_import.sql', import.meta.url), 'utf8');
const trackerSeed = await readFile(new URL('../supabase/seeds/trackers.sql', import.meta.url), 'utf8');
const collectionMigration = await readFile(new URL('../supabase/migrations/20261001070000_scout_collection.sql', import.meta.url), 'utf8');
const evidenceMigration = await readFile(new URL('../supabase/migrations/20261001080000_scout_event_evidence.sql', import.meta.url), 'utf8');
const workspaceMigration = await readFile(new URL('../supabase/migrations/20261001140000_scout_workspace_access.sql', import.meta.url), 'utf8');
const historyMigration = await readFile(new URL('../supabase/migrations/20261001150000_scout_record_change_fields.sql', import.meta.url), 'utf8');
const leanMigration = await readFile(new URL('../supabase/migrations/20261001160000_scout_lean_records.sql', import.meta.url), 'utf8');
const deliveryMigration = await readFile(new URL('../supabase/migrations/20261001090000_scout_delivery_evidence.sql', import.meta.url), 'utf8');
const schemaMigration = await readFile(new URL('../supabase/migrations/20261001170000_scout_lean_schema.sql', import.meta.url), 'utf8');
const fiveTablesMigration = await readFile(new URL('../supabase/migrations/20261001180000_scout_five_tables.sql', import.meta.url), 'utf8');
const beforeSchema = migration + trackerMigration + collectionMigration + evidenceMigration + deliveryMigration + workspaceMigration + historyMigration + leanMigration;
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

test('date evidence column removal preserves event times, source proofs, accounting and access', async () => {
  const db = new PGlite(), name = '20261007090000_scout_source_date_evidence.sql';
  try {
    await db.exec(auth + fixture);
    for (const file of (await readdir(new URL('../supabase/migrations/', import.meta.url))).sort())
      if (file !== name&&file<'20261009190000') await db.exec(await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
    const tracker = (await db.query("insert into scout.trackers(name,url,collector,cadence) values('Source','https://example.org','web','1 day') returning *")).rows[0];
    const record = (await db.query("insert into scout.records(kind,title,starts_at,ends_at) values('event','Supported webinar','2026-10-08T14:00Z','2026-10-08T15:00Z') returning *")).rows[0];
    const source = (await db.query(`insert into scout.evidence(record_id,tracker_id,url,content_hash,content,parsed,last_seen_at)
      values($1,$2,'https://example.org/event','source-version','Original schedule text',$3,clock_timestamp()) returning *`,
      [record.id, tracker.id, { accepted_fields: { starts_at: { value: record.starts_at.toISOString(), sources: [{ url: 'https://example.org/event', hash: 'source-version' }] } } }])).rows[0];
    await db.query('update scout.records set date_evidence=$2 where id=$1', [record.id, { schedule_source: source.id }]);
    const run = (await db.query("insert into scout.collection_runs(tracker_id,outcome,finished_at,stats) values($1,'partial',clock_timestamp(),'{\"model_attempts\":[{\"at\":\"2026-10-07T12:00:00Z\"}]}') returning *", [tracker.id])).rows[0];
    const shared = (await db.query(sharedState)).rows;
    await db.exec(await readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8'));
    const { date_evidence, ...expected } = record;
    assert.deepEqual((await db.query('select * from scout.records')).rows, [expected]);
    assert.deepEqual((await db.query('select * from scout.evidence')).rows, [source]);
    assert.deepEqual((await db.query('select * from scout.trackers')).rows, [tracker]);
    assert.deepEqual((await db.query('select * from scout.collection_runs')).rows, [run]);
    assert.deepEqual((await db.query(sharedState)).rows, shared);
    assert.equal((await db.query("select count(*)::int n from information_schema.columns where table_schema='scout' and table_name='records'")).rows[0].n, 17);
    await db.exec('set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [reader]);
    assert.deepEqual((await db.query('select * from scout.records')).rows, [expected]);
    assert.equal((await db.query('select * from scout.source_details')).rows[0].url, source.url);
    await assert.rejects(db.query('select * from scout.evidence'), { code: '42501' });
  } finally { await db.close(); }
});

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

test('history migration preserves creations, null transitions, evidence, timestamps and access', async () => {
  const db = new PGlite();
  try {
    await db.exec(auth + fixture);
    await db.exec(migration);
    await db.exec(collectionMigration);
    await db.exec(evidenceMigration);
    await db.exec(workspaceMigration);
    const record = (await db.query("insert into scout.records (kind,title) values ('event','BBNJ webinar') returning *")).rows[0];
    const tracker = (await db.query("insert into scout.trackers (name,url,channel,method,cadence) values ('Source','https://example.org','web','http','1 day') returning id")).rows[0];
    const source = (await db.query(`insert into scout.source_versions (tracker_id,url,content_hash,content,parsed)
      values ($1,'https://example.org/event','fixture','Captured evidence','{"title":"BBNJ webinar"}') returning *`, [tracker.id])).rows[0];
    const initial = { kind: 'event', title: 'BBNJ webinar', location: null, start_on: '2026-10-08', starts_at: null, time_zone: null };
    const timed = { ...initial, start_on: null, starts_at: '2026-10-08T14:00:00.000Z', time_zone: 'UTC',
      date_evidence: { time_zone: { value: 'UTC', source_versions: [source.id] } } };
    const dateBefore = { start_on: '2026-10-08', starts_at: null, time_zone: null };
    const dateAfter = { start_on: null, starts_at: timed.starts_at, time_zone: 'UTC', date_evidence: timed.date_evidence };
    const cases = [
      [null, initial, null, initial],
      [initial, timed, dateBefore, dateAfter],
      [timed, initial, dateAfter, dateBefore],
      [initial, { ...initial, date_evidence: null }, {}, { date_evidence: null }],
      [{ ...initial, date_evidence: null }, initial, { date_evidence: null }, {}],
      [timed, { ...timed, date_evidence: { time_zone: { source_versions: [source.id], value: 'UTC' } } }, {}, {}],
    ];
    const rows = [];
    for (const [previous, current] of cases) {
      rows.push((await db.query(`insert into scout.record_changes (record_id,source_version_id,changed_at,previous,current)
        values ($1,$2,$3,$4,$5) returning *`, [record.id, source.id, `2026-10-01T0${rows.length}:00:00Z`,
        previous === null ? null : JSON.stringify(previous), JSON.stringify(current)])).rows[0]);
    }
    const shared = (await db.query(sharedState)).rows;
    const access = (await db.query("select relacl::text, relrowsecurity from pg_class where oid='scout.record_changes'::regclass")).rows;
    await db.exec(historyMigration);
    const migrated = (await db.query('select * from scout.record_changes order by changed_at')).rows;
    assert.deepEqual(migrated, rows.map((row, i) => ({ ...row, previous: cases[i][2], current: cases[i][3] })));
    assert.deepEqual((await db.query('select * from scout.source_versions')).rows, [source]);
    assert.deepEqual((await db.query('select * from scout.records')).rows, [record]);
    assert.deepEqual((await db.query(sharedState)).rows, shared);
    assert.deepEqual((await db.query("select relacl::text, relrowsecurity from pg_class where oid='scout.record_changes'::regclass")).rows, access);
    await db.exec('set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [reader]);
    assert.deepEqual((await db.query('select * from scout.record_changes order by changed_at')).rows, migrated);
    await assert.rejects(db.query('select * from scout.source_versions'), { code: '42501' });
    await assert.rejects(db.query("update scout.record_changes set current='{}'"), { code: '42501' });
  } finally { await db.close(); }
});

test('lean record migration removes redundant columns without altering captured evidence or history', async () => {
  const db = new PGlite();
  try {
    await db.exec(auth + fixture);
    await db.exec(migration);
    await db.exec(collectionMigration);
    await db.exec(evidenceMigration);
    await db.exec(historyMigration);
    await db.exec(await readFile(new URL('../supabase/migrations/20261001090000_scout_delivery_evidence.sql', import.meta.url), 'utf8'));
    const description = '🌊'.repeat(300);
    const record = (await db.query(`insert into scout.records (kind,title,description,summary,start_on,end_on,published_on,collected_at,updated_at)
      values ('event','Legacy webinar',$1,'Duplicate summary','2026-10-03','2026-10-04','2026-09-30','2026-10-01','2026-10-01') returning *`, [description])).rows[0];
    const timed = (await db.query(`insert into scout.records (kind,title,description,starts_at,ends_at,time_zone,updated_at)
      values ('event','Timed webinar','Short description','2026-10-03T12:00Z','2026-10-03T13:00Z','UTC','2026-10-01') returning *`)).rows[0];
    const fallback = (await db.query("insert into scout.records (kind,title,summary) values ('announcement','Summary only','Preserve this description') returning id")).rows[0];
    const tracker = (await db.query("insert into scout.trackers (name,url,channel,method,cadence) values ('Source','https://example.org','web','http','1 day') returning id")).rows[0];
    const source = (await db.query(`insert into scout.source_versions (tracker_id,url,content_hash,content,parsed)
      values ($1,'https://example.org/event','legacy',$2,$3) returning *`, [tracker.id, description, JSON.stringify({ description, start_on: '2026-10-03' })])).rows[0];
    const history = (await db.query('insert into scout.record_changes (record_id,source_version_id,current) values ($1,$2,$3) returning *',
      [record.id, source.id, JSON.stringify({ description, start_on: '2026-10-03' })])).rows[0];
    const delivery = (await db.query(`insert into scout.deliveries (record_id,kind,channel_id,idempotency_key,snapshot,payload)
      values ($1,'finding','fixture','legacy',$2,'{"text":"Previously prepared message"}') returning *`, [record.id, JSON.stringify({ records: [record] })])).rows[0];
    const shared = (await db.query(sharedState)).rows;
    await db.exec(leanMigration);
    const current = (await db.query('select * from scout.records where id=$1', [record.id])).rows[0];
    assert.equal(current.description, '🌊'.repeat(279) + '…');
    assert.ok(current.updated_at > record.updated_at);
    assert.equal(current.starts_at, null);
    assert.equal(current.ends_at, null);
    for (const field of ['summary', 'start_on', 'end_on', 'published_on', 'country', 'treaty_action', 'recorded_on', 'collected_at']) assert.equal(Object.hasOwn(current, field), false);
    const unchanged = (await db.query('select * from scout.records where id=$1', [timed.id])).rows[0];
    for (const field of ['starts_at', 'ends_at', 'updated_at', 'date_evidence']) assert.deepEqual(unchanged[field], timed[field]);
    assert.equal((await db.query('select description from scout.records where id=$1', [fallback.id])).rows[0].description, 'Preserve this description');
    assert.deepEqual((await db.query('select * from scout.source_versions')).rows, [source]);
    assert.deepEqual((await db.query('select * from scout.record_changes')).rows, [history]);
    assert.deepEqual((await db.query('select * from scout.deliveries')).rows, [delivery]);
    assert.deepEqual((await db.query(sharedState)).rows, shared);
    await assert.rejects(db.query('update scout.records set description=$1 where id=$2', ['x'.repeat(281), record.id]), { code: '23514' });
    await assert.rejects(db.query("insert into scout.records (kind,title,starts_at,time_zone) values ('announcement','Invalid','2026-10-03T12:00Z','UTC')"), { code: '23514' });
    await assert.rejects(db.query("insert into scout.records (kind,title,starts_at,ends_at,time_zone) values ('event','Invalid','2026-10-03T12:00Z','2026-10-02T12:00Z','UTC')"), { code: '23514' });
    await db.query("update scout.records set description='Corrected' where id=$1", [timed.id]);
    assert.ok((await db.query('select updated_at from scout.records where id=$1', [timed.id])).rows[0].updated_at > timed.updated_at);
  } finally { await db.close(); }
});

for (const shared of [false, true]) {
  test(`foundation migration and access policies in ${shared ? 'shared' : 'empty'} database`, async () => {
    const db = new PGlite();
    try {
      await db.exec(auth);
      if (shared) await db.exec(fixture);
      const before = shared ? (await db.query(sharedState)).rows : null;
      await db.exec(migration);
      await db.exec(trackerMigration);
      await db.exec(collectionMigration);
      await db.exec(evidenceMigration);
      await db.exec(workspaceMigration);
      await db.exec(historyMigration);
      if (shared) assert.deepEqual((await db.query(sharedState)).rows, before);
      assert.equal((await db.query("select count(*)::int n from pg_class where relnamespace = 'scout'::regnamespace and relkind = 'r' and relrowsecurity")).rows[0].n, 8);
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
      await assert.rejects(db.query('select * from scout.source_versions'), { code: '42501' });
      assert.equal((await db.query('select * from scout.record_changes')).rows.length, 0);
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

test('Workspace provider proof grants readers automatically; editable metadata and other identities cannot grant access', async () => {
  const db = new PGlite();
  const proof = { iss: 'https://accounts.google.com', email: 'reader@oceanagentics.com', email_verified: true, custom_claims: { hd: 'oceanagentics.com' } };
  try {
    await db.exec(auth + fixture + beforeSchema + schemaMigration + trackerSeed);
    const shared = (await db.query(sharedState)).rows;
    await db.exec("insert into scout.records (kind,title) values ('announcement','Private fixture')");
    await db.query('update auth.users set raw_user_meta_data=$1 where id=$2', [JSON.stringify({ ...proof, scout: { admin: true } }), outsider]);
    const denied = [null, ['email', proof], ['other', proof], ['google', { ...proof, iss: 'https://attacker.example' }],
      ['google', { ...proof, email: 'person@gmail.com', custom_claims: {} }],
      ['google', { ...proof, custom_claims: { hd: 'other.example' } }],
      ['google', { ...proof, email_verified: false }], ['google', { ...proof, email_verified: 'true' }],
      ['google', { ...proof, custom_claims: null }]];
    for (const identity of denied) {
      await db.query('delete from auth.identities where user_id=$1', [outsider]);
      if (identity) await db.query('insert into auth.identities values ($1,$2,$3)', [outsider, identity[0], JSON.stringify(identity[1])]);
      await db.exec('set role authenticated');
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [outsider]);
      assert.equal((await db.query('select scout.access_role() as role')).rows[0].role, null);
      assert.equal((await db.query('select * from scout.records')).rows.length, 0);
      assert.equal((await db.query('select * from scout.trackers')).rows.length, 0);
      await assert.rejects(db.query('update auth.identities set identity_data=$1', [JSON.stringify(proof)]), { code: '42501' });
      await db.exec('reset role');
    }
    await db.query('delete from auth.identities where user_id=$1', [outsider]);
    await db.query('insert into auth.identities values ($1,$2,$3)', [outsider, 'google', JSON.stringify(proof)]);
    await db.exec('set role authenticated');
    assert.equal((await db.query('select scout.access_role() as role')).rows[0].role, 'reader');
    assert.equal((await db.query('select * from scout.records')).rows.length, 1);
    assert.equal((await db.query('select * from scout.trackers')).rows.length, 32);
    assert.equal((await db.query('update scout.trackers set enabled=false returning id')).rows.length, 0);
    await assert.rejects(db.query("update auth.users set raw_app_meta_data='{\"scout\":{\"admin\":true}}'"), { code: '42501' });
    for (const table of ['records','sources','record_changes','collection_runs','deliveries','source_versions']) {
      await assert.rejects(db.query(`delete from scout.${table}`), { code: '42501' });
    }
    await db.exec('reset role');
    assert.deepEqual((await db.query(sharedState)).rows, shared);
    await db.query("update auth.users set raw_app_meta_data='{\"scout\":{\"admin\":true}}' where id=$1", [outsider]);
    await db.query('delete from auth.identities where user_id=$1', [outsider]);
    await db.exec('set role authenticated');
    assert.equal((await db.query('select scout.access_role() as role')).rows[0].role, null);
    assert.equal((await db.query('update scout.trackers set enabled=false returning id')).rows.length, 0);
    await db.exec('reset role; set role anon');
    await assert.rejects(db.query('select scout.access_role()'), { code: '42501' });
  } finally { await db.close(); }
});

test('schema cleanup preserves evidence, derives freshness, migrates admins and protects source projections', async () => {
  const db = new PGlite();
  try {
    await db.exec(auth + fixture + beforeSchema);
    await db.query("insert into scout.memberships(user_id,role) values ($1,'admin')", [admin]);
    await db.query('update auth.users set raw_app_meta_data=$1 where id=$2', [{ other: 'unchanged', scout: { preference: 'keep' } }, admin]);
    const tracker = (await db.query("insert into scout.trackers(name,url,channel,method,cadence) values ('HSA','https://example.org','Bluesky','Bluesky API: getAuthorFeed','1 day') returning id")).rows[0];
    const record = (await db.query("insert into scout.records(kind,title,starts_at,time_zone,updated_at) values ('event','BBNJ webinar','2026-10-02T00:30Z','-04:00','2026-10-01') returning *")).rows[0];
    const source = (await db.query(`insert into scout.source_versions(tracker_id,url,content_hash,content,parsed,collected_at)
      values ($1,'https://example.org/event','hsa-v2:fixture','Complete original content','{"summary":"Original parsed evidence","starts_at":"2026-10-02T00:30:00.000Z"}','2026-09-30T00:00Z') returning *`, [tracker.id])).rows[0];
    const direct = (await db.query("insert into scout.records(kind,title,starts_at,time_zone) values ('event','Direct timestamp','2026-10-02T00:30Z','-04:00') returning id")).rows[0];
    const directHistory = (await db.query('insert into scout.record_changes(record_id,source_version_id,current) values ($1,$2,$3) returning *', [direct.id, source.id, { starts_at: '2026-10-02T00:30:00.000Z' }])).rows[0];
    const dateEvidence = { calendar_date: { value: '2026-10-01', source_versions: [source.id] }, time_zone: { value: 'EDT', source_versions: [source.id] } };
    await db.query('update scout.records set date_evidence=$1 where id=$2', [dateEvidence, record.id]);
    const history = (await db.query('insert into scout.record_changes(record_id,source_version_id,current) values ($1,$2,$3) returning *', [record.id, source.id, { date_evidence: dateEvidence }])).rows[0];
    const delivery = (await db.query(`insert into scout.deliveries(record_id,record_updated_at,kind,channel_id,idempotency_key,payload,snapshot)
      values ($1,$2,'finding','fixture','fixture','{"text":"Original message"}',$3) returning *`, [record.id, record.updated_at, { format: 2, records: [record] }])).rows[0];
    await db.query(`insert into scout.sources(record_id,tracker_id,url,content_hash,excerpt,published_on,collected_at,authoritative)
      values ($1,$2,'https://example.org/event','hsa-v2:fixture','Complete original content','2026-09-29','2026-10-01T00:00Z',true)`, [record.id, tracker.id]);
    await db.query(`insert into scout.collection_runs(tracker_id,started_at,finished_at,outcome,error,stats) values
      ($1,'2026-09-29T00:00Z','2026-09-29T00:01Z','success',null,'{"models":0}'),
      ($1,'2026-09-30T00:00Z','2026-09-30T00:01Z','partial','Page unavailable','{"warnings":["Page unavailable"],"models":0}'),
      ($1,'2026-10-01T00:00Z',null,'running',null,'{}')`, [tracker.id]);
    const shared = (await db.query(sharedState)).rows;
    // Refuse to discard a source whose capture cannot be identified.
    await db.query("insert into scout.sources(record_id,url,excerpt) values ($1,'https://example.org/unmatched','Uncaptured evidence')", [record.id]);
    await assert.rejects(db.exec(schemaMigration), { code: '23502' });
    await db.exec('rollback');
    assert.equal((await db.query('select count(*)::int n from scout.memberships')).rows[0].n, 1);
    assert.equal((await db.query('select count(*)::int n from scout.sources')).rows[0].n, 2);
    await db.query("delete from scout.sources where url='https://example.org/unmatched'");
    await db.exec(schemaMigration);
    assert.equal((await db.query("select count(*)::int n from information_schema.tables where table_schema='scout' and table_type='BASE TABLE'")).rows[0].n, 7);
    assert.equal((await db.query("select count(*)::int n from information_schema.columns c join information_schema.tables t using(table_schema,table_name) where c.table_schema='scout' and t.table_type='BASE TABLE'")).rows[0].n, 67);
    const migrated = (await db.query('select * from scout.records where id=$1', [record.id])).rows[0];
    assert.deepEqual(migrated.starts_at, record.starts_at);
    assert.deepEqual(migrated.updated_at, record.updated_at);
    assert.deepEqual(migrated.date_evidence, { schedule_source: source.id, zone_source: source.id });
    assert.deepEqual((await db.query('select date_evidence from scout.records where id=$1', [direct.id])).rows[0].date_evidence, { schedule_source: source.id });
    for (const key of ['created_at','material_hash','time_zone']) assert.equal(Object.hasOwn(migrated, key), false);
    const capture = (await db.query('select * from scout.source_versions')).rows[0];
    assert.equal(capture.published_on.toISOString().slice(0, 10), '2026-09-29');
    delete capture.published_on;
    assert.deepEqual(capture, source);
    assert.deepEqual((await db.query('select * from scout.record_changes order by changed_at')).rows, [directHistory, history]);
    delete delivery.record_updated_at;
    assert.deepEqual((await db.query('select * from scout.deliveries')).rows, [delivery]);
    const status = (await db.query('select * from scout.tracker_status')).rows[0];
    assert.equal(status.collector, 'bluesky_feed');
    assert.equal(status.last_attempt_at.toISOString(), '2026-10-01T00:00:00.000Z');
    assert.equal(status.last_success_at.toISOString(), '2026-09-29T00:01:00.000Z');
    assert.equal(status.last_outcome, 'partial');
    assert.equal(status.last_error, 'Page unavailable');
    assert.deepEqual((await db.query('select raw_app_meta_data from auth.users where id=$1', [admin])).rows[0].raw_app_meta_data,
      { other: 'unchanged', scout: { preference: 'keep', admin: true } });
    assert.deepEqual((await db.query(sharedState)).rows, shared);
    await db.exec('set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [outsider]);
    for (const view of ['source_details','tracker_status']) assert.deepEqual((await db.query(`select * from scout.${view}`)).rows, []);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [reader]);
    assert.equal((await db.query('select scout.access_role() as role')).rows[0].role, 'reader');
    const detail = (await db.query('select * from scout.source_details')).rows[0];
    assert.equal(detail.published_on.toISOString().slice(0, 10), '2026-09-29');
    assert.equal(detail.collected_at.toISOString(), '2026-09-30T00:00:00.000Z');
    assert.equal(detail.last_seen_at.toISOString(), '2026-10-01T00:00:00.000Z');
    assert.equal(Object.hasOwn(detail, 'content'), false);
    await assert.rejects(db.query('select * from scout.source_versions'), { code: '42501' });
    await assert.rejects(db.query("update scout.source_details set url='https://example.org/tampered'"), { code: '55000' });
    assert.equal((await db.query('update scout.trackers set enabled=false returning id')).rows.length, 0);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [admin]);
    assert.equal((await db.query('select scout.access_role() as role')).rows[0].role, 'admin');
    assert.equal((await db.query("update scout.trackers set collector='web' returning id")).rows.length, 1);
    await assert.rejects(db.query('update auth.users set raw_app_meta_data=null'), { code: '42501' });
    await db.exec('reset role; set role anon');
    for (const view of ['source_details','tracker_status']) await assert.rejects(db.query(`select * from scout.${view}`), { code: '42501' });
  } finally { await db.close(); }
});

test('five-table migration preserves captures, shared associations, current evidence, record versions and deliveries', async () => {
  const db = new PGlite();
  try {
    await db.exec(auth + fixture + beforeSchema + schemaMigration);
    const tracker = (await db.query("insert into scout.trackers(name,url,collector,cadence) values ('Fixture','https://example.org','web','1 day') returning id")).rows[0];
    const records = (await db.query("insert into scout.records(kind,title,starts_at) values ('event','First','2026-11-03T12:00Z'),('event','Second','2026-11-04T12:00Z') returning *")).rows;
    const captures = (await db.query(`insert into scout.source_versions(tracker_id,url,content_hash,content,parsed,collected_at,published_on) values
      ($1,'https://example.org/event','A','Original capture','{"starts_at":"2026-11-03T12:00:00.000Z"}','2026-10-01T00:00Z','2026-09-30'),
      ($1,'https://example.org/event','B','Revised capture','{"starts_at":"2026-11-04T12:00:00.000Z"}','2026-10-02T00:00Z',null),
      ($1,'https://example.org/unrelated','U','Unrelated capture',null,'2026-10-01T00:00Z',null),
      ($1,'https://example.org/earlier','H','Earlier supporting capture','{}','2026-09-01T00:00Z',null) returning *`, [tracker.id])).rows;
    for (const [i, record] of records.entries()) {
      await db.query('update scout.records set date_evidence=$1 where id=$2', [{ schedule_source: captures[i].id, zone_source: captures[0].id }, record.id]);
      await db.query(`insert into scout.sources(record_id,url,source_version_id,last_seen_at,authoritative,evidence_at)
        values ($1,'https://example.org/event',$2,'2026-10-03T00:00Z',$3,$4)`,
      [record.id, captures[i].id, i === 0, i === 0 ? '2026-10-03T00:00Z' : null]);
    }
    await db.query('insert into scout.record_changes(record_id,source_version_id,current) values ($1,$2,$3)',
      [records[1].id, captures[3].id, { title: 'Earlier title' }]);
    await db.query(`insert into scout.deliveries(record_id,kind,channel_id,idempotency_key,payload,snapshot)
      values ($1,'finding','fixture','preserved','{"text":"Reviewed message"}',$2)`, [records[1].id, { format: 3, records }]);
    const beforeRecords = (await db.query('select * from scout.records order by id')).rows;
    const deliveries = (await db.query('select * from scout.deliveries')).rows;
    const shared = (await db.query(sharedState)).rows;
    const current = (await db.query(`select s.record_id,s.url,s.last_seen_at,s.authoritative,s.evidence_at,v.content_hash
      from scout.sources s join scout.source_versions v on v.id=s.source_version_id order by s.record_id`)).rows;
    await db.exec(fiveTablesMigration);
    assert.deepEqual((await db.query("select table_name from information_schema.tables where table_schema='scout' and table_type='BASE TABLE' order by table_name")).rows.map(row => row.table_name),
      ['collection_runs','deliveries','evidence','records','trackers']);
    assert.equal((await db.query("select count(*)::int n from information_schema.columns c join information_schema.tables t using(table_schema,table_name) where c.table_schema='scout' and t.table_type='BASE TABLE'")).rows[0].n, 59);
    const evidence = (await db.query('select * from scout.evidence')).rows;
    assert.equal(evidence.length, 6);
    for (const capture of captures) {
      assert.ok(evidence.some(row => row.id === capture.id));
      for (const row of evidence.filter(row => row.content_hash === capture.content_hash)) {
        for (const key of Object.keys(capture).filter(key => key !== 'id')) assert.deepEqual(row[key], capture[key]);
      }
    }
    assert.equal(evidence.find(row => row.content_hash === 'U').record_id, null);
    assert.equal(evidence.find(row => row.content_hash === 'H').record_id, records[1].id);
    assert.deepEqual((await db.query('select record_id,url,last_seen_at,authoritative,evidence_at,content_hash from scout.current_evidence order by record_id')).rows, current);
    for (const record of (await db.query('select * from scout.records order by id')).rows) {
      const before = beforeRecords.find(row => row.id === record.id);
      for (const key of Object.keys(before).filter(key => key !== 'date_evidence')) assert.deepEqual(record[key], before[key]);
      for (const key of ['schedule_source','zone_source']) {
        const proof = evidence.find(row => row.id === record.date_evidence[key]);
        assert.equal(proof.record_id, record.id);
        assert.equal(proof.content, captures.find(row => row.id === before.date_evidence[key]).content);
      }
    }
    assert.deepEqual((await db.query('select * from scout.deliveries')).rows, deliveries);
    assert.deepEqual((await db.query(sharedState)).rows, shared);
    await db.exec('set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [reader]);
    assert.equal((await db.query('select * from scout.source_details')).rows.length, 2);
    for (const table of ['evidence','current_evidence']) await assert.rejects(db.query(`select * from scout.${table}`), { code: '42501' });
    await assert.rejects(db.query('delete from scout.evidence'), { code: '42501' });
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [outsider]);
    assert.deepEqual((await db.query('select * from scout.source_details')).rows, []);
    await db.exec('reset role; set role anon');
    await assert.rejects(db.query('select * from scout.source_details'), { code: '42501' });
    await db.exec('reset role; set role service_role');
    assert.equal((await db.query('select * from scout.evidence')).rows.length, 6);
    assert.equal((await db.query('select * from scout.current_evidence')).rows.length, 2);
  } finally { await db.close(); }
});

test('collector proof migration enables only verified configurations and preserves collected data', async () => {
  const db = new PGlite();
  try {
    await db.exec(auth + fixture + beforeSchema + schemaMigration + fiveTablesMigration);
    await db.exec(await readFile(new URL('../supabase/migrations/20261001190000_assessment_and_communication.sql', import.meta.url), 'utf8'));
    await db.exec(trackerSeed);
    await db.exec(`insert into scout.trackers(name,url,collector,cadence) values
      ('HUB','https://www.hubocean.earth/events-calendar','web','7 days'),
      ('Untested feed','https://bsky.app/profile/example.org','bluesky_feed','1 day'),
      ('Wrong collector','https://bsky.app/profile/highseasalliance.bsky.social','web','7 days');
      update scout.trackers set enabled=true where url is not null;
      insert into scout.records(kind,title,identity_key) values('announcement','Preserved finding','proof-fixture');
      insert into scout.collection_runs(tracker_id,outcome,finished_at) select id,'partial',now() from scout.trackers where seed_key like '%:17';
      insert into scout.evidence(tracker_id,url,content,content_hash) select id,url,'Preserved evidence','proof-hash' from scout.trackers where seed_key like '%:17';`);
    const before = (await db.query('select * from scout.trackers order by id')).rows;
    const preserved = {};
    for (const table of ['records','evidence','collection_runs']) preserved[table] = (await db.query(`select * from scout.${table} order by id`)).rows;
    const otherService = (await db.query(sharedState)).rows;
    await db.exec(await readFile(new URL('../supabase/migrations/20261002130000_scout_proven_collectors.sql', import.meta.url), 'utf8'));
    const after = (await db.query('select * from scout.trackers order by id')).rows;
    assert.deepEqual(after.map(({enabled,...row})=>row), before.map(({enabled,...row})=>row));
    assert.deepEqual(after.filter(row=>row.enabled).map(row=>row.url).sort(), [
      'https://bsky.app/profile/highseasalliance.bsky.social',
      'https://bsky.app/profile/deepstewardship.bsky.social',
      'https://bsky.app/profile/globalfishingwatch.org',
      'https://bsky.app/profile/iddri.bsky.social',
      'https://www.hubocean.earth/events-calendar',
    ].sort());
    for (const table of Object.keys(preserved)) assert.deepEqual((await db.query(`select * from scout.${table} order by id`)).rows,preserved[table]);
    assert.deepEqual((await db.query(sharedState)).rows, otherService);
    await db.exec(trackerSeed);
    assert.deepEqual((await db.query('select * from scout.trackers order by id')).rows,after);
    assert.equal((await db.query("insert into scout.trackers(name,url,collector,cadence) values('New','https://example.org','web','1 day') returning enabled")).rows[0].enabled,false);
  } finally { await db.close(); }
});

test('proof guard preserves data, invalidates source edits and reserves promotion for the backend', async () => {
  const db = new PGlite();
  try {
    await db.exec(auth + fixture + beforeSchema + schemaMigration + fiveTablesMigration);
    for (const name of ['20261001190000_assessment_and_communication.sql','20261002130000_scout_proven_collectors.sql']) {
      await db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
    }
    await db.exec(trackerSeed);
    const before=(await db.query('select * from scout.trackers order by id')).rows;
    const shared=(await db.query(sharedState)).rows, users=(await db.query('select * from auth.users order by id')).rows;
    await db.exec(await readFile(new URL('../supabase/migrations/20261002150000_scout_collector_proof_guard.sql', import.meta.url), 'utf8'));
    assert.deepEqual((await db.query('select * from scout.trackers order by id')).rows,before);
    assert.deepEqual((await db.query(sharedState)).rows,shared);
    assert.deepEqual((await db.query('select * from auth.users order by id')).rows,users);
    const tracker=before.find(row=>row.seed_key.endsWith(':17'));
    await db.query("update auth.users set raw_app_meta_data='{\"scout\":{\"admin\":true}}' where id=$1",[admin]);
    await db.exec('set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[admin]);
    assert.equal((await db.query('select scout.access_role() role')).rows[0].role,'admin');
    await db.query('update scout.trackers set cadence=$1,url=$2,collector=$3 where id=$4',['2 days',tracker.url,tracker.collector,tracker.id]);
    assert.equal((await db.query('select enabled from scout.trackers where id=$1',[tracker.id])).rows[0].enabled,true);
    for (const enabled of [true,false]) {
      await assert.rejects(db.query('update scout.trackers set enabled=$1 where id=$2',[enabled,tracker.id]),{code:'42501'});
      await assert.rejects(db.query("insert into scout.trackers(name,url,collector,cadence,enabled) values('Self-promote','https://example.org','web','1 day',$1)",[enabled]),{code:'42501'});
    }
    const inserted=(await db.query("insert into scout.trackers(name,url,collector,cadence) values('Unproven','https://example.org','web','1 day') returning *")).rows[0];
    assert.equal(inserted.enabled,false);
    await db.query("update scout.trackers set url='https://bsky.app/profile/changed.org' where id=$1",[tracker.id]);
    assert.equal((await db.query('select enabled from scout.trackers where id=$1',[tracker.id])).rows[0].enabled,false);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[reader]);
    assert.equal((await db.query('select scout.access_role() role')).rows[0].role,'reader');
    assert.equal((await db.query("update scout.trackers set cadence='3 days' where id=$1 returning id",[tracker.id])).rows.length,0);
    await assert.rejects(db.query('update scout.trackers set enabled=true where id=$1',[tracker.id]),{code:'42501'});
    await assert.rejects(db.query("insert into scout.trackers(name,url,collector,cadence) values('Reader','https://reader.org','web','1 day')"),{code:'42501'});
    await db.exec('reset role; set role service_role');
    await db.query('update scout.trackers set enabled=true where id=$1',[tracker.id]);
    assert.equal((await db.query('select enabled from scout.trackers where id=$1',[tracker.id])).rows[0].enabled,true);
    for(const edit of ["url='https://bsky.app/profile/another.org'","collector='web'","url=null"]) {
      await db.query(`update scout.trackers set ${edit},enabled=true where id=$1`,[tracker.id]);
      assert.equal((await db.query('select enabled from scout.trackers where id=$1',[tracker.id])).rows[0].enabled,false);
    }
    await db.exec('reset role');
    assert.deepEqual((await db.query(sharedState)).rows,shared);
  } finally { await db.close(); }
});

test('all tracker seeds are uncollected and repeat safely after app edits', async () => {
  const db = new PGlite();
  try {
    await db.exec(auth + fixture);
    const beforeOtherService = (await db.query(sharedState)).rows;
    await db.exec(beforeSchema + schemaMigration);
    await db.exec(trackerSeed);
    const initial = (await db.query('select * from scout.trackers order by seed_key')).rows;
    assert.equal(initial.length, 32);
    assert.deepEqual(new Set(initial.filter(row=>row.seed_key.startsWith('bbnj-trackers-2026-10-01:')).map(row => row.seed_key)), new Set(Array.from({ length: 22 }, (_, i) => `bbnj-trackers-2026-10-01:${i}`)));
    assert.equal(initial.filter(row=>row.seed_key.startsWith('bbnj-trackers-2026-10-08:')&&!row.enabled).length,10);
    for (const row of (await db.query('select * from scout.tracker_status')).rows) {
      for (const key of ['last_attempt_at', 'last_success_at', 'last_outcome', 'last_error']) assert.equal(row[key], null);
    }
    const website = initial.find(row => row.seed_key.endsWith(':0'));
    const feed = initial.find(row => row.seed_key.endsWith(':17'));
    const discovery = initial.find(row => row.seed_key.endsWith(':21'));
    assert.equal(website.collector, 'web');
    assert.equal(website.cadence, '7 days');
    assert.equal(feed.url, 'https://bsky.app/profile/highseasalliance.bsky.social');
    assert.equal(feed.collector, 'bluesky_feed');
    assert.equal(feed.cadence, '1 day');
    assert.equal(discovery.collector, 'bluesky_search');
    assert.match(discovery.coverage, /traité sur la haute mer/);
    assert.equal(initial.filter(row => row.collector === 'web').length, 27);
    assert.equal(initial.filter(row => row.collector === feed.collector).length, 4);
    assert.deepEqual(initial.filter(row => row.enabled).map(row => row.seed_key),
      [17, 18, 19, 20].map(id => `bbnj-trackers-2026-10-01:${id}`));
    const incomplete = initial.find(row => row.seed_key.endsWith(':8'));
    assert.equal(incomplete.url, null);
    assert.equal(incomplete.enabled, false);
    await db.query("update auth.users set raw_app_meta_data='{\"scout\":{\"admin\":true}}' where id=$1", [admin]);
    await db.exec('set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [admin]);
    await db.query(`update scout.trackers set name = 'Edited source', url = 'https://example.org/edited',
      collector = 'Edited collector', coverage = 'Edited coverage', cadence = '2 days', enabled = false
      where id = $1`, [feed.id]);
    await assert.rejects(db.query("update scout.trackers set seed_key = 'edited' where id = $1", [feed.id]), { code: '42501' });
    await assert.rejects(db.query('update scout.trackers set enabled = true where id = $1', [incomplete.id]), { code: '23514' });
    await db.exec('reset role');
    await db.query("insert into scout.collection_runs(tracker_id,finished_at,outcome) values ($1,now(),'no_change')", [feed.id]);
    const edited = (await db.query('select * from scout.trackers order by seed_key')).rows;
    await db.exec(trackerSeed);
    await db.exec(trackerSeed);
    assert.deepEqual((await db.query('select * from scout.trackers order by seed_key')).rows, edited);
    assert.deepEqual((await db.query(sharedState)).rows, beforeOtherService);
  } finally {
    await db.close();
  }
});
