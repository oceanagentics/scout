import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mountCalendar} from '../website/calendar.js';

test('calendar offers the private subscription link without Google authorization',async()=>{
  const calls=[];
  const nodes=Object.fromEntries(['status','feed','url','subscription'].map(id=>[id,{
    hidden:true,events:{},addEventListener(name,callback){this.events[name]=callback;},focus(){},select(){},
  }]));
  const root={hidden:true,querySelector:id=>nodes[id.slice(10)],replaceChildren(){this.innerHTML='';}};
  const tick=()=>new Promise(setImmediate);
  const client={functions:{invoke:async(path,options)=>{
    calls.push({path,options});
    return {data:path.endsWith('status')?{manager:true}:{url:'https://example.org/private-feed'}};
  }}};
  const close=mountCalendar(client,root);await tick();
  assert.equal(root.hidden,false);assert.equal(nodes.feed.disabled,false);
  assert.doesNotMatch(root.innerHTML,/calendar-connect|calendar-sync/);
  assert.match(nodes.status.textContent,/automatic/);
  await nodes.feed.events.click();
  assert.equal(nodes.url.value,'https://example.org/private-feed');assert.equal(nodes.subscription.hidden,false);
  assert.deepEqual(calls,[{path:'scout-calendar/status',options:{method:'GET'}},
    {path:'scout-calendar/feed-link',options:{method:'POST'}}]);
  close();assert.equal(root.hidden,true);assert.equal(root.innerHTML,'');
});
