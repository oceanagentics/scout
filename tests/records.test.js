import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {eventLabel,trackerState,fieldLabel,stamp} from '../website/records.js';
import {eventTiming,recordDates,sourceLink,orderRecords} from '../shared/records.js';
import {loadScout} from '../website/dashboard.js';
import {scoutDay} from '../shared/finding-dates.js';

test('flat reader displays local date/time and organization strings',()=>{
  const event={id:'event',type:'event',organizations:['Ocean Institute','Second Institute'],date:'2026-10-15',starttime:'00:30',timezone:'+08:00'};
  assert.deepEqual(recordDates(event),['2026-10-15','2026-10-15']);assert.ok(eventLabel(event).includes('2026-10-15 · 00:30 +08:00'));
  assert.match(eventLabel({...event,enddate:'2026-10-15',endtime:'01:30'}),/→ 2026-10-15 · 01:30 \+08:00/);
  assert.equal(fieldLabel(event,'organizations'),'Ocean Institute; Second Institute');
  assert.equal(eventTiming(event,new Date('2026-10-14T16:00:00Z')),'Upcoming');
  assert.equal(eventTiming({...event,date:'2026-10-04',starttime:null},new Date('2026-10-04T12:00:00Z')),'Date known · time unknown');
  assert.equal(eventTiming({type:'event',date:null}),'Date unknown');
  const publication={id:'pub',type:'announcement',date:'2026-03'};
  assert.equal(eventLabel(publication),'Published · 2026-03 · month precision');
  assert.equal(orderRecords([event,publication],'date')[0].id,'pub');
});
test('source links reject unsafe URLs and tracker freshness uses persisted run status',()=>{
  for(const url of ['javascript:alert(1)','https://user:secret@example.org'])assert.equal(sourceLink(url),null);
  assert.equal(trackerState({enabled:false,url:null}).availability,'Unconfigured');
  assert.equal(trackerState({enabled:false,url:'https://example.org'}).availability,'Disabled');
  assert.equal(trackerState({enabled:true,url:'https://example.org'}).availability,'Not checked');
  assert.equal(trackerState({enabled:true,url:'https://example.org',failure_count:3}).availability,'Needs attention');
  assert.equal(trackerState({enabled:true,url:'https://example.org',last_error:'quota'}).availability,'Retry scheduled');
});
test('reader sends filters and stable cursor to bounded server queries and surfaces errors',async()=>{
  const rows=Array.from({length:50},(_,i)=>({id:String(i),score:25,type:'announcement',organizations:[],date:'2026-03'})),calls=[];let fail=false;
  const client={rpc:async(name,args)=>{calls.push({name,args});return fail?{error:new Error('Unavailable')}:{data:name==='findings'?rows:[]};},
    from:table=>{assert.equal(table,'trackers');return{select(fields){assert.ok(fields.split(',').includes('retire_on'));return this;},
      or(filter){assert.equal(filter,'retire_on.is.null,retire_on.gt.'+scoutDay());return this;},
      order(){return this;},limit(n){assert.equal(n,500);return{data:[]};}};}};
  const result=await loadScout(client,{filters:{type:'announcement',organization:'Ocean Institute',from:'2027-01-01'}});
  assert.deepEqual(result.records,rows);assert.equal(result.records.length,50);assert.deepEqual(result.next,{rank:-25,day:'2026-03-01',id:'49'});
  assert.equal(calls[0].args.p_limit,50);assert.equal(calls[0].args.p_organization,'Ocean Institute');assert.equal(calls[0].args.p_from,'2027-01-01');
  await loadScout(client,{after:result.next});assert.deepEqual(calls[1].args.p_after,result.next);
  assert.ok(calls.every(c=>c.name==='findings'));fail=true;await assert.rejects(loadScout(client),/Unavailable/);
});

test('Scout calendar days and operational timestamps use New York across DST',()=>{
 assert.equal(scoutDay(new Date('2026-11-09T04:30:00Z')),'2026-11-08');
 assert.equal(stamp('2026-11-09T04:30:00Z'),'2026-11-08 23:30 EST');
 assert.equal(stamp('2026-07-09T03:30:00Z'),'2026-07-08 23:30 EDT');
 assert.equal(eventTiming({type:'event',date:'2026-11-08'},new Date('2026-11-09T04:30:00Z')),'Date known · time unknown');
});

test('numeric migration preserves finding facts and supports filtering and stable descending pagination through zero and null',async()=>{
 const db=new PGlite(),migration='20261120220000_scout_numeric_ranking.sql';
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
   create schema vault;create table vault.secrets(name text,secret text);
   create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');
   create table auth.identities(user_id uuid,provider text,identity_data jsonb);
   create function auth.uid() returns uuid language sql as $$select null::uuid$$;`);
  for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort()){
   if(name===migration)break;
   await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
  }
  for(const priority of ['high','normal','low',null])await db.query(
   "insert into scout.records(description,priority,date,slack_channel_post) values('Preserved finding',$1,'2026-11-19','{\"state\":\"do_not_post\"}')",[priority]);
  const before=(await db.query('select * from scout.records order by id')).rows;
  await db.exec(await readFile(new URL('../supabase/migrations/'+migration,import.meta.url),'utf8'));
  assert.deepEqual((await db.query('select * from scout.records order by id')).rows,
   before.map(({priority,...record})=>({...record,score:{high:85,normal:60,low:25}[priority]??null})));
  for(const score of [-1,101])await assert.rejects(db.query("insert into scout.records(description,score) values('Invalid score',$1)",[score]),{code:'23514'});
  for(const score of [0,85,100])await db.query("insert into scout.records(description,score,date) values('Additional finding',$1,'2026-11-19')",[score]);
  await db.exec('set role service_role');
  assert.equal((await db.query('select * from scout.findings(p_min_score=>0)')).rows.length,6);
  assert.deepEqual((await db.query('select score from scout.findings(p_unassessed=>true)')).rows,[{score:null}]);
  assert.deepEqual((await db.query('select score from scout.findings(p_min_score=>75)')).rows.map(r=>r.score),[100,85,85]);
  await assert.rejects(db.query('select * from scout.findings(p_min_score=>101)'),{code:'22023'});
  const paged=[];let after=null;
  for(let n=0;n<8;n++){
   const record=(await db.query('select r.*,lower(scout.date_span(r.date))::text as cursor_day from scout.findings(p_after=>$1::jsonb,p_limit=>1) r',[after===null?null:JSON.stringify(after)])).rows[0];
   if(!record)break;
   paged.push(record);after={rank:record.score==null?1:-record.score,day:record.cursor_day,id:record.id};
  }
  assert.equal(new Set(paged.map(r=>r.id)).size,7);
  assert.deepEqual(paged.map(r=>r.score),[100,85,85,60,25,0,null]);
  assert.deepEqual(orderRecords([...paged].reverse()).map(r=>r.id),paged.map(r=>r.id));
  assert.equal(fieldLabel({score:0},'score'),'0/100');assert.equal(fieldLabel({score:null},'score'),'Not yet assessed');
 }finally{await db.close();}
});
