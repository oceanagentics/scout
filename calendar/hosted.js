import {verifyAuth} from '@supabase/server/core';
import postgres from 'postgres';
import {randomBytes,timingSafeEqual,createHash} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {calendarFeed} from './feed.js';

const project='https://vhlfumeyhkeospnemukq.supabase.co';
const columns='id,modified,type,description,organizations,date,starttime,timezone,sources';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});

export async function hostedCalendar(request,{databaseURL,env,connect=postgres,authenticate=verifyAuth}={}){
  const url=new URL(request.url),action=url.pathname.split('/').at(-1),origin=request.headers.get('origin');
  const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
  if(['https://bbnj-scout.web.app','http://127.0.0.1:5173'].includes(origin))Object.assign(headers,{
    'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info',
    'Access-Control-Allow-Methods':'GET,POST,OPTIONS',Vary:'Origin'});
  const json=(body,status=200)=>Response.json(body,{status,headers});
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
  if(!['feed-link','feed.ics'].includes(action))return json({error:'Not found'},404);
  if(request.method!==(action==='feed.ics'?'GET':'POST'))return json({error:'Method not allowed'},405);
  if(url.searchParams.size!==(action==='feed.ics'?1:0))return json({error:'Invalid request'},400);
  let auth;
  if(action!=='feed.ics'){
    const result=await authenticate(request,{auth:'user',issuer:project+'/auth/v1',audience:'authenticated',env});
    if(result.error)return json({error:'Sign in to Scout first'},401);
    auth=result.data;
  }else if(!/^[a-f0-9]{64}$/.test(url.searchParams.get('token')??''))return json({error:'Not found'},404);
  if(!databaseURL)return json({error:'Calendar backend unavailable'},503);
  let sql,session;
  try{
    sql=connect(databaseURL,{max:1,prepare:false,connect_timeout:5,
      types:{json:{to:114,from:[114,3802],parse:JSON.parse,serialize:value=>typeof value==='string'?value:JSON.stringify(value)}},
      connection:{application_name:'scout-calendar',statement_timeout:5000}});
    session=await sql.reserve();
    const query=(sql,params=[])=>session.unsafe(sql,params);
    const secret=async name=>(await query('select decrypted_secret from vault.decrypted_secrets where name=$1',[name]))[0]?.decrypted_secret;
    const records=()=>query(`select ${columns} from scout.records where type='event' order by id`);
    if(action==='feed.ics'){
      const token=await secret('scout_calendar_feed'),supplied=url.searchParams.get('token');
      if(!token||token.length!==supplied.length||!timingSafeEqual(Buffer.from(token),Buffer.from(supplied)))throw fail('Not found',404);
      const body=calendarFeed(await records()),etag='"'+createHash('sha256').update(body).digest('hex')+'"';
      if(Buffer.byteLength(body)>524288)throw fail('Feed exceeds the reviewed size limit',503);
      const feedHeaders={...headers,'Content-Type':'text/calendar; charset=utf-8',ETag:etag};
      return new Response(request.headers.get('if-none-match')===etag?null:body,{status:request.headers.get('if-none-match')===etag?304:200,headers:feedHeaders});
    }
    const identity=(await query(`select 1 from auth.identities
      where user_id=$1 and provider='google' and identity_data @> '{"iss":"https://accounts.google.com","email_verified":true,"custom_claims":{"hd":"oceanagentics.com"}}'`,[auth.userClaims.id]))[0];
    if(!identity)throw fail('Ocean Agentics Google identity required',403);
    let token=await secret('scout_calendar_feed');
    if(!token){
      await query('select scout.save_calendar_secret($1,$2)',['scout_calendar_feed',randomBytes(32).toString('hex')]);
      token=await secret('scout_calendar_feed');
    }
    return json({url:project+'/functions/v1/scout-calendar/feed.ics?token='+token});
  }catch(error){return json({error:error.status?error.message:'Calendar operation interrupted; no automatic retry'},error.status??502);}
  finally{session?.release();await sql?.end({timeout:1}).catch(()=>{});}
}
