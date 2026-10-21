import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeFinding} from '../reader/findings.js';

test('model fields stay flat, partial dates survive and organization names remain strings',()=>{
 const f=normalizeFinding({type:'announcement',description:'Brief',date:'2026-03',starttime:'12:00'},'https://example.org/a');
 assert.equal(f.date,'2026-03');assert.equal(f.starttime,'12:00');assert.equal(f.timezone,null);
 const event=normalizeFinding({type:'event',description:'Meeting',priority:'normal',organizations:['Ocean Institute','Ocean Institute','Partner'],date:'2026-04-02'},'https://example.org/a');
 assert.deepEqual(event.organizations,['Ocean Institute','Partner']);assert.equal(event.type,'event');
 assert.equal(event.priority,'normal');assert.deepEqual(event.sources,['https://example.org/a']);
 assert.deepEqual(Object.keys(event).sort(),['description','type','priority','organizations','deadline','date','starttime','timezone','sources'].sort());
});
test('invalid dates, clocks and zones remain null without losing the useful description',()=>{
 const f=normalizeFinding({type:'event',description:'Meeting',date:'2026-04-02',starttime:'13:30',timezone:'invalid'},'https://example.org/a');
 assert.equal(f.date,'2026-04-02');assert.equal(f.starttime,'13:30');assert.equal(f.timezone,null);
 const invalid=normalizeFinding({description:'Meeting',date:'2026-02-30',starttime:'25:30'},'https://example.org/a');
 assert.equal(invalid.description,'Meeting');assert.equal(invalid.date,null);assert.equal(invalid.starttime,null);assert.equal(invalid.type,null);
});
test('deadline is an independent scalar for every type',()=>{
 for(const type of ['event','announcement','treaty_status']){
  const input={type,description:'Development',date:'2026-04-02',deadline:'2026-03-01'},f=normalizeFinding(input,'https://example.org/a');
  assert.equal(f.deadline,'2026-03-01');assert.equal(f.date,'2026-04-02');
  for(const deadline of [undefined,null,'2026-02-30']){
   const partial=normalizeFinding({...input,deadline},'https://example.org/a');
   assert.equal(partial.deadline,null);assert.equal(partial.date,f.date);
  }
 }
});
