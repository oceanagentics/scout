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
    const record = (await db.query("insert into scout.records(type,description) values('announcement','Private finding') returning id")).rows[0].id;
    await db.query("update scout.records set sources=$2 where id=$1", [record,['https://example.org/source']]);
    const publicReads = ['scout.records','scout.findings()'];
    const privateTables = ['delivery_state'];
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
      await assert.rejects(db.query("insert into scout.records(type,description) values('announcement','Forged')"), { code: '42501' });
      await assert.rejects(db.query("update scout.records set description='Forged'"), { code: '42501' });
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
    assert.deepEqual(finding.sources, ['https://example.org/source']);
    await db.query("update scout.trackers set url='https://example.org/edited' where id=$1", [tracker]);
    assert.equal((await db.query('select enabled from scout.trackers where id=$1', [tracker])).rows[0].enabled, false);
    const inserted = (await db.query("insert into scout.trackers(name,url,collector,cadence) values('Unproven','https://example.org/new','web','1 day') returning enabled")).rows[0];
    assert.equal(inserted.enabled, false);
    await db.exec('reset role; set role service_role');
    await db.query('update scout.trackers set enabled=true where id=$1', [tracker]);
    assert.equal((await db.query('select enabled from scout.trackers where id=$1', [tracker])).rows[0].enabled, true);
    for (const edit of ["url=null"]) {
      await db.query('update scout.trackers set ' + edit + ',enabled=true where id=$1', [tracker]);
      assert.equal((await db.query('select enabled from scout.trackers where id=$1', [tracker])).rows[0].enabled, false);
    }
    for (const table of privateTables) {
      await db.query('select * from scout.' + table);
      for (const privilege of ['INSERT','UPDATE','DELETE']) assert.equal((await db.query("select has_table_privilege('service_role',$1,$2) allowed", ['scout.' + table,privilege])).rows[0].allowed, true);
    }
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
    await db.exec("insert into scout.records(type,description) values('announcement','Private finding')");
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
    assert.ok((await db.query('select last_checked_at from scout.trackers')).rows.every(r=>r.last_checked_at===null));
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

test('description migration preserves findings, corrections, sources and accounting without a title column', async () => {
  const db=new PGlite();
  try {
    await db.exec(auth);
    for(const [name,sql] of migrations) {
      if(name==='20261019190000_scout_description_only.sql')break;
      await db.exec(sql);
    }
    await db.exec(`insert into scout.records(kind,title,description,sources,overrides,provenance) values
      ('announcement','Different title','Preserved description','[{"url":"https://example.org/a"}]','{"description":{"url":"https://example.org/a"}}','{"description":["https://example.org/a"]}'),
      ('event',repeat('Legacy text ',30),null,'[{"url":"https://example.org/b"}]','{}','{"title":["https://example.org/b"]}'),
      ('event','Empty fallback','  ','[]','{}','{}');
      insert into scout.delivery_state(record_id,version,status) select id,version,'sent' from scout.records;`);
    const before=(await db.query('select * from scout.records order by id')).rows;
    const accounting=(await db.query('select * from scout.quota_policy')).rows;
    const deliveries=(await db.query('select * from scout.delivery_state order by record_id')).rows;
    await db.exec(migrations.find(([name])=>name==='20261019190000_scout_description_only.sql')[1]);
    const after=(await db.query('select * from scout.records order by id')).rows;
    for(let i=0;i<before.length;i++){
      const {title,...expected}=before[i];
      if(!expected.description?.trim())expected.description=title;
      delete expected.provenance.title;
      assert.deepEqual(after[i],expected);
    }
    assert.deepEqual((await db.query('select * from scout.quota_policy')).rows,accounting);
    assert.deepEqual((await db.query('select * from scout.delivery_state order by record_id')).rows,deliveries);
    await db.exec('set role service_role');
    const found=(await db.query("select * from scout.findings(p_search=>'Preserved')")).rows;
    assert.equal(found.length,1);assert.equal(Object.hasOwn(found[0],'title'),false);
    await db.query("update scout.records set description='Updated description' where id=$1",[found[0].id]);
    assert.equal((await db.query("select * from scout.findings(p_search=>'Updated')")).rows.length,1);
    await db.exec("insert into scout.records(kind,description) values('announcement','New finding')");
  }finally{await db.close();}
});

