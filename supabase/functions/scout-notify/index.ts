import {verifyAuth} from '@supabase/server/core';
import postgres from 'postgres';
import {database} from '../../../reader/database.js';
import {prepareMessages,sendMessages,botTransport} from '../../../slackbot/slack.js';

export async function hostedNotify(request,{databaseURL,slackToken,env,connect=postgres,post}={}){
  const {error}=await verifyAuth(request,{auth:'secret:default',env});
  if(error)return Response.json({error:'Backend secret required'},{status:401});
  if(request.method!=='POST')return Response.json({error:'POST required'},{status:405});
  const params=new URL(request.url).searchParams,kind=params.get('kind'),ids=params.get('ids')?.split(',')??[];
  if(!['morning','weekly','findings'].includes(kind)||[...params.keys()].some(k=>!['kind','ids'].includes(k))||
    params.getAll('kind').length!==1||params.getAll('ids').length>1||
    (kind==='findings'?!ids.length||ids.some(id=>!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)):params.has('ids'))||
    request.body&&await request.text())return Response.json({error:'Use kind=morning, kind=weekly, or kind=findings with comma-separated ids; no body.'},{status:400});
  if(!databaseURL)return Response.json({error:'Database unavailable'},{status:503});
  let sql,session;
  try{
    sql=connect(databaseURL,{max:1,prepare:false,connect_timeout:5,
      types:{json:{to:114,from:[114,3802],parse:JSON.parse,serialize:value=>typeof value==='string'?value:JSON.stringify(value)}},
      connection:{application_name:'scout-notify',statement_timeout:5000}});
    session=await sql.reserve();const db=database(session);
    const preview=await prepareMessages(db,{kind,ids}),result=await sendMessages(db,preview,post??botTransport(slackToken));
    return Response.json({...result,cost:db.metrics});
  }catch{return Response.json({error:'Notification interrupted'},{status:500});}
  finally{session?.release();await sql?.end({timeout:1}).catch(()=>{});}
}

if(typeof Deno!=='undefined')Deno.serve(request=>hostedNotify(request,{databaseURL:Deno.env.get('SUPABASE_DB_URL'),slackToken:Deno.env.get('SCOUT_SLACK_BOT_TOKEN')}));
