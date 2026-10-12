import {verifyAuth} from '@supabase/server/core';
import postgres from 'postgres';
import {Buffer} from 'node:buffer';
import {randomUUID} from 'node:crypto';
import {collectHSA,readPublic,sourceURL} from './hsa.js';
import {gemini} from './model.js';
import {processDocument} from './finding-jobs.js';
import {correctFinding} from './corrections.js';
import {prepareMessage,sendMessage,webhookTransport} from '../notifications/slack.js';

// Numeric counters only, bounded per invocation. No parameters or results are retained.
export function database(sql,inTransaction=false,metrics={statements:0,mutations:0,submitted_bytes:0,result_bytes:0}){
  const db={
    metrics,
    async query(query,params=[]){
      const bytes=Buffer.byteLength(query)+Buffer.byteLength(JSON.stringify(params));
      if(query.trim().toLowerCase()!=='rollback'&&(metrics.statements>=96||metrics.submitted_bytes+bytes>262144))throw new Error('sql_bound');
      metrics.statements++;metrics.submitted_bytes+=bytes;
      try{
        const rows=await sql.unsafe(query,params);
        metrics.statements+=Number(rows[0]?.sql_statements??0);
        metrics.result_bytes+=Buffer.byteLength(JSON.stringify(rows));
        metrics.mutations+=/^\s*(insert|update|delete)\b/i.test(query)?Number(rows.count??rows.length):Number(rows[0]?.mutations??0);
        return {rows};
      }catch(error){throw Object.assign(new Error('database_operation'),{reason:'database_operation',code:/^[A-Z0-9]{5}$/.test(error.code??'')?error.code:undefined});}
    },
    async transaction(work){
      if(inTransaction)throw new Error('nested_transaction');
      await db.query('begin');
      try{const result=await work(database(sql,true,metrics));await db.query('commit');return result;}
      catch(error){await db.query('rollback');throw error;}
    }
  };
  return db;
}
export async function hostedHSA(request,{databaseURL,apiKey,webhook,env,connect=postgres,read=readPublic,modelFetch=fetch,post}={}){
  const {error}=await verifyAuth(request,{auth:'secret:default',env});
  if(error)return Response.json({error:'Backend secret required'},{status:401});
  if(request.method!=='POST')return Response.json({error:'POST required'},{status:405});
  const params=new URL(request.url).searchParams,rotation=params.get('next')==='true',notify=params.get('notify')==='true',correct=params.get('correct')==='true';
  const trackerId=params.get('tracker_id'),url=params.get('source_url'),uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
  if(rotation||notify||correct?params.size!==1:params.size!==2||!uuid.test(trackerId??'')||!url)
    return Response.json({error:'Use next=true, notify=true, correct=true, or tracker_id and source_url.'},{status:400});
  if(!databaseURL)return Response.json({error:'Database unavailable'},{status:503});
  let sql,session;
  try{
    if(url&&sourceURL(url)!==url)throw new Error('invalid_url');
    sql=connect(databaseURL,{max:1,prepare:false,connect_timeout:5,
      types:{json:{to:114,from:[114,3802],parse:JSON.parse,serialize:value=>typeof value==='string'?value:JSON.stringify(value)}},
      connection:{application_name:'scout-collect-hsa',statement_timeout:5000}});
    session=await sql.reserve();
    const db=database(session),deadline=Date.now()+100000;
    if(correct){
      const body=await request.text();
      if(Buffer.byteLength(body)>4096)return Response.json({error:'Correction too large'},{status:400});
      return Response.json(await correctFinding(db,JSON.parse(body)));
    }
    if(request.body&&await request.text())return Response.json({error:'Empty body required'},{status:400});
    // Due selection precedes HTTP, maintenance, reservations and source writes.
    let selected;
    if(rotation){
      selected=(await db.query(`select t.*,s.identity source_identity,s.url source_url,s.native_ref source_ref from scout.source_state s join scout.trackers t on t.id=s.tracker_id
        where t.enabled and s.due_at<=clock_timestamp() and (s.lease_until is null or s.lease_until<clock_timestamp())
        order by s.due_at,s.id limit 1`)).rows[0];
      if(!selected)return Response.json({outcome:'idle',cost:db.metrics});
    }else if(!notify)selected=(await db.query('select * from scout.trackers where id=$1',[trackerId])).rows[0];
    if(!notify&&!selected)return Response.json({error:'Existing tracker required'},{status:400});
    const policy=(await db.query('select enabled and verified_until>clock_timestamp() and verified_rpm>0 and verified_rpd>0 and verified_tpm>0 and database_verified_until>clock_timestamp() and database_bytes between 0 and 399999999 as allowed from scout.quota_policy where id')).rows[0];
    if(!policy?.allowed)return Response.json({outcome:'deferred',reason:'unverified_budget',cost:db.metrics});
    if(notify){
      const preview=await prepareMessage(db),result=await sendMessage(db,preview,post??webhookTransport(webhook));
      return Response.json({...result,cost:db.metrics});
    }
    // Manual pilots use the same bounded accounting retention as scheduled work.
    await db.query('select * from scout.expire_quota()');
    const invocation=randomUUID(),model=gemini({apiKey,ledger:db,invocation,deadline,fetch:modelFetch});
    let result;
    if(rotation&&selected.source_identity==='tracker'){
      result=await collectHSA(db,{trackerId:selected.id,documents:'process',rotation:true,model,read,deadline});
    }else{
      const source={tracker_id:selected.id,identity:rotation?selected.source_identity:url,url:rotation?selected.source_url:url},budget={requests:0,support:true,deadline};
      result=await processDocument(db,{source,model,deadline,read:url=>read(url,budget)});
    }
    return Response.json({...result,cost:db.metrics});
  }catch(error){
    return Response.json({error:[400,409].includes(error.status)?error.message:'Collection interrupted; compact state retains the retry and quota charge.'},{status:error.status??500});
  }finally{session?.release();await sql?.end({timeout:1}).catch(()=>{});}
}
