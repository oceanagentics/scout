import {verifyAuth} from '@supabase/server/core';
import postgres from 'postgres';
import {randomBytes,timingSafeEqual,createHash} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {calendarFeed} from './feed.js';
import {googleAccessToken,syncCalendar} from './google.js';

const owner='danny@oceanagentics.com',project='https://vhlfumeyhkeospnemukq.supabase.co';
const columns='id,version,updated_at,kind,title,description,organizations,details,canonical_url';
const fail=(message,status=400,code)=>Object.assign(new Error(message),{status,code});

export async function hostedCalendar(request,{databaseURL,clientId,clientSecret,env,connect=postgres,authenticate=verifyAuth,send=fetch}={}){
  const url=new URL(request.url),action=url.pathname.split('/').at(-1),origin=request.headers.get('origin');
  const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
  if(['https://bbnj-scout.web.app','http://127.0.0.1:5173'].includes(origin))Object.assign(headers,{
    'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info',
    'Access-Control-Allow-Methods':'GET,POST,OPTIONS',Vary:'Origin'});
  const json=(body,status=200)=>Response.json(body,{status,headers});
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
  if(!['status','connect','feed-link','feed.ics','sync'].includes(action))return json({error:'Not found'},404);
  if(request.method!==(['status','feed.ics'].includes(action)?'GET':'POST'))return json({error:'Method not allowed'},405);
  if(url.searchParams.size!==(action==='feed.ics'?1:0))return json({error:'Invalid request'},400);
  let auth;
  if(action!=='feed.ics'){
    const result=await authenticate(request,{auth:'user',issuer:project+'/auth/v1',audience:'authenticated',env});
    if(result.error)return json({error:'Sign in to Scout first'},401);
    auth=result.data;
  }else if(!/^[a-f0-9]{64}$/.test(url.searchParams.get('token')??''))return json({error:'Not found'},404);
  if(!databaseURL)return json({error:'Calendar backend unavailable'},503);
  let sql,session;
  const cost={sql_statements:0,row_mutations:0};
  try{
    sql=connect(databaseURL,{max:1,prepare:false,connect_timeout:5,
      types:{json:{to:114,from:[114,3802],parse:JSON.parse,serialize:value=>typeof value==='string'?value:JSON.stringify(value)}},
      connection:{application_name:'scout-calendar',statement_timeout:5000}});
    session=await sql.reserve();
    const query=async(sql,params=[])=>{cost.sql_statements++;const rows=await session.unsafe(sql,params);
      if(/^\s*(insert|update|delete)/i.test(sql))cost.row_mutations+=Number(rows.count??rows.length);return rows;};
    const secret=async name=>(await query('select decrypted_secret from vault.decrypted_secrets where name=$1',[name]))[0]?.decrypted_secret;
    const reserve=async count=>{
      if(!(await query('update scout.calendar_trial set remaining=remaining-$1 where id and expires_at>clock_timestamp() and remaining>=$1 returning remaining',[count])).length)
        throw fail('Calendar trial is paused or its allowance is used up; review before continuing',503);
    };
    const records=async()=>{
      const rows=await query(`select ${columns} from scout.records where kind='event' order by id limit 251`);
      if(rows.length>250)throw fail('Event count exceeds the reviewed calendar limit',503);
      return rows;
    };
    if(action==='feed.ics'){
      const token=await secret('scout_calendar_feed'),supplied=url.searchParams.get('token');
      if(!token||token.length!==supplied.length||!timingSafeEqual(Buffer.from(token),Buffer.from(supplied)))throw fail('Not found',404);
      await reserve(1);
      const body=calendarFeed(await records()),etag='"'+createHash('sha256').update(body).digest('hex')+'"';
      if(Buffer.byteLength(body)>524288)throw fail('Feed exceeds the reviewed size limit',503);
      const feedHeaders={...headers,'Content-Type':'text/calendar; charset=utf-8',ETag:etag};
      return new Response(request.headers.get('if-none-match')===etag?null:body,{status:request.headers.get('if-none-match')===etag?304:200,headers:feedHeaders});
    }
    const identity=(await query(`select provider_id,identity_data->>'email' email from auth.identities
      where user_id=$1 and provider='google' and identity_data @> '{"iss":"https://accounts.google.com","email_verified":true,"custom_claims":{"hd":"oceanagentics.com"}}'`,[auth.userClaims.id]))[0];
    if(!identity)throw fail('Ocean Agentics Google identity required',403);
    if(identity.email!==owner)return action==='status'?json({manager:false}):json({error:'Only the calendar owner can configure this trial'},403);
    if(action==='status'){
      const trial=(await query('select expires_at,remaining from scout.calendar_trial where id'))[0];
      const connected=(await query("select exists(select 1 from vault.secrets where name='scout_calendar_google') connected"))[0].connected;
      return json({manager:true,connected,backend_ready:Boolean(clientId&&clientSecret),calendar_id:owner,...trial});
    }
    const raw=await request.text();
    if(Buffer.byteLength(raw)>16384)throw fail('Request too large');
    const body=raw?JSON.parse(raw):{};
    if(!body||typeof body!=='object'||Array.isArray(body))throw fail('Invalid request');
    if(action==='feed-link'){
      const trial=(await query('select expires_at,remaining from scout.calendar_trial where id'))[0];
      if(!trial.expires_at||Date.parse(trial.expires_at)<=Date.now()||!trial.remaining)throw fail('Feed trial is not enabled yet',503);
      let token=await secret('scout_calendar_feed');
      if(!token){
        await query('select scout.save_calendar_secret($1,$2)',['scout_calendar_feed',randomBytes(32).toString('hex')]);cost.row_mutations++;
        token=await secret('scout_calendar_feed');
      }
      return json({url:project+'/functions/v1/scout-calendar/feed.ics?token='+token,expires_at:trial.expires_at});
    }
    const checkIdentity=async token=>{
      const profile=await send('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)});
      if(!profile.ok)throw fail('Google authorization could not be verified',403);
      const google=await profile.json();
      if(google.sub!==identity.provider_id||google.email!==owner||google.email_verified!==true)throw fail('Connect the same Google account you use for Scout',403);
      return google;
    };
    if(action==='connect'){
      if(typeof body.access_token!=='string'||!body.access_token)throw fail('Google did not return Calendar authorization; reconnect with consent');
      if(body.refresh_token!=null&&(typeof body.refresh_token!=='string'||!body.refresh_token||body.refresh_token.length>4096))throw fail('Invalid offline authorization');
      await reserve(1);
      const google=await checkIdentity(body.access_token);
      const check=await send('https://www.googleapis.com/calendar/v3/calendars/'+encodeURIComponent(owner)+'/events?maxResults=1&fields=kind',{
        headers:{Authorization:'Bearer '+body.access_token},signal:AbortSignal.timeout(10000)});
      if(!check.ok){
        const problem=(await check.json().catch(()=>null))?.error;
        const reasons=[...(problem?.errors??[]),...(problem?.details??[])].map(item=>item.reason);
        if(reasons.some(reason=>['accessNotConfigured','SERVICE_DISABLED'].includes(reason)))
          throw fail('Google Calendar API is disabled in Scout’s Google Cloud project. Reconnecting will not fix this; the project administrator must enable it. You can still use the subscription link.',503,'calendar_api_disabled');
        if(reasons.some(reason=>['insufficientPermissions','ACCESS_TOKEN_SCOPE_INSUFFICIENT'].includes(reason)))
          throw fail('Google sign-in succeeded, but Calendar permission was not granted. Reconnect and approve Calendar access.',403);
        if(check.status===429||reasons.some(reason=>['rateLimitExceeded','userRateLimitExceeded','quotaExceeded'].includes(reason)))
          throw fail('Google Calendar’s request limit was reached. Wait before trying again; reconnecting will not help.',429);
        throw fail(check.status===401?'Google authorization expired. Reconnect Google Calendar.':'Google denied access to this calendar. Check your Workspace Calendar access; repeated sign-ins will not fix this.',check.status===401?401:403);
      }
      if(body.refresh_token){
        await query('select scout.save_calendar_secret($1,$2)',['scout_calendar_google',JSON.stringify({refresh_token:body.refresh_token,sub:google.sub})]);cost.row_mutations++;
      }
      return json({connected:true,backend_ready:Boolean(clientId&&clientSecret)});
    }
    if(body.access_token!==undefined&&(typeof body.access_token!=='string'||!body.access_token))throw fail('Invalid Google authorization');
    if(!body.access_token&&(!clientId||!clientSecret))throw fail('Reconnect Google Calendar to sync during this session',409);
    await reserve(26);
    const metrics={requests:0,writes:0};
    let result;
    try{
      let token=body.access_token;
      if(!token){
        const saved=await secret('scout_calendar_google');
        if(!saved)throw fail('Connect Google Calendar first',409);
        token=await googleAccessToken({clientId,clientSecret,refreshToken:JSON.parse(saved).refresh_token},send);
      }
      await checkIdentity(token);
      result=await syncCalendar(await records(),{calendarId:owner,accessToken:token,send,metrics});
    }finally{
      // Requests whose responses are uncertain remain charged; only undispatched capacity returns.
      await query('update scout.calendar_trial set remaining=remaining+$1 where id',[26-metrics.requests]);
    }
    return json({...result,cost:{...cost,google_calendar_requests:metrics.requests,google_calendar_writes:metrics.writes}});
  }catch(error){return json({error:error.status?error.message:'Calendar operation interrupted; no automatic retry',...(error.status&&error.code?{code:error.code}:{})},error.status??502);}
  finally{session?.release();await sql?.end({timeout:1}).catch(()=>{});}
}
