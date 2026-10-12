import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {prepareDocument,collectDocuments} from '../collector/octo-documents.js';
import {sourceURL} from '../collector/hsa.js';

async function setup(){
 const db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');create table auth.identities(user_id uuid,provider text,identity_data jsonb);
 create function auth.uid() returns uuid language sql as $$select null::uuid$$;`);
 for(const n of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec(await readFile(new URL('../supabase/migrations/'+n,import.meta.url),'utf8'));
 return db;
}
test('tracker discovery keeps native IDs and advances its bounded cursor across source checks',async()=>{
 const db=await setup();try{
  const tracker=(await db.query("insert into scout.trackers(name,url,collector,cadence) values('List','https://example.org/list','web','6 hours') returning *")).rows[0],seen=[];
  const retrieve=async({known,progress})=>{
   seen.push({known,progress});const id=progress.after_id==='1'?'2':'1',url='https://example.org/'+id;
   return {documents:[{id,identity:'item:'+id,url,prepared:prepareDocument({url,title:'',html:'<p>Item.</p>'})}],progress:{after_id:id},inventory:[]};
  };
  const options={tracker,retrieve,sourceURL,deadline:Date.now()+100000,limits:{requests:4,pages:4},model:async()=>({status:'none',records:[]})};
  await collectDocuments(db,options);
  await db.exec("update scout.source_state set due_at=now()-interval '1 second'");
  await collectDocuments(db,options);
  assert.equal(seen[1].progress.after_id,'1');assert.equal(seen[1].known[0].id,'1');
  assert.equal((await db.query("select count(*)::int n from scout.source_state where identity<>'tracker'")).rows[0].n,2);
  assert.equal((await db.query("select to_regclass('scout.evidence') name")).rows[0].name,null);
 }finally{await db.close();}
});
