import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeFinding} from '../collector/finding-contract.js';
test('date precision and independent clocks survive optional field errors',()=>{
 const f=normalizeFinding({type:'announcement',title:'Brief',dates:[{meaning:'publication',date:'2026-03',time:'12:00'},{meaning:'response_deadline',date:'2026-04-02'}]},'https://example.org/a');
 assert.deepEqual(f.details.published,{value:'2026-03',precision:'month'});
 assert.equal(f.details.response_due.value,'2026-04-02');
 const event=normalizeFinding({type:'event',title:'Meeting',organizations:[{name:'Ocean Institute'}],dates:[{meaning:'event_start',date:'2026-04-02'}]},'https://example.org/a');
 assert.deepEqual(event.completeness,{state:'complete',unknowns:{}});
});
test('invalid ranges and unsafe links stay unknown without losing the record',()=>{
 const f=normalizeFinding({type:'event',title:'Meeting',dates:[{meaning:'event_start',date:'2026-04-02'},{meaning:'event_end',date:'2026-03-23'}],registration_urls:['javascript:alert(1)']},'https://example.org/a');
 assert.equal(f.details.start.value,'2026-04-02');assert.equal(f.details.end,undefined);assert.equal(f.details.registration_url,undefined);
});
