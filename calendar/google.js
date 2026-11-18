import {calendarEvent} from './feed.js';

const calendar='c_c4eba5697d3a3e33c4590daa7c20c8791d7d608b787ff959bf3117f3a7d02df5@group.calendar.google.com';
const scope='https://www.googleapis.com/auth/calendar.events.owned';
const base='https://www.googleapis.com/calendar/v3/calendars/'+encodeURIComponent(calendar)+'/events';
const fail=(message,status=502)=>Object.assign(new Error(message),{status});
const eventId=id=>'scout'+id.replaceAll('-','');
const managed=event=>event.extendedProperties?.private?.scout==='1';
const time=value=>value?.date??(value?.dateTime?new Date(value.dateTime).toISOString():null);
const content=event=>JSON.stringify([event.summary??'',event.description??'',time(event.start),time(event.end),
  event.status??'confirmed',event.transparency??'opaque',event.reminders?.useDefault??true,event.reminders?.overrides??[],
  event.extendedProperties?.private?.scout_modified]);

export function googleEvent(record){
  const event=calendarEvent(record);
  if(!event)return null;
  const {start,end,allDay}=event;
  let timing,description=event.description;
  if(start.utc&&!allDay){
    timing={start:{dateTime:start.utc},end:{dateTime:end?.utc??new Date(Date.parse(start.utc)+30*60000).toISOString()}};
    if(!end?.utc)description+='\n\nEnd time unknown; displayed end is a 30-minute placeholder.';
  }else{
    const through=end?.precision==='day'?end.value:start.value;
    timing={start:{date:start.value},end:{date:new Date(Date.parse(through+'T00:00:00Z')+86400000).toISOString().slice(0,10)}};
    if(start.time&&!allDay)description+='\n\nCalendar date entry; the published clock cannot be resolved to a unique instant.';
  }
  return {id:eventId(record.id),summary:event.summary,description,...timing,status:'confirmed',
    transparency:'transparent',reminders:{useDefault:false},extendedProperties:{private:{scout:'1',
      scout_modified:new Date(record.modified.at(-1)).toISOString()}}};
}

async function openCalendar(credential,{deadline,fetch:send},metrics){
  const signal=AbortSignal.timeout(Math.max(1,deadline-Date.now()));
  async function request(url,options={},missing=false){
    let response,data;
    try{
      metrics.google_requests++;
      response=await send(url,{...options,signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])});
      data=response.status===204?null:await response.json();
    }catch{throw fail('Google Calendar request interrupted; reconciliation can repair an uncertain write.');}
    if(missing&&response.status===404)return null;
    if(!response.ok)throw fail(data?.error==='invalid_grant'?'Google Calendar authorization was revoked or expired.':
      'Google Calendar request failed (HTTP '+response.status+').');
    return data;
  }
  if(!credential?.client_id||!credential.client_secret||!credential.refresh_token)
    throw fail('Google Calendar OAuth credential is unavailable.',503);
  const token=await request('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({
    grant_type:'refresh_token',refresh_token:credential.refresh_token,client_id:credential.client_id,client_secret:credential.client_secret})});
  if(!token.access_token||!token.scope?.split(' ').includes(scope))throw fail('Google Calendar permission is missing.',403);
  const options=(method,body,etag)=>({method,headers:{Authorization:'Bearer '+token.access_token,
    ...(body?{'Content-Type':'application/json'}:{}),...(etag?{'If-Match':etag}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {
    get:id=>request(base+'/'+id,options('GET'),true),
    async list(){
      const events=[];let pageToken;
      do{
        const query=new URLSearchParams({privateExtendedProperty:'scout=1',showDeleted:'true',maxResults:'2500',...(pageToken?{pageToken}:{})});
        const page=await request(base+'?'+query,options('GET'));
        events.push(...page.items??[]);pageToken=page.nextPageToken;
      }while(pageToken);
      return events;
    },
    write:(event,current)=>request(base+(current?'/'+event.id:'')+'?sendUpdates=none',
      options(current?'PUT':'POST',current?{...current,...event}:event,current?.etag)),
    remove:event=>request(base+'/'+event.id+'?sendUpdates=none',options('DELETE',undefined,event.etag)),
  };
}

export async function syncCalendar(db,{ids=null,deadline=Date.now()+110000,fetch:send=fetch}={}){
  const counts={created:0,updated:0,removed:0,unchanged:0},metrics={google_requests:0};
  try{
    const row=(await db.query("select decrypted_secret from vault.decrypted_secrets where name='scout_calendar_google'")).rows[0];
    const google=await openCalendar(row?JSON.parse(row.decrypted_secret):null,{deadline,fetch:send},metrics);
    // Read Google before the source snapshot, so newly saved records cannot become apparent orphans.
    let existing;
    if(ids){
      existing=[];
      for(const id of ids){const event=await google.get(eventId(id));if(event)existing.push(event);}
    }else existing=await google.list();
    const records=(await db.query(`select id,modified,type,priority,description,organizations,date,starttime,timezone,enddate,endtime,sources
      from scout.records ${ids?'where id=any($1::uuid[])':"where type='event'"} order by id`,ids?[ids]:[])).rows;
    // Complete mapping before any writes, including removals.
    const desired=new Map();
    for(const record of records){const event=googleEvent(record);if(event)desired.set(event.id,event);}
    const current=new Map(existing.map(event=>[event.id,event]));
    for(const [id,event] of desired){
      const previous=current.get(id);
      if(previous&&!managed(previous))throw fail('Refusing to overwrite an unmanaged Google event.',409);
      if(previous&&(Date.parse(previous.extendedProperties.private.scout_modified)>
        Date.parse(event.extendedProperties.private.scout_modified)||content(previous)===content(event))){counts.unchanged++;continue;}
      await google.write(event,previous);counts[previous?'updated':'created']++;
    }
    for(const event of existing){
      if(!managed(event)||event.status==='cancelled'||desired.has(event.id))continue;
      await google.remove(event);counts.removed++;
    }
    return {status:'ok',...counts,...metrics};
  }catch(error){return {status:'failed',...counts,...metrics,error:error.status?error.message:'Calendar synchronization interrupted.'};}
}
