import {verifyAuth} from '@supabase/server/core';
import postgres from 'postgres';
import {database} from '../../../reader/database.js';
import {prepareMessage,sendMessage,webhookTransport} from '../../../slackbot/slack.js';

export async function hostedNotify(request,{databaseURL,webhook,env,connect=postgres,post}={}){
  const {error}=await verifyAuth(request,{auth:'secret:default',env});
  if(error)return Response.json({error:'Backend secret required'},{status:401});
  if(request.method!=='POST')return Response.json({error:'POST required'},{status:405});
  if(new URL(request.url).search||request.body&&await request.text())return Response.json({error:'No parameters or body required'},{status:400});
  if(!databaseURL)return Response.json({error:'Database unavailable'},{status:503});
  let sql,session;
  try{
    sql=connect(databaseURL,{max:1,prepare:false,connect_timeout:5,
      types:{json:{to:114,from:[114,3802],parse:JSON.parse,serialize:value=>typeof value==='string'?value:JSON.stringify(value)}},
      connection:{application_name:'scout-notify',statement_timeout:5000}});
    session=await sql.reserve();const db=database(session);
    const preview=await prepareMessage(db),result=await sendMessage(db,preview,post??webhookTransport(webhook));
    return Response.json({...result,cost:db.metrics});
  }catch{return Response.json({error:'Notification interrupted'},{status:500});}
  finally{session?.release();await sql?.end({timeout:1}).catch(()=>{});}
}

if(typeof Deno!=='undefined')Deno.serve(request=>hostedNotify(request,{databaseURL:Deno.env.get('SUPABASE_DB_URL'),webhook:Deno.env.get('SCOUT_SLACK_WEBHOOK_URL')}));