test('flat migration preserves IDs, scalar facts, URL arrays, known timestamps and delivery outcomes',async()=>{
  const db=new PGlite(),name='20261021180000_scout_flat_records.sql';
  try{
    await db.exec(auth);
    await db.exec("set timezone='UTC'");
    for(const [file,sql] of migrations){if(file===name)break;await db.exec(sql);}
    await db.exec(`insert into scout.records(id,kind,description,organizations,details,canonical_url,sources,version,accepted_version,discovered_at,updated_at) values
      ('11111111-1111-4111-8111-111111111111','event','Workshop','[{"name":"Z Institute"},{"name":"A Partner"},{"name":"Z Institute"}]',
      '{"start":{"value":"2026-11-10","precision":"day","time":"14:00","zone":"UTC","utc":"2026-11-10T14:00:00Z"},"response_due":{"value":"2026-11","precision":"month"},"end":{"value":"2026-11-11","precision":"day"},"registration_url":"https://example.org/register"}',
      'https://example.org/event','[{"url":"https://example.org/event"},{"url":"https://example.org/other"}]',4,4,'2026-10-01T10:00:00.123456Z','2026-10-20T12:00:00.654321Z'),
      ('22222222-2222-4222-8222-222222222222','announcement','Brief','[]','{"published":{"value":"2026-03","precision":"month"}}',null,'[]',1,null,'2026-10-01','2026-10-01'),
      ('33333333-3333-4333-8333-333333333333','treaty_status','Ratification','[]','{"action_date":{"value":"2026","precision":"year"}}',null,'[]',1,null,'2026-10-01','2026-10-01');
      insert into scout.delivery_state(record_id,version,status,at) values
      ('11111111-1111-4111-8111-111111111111',4,'sent','2026-10-20T13:00:00Z'),
      ('22222222-2222-4222-8222-222222222222',1,'unknown','2026-10-20T13:00:00Z');`);
    const delivery=(await db.query('select record_id,status,at from scout.delivery_state order by record_id')).rows;
    await db.exec(migrations.find(([file])=>file===name)[1]);
    const rows=(await db.query('select * from scout.records order by id')).rows;
    assert.deepEqual(Object.keys(rows[0]),['id','description','type','priority','organizations','deadline','date','starttime','timezone','sources','modified']);
    assert.equal(rows.length,3);assert.equal(rows[0].type,'event');assert.equal(rows[0].date,'2026-11-10');
    assert.equal(rows[0].deadline,'2026-11');assert.equal(rows[0].starttime,'14:00');assert.equal(rows[0].timezone,'UTC');
    assert.deepEqual(rows[0].organizations,['Z Institute','A Partner']);
    assert.deepEqual(rows[0].sources,['https://example.org/event','https://example.org/other','https://example.org/register']);
    const stamps=(await db.query('select modified::text[] from scout.records order by id')).rows;
    assert.deepEqual(stamps[0].modified,['2026-10-01 10:00:00.123456+00','2026-10-20 12:00:00.654321+00']);
    assert.equal(stamps[1].modified.length,1);assert.equal(rows[1].date,'2026-03');assert.equal(rows[2].date,'2026');
    assert.deepEqual((await db.query('select record_id,status,at from scout.delivery_state order by record_id')).rows,delivery);
    assert.equal((await db.query('select modified_at::text from scout.delivery_state order by record_id')).rows[0].modified_at,stamps[0].modified[1]);
    await db.exec('set role service_role');
    assert.equal((await db.query("select * from scout.findings(p_type=>'event',p_meaning=>'deadline',p_from=>'2026-11-15',p_to=>'2026-11-15')")).rows[0].id,rows[0].id);
    assert.equal((await db.query("select * from scout.findings(p_organization=>'Z Institute')")).rows.length,1);
    assert.equal((await db.query("select * from scout.findings(p_search=>'Partner')")).rows.length,1);
    const page=(await db.query("select * from scout.findings(p_order=>'date',p_limit=>1)")).rows;
    assert.equal(page[0].type,'treaty_status');
    const next=(await db.query("select * from scout.findings(p_order=>'date',p_after=>$1,p_limit=>1)",[{rank:0,day:'2026-01-01',id:page[0].id}])).rows;
    assert.equal(next[0].type,'announcement');
  }finally{await db.close();}
});
