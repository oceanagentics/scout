import { request } from 'node:https';
import { eventTiming,recordDates,sourceLink,orderRecords } from '../src/records.js';

export const CHANNEL='C0C5PE21KN1';
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('|','%7C');

export async function readRecords(db){
  return (await db.query(`select r.*,r.relevance->>'reason' priority_reason
    from scout.records r where accepted_version=version and priority in ('high','normal')
    and not exists(select 1 from scout.delivery_state d where d.record_id=r.id and (d.version=r.version or d.status in ('sending','unknown')))
    order by updated_at desc,id limit 100`)).rows;
}

export function eligibleRecords(records,{kind='findings',from,through,now=new Date()}={}) {
  return orderRecords(records.filter(r=>{
    if(r.verification_pending||!r.accepted_version||r.accepted_version!==r.version||r.relevance?.state!=='assessed')return false;
    if (kind==='digest') {
      if (r.kind!=='event'||!['high','normal'].includes(r.priority)||r.details.status==='cancelled') return false;
      const [start,end]=recordDates(r);
      return !!start&&eventTiming(r,now)==='Upcoming'&&start<=through&&end>=from;
    }
    const age=now.getTime()-Date.parse(r.discovered_at);
    return r.priority==='high'&&!r.last_communicated_at&&age>=0&&age<=86400000&&
      (r.kind!=='event'||!['Cancelled','Past / started','In progress'].includes(eventTiming(r,now)));
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
    const url=(r.sources??[]).map(s=>sourceLink(s.url)).find(Boolean);
    if (!url) throw new Error('Notification requires a supporting source link');
    lines.push(`${escape(r.title)} <${escape(url)}|Read more>`);
  }
  return {records,payload:{text:lines.join('\n'),parse:'none',unfurl_links:false,unfurl_media:false},prepared_at:now.toISOString()};
}

export async function sendMessage(db,preview,post,{now=()=>new Date()}={}) {
  if (!preview.payload||!preview.records.length) return {status:'no_change',communicated:0};
  if(now()-Date.parse(preview.prepared_at)>60000)throw new Error('Preview expired');
  await db.transaction(async tx=>{
    for(const r of preview.records){
      const current=(await tx.query('select * from scout.records where id=$1 and version=$2 and accepted_version=version for update',[r.id,r.version])).rows[0];
      if(!current||String(current.updated_at)!==String(r.updated_at)||String(current.last_communicated_at)!==String(r.last_communicated_at))throw new Error('Preview changed');
      const claimed=(await tx.query(`insert into scout.delivery_state(record_id,version,status) values($1,$2,'sending')
        on conflict(record_id) do update set version=excluded.version,status='sending',at=clock_timestamp()
        where scout.delivery_state.version<excluded.version and scout.delivery_state.status='sent' returning record_id`,[r.id,r.version])).rows;
      if(!claimed.length)throw new Error('Delivery already reserved');
    }
  });
  let status='unknown';
  try{const response=await post(preview.payload);status=response.status===200&&response.body.trim()==='ok'?'sent':response.status>=400&&response.status<500?'failed':'unknown';}catch{}
  for(const r of preview.records)await db.query('update scout.delivery_state set status=$3,at=clock_timestamp() where record_id=$1 and version=$2 returning record_id',[r.id,r.version,status]);
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
