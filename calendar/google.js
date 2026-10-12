import {normalizeDate,dateInterval,dateLabel} from '../src/finding.js';
import {sourceLink} from '../src/records.js';

const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const recordLink=id=>'https://bbnj-scout.web.app/?record='+id;
const marker=id=>'Scout record: '+recordLink(id);
const eventId=id=>'scout'+id.replaceAll('-','');
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');

export function calendarEvent(record){
  if(!uuid.test(record.id))throw new Error('Invalid Scout record ID');
  if(record.kind!=='event'||record.details?.status==='cancelled')return null;
  const date=value=>value&&normalizeDate(Object.fromEntries(Object.entries(value).filter(([k])=>k!=='utc')));
  const start=date(record.details?.start),end=date(record.details?.end);
  if(start?.precision!=='day')return null;
  if(end&&(dateInterval(end)[1]<start.value||start.utc&&end.utc&&end.utc<start.utc))throw new Error('Invalid event date range');
  const last=end?.precision==='day'?end.value:start.value;
  // Calendar requires an end. Incomplete clocks use an explicitly labelled date entry.
  const timed=Boolean(start.utc&&end?.utc&&end.utc>start.utc);
  const timing=timed?[]:[`Calendar date entry; ${start.time?'complete timing unavailable':'time unknown'}.`,
    'Source start: '+dateLabel(start),...(end?['Source end: '+dateLabel(end)]:['End time unknown.'])];
  const links=[['Source',record.canonical_url],['Registration',record.details?.registration_url]]
    .filter(([,url])=>sourceLink(url)).map(([label,url])=>label+': '+sourceLink(url));
  return {
    summary:'[Scout] '+record.title,
    description:[record.description,(record.organizations??[]).map(o=>o.name).join('; '),...timing,...links,
      'Informational event from Scout; registration may be required.',marker(record.id)].filter(Boolean).map(escape).join('\n\n'),
    location:record.details?.location??'',
    start:timed?{dateTime:start.utc}:{date:start.value},
    end:timed?{dateTime:end.utc}:{date:new Date(Date.parse(last+'T00:00:00Z')+86400000).toISOString().slice(0,10)},
    transparency:'transparent',visibility:'default',reminders:{useDefault:false,overrides:[]},
  };
}

export function sameEvent(current,desired){
  const boundary=value=>value?.date??(value?.dateTime?new Date(value.dateTime).toISOString():null);
  return ['summary','description','location'].every(k=>(current[k]??'')===(desired[k]??''))&&
    ['start','end'].every(k=>boundary(current[k])===boundary(desired[k]))&&
    current.transparency===desired.transparency&&(current.visibility??'default')===desired.visibility&&
    current.reminders?.useDefault===false&&!(current.reminders.overrides??[]).length;
}

// Reconcile a complete, bounded snapshot in one action. Never retry uncertain writes.
export async function syncCalendar(records,{calendarId,accessToken,send=fetch,reserveWrites=async()=>{},metrics={requests:0,writes:0}}){
  if(!calendarId||calendarId==='primary'||!accessToken)throw new Error('Explicit calendar ID and Google access token required');
  if(records.length>250)throw new Error('Event count exceeds the reviewed calendar limit');
  const base='https://www.googleapis.com/calendar/v3/calendars/'+encodeURIComponent(calendarId)+'/events';
  const deadline=Date.now()+90000;
  async function request(path,{method='GET',body,etag}={}){
    if(metrics.requests>=51||Date.now()>=deadline||method!=='GET'&&metrics.writes>=50)throw new Error('Calendar trial request limit');
    metrics.requests++;if(method!=='GET')metrics.writes++;
    let response;
    try{response=await send(base+path,{method,headers:{Authorization:'Bearer '+accessToken,'Content-Type':'application/json',...(etag?{'If-Match':etag}:{})},
      ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(Math.min(12000,deadline-Date.now()))});}
    catch{throw new Error(method==='GET'?'Calendar read interrupted':'Calendar outcome unknown; inspect before retrying');}
    if(!response.ok)throw new Error('Calendar HTTP '+response.status+'; no automatic retry');
    return response.status===204?null:response.json();
  }
  const listed=await request('?'+new URLSearchParams({privateExtendedProperty:'scout=events-v1',maxResults:'250',showDeleted:'true'}));
  if(listed.nextPageToken)throw new Error('Calendar entries exceed the reviewed limit');
  const existing=new Map(),source=new Map(records.map(record=>[eventId(record.id),record]));
  for(const event of listed.items??[]){
    if(existing.has(event.id))throw new Error('Ambiguous Scout calendar entries');
    existing.set(event.id,event);
  }
  const actions=[],result={created:0,updated:0,removed:0,unchanged:0,skipped:0};
  for(const id of new Set([...source.keys(),...existing.keys()])){
    const record=source.get(id),current=existing.get(id);
    if(current?.status==='cancelled'){result.skipped++;continue;}
    const event=record?calendarEvent(record):null;
    if(!event&&!current){result.skipped++;continue;}
    if(current){
      const recordId=current.extendedProperties?.private?.record_id;
      if(!uuid.test(recordId??'')||id!==eventId(recordId)||!current.description?.split(/\r?\n/).includes(marker(recordId)))throw new Error('Calendar entry is not owned by Scout');
      if(current.attendees?.length||current.recurrence||current.recurringEventId)throw new Error('Calendar entry has guests or recurrence; review manually');
      if(event&&sameEvent(current,event)){result.unchanged++;continue;}
      if(!current.etag)throw new Error('Calendar revision required');
    }
    actions.push({id,record,current,event});
  }
  if(actions.length>50)throw new Error('More than 50 changes need review before syncing');
  if(actions.length)await reserveWrites(actions.length);
  // Validate every planned change before making the first write.
  for(const {id,record,current,event} of actions){
    if(!event){await request('/'+id+'?sendUpdates=none',{method:'DELETE',etag:current.etag});result.removed++;}
    else if(!current){
      await request('?sendUpdates=none',{method:'POST',body:{...event,id,extendedProperties:{private:{scout:'events-v1',record_id:record.id}}}});result.created++;
    }else{
      const body={...event};
      for(const key of ['start','end'])body[key]={date:null,dateTime:null,timeZone:null,...event[key]};
      await request('/'+id+'?sendUpdates=none',{method:'PATCH',body,etag:current.etag});result.updated++;
    }
  }
  return result;
}

export async function googleAccessToken({clientId,clientSecret,refreshToken},send=fetch){
  if(!clientId||!clientSecret||!refreshToken)throw new Error('Scout Google OAuth client and refresh token required');
  const response=await send('https://oauth2.googleapis.com/token',{method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},signal:AbortSignal.timeout(12000),
    body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,refresh_token:refreshToken,grant_type:'refresh_token'})});
  if(!response.ok)throw new Error('Google authorization HTTP '+response.status);
  const result=await response.json();
  if(!result.access_token)throw new Error('Google authorization returned no access token');
  return result.access_token;
}
