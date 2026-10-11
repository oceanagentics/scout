import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {prepareDocument,prepareResponse} from '../collector/octo-documents.js';
import {packDocument} from '../collector/finding-jobs.js';
import {validateFinding,proposalClaims,reviewFinding} from '../collector/finding-contract.js';
import {sourceURL} from '../collector/hsa.js';

const packet=(prepared,relationship='primary')=>packDocument({id:'capture'},{documents:[{id:'P',capture_id:'capture',url:prepared.url,relationship,prepared}]});
const claim=(value,quote,block=0)=>({...value?.precision?value:{value},sources:[{doc:'P',block,quote}]});
const proposal=(text,kind='event')=>({occurrence:{kind,anchor:'Ocean workshop',title:'Ocean workshop',sources:claim(null,text).sources},description:null,canonical_url:null,organizations:[],
  details:kind==='event'?{start:null,end:null,occurrence:null,parent:null,location:null,mode:null,registration_url:null,status:null}:{published:null,effective:null,subjects:null},identities:[],
  unknowns:{organizations:{reason:'not_announced',explanation:'Source does not announce an affiliation.'},[kind==='event'?'details.start':'details.published']:{reason:'not_announced',explanation:'Source does not announce this date.'}}});
// Every verdict below is injected. These tests prove boundaries, not model judgment.
const decision=(finding,unsupported=[])=>({input_hash:'review-input',occurrence:{status:'supported',reason:'Injected occurrence support.',sources:finding.proposal.occurrence.sources},
  claims:proposalClaims(finding.proposal).map(c=>({...c,status:unsupported.includes(c.field)?'unsupported':'supported',reason:unsupported.includes(c.field)?'Injected rejection: '+c.field:'Injected support.'})),
  relevance:{priority:'low',reason:'Injected relevance.',fields:['proposed.title']}});
const verify=(finding,input,response=decision(finding))=>reviewFinding(finding,response,input,{job_id:'review-job',input_hash:'review-input'});

test('malformed claim wrappers fail as invalid output before semantic review',()=>{
  const text='Ocean workshop.',input=packet(prepareDocument({url:'https://example.org/event',html:'<p>'+text+'</p>'}));
  for(const bad of [1,'claim',[],{sources:claim(null,text).sources}]){
    const raw=proposal(text);raw.description=bad;
    assert.throws(()=>validateFinding(raw,input),{invalid:true,message:'Claim object and value required: description'});
  }
  for(const key of ['organizations','identities'])for(const bad of [null,1,[]]){const raw=proposal(text);raw[key]=[bad];assert.throws(()=>validateFinding(raw,input),{invalid:true});}
  for(const kind of ['constructor','toString','unknown',['event'],{toString:null,valueOf:null}]){const raw=proposal(text);raw.occurrence.kind=kind;assert.throws(()=>validateFinding(raw,input),{invalid:true});}
  for(const key of ['evidence','citations']){const raw=proposal(text);raw[key]=[];assert.throws(()=>validateFinding(raw,input),{invalid:true});}
});

