import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeFinding} from '../collector/finding-contract.js';
test('flat dates apply only to events and preserve supported precision',()=>{
 const f=normalizeFinding({type:'announcement',description:'Brief',date:'2026-03',starttime:'12:00'},'https://example.org/a');
 assert.deepEqual(f.details,{});assert.equal(f.completeness.unknowns['details.published'],undefined);
 const event=normalizeFinding({type:'event',description:'Meeting',priority:'normal',organizations:['Ocean Institute','Ocean Institute','Partner'],date:'2026-04-02'},'https://example.org/a');
 assert.deepEqual(event.details.start,{value:'2026-04-02',precision:'day'});
 assert.deepEqual(event.organizations,[{name:'Ocean Institute'},{name:'Partner'}]);
 assert.equal(event.priority,'normal');assert.equal(Object.hasOwn(event,'title'),false);
 assert.deepEqual(event.completeness,{state:'complete',unknowns:{}});
 const treaty=normalizeFinding({type:'treaty_status',description:'Ratification',date:'2026-04-02'},'https://example.org/a');
 assert.deepEqual(treaty.details,{});assert.equal(treaty.completeness.unknowns['details.action_date'],undefined);
 assert.deepEqual(normalizeFinding({type:'event',description:'Meeting',date:'2026-03'},'https://example.org/a').details.start,{value:'2026-03',precision:'month'});
});
test('invalid dates and timezones do not discard the description or a supported local clock',()=>{
 const f=normalizeFinding({type:'event',description:'Meeting',date:'2026-04-02',starttime:'13:30',timezone:'invalid'},'https://example.org/a');
 assert.deepEqual(f.details.start,{value:'2026-04-02',precision:'day',time:'13:30'});
 assert.equal(f.completeness.unknowns['details.start.zone'].reason,'invalid_timezone');
 const invalid=normalizeFinding({type:'event',description:'Meeting',date:'2026-02-30'},'https://example.org/a');
 assert.equal(invalid.description,'Meeting');assert.equal(invalid.details.start,undefined);
 assert.equal(invalid.completeness.unknowns['details.start'].reason,'invalid_date');
});
test('submission deadlines remain separate from event starts and never block useful records',()=>{
 for(const type of ['event','announcement','treaty_status']){
  const input={type,description:'Development',date:'2026-04-02',deadline:'2026-03-01'},f=normalizeFinding(input,'https://example.org/a');
  assert.deepEqual(f.details.response_due,{value:'2026-03-01',precision:'day'});
  assert.equal(f.details.start?.value,type==='event'?'2026-04-02':undefined);
  for(const deadline of [undefined,null,'2026-02-30']){
   const partial=normalizeFinding({...input,deadline},'https://example.org/a');
   assert.equal(partial.description,input.description);assert.equal(partial.details.response_due,undefined);
   assert.equal(partial.details.start?.value,f.details.start?.value);
  }
 }
});

test('normalization emits one finding description and ignores a supplied title',()=>{
 const finding=normalizeFinding({type:'announcement',description:'Useful description',title:'Duplicate label'},'https://example.org/a');
 assert.equal(finding.description,'Useful description');assert.equal(Object.hasOwn(finding,'title'),false);
});
