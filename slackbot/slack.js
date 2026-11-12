import { request } from 'node:https';
import {Buffer} from 'node:buffer';
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
    const url=(r.sources??[]).map(sourceLink).find(Boolean);
    if(!url)throw new Error('Notification requires a supporting source link');
    const tag=r.priority[0]+(r.type??'finding')[0];
    return {text:`${escape(r.description)} [${tag}] · <${escape(url)}|Read more>`,parse:'none',unfurl_links:false,unfurl_media:false};
  });
  return {records,payloads,prepared_at:now.toISOString()};
}

export async function sendMessages(db,preview,post,{now=()=>new Date()}={}) {
  if(!preview.records.length)return {status:'no_change',communicated:0};
  if(now()-Date.parse(preview.prepared_at)>60000)throw new Error('Preview expired');
  const current=(await db.query(`select r.id from scout.records r join unnest($1::uuid[],$2::text[]) expected(id,modified)
    on r.id=expected.id and r.modified[cardinality(r.modified)]=expected.modified::timestamptz`,
    [preview.records.map(r=>r.id),preview.records.map(r=>r.modified.at(-1))])).rows;
  if(current.length!==preview.records.length)throw new Error('Preview changed');
  let communicated=0;
  for(const payload of preview.payloads){
    if(communicated)await new Promise(resolve=>setTimeout(resolve,1000));
    let status='unknown';
    try{const response=await post(payload);status=response.status===200&&response.body.trim()==='ok'?'sent':response.status>=400&&response.status<500?'failed':'unknown';}catch{}
    if(status!=='sent')return {status,communicated};
    communicated++;
  }
  return {status:'sent',communicated};
}

export function webhookTransport(value,send) {
  let url;
  try { url=new URL(value); } catch { throw new Error('Missing Scout webhook'); }
  if (url.protocol!=='https:'||url.host!=='hooks.slack.com'||url.username||url.password||url.search||url.hash||
      !/^\/services\/TFZ8FRLBV\/B0C5TEK4R38\/[A-Za-z0-9]+$/.test(url.pathname)) throw new Error('Webhook does not match the confirmed Scout installation');
  if(send)return async body=>{
    const response=await send(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
    const reader=response.body?.getReader();let content='',bytes=0;
    try{for(;;){const part=await reader?.read();if(!part||part.done)break;bytes+=part.value.byteLength;
      if(bytes>4096)throw new Error('Response limit');content+=new TextDecoder().decode(part.value);}}
    finally{await reader?.cancel().catch(()=>{});}
    return {status:response.status,body:content};
  };
  return body=>new Promise((resolve,reject)=>{
    const req=request(url,{method:'POST',headers:{'Content-Type':'application/json'}},res=>{
      let content='';res.setEncoding('utf8');
      res.on('data',chunk=>{content+=chunk;if(Buffer.byteLength(content)>4096)req.destroy(new Error('Response limit'));});
      res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,body:content}));
    });
    const timer=setTimeout(()=>req.destroy(new Error('Delivery timeout')),12000);
    req.on('close',()=>clearTimeout(timer));req.on('error',reject);req.end(JSON.stringify(body));
  });
}
