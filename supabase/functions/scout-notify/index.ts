import {verifyAuth} from '@supabase/server/core';
import postgres from 'postgres';
import {database} from '../../../reader/database.js';
import {prepareMessages,sendMessages,botTransport,readPostedFindings} from '../../../slackbot/slack.js';

export async function hostedNotify(request,{databaseURL,slackToken,env,connect=postgres,post,slackFetch=fetch}={}){
  const deadline=Date.now()+115000;
  const {error}=await verifyAuth(request,{auth:'secret:default',env});
  if(error)return Response.json({error:'Backend secret required'},{status:401});
  if(request.method!=='POST')return Response.json({error:'POST required'},{status:405});
  const params=new URL(request.url).searchParams,kind=params.get('kind'),ids=params.get('ids')?.split(',')??[];
  if(!['unposted','findings'].includes(kind)||[...params.keys()].some(k=>!['kind','ids'].includes(k))||
    params.getAll('kind').length!==1||params.getAll('ids').length>1||
    (kind==='findings'?!ids.length||ids.some(id=>!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)):params.has('ids'))||
    request.body&&await request.text())return Response.json({error:'Use kind=unposted, or kind=findings with comma-separated ids; no body.'},{status:400});
  if(!databaseURL)return Response.json({error:'Database unavailable'},{status:503});
  let sql,session;
  try{
    sql=connect(databaseURL,{max:1,prepare:false,connect_timeout:5,
      types:{json:{to:114,from:[114,3802],parse:JSON.parse,serialize:value=>typeof value==='string'?value:JSON.stringify(value)}},
      connection:{application_name:'scout-notify',statement_timeout:5000}});
    session=await sql.reserve();const db=database(session);
    const preview=await prepareMessages(db,{kind,ids});let reconciled=0;
    if(kind==='unposted'&&preview.records.length){
      const posted=await readPostedFindings(slackToken,{fetch:slackFetch,deadline});
      const matches=preview.records.filter(r=>posted.has(r.id)).map(r=>({id:r.id,ts:posted.get(r.id)}));
      if(matches.length){
        reconciled=(await db.query(`update scout.records r set slack_channel_post=jsonb_build_object('state','posted','ts',p.ts)
         from jsonb_to_recordset($1::jsonb) p(id uuid,ts text) where r.id=p.id
         and (r.slack_channel_post is null or r.slack_channel_post->>'state'='uncertain') returning r.id`,[JSON.stringify(matches)])).rows.length;
        preview.records=preview.records.filter(r=>!posted.has(r.id));
        preview.payloads=preview.payloads.filter(p=>!posted.has(p.metadata.event_payload.record_id));
      }
    }
    const result=await sendMessages(db,preview,post??botTransport(slackToken,slackFetch,{deadline}),{deadline});
    return Response.json({...result,reconciled,cost:db.metrics},{status:['failed','unknown'].includes(result.status)?502:200});
  }catch(cause){
    const error=/^(slack_[a-z_]+|database_operation)$/.test(cause?.reason??'')?cause.reason:'notification_interrupted';
    return Response.json({error},{status:502});
  }
  finally{session?.release();await sql?.end({timeout:1}).catch(()=>{});}
}

if(typeof Deno!=='undefined')Deno.serve(request=>hostedNotify(request,{databaseURL:Deno.env.get('SUPABASE_DB_URL'),slackToken:Deno.env.get('SCOUT_SLACK_BOT_TOKEN')}));
