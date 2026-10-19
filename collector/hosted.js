import {verifyAuth} from '@supabase/server/core';
import postgres from 'postgres';
import {randomUUID} from 'node:crypto';
import {sourceURL} from './source-url.js';
import {database} from './database.js';
import {trackerModel} from './models/gateway.js';
import {processDocument} from './intake.js';
import {prepareMessage,sendMessage,webhookTransport} from '../slackbot/slack.js';

export async function hostedHSA(request,{databaseURL,apiKey,openaiApiKey,webhook,env,connect=postgres,modelFetch=fetch,post}={}){
  const {error}=await verifyAuth(request,{auth:'secret:default',env});
  if(error)return Response.json({error:'Backend secret required'},{status:401});
  if(request.method!=='POST')return Response.json({error:'POST required'},{status:405});
  const params=new URL(request.url).searchParams,rotation=params.get('next')==='true',notify=params.get('notify')==='true';
  const trackerId=params.get('tracker_id'),url=params.get('source_url'),uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
  if(rotation||notify?params.size!==1:params.size!==2||!uuid.test(trackerId??'')||!url)
    return Response.json({error:'Use next=true, notify=true, or tracker_id and source_url.'},{status:400});
  if(!databaseURL)return Response.json({error:'Database unavailable'},{status:503});
  let sql,session;
  try{
    if(url&&sourceURL(url)!==url)throw new Error('invalid_url');
    sql=connect(databaseURL,{max:1,prepare:false,connect_timeout:5,
      types:{json:{to:114,from:[114,3802],parse:JSON.parse,serialize:value=>typeof value==='string'?value:JSON.stringify(value)}},
      connection:{application_name:'scout-collect-hsa',statement_timeout:5000}});
    session=await sql.reserve();
    const db=database(session);
    if(request.body&&await request.text())return Response.json({error:'Empty body required'},{status:400});
    // Due selection precedes HTTP, maintenance, reservations and source writes.
    let selected;
    if(rotation){
      selected=(await db.query(`select t.*,s.identity source_identity,s.url source_url,s.native_id source_native_id,s.native_ref source_ref from scout.source_state s join scout.trackers t on t.id=s.tracker_id
        where t.enabled and s.due_at<=clock_timestamp() and (s.lease_until is null or s.lease_until<clock_timestamp())
        order by s.due_at,s.id limit 1`)).rows[0];
      if(!selected)return Response.json({outcome:'idle',cost:db.metrics});
    }else if(!notify)selected=(await db.query(`select t.*,s.identity source_identity,s.native_id source_native_id,s.native_ref source_ref
      from scout.trackers t left join lateral (select identity,native_id,native_ref from scout.source_state where tracker_id=t.id and url=$2
      order by native_id is not null desc,id limit 1) s on true where t.id=$1`,[trackerId,url])).rows[0];
    if(!notify&&!selected)return Response.json({error:'Existing tracker required'},{status:400});
    if(notify){
      const preview=await prepareMessage(db),result=await sendMessage(db,preview,post??webhookTransport(webhook));
      return Response.json({...result,cost:db.metrics});
    }
    // Manual pilots use the same bounded accounting retention as scheduled work.
    await db.query('select * from scout.expire_quota()');
    const invocation=randomUUID(),source={tracker_id:selected.id,identity:selected.source_identity??url,url:rotation?selected.source_url:url,
      native_id:selected.source_native_id,native_ref:selected.source_ref};
    const model=trackerModel({apiKey,openaiApiKey,ledger:db,source,invocation,fetch:modelFetch});
    const result=await processDocument(db,{source,model});
    return Response.json({...result,cost:db.metrics});
  }catch(error){
    return Response.json({error:[400,409].includes(error.status)?error.message:'Collection interrupted; compact state retains the retry and quota charge.'},{status:error.status??500});
  }finally{session?.release();await sql?.end({timeout:1}).catch(()=>{});}
}
