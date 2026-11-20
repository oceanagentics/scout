import {recordDate,recordEnd,dateLabel} from '../shared/finding-dates.js';
import {sourceLink,PUBLICATION_SCORE} from '../shared/records.js';

const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sharedCalendar='c_c4eba5697d3a3e33c4590daa7c20c8791d7d608b787ff959bf3117f3a7d02df5@group.calendar.google.com';
const reviewCalendar='c_d6d8bace0ef22918c156fc9878f310a210a4feb47a7f078744a99cceef293633@group.calendar.google.com';
const scope='https://www.googleapis.com/auth/calendar.events.owned';
const base='https://www.googleapis.com/calendar/v3/calendars/';
const fail=(message,status=502)=>Object.assign(new Error(message),{status});
const eventId=id=>'scout'+id.replaceAll('-','');
const managed=event=>event.extendedProperties?.private?.scout==='1';
const time=value=>value?.date??(value?.dateTime?new Date(value.dateTime).toISOString():null);
const content=event=>JSON.stringify([event.summary??'',event.description??'',time(event.start),time(event.end),
  event.status??'confirmed',event.transparency??'opaque',event.reminders?.useDefault??true,event.reminders?.overrides??[],
  event.extendedProperties?.private?.scout_modified]);

export function googleEvent(record){
  if(!uuid.test(record.id))throw new Error('Invalid Scout record ID');
  if(record.type!=='event')return null;
  const start=recordDate(record);
  if(start?.precision!=='day')return null;
  const end=recordEnd(record),allDay=!start.time||end?.precision==='day'&&end.value>start.value&&!end.time;
  const links=record.sources.map(s=>sourceLink(s.url)).filter(Boolean),registrationLinks=links.filter(url=>/regist/i.test(url));
  let timing,description=[record.description,record.organizations.join('; '),'Source start: '+dateLabel(start),
    ...(end?['Source end: '+dateLabel(end)]:[]),
    ...links.map(url=>(registrationLinks.includes(url)?'Registration link: ':'Source: ')+url),
    registrationLinks.length?'Registration is required.':'Informational event from Scout; registration may be required.',
    'Scout record: https://bbnj-scout.web.app/?record='+record.id].filter(Boolean).join('\n\n');
  if(start.utc&&!allDay){
    timing={start:{dateTime:start.utc},end:{dateTime:end?.utc??new Date(Date.parse(start.utc)+30*60000).toISOString()}};
    if(!end?.utc)description+='\n\nEnd time unknown; displayed end is a 30-minute placeholder.';
  }else{
    const through=end?.precision==='day'?end.value:start.value;
    timing={start:{date:start.value},end:{date:new Date(Date.parse(through+'T00:00:00Z')+86400000).toISOString().slice(0,10)}};
    if(start.time&&!allDay)description+='\n\nCalendar date entry; the published clock cannot be resolved to a unique instant.';
  }
  return {id:eventId(record.id),summary:record.description,description,...timing,status:'confirmed',
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
    get:(calendar,id)=>request(base+encodeURIComponent(calendar)+'/events/'+id,options('GET'),true),
    async list(calendar){
      const events=[];let pageToken;
      do{
        const query=new URLSearchParams({privateExtendedProperty:'scout=1',showDeleted:'true',maxResults:'2500',...(pageToken?{pageToken}:{})});
        const page=await request(base+encodeURIComponent(calendar)+'/events?'+query,options('GET'));
        events.push(...page.items??[]);pageToken=page.nextPageToken;
      }while(pageToken);
      return events;
    },
    write:(calendar,event,current)=>request(base+encodeURIComponent(calendar)+'/events'+(current?'/'+event.id:'')+'?sendUpdates=none',
      options(current?'PUT':'POST',current?{...current,...event}:event,current?.etag)),
    remove:(calendar,event)=>request(base+encodeURIComponent(calendar)+'/events/'+event.id+'?sendUpdates=none',options('DELETE',undefined,event.etag)),
  };
}

export async function syncCalendar(db,{ids=null,deadline=Date.now()+110000,fetch:send=fetch}={}){
  const counts={created:0,updated:0,removed:0,unchanged:0},metrics={google_requests:0};
  try{
    const row=(await db.query("select decrypted_secret from vault.decrypted_secrets where name='scout_calendar_google'")).rows[0];
    const google=await openCalendar(row?JSON.parse(row.decrypted_secret):null,{deadline,fetch:send},metrics);
    // Read Google before the source snapshot, so newly saved records cannot become apparent orphans.
    const calendars=new Map();
    for(const calendar of [sharedCalendar,reviewCalendar]){
      let existing;
      if(ids){
        existing=[];
        for(const id of ids){const event=await google.get(calendar,eventId(id));if(event)existing.push(event);}
      }else existing=await google.list(calendar);
      calendars.set(calendar,existing);
    }
    const records=(await db.query(`select id,modified,type,score,description,organizations,date,starttime,timezone,enddate,endtime,sources
      from scout.records ${ids?'where id=any($1::uuid[])':"where type='event'"} order by id`,ids?[ids]:[])).rows;
    // Complete mapping before any writes, including removals.
    const allEvents=new Map(),highEvents=new Map();
    for(const record of records){
      const event=googleEvent(record);if(!event)continue;
      allEvents.set(event.id,{...event,summary:(record.score==null?'':record.score+'/100 ')+event.summary});
      if(record.score>=PUBLICATION_SCORE)highEvents.set(event.id,{...event,summary:'🐧 '+event.summary});
    }
    for(const [calendar,existing] of calendars){
      const desired=calendar===sharedCalendar?highEvents:allEvents,current=new Map(existing.map(event=>[event.id,event]));
      for(const [id,event] of desired){
        const previous=current.get(id);
        if(previous&&!managed(previous))throw fail('Refusing to overwrite an unmanaged Google event.',409);
        if(previous&&(Date.parse(previous.extendedProperties.private.scout_modified)>
          Date.parse(event.extendedProperties.private.scout_modified)||content(previous)===content(event))){counts.unchanged++;continue;}
        await google.write(calendar,event,previous);counts[previous?'updated':'created']++;
      }
      for(const event of existing){
        if(!managed(event)||event.status==='cancelled'||desired.has(event.id))continue;
        await google.remove(calendar,event);counts.removed++;
      }
    }
    return {status:'ok',...counts,...metrics};
  }catch(error){return {status:'failed',...counts,...metrics,error:error.status?error.message:'Calendar synchronization interrupted.'};}
}
