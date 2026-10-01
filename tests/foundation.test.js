import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile(new URL('../supabase/migrations/20261001050000_scout_foundation.sql', import.meta.url), 'utf8');
const trackerMigration = await readFile(new URL('../supabase/migrations/20261001060000_scout_tracker_import.sql', import.meta.url), 'utf8');
const trackerSeed = await readFile(new URL('../supabase/seeds/trackers.sql', import.meta.url), 'utf8');
const collectionMigration = await readFile(new URL('../supabase/migrations/20261001070000_scout_collection.sql', import.meta.url), 'utf8');
const evidenceMigration = await readFile(new URL('../supabase/migrations/20261001080000_scout_event_evidence.sql', import.meta.url), 'utf8');
const workspaceMigration = await readFile(new URL('../supabase/migrations/20261001140000_scout_workspace_access.sql', import.meta.url), 'utf8');
const historyMigration = await readFile(new URL('../supabase/migrations/20261001150000_scout_record_change_fields.sql', import.meta.url), 'utf8');
const leanMigration = await readFile(new URL('../supabase/migrations/20261001160000_scout_lean_records.sql', import.meta.url), 'utf8');
const reader = '00000000-0000-0000-0000-000000000001';
const admin = '00000000-0000-0000-0000-000000000002';
const outsider = '00000000-0000-0000-0000-000000000003';

// Minimal Supabase Auth fixtures; these tests exercise PostgreSQL RLS, not GoTrue/PostgREST.
const auth = `
  create role anon;
  create role authenticated;
  create role service_role bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key, raw_user_meta_data jsonb default '{}');
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
    await db.exec(auth + fixture + migration + trackerMigration + collectionMigration + evidenceMigration + workspaceMigration + trackerSeed);
    const shared = (await db.query(sharedState)).rows;
    await db.exec("insert into scout.records (kind,title) values ('announcement','Private fixture')");
    await db.query('update auth.users set raw_user_meta_data=$1 where id=$2', [JSON.stringify(proof), outsider]);
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
    assert.equal((await db.query('select * from scout.memberships')).rows.length, 0);
    assert.equal((await db.query('select * from scout.records')).rows.length, 1);
    assert.equal((await db.query('select * from scout.trackers')).rows.length, 22);
    assert.equal((await db.query('update scout.trackers set enabled=false returning id')).rows.length, 0);
    await assert.rejects(db.query("insert into scout.memberships values ($1,'admin',now())", [outsider]), { code: '42501' });
    for (const table of ['records','sources','record_changes','collection_runs','deliveries','source_versions']) {
      await assert.rejects(db.query(`delete from scout.${table}`), { code: '42501' });
    }
    await db.exec('reset role');
    assert.deepEqual((await db.query(sharedState)).rows, shared);
    await db.query("insert into scout.memberships (user_id,role) values ($1,'admin')", [outsider]);
    await db.query('delete from auth.identities where user_id=$1', [outsider]);
    await db.exec('set role authenticated');
    assert.equal((await db.query('select scout.access_role() as role')).rows[0].role, null);
    assert.equal((await db.query('select * from scout.memberships')).rows.length, 0);
    assert.equal((await db.query('update scout.trackers set enabled=false returning id')).rows.length, 0);
    await db.exec('reset role; set role anon');
    await assert.rejects(db.query('select scout.access_role()'), { code: '42501' });
  } finally { await db.close(); }
});

test('all tracker seeds are uncollected and repeat safely after app edits', async () => {
  const db = new PGlite();
  try {
    await db.exec(auth + fixture);
    const beforeOtherService = (await db.query(sharedState)).rows;
    await db.exec(migration);
    await db.exec(trackerMigration);
    await db.exec(trackerSeed);
    const initial = (await db.query('select * from scout.trackers order by seed_key')).rows;
    assert.equal(initial.length, 22);
    assert.deepEqual(new Set(initial.map(row => row.seed_key)), new Set(Array.from({ length: 22 }, (_, i) => `bbnj-trackers-2026-10-01:${i}`)));
    for (const row of initial) {
      for (const key of ['last_attempt_at', 'last_success_at', 'last_outcome', 'last_error', 'next_run_at']) assert.equal(row[key], null);
    }
    const website = initial.find(row => row.seed_key.endsWith(':0'));
    const feed = initial.find(row => row.seed_key.endsWith(':17'));
    const discovery = initial.find(row => row.seed_key.endsWith(':21'));
    assert.equal(website.channel, 'Website');
    assert.equal(website.method, 'Web retrieval + extraction');
    assert.equal(website.cadence, '7 days');
    assert.equal(feed.url, 'https://bsky.app/profile/highseasalliance.bsky.social');
    assert.equal(feed.method, 'Bluesky API: getAuthorFeed');
    assert.equal(feed.cadence, '1 day');
    assert.equal(discovery.method, 'Bluesky API: searchPosts; separate keyword queries');
    assert.equal(discovery.cadence_note, 'Weekly; daily during major BBNJ meetings');
    assert.match(discovery.coverage, /traité sur la haute mer/);
    assert.equal(initial.filter(row => row.channel === 'Website').length, 17);
    assert.equal(initial.filter(row => row.method === feed.method).length, 4);
    assert.equal(initial.filter(row => row.cadence_note.includes('; daily')).length, 5);
    const incomplete = initial.find(row => row.seed_key.endsWith(':8'));
    assert.equal(incomplete.url, null);
    assert.equal(incomplete.enabled, false);
    assert.equal(incomplete.configuration_note, 'Set per conference');
    await db.query("insert into scout.memberships (user_id,role) values ($1,'admin')", [admin]);
    await db.exec('set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [admin]);
    await db.query(`update scout.trackers set name = 'Edited source', url = 'https://example.org/edited',
      method = 'Edited method', coverage = 'Edited coverage', cadence = '2 days', cadence_note = 'Every other day', enabled = false
      where id = $1`, [feed.id]);
    await assert.rejects(db.query("update scout.trackers set seed_key = 'edited' where id = $1", [feed.id]), { code: '42501' });
    await assert.rejects(db.query('update scout.trackers set enabled = true where id = $1', [incomplete.id]), { code: '23514' });
    await db.exec('reset role');
    await db.query("update scout.trackers set last_attempt_at = now(), last_success_at = now(), last_outcome = 'no_change', next_run_at = now() + interval '2 days' where id = $1", [feed.id]);
    const edited = (await db.query('select * from scout.trackers order by seed_key')).rows;
    await db.exec(trackerSeed);
    await db.exec(trackerSeed);
    assert.deepEqual((await db.query('select * from scout.trackers order by seed_key')).rows, edited);
    assert.deepEqual((await db.query(sharedState)).rows, beforeOtherService);
  } finally {
    await db.close();
  }
});
