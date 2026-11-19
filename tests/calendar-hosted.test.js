import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {hostedCalendar} from '../calendar/hosted.js';

const user='11111111-1111-4111-8111-111111111111',token='a'.repeat(64);
const profile={sub:'google-owner',email:'danny@oceanagentics.com',email_verified:true};
const identity={...profile,iss:'https://accounts.google.com',custom_claims:{hd:'oceanagentics.com'}};
const record={id:'89a76621-0fac-447f-9429-62e1e8f985d1',modified:['2026-10-12T10:00:00Z'],type:'event',priority:'high',
  description:'Test fixture',organizations:[],sources:[{url:'https://example.org/event',role:'finding'}],date:'2026-11-17',starttime:'03:00',timezone:'+00:00'};

test('reconciliation requires the backend secret before reading credentials or findings',async()=>{
  const key='sb_secret_calendar_test',env={url:'https://example.supabase.co',secretKeys:{default:key},
    publishableKeys:{default:'sb_publishable_test'},jwks:null};let connects=0;
  for(const apikey of ['',env.publishableKeys.default,'invalid']){
    const response=await hostedCalendar(new Request('https://example.org/scout-calendar/reconcile',{method:'POST',headers:{apikey}}),
      {env,databaseURL:'test',connect:()=>{connects++;}});
    assert.equal(response.status,401);
  }
  assert.equal(connects,0);
  const response=await hostedCalendar(new Request('https://example.org/scout-calendar/reconcile',{method:'POST',headers:{apikey:key}}),
    {env,databaseURL:'test',connect:()=>({reserve:async()=>({unsafe:async()=>{connects++;return [];},release(){}}),end:async()=>{}})});
  assert.equal(response.status,502);assert.equal(connects,1);
  assert.equal((await response.json()).error,'Google Calendar OAuth credential is unavailable.');
});

