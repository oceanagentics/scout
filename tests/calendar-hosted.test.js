import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {hostedCalendar} from '../calendar/hosted.js';
import {googleEvent} from '../calendar/google.js';

const record={id:'89a76621-0fac-447f-9429-62e1e8f985d1',modified:['2026-10-12T10:00:00Z'],type:'event',score:85,
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

test('removed feed routes and invalid reconciliation requests never open a database',async()=>{
  let connects=0,authentications=0;
  const config={databaseURL:'test',connect:()=>{connects++;},authenticate:async()=>{authentications++;return {data:{}};}};
  for(const action of ['feed-link','feed.ics?token='+'a'.repeat(64)]){
    for(const method of ['GET','POST','OPTIONS']){
      const response=await hostedCalendar(new Request('https://example.org/scout-calendar/'+action,{
        method,headers:{origin:'https://bbnj-scout.web.app'}}),config);
      assert.equal(response.status,404);assert.equal(response.headers.get('access-control-allow-origin'),null);
    }
  }
  assert.equal(authentications,0);
  for(const [suffix,method,body,status] of [['','GET',null,405],['?extra=1','POST',null,400],['','POST','{}',400]]){
    const response=await hostedCalendar(new Request('https://example.org/scout-calendar/reconcile'+suffix,{method,body}),config);
    assert.equal(response.status,status);
  }
  assert.equal(connects,0);
});

test('real SQL reconciliation repairs calendar-specific penguin titles and keeps the shared calendar high-only',async()=>{
  const db=new PGlite(),queries=[],credential={client_id:'client',client_secret:'secret',refresh_token:'refresh'};
  const records=[record,...[60,25,null].map((score,index)=>({...record,
    id:(index+1).toString().repeat(8)+'-1111-4111-8111-111111111111',score}))];
  const events=new Map(records.map(r=>{const event={...googleEvent(r),summary:'⭐ 🐧 '+r.description,etag:r.id};return [event.id,event];}));
  const reviewEvents=new Map(events),calendars=new Map([
    ['c_c4eba5697d3a3e33c4590daa7c20c8791d7d608b787ff959bf3117f3a7d02df5@group.calendar.google.com',events],
    ['c_d6d8bace0ef22918c156fc9878f310a210a4feb47a7f078744a99cceef293633@group.calendar.google.com',reviewEvents]
  ]);
  try{
    // Vault is a SQL fixture; Google HTTP is mocked. No live permissions are established here.
    await db.exec(`create role anon;create role authenticated;create role service_role;create schema scout;create schema vault;
      create table scout.records(id uuid,modified timestamptz[],type text,score smallint,description text,organizations text[],sources jsonb,date text,starttime text,timezone text,enddate text,endtime text);
      create table vault.secrets(id uuid default gen_random_uuid(),name text unique,secret text);
      create view vault.decrypted_secrets as select name,secret as decrypted_secret from vault.secrets;
      create function vault.create_secret(value text,label text) returns uuid language sql as $$ insert into vault.secrets(name,secret) values(label,value) returning id $$;
      create function vault.update_secret(key uuid,value text) returns void language sql as $$ update vault.secrets set secret=value where id=key $$;`);
    for(const name of ['20261012220000_scout_calendar.sql','20261102210000_scout_subscription_calendar.sql'])
      await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
    for(const [name,secret] of [['scout_calendar_google',JSON.stringify(credential)],['scout_calendar_feed','a'.repeat(64)],['unrelated','keep']])
      await db.query('insert into vault.secrets(name,secret) values($1,$2)',[name,secret]);
    for(const r of records)await db.query('insert into scout.records(id,modified,type,score,description,organizations,sources,date,starttime,timezone) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',Object.values(r));
    const before=(await db.query('select * from scout.records order by id')).rows;
    await db.exec(await readFile(new URL('../supabase/migrations/20261119210000_scout_remove_calendar_feed.sql',import.meta.url),'utf8'));
    assert.deepEqual((await db.query('select name,secret from vault.secrets order by name')).rows,
      [{name:'scout_calendar_google',secret:JSON.stringify(credential)},{name:'unrelated',secret:'keep'}]);
    assert.deepEqual((await db.query("select to_regclass('scout.calendar_trial') as trial,to_regprocedure('scout.save_calendar_secret(text,text)') as save")).rows,
      [{trial:null,save:null}]);
    assert.deepEqual((await db.query('select * from scout.records order by id')).rows,before);
    const key='sb_secret_calendar_test',config={databaseURL:'test',
      env:{url:'https://example.supabase.co',secretKeys:{default:key},publishableKeys:{default:'sb_publishable_test'},jwks:null},
      connect:()=>({reserve:async()=>({unsafe:async(sql,params)=>{
        queries.push(sql);const result=await db.query(sql,params);return Object.assign(result.rows,{count:result.affectedRows});
      },release(){}}),end:async()=>{}}),
      fetch:async(url,options)=>{
        if(url.includes('oauth2'))return Response.json({access_token:'access',scope:'https://www.googleapis.com/auth/calendar.events.owned'});
        const path=new URL(url).pathname.split('/'),calendarEvents=calendars.get(decodeURIComponent(path[4]));assert.ok(calendarEvents);
        if(options.method==='GET')return Response.json({items:[...calendarEvents.values()]});
        if(options.method==='DELETE'){
          const id=path.at(-1);assert.equal(options.headers['If-Match'],calendarEvents.get(id).etag);calendarEvents.delete(id);
          return new Response(null,{status:204});
        }
        assert.equal(options.method,'PUT');const event=JSON.parse(options.body);
        assert.equal(options.headers['If-Match'],calendarEvents.get(event.id).etag);
        calendarEvents.set(event.id,{...event,etag:event.id});return Response.json(calendarEvents.get(event.id));
      }};
    for(const [updated,removed,unchanged] of [[5,3,0],[0,0,5]]){
      const response=await hostedCalendar(new Request('https://example.org/scout-calendar/reconcile',{
        method:'POST',headers:{apikey:key}}),config);
      assert.equal(response.status,200);
      const result=await response.json();
      assert.equal(result.status,'ok');assert.equal(result.created,0);assert.equal(result.updated,updated);
      assert.equal(result.removed,removed);assert.equal(result.unchanged,unchanged);assert.equal(result.google_requests,3+updated+removed);
      assert.equal(result.cost.statements,2);assert.equal(result.cost.mutations,0);
    }
    assert.deepEqual([...events.keys()],[googleEvent(record).id]);assert.equal(queries.length,4);
    assert.deepEqual([...reviewEvents.keys()].sort(),records.map(r=>googleEvent(r).id).sort());
    assert.equal(events.get(googleEvent(record).id).summary,'🐧 Test fixture');
    for(const [index,prefix] of ['85/100 ','60/100 ','25/100 ',''].entries())
      assert.equal(reviewEvents.get(googleEvent(records[index]).id).summary,prefix+'Test fixture');
    assert.deepEqual((await db.query('select * from scout.records order by id')).rows,before);
  }finally{await db.close();}
});
