import {sourceLink,PUBLICATION_SCORE} from '../shared/records.js';

export const CHANNEL='C0C5PE21KN1';
export const DM_CHANNEL='D0C5XA5RT41';
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('|','%7C');

export async function readRecords(db,{kind,ids=[]}){
  if(kind==='findings'&&!ids.length)return [];
  const where=kind==='findings'?'r.id=any($1::uuid[])':"r.slack_channel_post is null or r.slack_channel_post->>'state'='uncertain'";
  const scored=kind==='findings'?'r.score is not null':`r.score>=${PUBLICATION_SCORE}`;
  return (await db.query(`select r.*,r.modified::text[] as modified from scout.records r where ${scored} and (${where}) order by r.date nulls last,r.id`,
    kind==='findings'?[ids]:[])).rows;
}

export async function prepareMessages(db,{kind='unposted',ids=[],now=new Date()}={}) {
  if(!['findings','unposted'].includes(kind))throw new Error('Unknown notification kind');
  const records=await readRecords(db,{kind,ids});
  const payloads=records.map(r=>{
    const source=(r.sources??[]).find(s=>s.role==='finding'&&sourceLink(s.url)),url=sourceLink(source?.url);
    return {channel:r.score>=PUBLICATION_SCORE?CHANNEL:DM_CHANNEL,text:`${escape(r.description)}${url?' · <'+escape(url)+'|'+escape(source.name||'Read more')+'>':''}`,parse:'none',unfurl_links:false,unfurl_media:false,
      metadata:{event_type:'scout_finding',event_payload:{record_id:r.id}}};
  });
  return {records,payloads,prepared_at:now.toISOString()};
}

export async function sendMessages(db,preview,post,{now=()=>new Date(),deadline=Infinity}={}) {
  const outcome={status:'no_change',communicated:0,skipped:0,uncertain:0};
  if(!preview.records.length)return outcome;
  if(now()-Date.parse(preview.prepared_at)>60000)throw new Error('Preview expired');
  const current=(await db.query(`select r.id,r.slack_channel_post from scout.records r join unnest($1::uuid[],$2::text[]) expected(id,modified)
    on r.id=expected.id and r.modified[cardinality(r.modified)]=expected.modified::timestamptz`,
    [preview.records.map(r=>r.id),preview.records.map(r=>r.modified.at(-1))])).rows;
  if(current.length!==preview.records.length)throw new Error('Preview changed');
  const receipts=new Map(current.map(r=>[r.id,r.slack_channel_post]));
  for(const payload of preview.payloads){
    const id=payload.metadata.event_payload.record_id,channelPost=payload.channel===CHANNEL;
    if(channelPost&&['posted','do_not_post'].includes(receipts.get(id)?.state)){outcome.skipped++;continue;}
    if(channelPost&&receipts.get(id)?.state==='uncertain'){outcome.uncertain++;continue;}
    if(outcome.communicated)await new Promise(resolve=>setTimeout(resolve,1000));
    if(+now()>=deadline)return {...outcome,status:'unknown',error:'runtime_bound'};
    if(channelPost){
      const claimed=await db.query(`update scout.records set slack_channel_post='{"state":"uncertain"}'::jsonb
       where id=$1 and score>=${PUBLICATION_SCORE} and slack_channel_post is null
       and modified[cardinality(modified)]=$2::timestamptz returning id`,[id,preview.records.find(r=>r.id===id).modified.at(-1)]);
      if(!claimed.rows.length){
        const receipt=(await db.query('select slack_channel_post from scout.records where id=$1',[id])).rows[0]?.slack_channel_post;
        if(['posted','do_not_post'].includes(receipt?.state))outcome.skipped++;
        else if(receipt?.state==='uncertain')outcome.uncertain++;
        else return {...outcome,status:'failed',error:'preview_changed',record_id:id};
        continue;
      }
    }
    let status='unknown',error='slack_invalid_response',ts;
    try{
      const response=await post(payload);
      error='slack_http_'+response.status;
      if(response.status>=400&&response.status<500)status='failed';
      if(response.status===200){
        error='slack_invalid_response';
        const result=JSON.parse(response.body);
        if(result.ok===true&&result.channel===payload.channel&&typeof result.ts==='string'&&/^\d+\.\d+$/.test(result.ts)){status='sent';ts=result.ts;}
        else if(result.ok===false){
          error=/^[a-z][a-z0-9_]{0,63}$/.test(result.error??'')?result.error:'slack_rejected';
          if(!['internal_error','fatal_error','request_timeout','service_unavailable'].includes(error))status='failed';
        }
      }
    }catch(cause){error=cause instanceof SyntaxError?'slack_invalid_response':['slack_timeout','slack_transport'].includes(cause?.reason)?cause.reason:'slack_transport';}
    if(status==='sent')outcome.communicated++;
    if(channelPost&&status!=='unknown'){
      try{
        await db.query(`update scout.records set slack_channel_post=$2::jsonb
         where id=$1 and slack_channel_post='{"state":"uncertain"}'::jsonb`,
        [id,status==='sent'?JSON.stringify({state:'posted',ts}):null]);
      }catch{return {...outcome,status:'unknown',uncertain:outcome.uncertain+1,error:'slack_receipt_failed',record_id:id};}
    }
    if(status!=='sent')return {...outcome,status,uncertain:outcome.uncertain+(channelPost&&status==='unknown'?1:0),error,record_id:id};
  }
  return {...outcome,status:outcome.uncertain?'unknown':outcome.communicated?'sent':'no_change',
    ...(outcome.uncertain?{error:'slack_delivery_uncertain'}:{})};
}