test('hosted calendar with real SQL: subscription survives removal of personal-calendar sync',async()=>{
  const db=new PGlite(),queries=[];let signedIn=true;
  // Vault here is a test double for SQL contracts, not a test of production encryption.
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema scout;create schema auth;create schema vault;
    create table auth.identities(user_id uuid,provider text,provider_id text,identity_data jsonb);
    create table scout.records(id uuid,modified timestamptz[],type text,priority text,description text,organizations text[],sources jsonb,date text,starttime text,timezone text,enddate text,endtime text);
    create table vault.secrets(id uuid default gen_random_uuid(),name text unique,secret text);
    create view vault.decrypted_secrets as select name,secret as decrypted_secret from vault.secrets;
    create function vault.create_secret(value text,label text) returns uuid language sql as $$ insert into vault.secrets(name,secret) values(label,value) returning id $$;
    create function vault.update_secret(key uuid,value text) returns void language sql as $$ update vault.secrets set secret=value where id=key $$;`);
  await db.exec(await readFile(new URL('../supabase/migrations/20261012220000_scout_calendar.sql',import.meta.url),'utf8'));
  await db.query('insert into auth.identities values($1,$2,$3,$4)',[user,'google',profile.sub,identity]);
  await db.query('insert into scout.records(id,modified,type,priority,description,organizations,sources,date,starttime,timezone) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',Object.values(record));
  const config={databaseURL:'test',authenticate:async()=>signedIn?{data:{userClaims:{id:user}}}:{error:new Error('Invalid JWT')},
    connect:()=>({reserve:async()=>({unsafe:async(sql,params)=>{
      queries.push(sql);const result=await db.query(sql,params);return Object.assign(result.rows,{count:result.affectedRows});
    },release(){}}),end:async()=>{}})};
  const request=(action,body,headers={})=>new Request('https://example.org/scout-calendar/'+action,{
    method:action.split('?')[0]==='feed.ics'?'GET':'POST',headers,
    ...(body?{body:JSON.stringify(body)}:{})});
  const run=(action,body,headers)=>hostedCalendar(request(action,body,headers),config);
  try{
    for(const action of ['status','connect','sync'])assert.equal((await run(action)).status,404);
    signedIn=false;assert.equal((await run('feed-link')).status,401);assert.equal(queries.length,0);signedIn=true;
    await db.query("update scout.calendar_trial set remaining=0,expires_at='2000-01-01T00:00:00Z'");
    await db.query('select scout.save_calendar_secret($1,$2)',['scout_calendar_feed',token]);
    await db.query('select scout.save_calendar_secret($1,$2)',['scout_calendar_google','old authorization']);
    await db.query('insert into vault.secrets(name,secret) values($1,$2)',['unrelated','keep']);
    await db.exec(await readFile(new URL('../supabase/migrations/20261102210000_scout_subscription_calendar.sql',import.meta.url),'utf8'));
    assert.deepEqual((await db.query('select name,secret from vault.secrets order by name')).rows,
      [{name:'scout_calendar_feed',secret:token},{name:'unrelated',secret:'keep'}]);
    await assert.rejects(db.query('select scout.save_calendar_secret($1,$2)',['scout_calendar_google','new authorization']),/Invalid calendar secret/);
    await db.query('select scout.save_calendar_secret($1,$2)',['scout_calendar_feed','b'.repeat(64)]);
    assert.equal((await db.query("select secret from vault.secrets where name='scout_calendar_feed'")).rows[0].secret,token);
    await assert.rejects(db.query('select scout.save_calendar_secret($1,$2)',[null,'bad']),/Invalid calendar secret/);
    await db.exec('set role authenticated');
    await assert.rejects(db.query('select * from scout.calendar_trial'),/permission denied/);
    await assert.rejects(db.query('select scout.save_calendar_secret($1,$2)',['scout_calendar_feed',token]),/permission denied/);
    await db.exec('reset role');

    queries.length=0;
    assert.equal((await run('feed.ics?token='+'b'.repeat(64))).status,404);assert.equal(queries.length,1);
    queries.length=0;
    const feed=await run('feed.ics?token='+token);assert.equal(feed.status,200);
    const initialBody=await feed.text();assert.match(initialBody,/SUMMARY:⭐ 🐧 Test fixture/);
    assert.ok(initialBody.includes('SEQUENCE:'+(Math.floor(Date.parse(record.modified[0])/1000)+3)));
    assert.match(initialBody,/DTSTART:20261117T030000Z/);assert.doesNotMatch(initialBody,/DTSTART;VALUE=DATE|DTEND|DURATION/);
    assert.match(initialBody,/UID:89a76621-0fac-447f-9429-62e1e8f985d1@scout.oceanagentics.com/);
    assert.equal(queries.length,2);assert.equal(queries.filter(sql=>sql.startsWith('update')).length,0);
    assert.equal((await run('feed.ics?token='+token,null,{'if-none-match':feed.headers.get('etag')})).status,304);
    await db.exec("update scout.records set enddate='2026-11-17',endtime='04:15'");
    const withEnd=await (await run('feed.ics?token='+token)).text();
    assert.match(withEnd,/DTSTART:20261117T030000Z\r\nDTEND:20261117T041500Z/);
    for(const priority of ['normal','low',null]){
      await db.query('update scout.records set priority=$1',[priority]);
      const filtered=await run('feed.ics?token='+token,null,{'if-none-match':feed.headers.get('etag')});
      assert.equal(filtered.status,200);assert.doesNotMatch(await filtered.text(),/BEGIN:VEVENT/);
    }
    await db.query("update scout.records set priority='high'");
    const subscription=await (await run('feed-link')).json();assert.ok(subscription.url.endsWith('?token='+token));
    assert.equal(subscription.expires_at,undefined);

    await db.query('update auth.identities set identity_data=$1',[{...identity,email:'teammate@oceanagentics.com'}]);
    const teammate=await run('feed-link');
    assert.equal(teammate.status,200);
    assert.deepEqual(await teammate.json(),subscription);
    for(const claims of [{...identity,email_verified:false},{...identity,custom_claims:{hd:'example.com'}}]){
      await db.query('update auth.identities set identity_data=$1',[claims]);
      assert.equal((await run('feed-link')).status,403);
    }
    assert.equal((await run('feed.ics?token='+token)).status,200);
    assert.equal(queries.some(sql=>sql.includes('calendar_trial')),false);
    assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,1);

    await db.exec(`insert into scout.records(id,modified,type,priority,description,organizations,sources,date,starttime,timezone)
      select gen_random_uuid(),array['2026-11-02T10:00:00Z']::timestamptz[],'event','high','Calendar event '||n||repeat('a',2000),
        '{}','[]','2026-11-05',null,null from generate_series(1,284) n`);
    queries.length=0;
    const expanded=await run('feed.ics?token='+token);
    assert.equal(expanded.status,200);
    const body=await expanded.text();
    assert.ok(Buffer.byteLength(body)>524288);
    assert.equal((body.match(/BEGIN:VEVENT/g)??[]).length,285);
    assert.match(body,/SUMMARY:⭐ 🐧 Calendar event 284/);
    assert.equal(queries.length,2);
  }finally{await db.close();}
});
