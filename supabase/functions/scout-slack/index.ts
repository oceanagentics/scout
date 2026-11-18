import {createHmac,timingSafeEqual} from 'node:crypto';
import {Buffer} from 'node:buffer';

// Receive Slack events without retaining message bodies. Conversation features are deferred.
export async function hostedSlack(request,{signingSecret,now=()=>Date.now()}={}){
  if(request.method!=='POST')return new Response('POST required',{status:405});
  if(!signingSecret)return new Response('Slack signing secret unavailable',{status:503});
  const timestamp=request.headers.get('x-slack-request-timestamp'),signature=request.headers.get('x-slack-signature');
  if(!/^\d+$/.test(timestamp??'')||Math.abs(now()/1000-Number(timestamp))>300||!/^v0=[a-f0-9]{64}$/.test(signature??''))
    return new Response('Invalid Slack signature',{status:401});
  const body=await request.text(),expected='v0='+createHmac('sha256',signingSecret).update(`v0:${timestamp}:${body}`).digest('hex');
  if(!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))return new Response('Invalid Slack signature',{status:401});
  let event;
  try{event=JSON.parse(request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')?
    new URLSearchParams(body).get('payload'):body);}catch{return new Response('Invalid Slack payload',{status:400});}
  if(event?.type==='url_verification'&&typeof event.challenge==='string')return Response.json({challenge:event.challenge});
  if(event?.type==='event_callback'&&event.team_id==='TFZ8FRLBV')return new Response(null,{status:200});
  if(event?.type==='block_actions'&&event.team?.id==='TFZ8FRLBV')return new Response(null,{status:200});
  return new Response('Unsupported Slack payload',{status:400});
}

if(typeof Deno!=='undefined')Deno.serve(request=>hostedSlack(request,{signingSecret:Deno.env.get('SLACK_SIGNING_SECRET')}));
