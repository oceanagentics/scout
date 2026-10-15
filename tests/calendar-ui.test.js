import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mountCalendar} from '../website/calendar.js';

test('calendar consent uses existing Google sign-in; callback connects once and one click syncs all',async()=>{
  const previous=globalThis.window,storage=new Map(),calls=[];let oauth,apiDisabled=false;
  const nodes=Object.fromEntries(['status','connect','sync','feed','url','subscription'].map(id=>[id,{
    hidden:true,events:{},addEventListener(name,callback){this.events[name]=callback;},focus(){},select(){},
  }]));
  const root={hidden:true,querySelector:id=>nodes[id.slice(10)],replaceChildren(){this.innerHTML='';}};
  globalThis.window={location:{origin:'https://bbnj-scout.web.app'},sessionStorage:{
    getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}};
  const tick=()=>new Promise(setImmediate);
  const client={auth:{signInWithOAuth:async value=>{oauth=value;return {};}},functions:{invoke:async(path,options)=>{
    calls.push({path,options});
    if(apiDisabled&&path.endsWith('connect'))return {error:{context:Response.json({error:'Calendar API must be enabled by the administrator.',code:'calendar_api_disabled'},{status:503})}};
    return {data:path.endsWith('status')?{manager:true,connected:false,calendar_id:'danny@oceanagentics.com'}:
      path.endsWith('connect')?{connected:true,backend_ready:false}:
      path.endsWith('sync')?{created:15,updated:0,removed:0,unchanged:0}:{url:'https://example.org/private-feed'}};
  }}};
  try{
    let close=mountCalendar(client,{},root);await tick();assert.equal(root.hidden,false);
    assert.equal(nodes.connect.disabled,false);assert.equal(nodes.feed.disabled,false);
    assert.doesNotMatch(nodes.status.textContent,/trial|allowance|ends/i);
    await nodes.connect.events.click();
    assert.equal(oauth.options.redirectTo,'https://bbnj-scout.web.app/');
    assert.match(oauth.options.scopes,/calendar.events/);assert.equal(oauth.options.queryParams.access_type,'offline');
    assert.equal(oauth.options.queryParams.prompt,'consent');close();
    close=mountCalendar(client,{provider_token:'access',provider_refresh_token:'refresh'},root);await tick();
    assert.equal(calls.filter(call=>call.path.endsWith('connect')).length,1);
    assert.equal(storage.has('scout-calendar-connect'),false);assert.equal(nodes.sync.disabled,false);
    await nodes.sync.events.click();assert.match(nodes.status.textContent,/15 added/);
    assert.deepEqual(calls.find(call=>call.path.endsWith('sync')).options.body,{access_token:'access'});
    await nodes.feed.events.click();assert.equal(nodes.url.value,'https://example.org/private-feed');
    close();assert.equal(root.hidden,true);assert.equal(root.innerHTML,'');
    apiDisabled=true;storage.set('scout-calendar-connect',String(Date.now()));
    close=mountCalendar(client,{provider_token:'access'},root);await tick();
    assert.equal(nodes.connect.disabled,true,'Do not offer repeated consent for a disabled API');
    assert.equal(nodes.feed.disabled,false,'The subscription remains available');
    assert.match(nodes.status.textContent,/administrator/);
    assert.equal(storage.has('scout-calendar-connect'),false);close();
  }finally{globalThis.window=previous;}
});
