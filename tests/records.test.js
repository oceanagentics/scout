import {test} from 'node:test';
import assert from 'node:assert/strict';
import {eventLabel,eventTiming,recordDates,sourceLink,trackerState,fieldLabel,orderRecords} from '../src/records.js';
import {loadScout} from '../src/dashboard.js';
import {normalizeDate} from '../src/finding.js';

test('typed reader displays local dates, ranked organization names and independent date meanings',()=>{
  const event={id:'event',kind:'event',organizations:[{name:'Ocean Institute',role:'partner'},{name:'Second Institute'}],details:{start:normalizeDate({value:'2026-10-15',precision:'day',time:'00:30',zone:'+08:00'})}};
  assert.deepEqual(recordDates(event),['2026-10-15','2026-10-15']);assert.ok(eventLabel(event).includes('2026-10-15 · 00:30 +08:00'));
  assert.equal(fieldLabel(event,'organization'),'Ocean Institute; Second Institute');
  assert.equal(eventTiming(event,new Date('2026-10-14T16:00:00Z')),'Upcoming');
  const day={...event,details:{start:{value:'2026-10-03',precision:'day'},end:{value:'2026-10-05',precision:'day'}}};
  assert.equal(eventTiming(day,new Date('2026-10-04T12:00:00Z')),'Date known · time unknown');
  assert.equal(eventTiming({...day,details:{...day.details,status:'cancelled'}}),'Cancelled');
  assert.equal(eventTiming({kind:'event',details:{}}),'Date unknown');
  const publication={id:'pub',kind:'announcement',details:{published:{value:'2026-03',precision:'month'},effective:{value:'2027',precision:'year'}}};
  assert.equal(eventLabel(publication),'Published · 2026-03 · month precision');
  assert.equal(fieldLabel(publication,'ends_at'),'2027 · year precision');
  assert.equal(eventLabel({kind:'treaty_status',details:{action_date:{value:'2026-05-28',precision:'day'}}}),'Action date · 2026-05-28 · Time unknown');
  assert.equal(orderRecords([event,publication],'date')[0].id,'pub');
});
test('source links reject unsafe URLs and tracker freshness uses persisted run status',()=>{
  for(const url of ['javascript:alert(1)','https://user:secret@example.org'])assert.equal(sourceLink(url),null);
  assert.equal(trackerState({enabled:false,url:null}).availability,'Unconfigured');
  assert.equal(trackerState({enabled:false,url:'https://example.org'}).availability,'Collector not yet proven');
  assert.equal(trackerState({enabled:true,url:'https://example.org'}).success,'Never');
  const tracker={url:'https://example.org',last_success_at:'2026-10-01T11:00:00Z'};
  for(const outcome of ['partial','failed','quota'])assert.equal(trackerState({...tracker,last_outcome:outcome}).success,'2026-10-01 11:00 UTC');
});
test('reader sends filters and stable cursor to bounded server queries and surfaces errors',async()=>{
  const rows=Array.from({length:50},(_,i)=>({id:String(i),priority:'low',kind:'announcement',organizations:[],details:{published:{value:'2026-03',precision:'month'}}})),calls=[];let fail=false;
  const client={rpc:async(name,args)=>{calls.push({name,args});return fail?{error:new Error('Unavailable')}:{data:name==='findings'?rows:[]};},
    from:table=>{assert.equal(table,'tracker_status');return{select(){return this;},order(){return this;},limit(n){assert.equal(n,500);return{data:[]};}};}};
  const result=await loadScout(client,{filters:{kind:'announcement',organization:'Ocean Institute',meaning:'effective',from:'2027-01-01'}});
  assert.equal(result.records.length,50);assert.deepEqual(result.next,{rank:2,day:'2026-03-01',id:'49'});
  assert.equal(calls[0].args.p_limit,50);assert.equal(calls[0].args.p_organization,'Ocean Institute');assert.equal(calls[0].args.p_meaning,'effective');
  await loadScout(client,{after:result.next});assert.deepEqual(calls[2].args.p_after,result.next);
  assert.ok(calls.every(c=>['findings','finding_jobs'].includes(c.name)));fail=true;await assert.rejects(loadScout(client),/Unavailable/);
});
