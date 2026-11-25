import {verifyAuth} from '@supabase/server/core';
import postgres from 'postgres';
import {database} from '../../../reader/database.js';
import {trackerModel} from '../../../reader/models/gateway.js';
import {intake} from '../../../reader/intake.js';
import {prepareMessages,sendMessages,botTransport} from '../../../slackbot/slack.js';
import {syncCalendar} from '../../../calendar/google.js';

export async function hostedReader(request,{databaseURL,apiKey,openaiApiKey,slackToken,serviceKeys,post,env,connect=postgres,modelFetch=fetch,sourceFetch=fetch,calendarFetch=fetch}={}){
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
    const result=await intake(db,{trackerId,sourceFetch,serviceKeys,modelFor:(source,{model,deadline,readUrl,functions,validate})=>trackerModel({source,model,deadline,readUrl,functions,validate,apiKey,openaiApiKey,fetch:modelFetch}),
      notify:async(ids,{deadline})=>sendMessages(db,await prepareMessages(db,{kind:'findings',ids}),post??botTransport(slackToken,undefined,{deadline}),{deadline}),
      publishCalendar:(ids,{deadline})=>syncCalendar(db,{ids,deadline,fetch:calendarFetch})});
    return Response.json({...result,cost:db.metrics});
  }catch{
    return Response.json({error:'Reader interrupted; the tracker lease expires before another check can run.'},{status:500});
  }finally{session?.release();await sql?.end({timeout:1}).catch(()=>{});}
}

if(typeof Deno!=='undefined')Deno.serve(request=>hostedReader(request,{databaseURL:Deno.env.get('SUPABASE_DB_URL'),
  apiKey:Deno.env.get('SCOUT_GEMINI_API_KEY'),openaiApiKey:Deno.env.get('SCOUT_OPENAI_API_KEY'),slackToken:Deno.env.get('SCOUT_SLACK_BOT_TOKEN'),
  serviceKeys:{tavily:Deno.env.get('TAVILY_API_KEY'),firecrawl:Deno.env.get('FIRECRAWL_API_KEY')}}));