test('ordinary wording, joint organizations, date ranges, abbreviations and heading context have no language gate',()=>{
  const examples=[
    {text:'Institute A is organizing Ocean workshop.',names:['Institute A']},
    {text:'Institute A and Institute B jointly organize Ocean workshop.',names:['Institute A','Institute B']},
    {text:'Ocean workshop starts on October 15, 2026 and ends on October 16, 2026.',date:'2026-10-15',end:'2026-10-16'},
    {text:'Ocean workshop on 15 Oct 2026.',date:'2026-10-15'},
    {text:'Ocean workshop. The event will take place on October 15, 2026.',date:'2026-10-15'},
  ];
  for(const example of examples){
    const prepared=prepareDocument({url:'https://example.org/event',title:'Ocean workshop',html:'<p>'+example.text+'</p>'}),input=packet(prepared),raw=proposal(example.text);
    if(example.date)raw.details.start=claim({value:example.date,precision:'day'},example.text);
    if(example.end)raw.details.end=claim({value:example.end,precision:'day'},example.text);
    raw.organizations=(example.names??[]).map(name=>({name,role:'organizer',sources:claim(null,example.text).sources}));
    const candidate=validateFinding(raw,input),accepted=verify(candidate,input);
    assert.equal(candidate.organizations.length,example.names?.length??0);
    assert.deepEqual(accepted.organizations.map(o=>o.name),example.names??[]);
    assert.equal(accepted.details.start?.value,example.date);assert.equal(accepted.details.end?.value,example.end);
    assert.equal(accepted.proofs.title.review.job_id,'review-job');
  }
});
test('canonical date components retain verbatim source notation and independent semantic decisions',()=>{
  const text='Ocean workshop on 29 February 2028 at 11:59:58 PM UTC+05:45.',input=packet(prepareDocument({url:'https://example.org/event',html:'<p>'+text+'</p>'})),raw=proposal(text);
  raw.details.start=claim({value:'2028-02-29',precision:'day',time:'23:59:58',zone:'+05:45'},text);
  const candidate=validateFinding(raw,input),accepted=verify(candidate,input);
  assert.equal(accepted.details.start.utc,'2028-02-29T18:14:58.000Z');assert.equal(accepted.proofs['details.start'].sources[0].quote,text);
  const local=verify(candidate,input,decision(candidate,['details.start.zone']));
  assert.equal(local.details.start.time,'23:59:58');assert.equal(local.details.start.zone,undefined);assert.equal(local.details.start.utc,undefined);
  const altered=decision(candidate);altered.claims.find(c=>c.field==='details.start.time').value='23:59';
  assert.throws(()=>verify(candidate,input,altered),/Review|reviewed/);
  raw.details.start.time='11:59:58 PM';const invalid=verify(validateFinding(raw,input),input);
  assert.deepEqual(invalid.details.start,{value:'2028-02-29',precision:'day'});assert.equal(invalid.unknowns['details.start.time'].reason,'unverified_evidence');
});
test('shared occurrence evidence keeps separate field verdicts, sources and correction permissions',()=>{
  const passages=['A gathering.','Ocean workshop.','Revised workshop title.','The source corrects this occurrence.','The title is corrected to Revised workshop title.'];
  const prepared=prepareDocument({url:'https://example.org/event',html:passages.map(s=>'<p>'+s+'</p>').join('')}),input=packet(prepared),raw=proposal(passages[1]);
  const sources=passages.map((quote,block)=>({doc:'P',block,quote}));
  raw.occurrence.title='Revised workshop title';raw.occurrence.sources=sources.slice(0,3);raw.occurrence.correction_sources=[sources[3]];
  const candidate=validateFinding(raw,input),response=decision(candidate,['kind.correction','anchor.correction']);
  for(const [i,field]of ['kind','anchor','title'].entries())response.claims.find(c=>c.field===field).sources=[sources[i]];
  response.claims.find(c=>c.field==='title.correction').sources=[sources[4]];response.occurrence.sources=[sources[1]];
  const accepted=verify(candidate,input,response);
  for(const [i,field]of ['kind','anchor','title'].entries())assert.deepEqual(accepted.proofs[field].sources.map(s=>s.block),[i]);
  assert.deepEqual(Object.keys(accepted.changes),['title']);assert.deepEqual(accepted.changes.title.map(s=>s.block),[4]);
  for(const field of ['kind','anchor','title'])assert.throws(()=>verify(candidate,input,decision(candidate,[field])),/Required occurrence claim/);
  for(const sources of [undefined,[]]){const missing=structuredClone(raw);missing.occurrence.sources=sources;assert.throws(()=>validateFinding(missing,input,{anchor:{sources:[{doc:'P',block:1,quote:passages[1]}]}}),/Direct source/);}
});
test('canonical proposals reject superseded identity wrappers and nested date claims',()=>{
  const text='Ocean workshop on October 15, 2026.',input=packet(prepareDocument({url:'https://example.org/event',html:'<p>'+text+'</p>'}));
  const old=proposal(text),{occurrence}=old;delete old.occurrence;
  for(const field of ['kind','anchor','title'])old[field]={value:occurrence[field],sources:occurrence.sources};
  assert.throws(()=>validateFinding(old,input),{invalid:true});
  for(const bad of [null,[],{kind:'event',anchor:{value:'Ocean workshop'},title:'Ocean workshop',sources:occurrence.sources}]){
    const raw=proposal(text);raw.occurrence=bad;assert.throws(()=>validateFinding(raw,input),{invalid:true});
  }
  for(const bad of [{value:{value:'2026-10-15',precision:'day'},sources:occurrence.sources},{value:'2026-10-15',sources:occurrence.sources}]){
    const raw=proposal(text);raw.details.start=bad;assert.throws(()=>validateFinding(raw,input),{invalid:true,message:'Flat typed date claim required: details.start'});
  }
});
test('funding commitments stay announcements and treaty actions require official authority',()=>{
  const text='Ocean workshop. Institute A committed USD 5000. Responses due October 15, 2026. France ratified BBNJ on October 15, 2026.';
  const prepared=prepareDocument({url:'https://example.org/news',html:'<p>'+text+'</p>'}),input=packet(prepared),raw=proposal(text,'announcement');
  raw.details={published:null,effective:null,subjects:null,response_due:claim({value:'2026-10-15',precision:'day'},text),committed_amount:claim(5000,text),currency:claim('USD',text)};
  raw.organizations=[{name:'Institute A',role:'funder',sources:claim(null,text).sources}];
  const accepted=verify(validateFinding(raw,input),input);assert.equal(accepted.details.response_due.value,'2026-10-15');assert.equal(accepted.details.committed_amount,5000);assert.equal(accepted.organizations[0].role,'funder');
  for(const field of ['deadline','application_url','start']){const bad=structuredClone(raw);bad.details[field]=raw.details.response_due;assert.throws(()=>validateFinding(bad,input),/Details must match/);}
  const funding=structuredClone(raw);funding.occurrence.kind='funding';assert.throws(()=>validateFinding(funding,input),/Supported kind/);
  const treaty={...raw,occurrence:{...raw.occurrence,kind:'treaty_status',anchor:'France ratified',title:'France ratification'},organizations:[],unknowns:{},details:{treaty:claim('BBNJ',text),jurisdiction:claim('France',text),action:claim('ratification',text),action_date:claim({value:'2026-10-15',precision:'day'},text),effective:null}};
  assert.throws(()=>validateFinding(treaty,input),/official UN/);
  const official=packet({...prepared,url:'https://treaties.un.org/fixture'}),candidate=validateFinding(treaty,official);
  assert.equal(verify(candidate,official).details.action_date.value,'2026-10-15');
  for(const field of ['treaty','action']){const missing=structuredClone(treaty);missing.details[field]=null;assert.throws(()=>validateFinding(missing,official),/Required claim/);assert.throws(()=>verify(candidate,official,decision(candidate,['details.'+field])),/Required occurrence claim/);}
});
test('semantic rejection of a product role preserves independently reviewed dates, hosts and genuine unknowns',()=>{
  const text='Ocean workshop on 15 Oct 2026. Institute A hosts it. Tool Q is demonstrated.',prepared=prepareDocument({url:'https://example.org/event',title:'',html:'<p>'+text+'</p>'}),input=packet(prepared),raw=proposal(text);
  raw.details.start=claim({value:'2026-10-15',precision:'day'},text);
  raw.organizations=[{name:'Tool Q',role:'organizer',sources:claim(null,text).sources},{name:'Institute A',role:'host',sources:claim(null,text).sources}];
  raw.unknowns={};
  const candidate=validateFinding(raw,input);assert.equal(candidate.organizations.length,2,'Extraction is a proposal, not semantic acceptance');
  const accepted=verify(candidate,input,decision(candidate,['organizations.0']));
  assert.equal(accepted.details.start.value,'2026-10-15');assert.deepEqual(accepted.organizations,[{name:'Institute A',role:'host'}]);
  assert.equal(accepted.completeness.state,'provisional');assert.equal(accepted.unknowns.organizations.reason,'unverified_evidence');assert.equal(accepted.accepted_claims['organizations.0'],undefined);
  assert.equal(accepted.accepted_claims['organizations.1'].field,'organizations.0','Basis survives array compaction by exact value');
  const unknown=validateFinding(proposal(text),input),unchanged=verify(unknown,input);
  assert.equal(unchanged.details.start,null);assert.equal(unchanged.unknowns['details.start'].reason,'not_announced');
});
test('review coverage rejects omitted, duplicate, invented, altered and stale claims; optional bad references stay local',()=>{
  const text='Ocean workshop. Institute A is a host.',prepared=prepareDocument({url:'https://example.org/event',title:'',html:'<p>'+text+'</p>'}),input=packet(prepared),raw=proposal(text);
  raw.description=claim('A workshop.',text);const candidate=validateFinding(raw,input);
  const cases=[
    r=>r.claims.pop(),
    r=>r.claims[1]=structuredClone(r.claims[0]),
    r=>r.claims[0].field='invented',
    r=>r.claims.find(c=>c.field==='description').value='Altered value',
    r=>r.input_hash='stale',
    r=>r.claims[0].status='probably',
  ];
  for(const change of cases){const response=decision(candidate);change(response);assert.throws(()=>verify(candidate,input,response),/Review|reviewed/);}
  const optional=decision(candidate);optional.claims.find(c=>c.field==='description').sources=[{doc:'missing',block:0,quote:text}];
  const accepted=verify(candidate,input,optional);assert.equal(accepted.description,null);assert.equal(accepted.title,'Ocean workshop');assert.equal(accepted.unknowns.description.reason,'unverified_evidence');
  const core=decision(candidate,['kind']);assert.throws(()=>verify(candidate,input,core),/Required occurrence/);
  const occurrence=decision(candidate);occurrence.occurrence.status='uncertain';assert.throws(()=>verify(candidate,input,occurrence),/Occurrence support/);
});
test('review can repair a reference for the same value, but cannot invent a replacement or override native components',async()=>{
  const body='BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:day-event\r\nSUMMARY:Ocean workshop\r\nDTSTART;VALUE=DATE:20261015\r\nDTEND;VALUE=DATE:20261017\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:clock-event\r\nSUMMARY:Other workshop\r\nDTSTART;TZID=Europe/Paris:20261015T150000\r\nDTEND:20261015T150000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const prepared=await prepareResponse({url:'https://example.org/events.ics',status:200,headers:{'content-type':'text/calendar'},body},{sourceURL}),input=packet(prepared);
  const [day,clock]=prepared.blocks.filter(b=>b.calendar).map(b=>b.calendar),quote=prepared.text.slice(prepared.blocks[0].start,prepared.blocks[0].end),raw=proposal(quote);
  raw.identities=[{scheme:'calendar_uid',value:'day-event',sources:claim(null,'UID:day-event').sources}];
  raw.details.start=claim(day.dates.start,'DTSTART;VALUE=DATE:20261015');raw.details.end=claim(day.dates.end,'DTSTART;VALUE=DATE:20261015');
  const candidate=validateFinding(raw,input);assert.equal(candidate.details.end,null);
  const wrong=verify(candidate,input);assert.equal(wrong.details.start.value,'2026-10-15');assert.equal(wrong.details.end,null);
  const repaired=decision(candidate);repaired.claims.find(c=>c.field==='details.end').sources=claim(null,'DTEND;VALUE=DATE:20261017').sources;
  assert.equal(verify(candidate,input,repaired).details.end.value,'2026-10-16');
  const endOnly=structuredClone(raw);endOnly.details.start=null;endOnly.details.end.sources=claim(null,'DTEND;VALUE=DATE:20261017').sources;
  assert.equal(verify(validateFinding(endOnly,input),input).details.end.value,'2026-10-16');
  const timed=proposal(quote);for(const key of ['anchor','title'])timed.occurrence[key]='Other workshop';
  timed.details.start=claim({...clock.dates.start,time:'16:00:00'},'DTSTART;TZID=Europe/Paris:20261015T150000');
  const badClock=verify(validateFinding(timed,input),input);assert.equal(badClock.details.start.value,'2026-10-15');assert.equal(badClock.details.start.time,undefined);assert.equal(badClock.accepted_claims['details.start.time'],undefined);
  timed.details.start={...clock.dates.start,zone:'UTC',sources:timed.details.start.sources};
  const badZone=verify(validateFinding(timed,input),input);assert.equal(badZone.details.start.time,'15:00:00');assert.equal(badZone.details.start.zone,undefined);assert.equal(badZone.details.start.utc,undefined);
  const declined=decision(validateFinding(timed,input),['details.start.time']);
  const partial=verify(validateFinding(timed,input),input,declined);assert.equal(partial.details.start.time,undefined);assert.equal(partial.details.start.value,'2026-10-15');
  const recurring=await prepareResponse({url:prepared.url,status:200,headers:{'content-type':'text/calendar'},body:body.replace('UID:day-event','UID:day-event\r\nRRULE:FREQ=YEARLY')},{sourceURL});
  raw.occurrence.sources=claim(null,'SUMMARY:Ocean workshop').sources;
  assert.throws(()=>validateFinding(raw,packet(recurring)),/occurrence-specific review/);
  await assert.rejects(prepareResponse({url:prepared.url,status:200,headers:{'content-type':'text/calendar'},body:body.replace('END:VCALENDAR','')},{sourceURL}),/Incomplete calendar/);
});
test('native publication metadata and same-title occurrence identities remain mechanical boundaries',async()=>{
  const prepared=prepareDocument({url:'https://example.org/session',title:'',html:'<time class="published">2026-10-15</time><p>Ocean workshop. Date to follow.</p>'}),input=packet(prepared),raw=proposal('Ocean workshop. Date to follow.');
  raw.occurrence.sources[0].block=1;
  raw.details.start=claim({value:'2026-10-15',precision:'day'},'2026-10-15');
  assert.match(verify(validateFinding(raw,input),input).unknowns['details.start'].explanation,/Publication metadata/);
  const body='BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:first\nSUMMARY:Ocean workshop\nDTSTART;VALUE=DATE:20261015\nEND:VEVENT\nBEGIN:VEVENT\nUID:second\nSUMMARY:Ocean workshop\nDTSTART;VALUE=DATE:20271015\nEND:VEVENT\nEND:VCALENDAR';
  const calendar=await prepareResponse({url:'https://example.org/events.ics',status:200,headers:{'content-type':'text/calendar'},body},{sourceURL}),finding=proposal('SUMMARY:Ocean workshop');
  finding.identities=[{scheme:'calendar_uid',value:'first',sources:claim(null,'UID:first').sources}];finding.details.start=claim({value:'2027-10-15',precision:'day'},'DTSTART;VALUE=DATE:20271015');
  const accepted=verify(validateFinding(finding,packet(calendar)),packet(calendar));assert.equal(accepted.details.start,null);assert.equal(accepted.identities[0].key,'event:calendar_uid:first');
});
test('source-linked native objects keep both sides of the association for semantic review',()=>{
  const primary=prepareDocument({url:'https://example.org/events',title:'',html:'<p>Ocean workshop. hostOrg: org-17.</p>'}),organization=prepareDocument({url:'https://example.org/orgs/17',title:'',html:'<p>id: org-17. name: Institute A.</p>'});
  const input=packDocument({id:'capture'},{documents:[{id:'P',capture_id:'capture',url:primary.url,relationship:'primary',prepared:primary},{id:'O',capture_id:'org-capture',url:organization.url,relationship:'profile',prepared:organization}]}),raw=proposal(primary.text);
  raw.organizations=[{name:'Institute A',role:'host',sources:[...claim(null,primary.text).sources,{doc:'O',block:0,quote:organization.text}]}];
  const candidate=validateFinding(raw,input),response=decision(candidate),accepted=verify(candidate,input,response);
  assert.equal(response.claims.find(c=>c.field==='organizations.0').sources.length,2);
  assert.deepEqual(accepted.proofs['organizations.0'].sources.map(p=>p.url),[primary.url,organization.url]);
});
test('retained failed P01 responses are immutable evidence; reviewer rejection never blesses the platform role',async()=>{
  const retained=JSON.parse(await readFile(new URL('./fixtures/P01-retained-extraction.json',import.meta.url),'utf8'));
  for(const [index,response]of retained.responses.entries()){
    const actual=response.findings[0];assert.throws(()=>validateFinding(actual,retained.packet),/co-located/);
    if(index===0){assert.deepEqual(actual.evidence.kind,[10]);assert.equal(actual.citations[10],undefined);}
    else {assert.deepEqual(actual.evidence.organizations,[1]);assert.equal(actual.evidence['organizations.0'],undefined);}
    const titleSource=actual.citations[index===0?0:1],bodySource=actual.citations[index===0?1:0],dateSource=actual.citations[index===0?3:1];
    // Explicit offline re-expression, never an alias or replacement model answer.
    const diagnostic={occurrence:{kind:actual.kind,anchor:actual.anchor,title:actual.title,sources:[titleSource]},
      description:{value:actual.description,sources:[bodySource]},canonical_url:null,organizations:actual.organizations.map(o=>({...o,sources:[titleSource]})),
      details:Object.fromEntries(Object.entries(actual.details).map(([key,value])=>[key,value==null?null:{...['start','end'].includes(key)?value:{value},sources:[key==='registration_url'&&index===0?actual.citations[6]:key==='location'||key==='mode'?actual.citations[index===0?5:1]:dateSource]}])),
      identities:actual.identities.map(i=>({scheme:i.scheme,value:i.value,sources:index===0?[{doc:'P',block:999,quote:i.value}]:[actual.citations[1]]})),unknowns:{}};
    const candidate=validateFinding(diagnostic,retained.packet),verdict=decision(candidate,['organizations.0','identities.0','details.status']),accepted=verify(candidate,retained.packet,verdict);
    assert.equal(accepted.title,actual.title);assert.equal(accepted.details.start.utc,'2026-10-22T13:30:00.000Z');assert.deepEqual(accepted.organizations,[]);assert.deepEqual(accepted.identities,[]);assert.equal(accepted.details.status,null);
    assert.equal(accepted.completeness.state,'provisional');assert.equal(accepted.details.end?.utc,index===0?undefined:'2026-10-22T14:15:00.000Z');
  }
});
