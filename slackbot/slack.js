import {eventTiming,sourceLink} from '../shared/records.js';
import {recordDate,scoutDay} from '../shared/finding-dates.js';

export const CHANNEL='C0C5PE21KN1';
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('|','%7C');

export async function readRecords(db,{kind,ids=[],now=new Date()}){
  if(kind==='findings'&&!ids.length)return [];
  const where=kind==='findings'?'r.id=any($1::uuid[])':kind==='morning'?"r.type='event' and length(r.date)=10":
    "r.type='event' or (r.type='announcement' and r.modified[1]>=((($1::timestamptz at time zone 'America/New_York')-interval '7 days') at time zone 'America/New_York') and r.modified[1]<$1::timestamptz)";
  return (await db.query(`select r.*,r.modified::text[] as modified from scout.records r where r.priority='high' and (${where}) order by r.date nulls last,r.id`,
    kind==='findings'?[ids]:kind==='weekly'?[now.toISOString()]:[])).rows;
}

export async function prepareMessages(db,{kind='weekly',ids=[],now=new Date()}={}) {
  if(!['findings','morning','weekly'].includes(kind))throw new Error('Unknown notification kind');
  const today=scoutDay(now);
  const records=(await readRecords(db,{kind,ids,now})).filter(r=>{
    if(kind==='findings')return true;
    if(kind==='weekly')return r.type==='announcement'||eventTiming(r,now)!=='Past / started';
    const start=recordDate(r);
    return (start?.utc?scoutDay(new Date(start.utc)):start?.value)===today;
  });
  const payloads=records.map(r=>{
    const url=(r.sources??[]).filter(s=>s.role==='finding').map(s=>sourceLink(s.url)).find(Boolean);
    return {text:`${escape(r.description)}${url?' · <'+escape(url)+'|Read more>':''}`,parse:'none',unfurl_links:false,unfurl_media:false,
      metadata:{event_type:'scout_finding',event_payload:{record_id:r.id}}};
  });
  return {records,payloads,prepared_at:now.toISOString()};
}

export async function sendMessages(db,preview,post,{now=()=>new Date(),deadline=Infinity}={}) {
  if(!preview.records.length)return {status:'no_change',communicated:0};
  if(now()-Date.parse(preview.prepared_at)>60000)throw new Error('Preview expired');
  const current=(await db.query(`select r.id from scout.records r join unnest($1::uuid[],$2::text[]) expected(id,modified)
    on r.id=expected.id and r.modified[cardinality(r.modified)]=expected.modified::timestamptz`,
    [preview.records.map(r=>r.id),preview.records.map(r=>r.modified.at(-1))])).rows;
  if(current.length!==preview.records.length)throw new Error('Preview changed');
  let communicated=0;
  for(const payload of preview.payloads){
    if(+now()>=deadline)return {status:'unknown',communicated};
    if(communicated)await new Promise(resolve=>setTimeout(resolve,1000));
    let status='unknown';
    try{
      const response=await post(payload);
      if(response.status>=400&&response.status<500)status='failed';
      else if(response.status===200){
        const result=JSON.parse(response.body);
        if(result.ok===true&&result.channel===CHANNEL&&typeof result.ts==='string'&&/^\d+\.\d+$/.test(result.ts))status='sent';
        else if(result.ok===false&&!['internal_error','fatal_error','request_timeout','service_unavailable'].includes(result.error))status='failed';
      }
    }catch{}
    if(status!=='sent')return {status,communicated};
    communicated++;
  }
  return {status:'sent',communicated};
}

export function botTransport(token,send=fetch,{deadline=Infinity}={}) {
  if(typeof token!=='string'||!token.startsWith('xoxb-'))throw new Error('Missing Scout bot token');
  return async body=>{
    const response=await send('https://slack.com/api/chat.postMessage',{method:'POST',
      headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json; charset=utf-8'},
      body:JSON.stringify({...body,channel:CHANNEL}),signal:AbortSignal.timeout(Math.max(1,Math.min(12000,deadline-Date.now())))});
    return {status:response.status,body:await response.text()};
  };
}
