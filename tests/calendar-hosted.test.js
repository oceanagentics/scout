import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {hostedCalendar} from '../calendar/hosted.js';

const user='11111111-1111-4111-8111-111111111111',token='a'.repeat(64);
const profile={sub:'google-owner',email:'danny@oceanagentics.com',email_verified:true};
const identity={...profile,iss:'https://accounts.google.com',custom_claims:{hd:'oceanagentics.com'}};
const record={id:'89a76621-0fac-447f-9429-62e1e8f985d1',version:1,updated_at:'2026-10-12T10:00:00Z',kind:'event',
  title:'Calendar test',description:'Test fixture',organizations:[],canonical_url:'https://example.org/event',
  details:{start:{value:'2001-10-22',precision:'day'}}};

test('hosted calendar with real SQL: access boundaries, expired trial does not block feed or sync',async()=>{
  const db=new PGlite(),queries=[];let signedIn=true,googleEvents=[],googleProfile=profile,calendarFailure;
  // Vault here is a test double for SQL contracts, not a test of production encryption.
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema scout;create schema auth;create schema vault;
    create table auth.identities(user_id uuid,provider text,provider_id text,identity_data jsonb);
    create table scout.records(id uuid,version int,updated_at timestamptz,kind text,title text,description text,organizations jsonb,details jsonb,canonical_url text);
    create table vault.secrets(id uuid default gen_random_uuid(),name text unique,secret text);
    create view vault.decrypted_secrets as select name,secret as decrypted_secret from vault.secrets;
    create function vault.create_secret(value text,label text) returns uuid language sql as $$ insert into vault.secrets(name,secret) values(label,value) returning id $$;
    create function vault.update_secret(key uuid,value text) returns void language sql as $$ update vault.secrets set secret=value where id=key $$;`);
  await db.exec(await readFile(new URL('../supabase/migrations/20261012220000_scout_calendar.sql',import.meta.url),'utf8'));
  await db.query('insert into auth.identities values($1,$2,$3,$4)',[user,'google',profile.sub,identity]);
  await db.query('insert into scout.records(id,version,updated_at,kind,title,description,organizations,canonical_url,details) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',Object.values(record));
  const config={databaseURL:'test',authenticate:async()=>signedIn?{data:{userClaims:{id:user}}}:{error:new Error('Invalid JWT')},
    connect:()=>({reserve:async()=>({unsafe:async(sql,params)=>{
      queries.push(sql);const result=await db.query(sql,params);return Object.assign(result.rows,{count:result.affectedRows});
    },release(){}}),end:async()=>{}}),
    send:async(url,options)=>{
      if(url.includes('/userinfo'))return Response.json(googleProfile);
      assert.ok(url.startsWith('https://www.googleapis.com/calendar/v3/calendars/danny%40oceanagentics.com/events'));
      if(calendarFailure)return Response.json(calendarFailure.body,{status:calendarFailure.status});
      if(options.method==='POST'){const saved={...JSON.parse(options.body),etag:'"1"'};googleEvents.push(saved);return Response.json(saved);}
      return Response.json({items:googleEvents});
    }};
  const request=(action,body,headers={})=>new Request('https://example.org/scout-calendar/'+action,{
    method:['status','feed.ics'].includes(action.split('?')[0])?'GET':'POST',headers,
    ...(body?{body:JSON.stringify(body)}:{})});
  const run=(action,body,headers)=>hostedCalendar(request(action,body,headers),config);
  try{
    signedIn=false;assert.equal((await run('status')).status,401);assert.equal(queries.length,0);signedIn=true;
    await db.query("update scout.calendar_trial set remaining=0,expires_at='2000-01-01T00:00:00Z'");
    assert.deepEqual(await (await run('status')).json(),{manager:true,connected:false,backend_ready:false,calendar_id:profile.email});
    await db.query('select scout.save_calendar_secret($1,$2)',['scout_calendar_feed',token]);
    await assert.rejects(db.query('select scout.save_calendar_secret($1,$2)',[null,'bad']),/Invalid calendar secret/);
    await db.exec('set role authenticated');
    await assert.rejects(db.query('select * from scout.calendar_trial'),/permission denied/);
    await db.exec('reset role');

    queries.length=0;
    assert.equal((await run('feed.ics?token='+'b'.repeat(64))).status,404);assert.equal(queries.length,1);
    queries.length=0;
    const feed=await run('feed.ics?token='+token);assert.equal(feed.status,200);assert.match(await feed.text(),/SUMMARY:\[Scout\] Calendar test/);
    assert.equal(queries.length,2);assert.equal(queries.filter(sql=>sql.startsWith('update')).length,0);
    assert.equal((await run('feed.ics?token='+token,null,{'if-none-match':feed.headers.get('etag')})).status,304);
    const subscription=await (await run('feed-link')).json();assert.ok(subscription.url.endsWith('?token='+token));
    assert.equal(subscription.expires_at,undefined);

    googleProfile={...profile,sub:'someone-else'};
    assert.equal((await run('connect',{access_token:'test',refresh_token:'refresh'})).status,403);
    assert.equal((await db.query("select count(*)::int n from vault.secrets where name='scout_calendar_google'")).rows[0].n,0);
    googleProfile=profile;
    for(const [reason,status,message] of [
      ['accessNotConfigured',503,/administrator must enable/],['SERVICE_DISABLED',503,/Reconnecting will not fix/],
      ['ACCESS_TOKEN_SCOPE_INSUFFICIENT',403,/permission was not granted/],['userRateLimitExceeded',429,/request limit/],
    ]){
      calendarFailure={status:403,body:{error:{message:'Private provider details',details:[{reason}]}}};
      const failed=await run('connect',{access_token:'test',refresh_token:'refresh'}),detail=await failed.json();
      assert.equal(failed.status,status);assert.match(detail.error,message);assert.doesNotMatch(detail.error,/Private provider/);
      if(status===503)assert.equal(detail.code,'calendar_api_disabled');
      assert.equal((await db.query("select count(*)::int n from vault.secrets where name='scout_calendar_google'")).rows[0].n,0);
    }
    calendarFailure=null;
    assert.equal((await run('connect',{access_token:'test'})).status,200,'Foreground sync works without a refresh token');
    assert.equal((await db.query("select count(*)::int n from vault.secrets where name='scout_calendar_google'")).rows[0].n,0);
    assert.equal((await run('connect',{access_token:'test',refresh_token:'refresh'})).status,200);
    const synced=await run('sync',{access_token:'test'});assert.equal(synced.status,200);
    const first=await synced.json();assert.equal(first.created,1);assert.deepEqual(first.cost,{sql_statements:2,row_mutations:0,google_calendar_requests:2,google_calendar_writes:1});
    assert.equal(googleEvents[0].start.date,'2001-10-22');
    const repeat=await (await run('sync',{access_token:'test'})).json();assert.equal(repeat.unchanged,1);
    assert.deepEqual(repeat.cost,{sql_statements:2,row_mutations:0,google_calendar_requests:1,google_calendar_writes:0});
    assert.equal(googleEvents.length,1);

    await db.query('update auth.identities set identity_data=$1',[{...identity,email:'teammate@oceanagentics.com'}]);
    assert.deepEqual(await (await run('status')).json(),{manager:false});
    assert.equal((await run('feed-link')).status,403);
    await db.query('update auth.identities set identity_data=$1',[{...identity,email_verified:false}]);
    assert.equal((await run('status')).status,403);
    assert.equal((await run('feed.ics?token='+token)).status,200);
    assert.equal(queries.some(sql=>sql.includes('calendar_trial')),false);
    assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,1);
  }finally{await db.close();}
});
