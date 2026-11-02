import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mountCalendar} from '../website/calendar.js';

test('Scout Calendar button reveals the private link on demand and allows retry after errors',async()=>{
  const calls=[];let unavailable=false;
  const nodes=Object.fromEntries(['status','feed','url','subscription'].map(id=>[id,{
    hidden:true,events:{},addEventListener(name,callback){this.events[name]=callback;},focus(){},select(){},
  }]));
  const root={hidden:true,querySelector:id=>nodes[id.slice(10)],replaceChildren(){this.innerHTML='';}};
  const client={functions:{invoke:async(path,options)=>{
    calls.push({path,options});
    return unavailable?{error:{context:Response.json({error:'Sign in to Scout first'})}}:
      {data:{url:'https://example.org/private-feed'}};
  }}};
  const close=mountCalendar(client,root);
  assert.equal(root.hidden,false);assert.notEqual(nodes.feed.disabled,true);
  assert.match(root.innerHTML,/Scout Calendar/);assert.match(root.innerHTML,/<svg[^>]+aria-hidden="true"/);
  assert.doesNotMatch(root.innerHTML,/<summary>|calendar-connect|calendar-sync/);
  assert.deepEqual(calls,[]);assert.equal(nodes.subscription.hidden,true);assert.equal(nodes.status.hidden,true);
  unavailable=true;
  await nodes.feed.events.click();
  assert.equal(nodes.status.hidden,false);assert.match(nodes.status.textContent,/Sign in/);assert.equal(nodes.feed.disabled,false);
  unavailable=false;
  await nodes.feed.events.click();
  assert.equal(nodes.url.value,'https://example.org/private-feed');assert.equal(nodes.subscription.hidden,false);
  assert.equal(nodes.status.hidden,true);
  assert.deepEqual(calls,Array(2).fill({path:'scout-calendar/feed-link',options:{method:'POST'}}));
  close();assert.equal(root.hidden,true);assert.equal(root.innerHTML,'');
});
