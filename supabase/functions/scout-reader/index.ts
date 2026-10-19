import {verifyAuth} from '@supabase/server/core';
import postgres from 'postgres';
import {database} from '../../../reader/database.js';
import {trackerModel} from '../../../reader/models/gateway.js';
import {intake} from '../../../reader/intake.js';

export async function hostedReader(request,{databaseURL,apiKey,openaiApiKey,env,connect=postgres,modelFetch=fetch}={}){
  const {error}=await verifyAuth(request,{auth:'secret:default',env});
  if(error)return Response.json({error:'Backend secret required'},{status:401});
  if(request.method!=='POST')return Response.json({error:'POST required'},{status:405});
  const params=new URL(request.url).searchParams,trackerId=params.get('tracker_id');
  if(params.size&&(params.size!==1||!params.has('tracker_id')||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(trackerId)))
    return Response.json({error:'Use no parameters for the next due tracker, or tracker_id for an explicit check.'},{status:400});
  if(request.body&&await request.text())return Response.json({error:'Empty body required'},{status:400});
  if(!databaseURL)return Response.json({error:'Database unavailable'},{status:503});
  let sql,session;
  try{
    sql=connect(databaseURL,{max:1,prepare:false,connect_timeout:5,
      types:{json:{to:114,from:[114,3802],parse:JSON.parse,serialize:value=>typeof value==='string'?value:JSON.stringify(value)}},
      connection:{application_name:'scout-reader',statement_timeout:5000}});
    session=await sql.reserve();const db=database(session);
    await db.query('select * from scout.expire_quota()');
    const result=await intake(db,{trackerId,modelFor:tracker=>trackerModel({source:tracker,ledger:db,apiKey,openaiApiKey,fetch:modelFetch})});
    return Response.json({...result,cost:db.metrics});
  }catch{
    return Response.json({error:'Reader interrupted; the tracker lease expires and uncertain quota charges remain accounted.'},{status:500});
  }finally{session?.release();await sql?.end({timeout:1}).catch(()=>{});}
}

if(typeof Deno!=='undefined')Deno.serve(request=>hostedReader(request,{databaseURL:Deno.env.get('SUPABASE_DB_URL'),
  apiKey:Deno.env.get('SCOUT_GEMINI_API_KEY'),openaiApiKey:Deno.env.get('SCOUT_OPENAI_API_KEY')}));