export async function readPostedFindings(token,{fetch:send=fetch,deadline=Date.now()+115000}={}){
  if(typeof token!=='string'||!token.startsWith('xoxb-'))throw Object.assign(new Error('Missing Scout bot token'),{reason:'slack_configuration'});
  const posted=new Map();let cursor='';
  do{
    const remaining=deadline-Date.now();
    if(remaining<=0)throw Object.assign(new Error('Slack history incomplete'),{reason:'slack_history_incomplete'});
    const url=new URL('https://slack.com/api/conversations.history');
    for(const [key,value]of Object.entries({channel:CHANNEL,limit:'200',include_all_metadata:'true',...(cursor?{cursor}:{})}))url.searchParams.set(key,value);
    const response=await send(url,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(Math.min(15000,remaining))});
    const result=await response.json();
    if(!response.ok||result.ok!==true||!Array.isArray(result.messages))
      throw Object.assign(new Error('Slack history unavailable'),{reason:'slack_history_failed'});
    for(const message of result.messages){
      const id=message.metadata?.event_payload?.record_id;
      if((message.user==='U0C6PNRPX4G'||message.bot_id==='B0C5TDBU5UN')&&message.metadata?.event_type==='scout_finding'
        &&typeof id==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)
        &&typeof message.ts==='string'&&/^\d+\.\d+$/.test(message.ts))posted.set(id,message.ts);
    }
    const next=result.response_metadata?.next_cursor??'';
    if(result.is_limited||result.has_more&&!next||next&&next===cursor)
      throw Object.assign(new Error('Slack history incomplete'),{reason:'slack_history_incomplete'});
    cursor=next;
  }while(cursor);
  return posted;
}

export function botTransport(token,send=fetch,{deadline=Infinity}={}) {
  if(typeof token!=='string'||!token.startsWith('xoxb-'))throw Object.assign(new Error('Missing Scout bot token'),{reason:'slack_configuration'});
  return async body=>{
    let response;
    try{response=await send('https://slack.com/api/chat.postMessage',{method:'POST',
      headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json; charset=utf-8'},
      body:JSON.stringify(body),signal:AbortSignal.timeout(Math.max(1,Math.min(12000,deadline-Date.now())))});
      return {status:response.status,body:await response.text()};
    }catch(cause){throw Object.assign(new Error('Slack transport failed'),{reason:cause?.name==='TimeoutError'||Date.now()>=deadline?'slack_timeout':'slack_transport'});}
  };
}
