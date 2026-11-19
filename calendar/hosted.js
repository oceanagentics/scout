import {verifyAuth} from '@supabase/server/core';
import postgres from 'postgres';
import {syncCalendar} from './google.js';
import {database} from '../reader/database.js';

export async function hostedCalendar(request,{databaseURL,env,connect=postgres,authenticate=verifyAuth,fetch}={}){
  const url=new URL(request.url),action=url.pathname.split('/').at(-1);
  const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
  const json=(body,status=200)=>Response.json(body,{status,headers});
  if(action!=='reconcile')return json({error:'Not found'},404);
  if(request.method!=='POST')return json({error:'Method not allowed'},405);
  if(url.searchParams.size)return json({error:'Invalid request'},400);
  const result=await authenticate(request,{auth:'secret:default',env});
  if(result.error)return json({error:'Backend secret required'},401);
  if(request.body&&await request.text())return json({error:'Empty body required'},400);
  if(!databaseURL)return json({error:'Calendar backend unavailable'},503);
  let sql,session;
  try{
    sql=connect(databaseURL,{max:1,prepare:false,connect_timeout:5,
      types:{json:{to:114,from:[114,3802],parse:JSON.parse,serialize:value=>typeof value==='string'?value:JSON.stringify(value)}},
      connection:{application_name:'scout-calendar',statement_timeout:5000}});
    session=await sql.reserve();
    const db=database(session),result=await syncCalendar(db,{fetch});
    return json({...result,cost:db.metrics},result.status==='ok'?200:502);
  }catch{return json({error:'Calendar operation interrupted; no automatic retry'},502);}
  finally{session?.release();await sql?.end({timeout:1}).catch(()=>{});}
}
