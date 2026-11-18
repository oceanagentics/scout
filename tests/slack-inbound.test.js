import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {hostedSlack} from '../supabase/functions/scout-slack/index.ts';

const signingSecret='slack-signing-test',timestamp='1795000000',now=()=>Number(timestamp)*1000;
const signed=(body,stamp=timestamp,contentType='application/json')=>new Request('https://example.org/scout-slack',{method:'POST',body,
  headers:{'content-type':contentType,'x-slack-request-timestamp':stamp,
    'x-slack-signature':'v0='+createHmac('sha256',signingSecret).update(`v0:${stamp}:${body}`).digest('hex')}});

test('only a fresh signature over the exact body can verify a Slack event URL',async()=>{
 const body=JSON.stringify({type:'url_verification',challenge:'test-challenge'});
 const response=await hostedSlack(signed(body),{signingSecret,now});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{challenge:'test-challenge'});
 for(const request of [new Request('https://example.org/scout-slack',{method:'POST',body}),signed(body,String(Number(timestamp)-301))])
  assert.equal((await hostedSlack(request,{signingSecret,now})).status,401);
 const changed=signed(body);assert.equal((await hostedSlack(new Request(changed,{body:body+' '}),{signingSecret,now})).status,401);
 assert.equal((await hostedSlack(signed(body),{signingSecret:'other-app',now})).status,401);
 assert.equal((await hostedSlack(signed(body),{now})).status,503);
});

test('channel replies, mentions and DMs are acknowledged without retaining or returning their text',async()=>{
 for(const event of [
  {type:'app_mention',channel:'C123',text:'@scout question'},
  {type:'message',channel_type:'channel',channel:'C123',thread_ts:'123.456',text:'follow-up without a mention'},
  {type:'message',channel_type:'group',channel:'C123',text:'private reply'},
  {type:'message',channel_type:'im',channel:'D123',text:'private question'},
  {type:'message',channel_type:'mpim',channel:'G123',text:'group question'}]){
  const response=await hostedSlack(signed(JSON.stringify({type:'event_callback',team_id:'TFZ8FRLBV',event})),{signingSecret,now});
  assert.equal(response.status,200);assert.equal(await response.text(),'');
 }
 assert.equal((await hostedSlack(signed(JSON.stringify({type:'event_callback',team_id:'OTHER'})),{signingSecret,now})).status,400);
 assert.equal((await hostedSlack(signed('null'),{signingSecret,now})).status,400);
 assert.equal((await hostedSlack(signed('{'),{signingSecret,now})).status,400);
});

test('interactive calendar buttons use the same signed endpoint without implementing actions yet',async()=>{
 for(const [team,status] of [['TFZ8FRLBV',200],['OTHER',400]]){
  const body=new URLSearchParams({payload:JSON.stringify({type:'block_actions',team:{id:team},actions:[{action_id:'calendar'}]})}).toString();
  const response=await hostedSlack(signed(body,timestamp,'application/x-www-form-urlencoded'),{signingSecret,now});
  assert.equal(response.status,status);
 }
});
