// Local CLI only. Never import this module from a hosted/browser entrypoint.
import {mkdirSync,openSync,closeSync,fchmodSync,writeSync} from 'node:fs';
import {readFile,readdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PGlite} from '@electric-sql/pglite';
import {managementDatabase} from './database.js';
import {database} from '../reader/database.js';
import {intake} from '../reader/intake.js';
import {trackerModel} from '../reader/models/gateway.js';

export function captureTraffic(path,{fetch:send=fetch,secrets=[]}={}){
  mkdirSync(dirname(path),{recursive:true});
  const file=openSync(path,'w',0o600);fchmodSync(file,0o600);
  let sequence=0;
  const redact=text=>secrets.filter(Boolean).reduce((s,key)=>s.replaceAll(key,'[REDACTED]'),text)
    .replace(/\bsk-[a-z0-9_.*-]+/gi,'[REDACTED]');
  const write=entry=>writeSync(file,redact(JSON.stringify(entry))+'\n');
  const limit=131072;
  return {close:()=>closeSync(file),fetch:async(url,options={})=>{
    const target=new URL(url),service=target.hostname;
    if(!['generativelanguage.googleapis.com','api.openai.com'].includes(service))return send(url,options);
    const id=++sequence,body=redact(String(options.body??'')),bytes=Buffer.from(body);
    write({id,direction:'request',at:new Date().toISOString(),url:target.origin+target.pathname,method:options.method??'GET',
      body:bytes.subarray(0,limit).toString('utf8'),truncated:bytes.length>limit});
    let response,reader;const chunks=[];let size=0,truncated=false;
    try{
      response=await send(url,options);reader=response.clone().body?.getReader();
      for(;;){
        const part=await reader?.read();if(!part||part.done)break;
        const remaining=limit-size;chunks.push(part.value.subarray(0,remaining));size+=Math.min(part.value.length,remaining);
        if(part.value.length>remaining){truncated=true;break;}
      }
      write({id,direction:'response',at:new Date().toISOString(),status:response.status,body:Buffer.concat(chunks).toString('utf8'),truncated});
      return response;
    }catch(error){
      write({id,direction:'error',at:new Date().toISOString(),status:response?.status??null,
        body:Buffer.concat(chunks).toString('utf8'),error:String(error.message)});
      throw error;
    }finally{void reader?.cancel().catch(()=>{});}
  }};
}

export async function diagnoseTracker({tracker,env,provider,ledger=managementDatabase(env.SUPABASE_ACCESS_TOKEN),fetch:send=fetch,
  output=fileURLToPath(new URL('../.cache/model-traffic/latest.jsonl',import.meta.url))}){
  const selected=(await ledger.query('select id,name,url,collector,cadence from scout.trackers where id=$1',[tracker])).rows[0];
  if(!selected)throw new Error('Existing tracker required');
  const raw=new PGlite();let traffic;
  try{
    // Same in-memory database setup used by the workflow tests. Findings never reach Supabase.
    await raw.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
      create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');create table auth.identities(user_id uuid,provider text,identity_data jsonb);
      create function auth.uid() returns uuid language sql as $$select null::uuid$$;`);
    for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())
      await raw.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
    await raw.query('insert into scout.trackers(id,name,url,collector,cadence) values($1,$2,$3,$4,$5)',
      [selected.id,selected.name,selected.url,selected.collector,selected.cadence]);
    traffic=captureTraffic(output,{fetch:send,secrets:[env.GEMINI_API_KEY,env.SCOUT_OPENAI_API_KEY,env.SUPABASE_ACCESS_TOKEN]});
    const db=database({unsafe:async(q,p=[])=>{const r=await raw.query(q,p);r.rows.count=r.affectedRows??r.rows.length;return r.rows;}});
    const result=await intake(db,{trackerId:tracker,modelFor:source=>trackerModel({source,provider,
      apiKey:env.GEMINI_API_KEY,openaiApiKey:env.SCOUT_OPENAI_API_KEY,fetch:traffic.fetch})});
    const records=(await raw.query('select * from scout.records order by id')).rows;
    return {traffic_file:output,result,records,cost:db.metrics};
  }finally{traffic?.close();await raw.close();}
}
