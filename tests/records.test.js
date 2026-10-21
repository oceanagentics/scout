import {test} from 'node:test';
import assert from 'node:assert/strict';
import {eventLabel,trackerState,fieldLabel} from '../website/records.js';
import {eventTiming,recordDates,sourceLink,orderRecords} from '../shared/records.js';
import {loadScout} from '../website/dashboard.js';

test('flat reader displays local date/time and organization strings',()=>{
  const event={id:'event',type:'event',organizations:['Ocean Institute','Second Institute'],date:'2026-10-15',starttime:'00:30',timezone:'+08:00'};
  assert.deepEqual(recordDates(event),['2026-10-15','2026-10-15']);assert.ok(eventLabel(event).includes('2026-10-15 · 00:30 +08:00'));
  assert.equal(fieldLabel(event,'organizations'),'Ocean Institute; Second Institute');
  assert.equal(eventTiming(event,new Date('2026-10-14T16:00:00Z')),'Upcoming');
  assert.equal(eventTiming({...event,date:'2026-10-04',starttime:null},new Date('2026-10-04T12:00:00Z')),'Date known · time unknown');
  assert.equal(eventTiming({type:'event',date:null}),'Date unknown');
  const publication={id:'pub',type:'announcement',date:'2026-03'};
  assert.equal(eventLabel(publication),'Published · 2026-03 · month precision');
  assert.equal(eventLabel({type:'treaty_status',date:'2026-05-28'}),'Action date · 2026-05-28 · Time unknown');
  assert.equal(orderRecords([event,publication],'date')[0].id,'pub');
});
test('source links reject unsafe URLs and tracker freshness uses persisted run status',()=>{
  for(const url of ['javascript:alert(1)','https://user:secret@example.org'])assert.equal(sourceLink(url),null);
  assert.equal(trackerState({enabled:false,url:null}).availability,'Unconfigured');
  assert.equal(trackerState({enabled:false,url:'https://example.org'}).availability,'Disabled');
  assert.equal(trackerState({enabled:true,url:'https://example.org'}).availability,'Not checked');
  assert.equal(trackerState({enabled:true,url:'https://example.org',failure_count:3}).availability,'Needs attention');
  assert.equal(trackerState({enabled:true,url:'https://example.org',last_error:'quota'}).availability,'Retry scheduled');
});
test('reader sends filters and stable cursor to bounded server queries and surfaces errors',async()=>{
  const rows=Array.from({length:50},(_,i)=>({id:String(i),priority:'low',type:'announcement',organizations:[],date:'2026-03'})),calls=[];let fail=false;
  const client={rpc:async(name,args)=>{calls.push({name,args});return fail?{error:new Error('Unavailable')}:{data:name==='findings'?rows:[]};},
    from:table=>{assert.equal(table,'trackers');return{select(){return this;},order(){return this;},limit(n){assert.equal(n,500);return{data:[]};}};}};
  const result=await loadScout(client,{filters:{type:'announcement',organization:'Ocean Institute',meaning:'deadline',from:'2027-01-01'}});
  assert.deepEqual(result.records,rows);assert.equal(result.records.length,50);assert.deepEqual(result.next,{rank:2,day:'2026-03-01',id:'49'});
  assert.equal(calls[0].args.p_limit,50);assert.equal(calls[0].args.p_organization,'Ocean Institute');assert.equal(calls[0].args.p_meaning,'deadline');
  await loadScout(client,{after:result.next});assert.deepEqual(calls[1].args.p_after,result.next);
  assert.ok(calls.every(c=>c.name==='findings'));fail=true;await assert.rejects(loadScout(client),/Unavailable/);
});
