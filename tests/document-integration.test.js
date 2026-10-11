import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {prepareResponse,prepareDocument,supportDocuments,collectDocuments} from '../collector/octo-documents.js';
import {processDocument} from '../collector/finding-jobs.js';
import {sourceURL} from '../collector/hsa.js';

async function setup(){
 const db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');create table auth.identities(user_id uuid,provider text,identity_data jsonb);
 create function auth.uid() returns uuid language sql as $$select null::uuid$$;`);
 for(const n of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec(await readFile(new URL('../supabase/migrations/'+n,import.meta.url),'utf8'));
 return db;
}
const review=input=>({input_hash:input.input_hash,occurrence:{status:'supported',reason:'Injected support.',sources:input.finding.proposal.occurrence.sources},
 claims:input.claims.map(c=>({...c,status:'supported',reason:'Injected support.'})),relevance:{priority:'normal',reason:'Ocean workshop.',fields:['proposed.title']}});
function finding(title,uid,date,correction=false){
 const sources=[{doc:'P',block:0,quote:'SUMMARY:'+title}],schedule=[{doc:'P',block:0,quote:'DTSTART;VALUE=DATE:'+date.replaceAll('-','')}];
 return {occurrence:{kind:'event',anchor:title,title,sources},description:null,canonical_url:null,organizations:[],
 details:{start:{value:date,precision:'day',sources:schedule,...correction?{correction_sources:[{doc:'P',block:0,quote:'DESCRIPTION:Rescheduled occurrence.'}]}:{}},
 end:null,occurrence:null,parent:null,location:null,mode:null,registration_url:null,status:null},
 identities:[{scheme:'calendar_uid',value:uid,sources:[{doc:'P',block:0,quote:'UID:'+uid}]}],unknowns:{organizations:{reason:'not_announced',explanation:'No organization stated.'}}};
}
const calendar=(title,uid,date,correction=false)=>'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:'+uid+'\nSUMMARY:'+title+'\nDTSTART;VALUE=DATE:'+date.replaceAll('-','')+(correction?'\nDESCRIPTION:Rescheduled occurrence.':'')+'\nEND:VEVENT\nEND:VCALENDAR';

test('native identity separates editions, explicit corrections preserve identity, and stale leases cannot save',async()=>{
 const db=await setup();try{
  const tr=(await db.query("insert into scout.trackers(name,url,collector,cadence) values('Calendar','https://example.org','web','6 hours') returning id")).rows[0];
  let uid='edition-a',day='2026-10-15',correct=false,stale=false;
  const source={tracker_id:tr.id,identity:'a',url:'https://example.org/a.ics'};
  const read=()=>prepareResponse({status:200,url:source.url,headers:{'content-type':'text/calendar'},body:calendar('Ocean workshop',uid,day,correct)},{sourceURL});
  const model=async(_q,inputs)=>{const input=inputs[0];if(input.stage==='extract')return{complete:true,findings:[finding('Ocean workshop',uid,day,correct)]};
    if(stale)await db.exec("update scout.source_state set lease_id=gen_random_uuid()");return review(input);};
  assert.equal((await processDocument(db,{source,read,model})).created,1);
  day='2026-10-16';correct=true;
  await db.exec("update scout.source_state set due_at=now()-interval '1 second'");
  assert.equal((await processDocument(db,{source,read,model})).changed,1);
  assert.equal((await db.query('select details from scout.records')).rows[0].details.start.value,day);
  uid='edition-b';source.identity='b';source.url='https://example.org/b.ics';
  assert.equal((await processDocument(db,{source,read,model})).created,1);
  assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,2);
  source.identity='stale';uid='edition-c';stale=true;
  assert.equal((await processDocument(db,{source,read,model})).reason,'stale_lease');
  assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,2);
 }finally{await db.close();}
});
test('mixed event and announcement share one extraction/review and unchanged repeat makes no model calls',async()=>{
 const db=await setup();try{
  const tr=(await db.query("insert into scout.trackers(name,url,collector,cadence) values('List','https://example.org','web','6 hours') returning id")).rows[0];
  const source={tracker_id:tr.id,identity:'list',url:'https://example.org/list'};
  const body='First workshop on 15 October 2026. Second announcement published 16 October 2026.';
  const prepared=prepareDocument({url:source.url,title:'',html:'<p>'+body+'</p>'}),sources=[{doc:'P',block:0,quote:body}];
  const event=finding('First workshop','unused','2026-10-15');event.occurrence.sources=sources;event.details.start.sources=sources;event.identities=[];
  const announcement={occurrence:{kind:'announcement',anchor:'Second announcement',title:'Second announcement',sources},description:null,canonical_url:null,organizations:[],
    details:{published:{value:'2026-10-16',precision:'day',sources},effective:null,subjects:null},identities:[],unknowns:{organizations:{reason:'not_announced',explanation:'Not supplied.'}}};
  let calls=0;
  const model=async(_q,inputs)=>{calls++;return inputs[0].stage==='extract'?{complete:true,findings:[event,announcement]}:{reviews:inputs[0].reviews.map(review)};};
  assert.deepEqual(await processDocument(db,{source,prepared,model}),{state:'complete',created:2,changed:0});assert.equal(calls,2);
  assert.deepEqual((await db.query('select kind from scout.records order by kind')).rows.map(r=>r.kind),['announcement','event']);
  await db.exec("update scout.source_state set due_at=now()-interval '1 second'");
  assert.equal((await processDocument(db,{source,prepared,model})).state,'unchanged');assert.equal(calls,2);
 }finally{await db.close();}
});
test('supporting source/PDF reading has no database access or content persistence',async()=>{
 const primary=prepareDocument({url:'https://example.org/event',title:'',html:'<p>Event.</p><p><a href="/registration">Register</a></p>'}),requests=[];
 const result=await supportDocuments({query:()=>assert.fail('No database calls while reading')},{source:{url:primary.url},prepared:primary,sourceURL,
  budget:{requests:0,deadline:Date.now()+10000},limits:{requests:4},read:async url=>{requests.push(url);return {url,status:200,body:'<p>Registration details.</p>',headers:{'content-type':'text/html'}};}});
 assert.equal(result.documents.length,2);assert.deepEqual(requests,['https://example.org/registration']);
 const bytes=await readFile(new URL('./fixtures/mixed-finding.pdf',import.meta.url));
 const pdf=await prepareResponse({url:'https://example.org/scan.pdf',status:200,encoding:'base64',body:bytes.toString('base64'),headers:{'content-type':'application/pdf'}},{sourceURL});
 assert.equal(pdf.inline_data.data,bytes.toString('base64'));assert.ok(pdf.visual);
});
test('tracker discovery keeps native IDs and advances its bounded cursor across source checks',async()=>{
 const db=await setup();try{
  const tracker=(await db.query("insert into scout.trackers(name,url,collector,cadence) values('List','https://example.org/list','web','6 hours') returning *")).rows[0],seen=[];
  const retrieve=async({known,progress})=>{
   seen.push({known,progress});const id=progress.after_id==='1'?'2':'1',url='https://example.org/'+id;
   return {documents:[{id,identity:'item:'+id,url,prepared:prepareDocument({url,title:'',html:'<p>Item.</p>'})}],progress:{after_id:id},inventory:[]};
  };
  const options={tracker,retrieve,sourceURL,deadline:Date.now()+100000,limits:{requests:4,pages:4},model:async()=>({complete:true,findings:[]})};
  await collectDocuments(db,options);
  await db.exec("update scout.source_state set due_at=now()-interval '1 second'");
  await collectDocuments(db,options);
  assert.equal(seen[1].progress.after_id,'1');assert.equal(seen[1].known[0].id,'1');
  assert.equal((await db.query("select count(*)::int n from scout.source_state where identity<>'tracker'")).rows[0].n,2);
  assert.equal((await db.query('select count(*)::int n from scout.evidence')).rows[0].n,0);
 }finally{await db.close();}
});
test('quota deferral before generation does not consume the source failure allowance',async()=>{
 const db=await setup();try{
  const tracker=(await db.query("insert into scout.trackers(name,url,collector,cadence) values('Quota','https://example.org','web','6 hours') returning id")).rows[0];
  const source={tracker_id:tracker.id,identity:'q',url:'https://example.org/q'},prepared=prepareDocument({url:source.url,title:'',html:'<p>Ocean news.</p>'});
  for(let i=0;i<5;i++){
   await db.exec("update scout.source_state set due_at=now()-interval '1 second'");
   const result=await processDocument(db,{source,prepared,model:()=>{throw Object.assign(new Error('quota'),{reason:'quota',deferred:{retry_at:new Date(Date.now()+3600000).toISOString()}});}});
   assert.equal(result.state,'deferred');
  }
  const state=(await db.query('select * from scout.source_state')).rows[0];assert.equal(state.attempts,0);assert.equal(state.processed_hash,null);
 }finally{await db.close();}
});
