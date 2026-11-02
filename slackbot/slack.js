import { request } from 'node:https';
import { eventTiming,recordDates,sourceLink,orderRecords } from '../shared/records.js';

export const CHANNEL='C0C5PE21KN1';
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('|','%7C');

export async function readRecords(db){
  return (await db.query(`select r.*,r.modified::text[] as modified
    from scout.records r where priority in ('high','normal')
    order by modified[cardinality(modified)] desc,id limit 100`)).rows;
}

export function eligibleRecords(records,{kind='findings',from,through,now=new Date()}={}) {
  return orderRecords(records.filter(r=>{
    if (kind==='digest') {
      if (r.type!=='event'||!['high','normal'].includes(r.priority)) return false;
      const [start,end]=recordDates(r);
      return !!start&&eventTiming(r,now)==='Upcoming'&&start<=through&&end>=from;
    }
    const age=now.getTime()-Date.parse(r.modified[0]);
    return r.priority==='high'&&age>=0&&age<=86400000&&
      (r.type!=='event'||eventTiming(r,now)!=='Past / started');
  }));
}

export async function prepareMessage(db,{model,kind='findings',from,through,now=new Date(),exclude=[]}={}) {
  const day=value=>/^\d{4}-\d{2}-\d{2}$/.test(value??'')&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
  if (!['findings','digest'].includes(kind)) throw new Error('Unknown notification kind');
  if (kind==='digest'&&(!day(from)||!day(through)||through<from||Date.parse(through)-Date.parse(from)>31*86400000)) throw new Error('Use an inclusive UTC digest window of at most 32 days');
  const candidates=eligibleRecords(await readRecords(db),{kind,from,through,now})
    .filter(r=>!exclude.some(e=>e.id===r.id)).slice(0,10);
  if (!candidates.length) return {records:[],payload:null};
  const records=candidates.slice(0,kind==='digest'?5:1);
  const lines=kind==='digest'?[`Upcoming events · ${from}–${through} UTC`]:[];
  for (const r of records) {
    const url=(r.sources??[]).map(sourceLink).find(Boolean);
    if (!url) throw new Error('Notification requires a supporting source link');
    lines.push(`${escape(r.description)} <${escape(url)}|Read more>`);
  }
  return {records,payload:{text:lines.join('\n'),parse:'none',unfurl_links:false,unfurl_media:false},prepared_at:now.toISOString()};
}

export async function sendMessage(db,preview,post,{now=()=>new Date()}={}) {
  if (!preview.payload||!preview.records.length) return {status:'no_change',communicated:0};
  if(now()-Date.parse(preview.prepared_at)>60000)throw new Error('Preview expired');
  for(const r of preview.records){
    const current=(await db.query('select id from scout.records where id=$1 and modified[cardinality(modified)]=$2',[r.id,r.modified.at(-1)])).rows[0];
    if(!current)throw new Error('Preview changed');
  }
  let status='unknown';
  try{const response=await post(preview.payload);status=response.status===200&&response.body.trim()==='ok'?'sent':response.status>=400&&response.status<500?'failed':'unknown';}catch{}
  return {status,communicated:status==='sent'?preview.records.length:0};
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
