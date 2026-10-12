import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareDocument,prepareResponse} from '../collector/octo-documents.js';
import {packDocument} from '../collector/finding-jobs.js';
import {validateFinding} from '../collector/finding-contract.js';
import {sourceURL} from '../collector/hsa.js';

const packet=(prepared,relationship='primary')=>packDocument({id:'capture'},{documents:[{id:'P',capture_id:'capture',url:prepared.url,relationship,prepared}]});
const claim=(value,quote,block=0)=>({...value?.precision?value:{value},sources:[{doc:'P',block,quote}]});
const proposal=(text,kind='event')=>({occurrence:{kind,anchor:'Ocean workshop',title:'Ocean workshop',sources:claim(null,text).sources},description:null,canonical_url:null,organizations:[],
  details:kind==='event'?{start:null,end:null,occurrence:null,parent:null,location:null,mode:null,registration_url:null,status:null}:{published:null,effective:null,subjects:null},identities:[],
  unknowns:{organizations:{reason:'not_announced',explanation:'Source does not announce an affiliation.'},[kind==='event'?'details.start':'details.published']:{reason:'not_announced',explanation:'Source does not announce this date.'}}});
// Completion choices below are injected; these tests prove mechanical boundaries, not model judgment.

test('malformed final claim wrappers fail as invalid output',()=>{
  const text='Ocean workshop.',input=packet(prepareDocument({url:'https://example.org/event',html:'<p>'+text+'</p>'}));
  for(const field of ['description','canonical_url'])for(const bad of [1,'claim',[],{sources:claim(null,text).sources}]){
    const raw=proposal(text);raw[field]=bad;
    assert.throws(()=>validateFinding(raw,input),{invalid:true,message:'Claim object and value required: '+field});
  }
  for(const key of ['organizations','identities'])for(const bad of [null,1,[]]){const raw=proposal(text);raw[key]=[bad];assert.throws(()=>validateFinding(raw,input),{invalid:true});}
  for(const kind of ['constructor','toString','unknown',['event'],{toString:null,valueOf:null}]){const raw=proposal(text);raw.occurrence.kind=kind;assert.throws(()=>validateFinding(raw,input),{invalid:true});}
  for(const key of ['evidence','citations']){const raw=proposal(text);raw[key]=[];assert.throws(()=>validateFinding(raw,input),{invalid:true});}
});

test('ordinary details require claim wrappers and citation pages must match supplied PDFs',()=>{
  const text='Ocean workshop.',prepared=prepareDocument({url:'https://example.org/event',html:'<p>'+text+'</p>'}),input=packet(prepared),raw=proposal(text);
  for(const field of ['occurrence','location','registration_url','mode','status']){
    const bad=structuredClone(raw);bad.details[field]='bare value';
    assert.throws(()=>validateFinding(bad,input),{message:'Claim object and value required: details.'+field});
  }
  const missing=structuredClone(raw);delete missing.details;assert.throws(()=>validateFinding(missing,input),{invalid:true});
  const bad=structuredClone(raw);bad.occurrence.sources[0].page=1;
  assert.throws(()=>validateFinding(bad,input),{message:'PDF citation page does not match its source'});
  assert.equal(validateFinding(raw,input).kind,'event');
  const pdf=packet({...prepared,url:'https://example.org/text.pdf',pages:2,visual:false,blocks:[{...prepared.blocks[0],page:1}]}).documents[0];
  assert.equal(pdf.pages,2);assert.equal(pdf.visual,undefined);pdf.id='S1';
  const mixed={...input,documents:[...input.documents,pdf]},pdfFinding=structuredClone(raw);
  pdfFinding.occurrence.sources=[{doc:'S1',block:0,quote:text,page:1}];assert.equal(validateFinding(pdfFinding,mixed).kind,'event');
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
    const accepted=validateFinding(raw,input);
    assert.deepEqual(accepted.organizations.map(o=>o.name),example.names??[]);
    assert.equal(accepted.details.start?.value,example.date);assert.equal(accepted.details.end?.value,example.end);
  }
});
test('canonical dates retain verbatim sources and independent supported components',()=>{
  const text='Ocean workshop on 29 February 2028 at 11:59:58 PM UTC+05:45.',input=packet(prepareDocument({url:'https://example.org/event',html:'<p>'+text+'</p>'})),raw=proposal(text);
  raw.details.start=claim({value:'2028-02-29',precision:'day',time:'23:59:58',zone:'+05:45'},text);
  const accepted=validateFinding(raw,input);
  assert.equal(accepted.details.start.utc,'2028-02-29T18:14:58.000Z');assert.equal(accepted.proofs['details.start'].sources[0].quote,text);
  const partial=structuredClone(raw);delete partial.details.start.zone;
  partial.unknowns['details.start.zone']={reason:'unverified_evidence',explanation:'Injected final uncertainty about the timezone.'};
  const local=validateFinding(partial,input);
  assert.equal(local.details.start.time,'23:59:58');assert.equal(local.details.start.zone,undefined);assert.equal(local.details.start.utc,undefined);
  assert.equal(local.unknowns['details.start.zone'].reason,'unverified_evidence');
  raw.details.start.time='11:59:58 PM';const invalid=validateFinding(raw,input);
  assert.deepEqual(invalid.details.start,{value:'2028-02-29',precision:'day'});assert.equal(invalid.unknowns['details.start.time'].reason,'unverified_evidence');
});
test('final occurrence sources support the bundle and explicit correction references',()=>{
  const passages=['A gathering.','Ocean workshop.','Revised workshop title.','The title is corrected to Revised workshop title.'];
  const input=packet(prepareDocument({url:'https://example.org/event',html:passages.map(s=>'<p>'+s+'</p>').join('')})),raw=proposal(passages[1]);
  const sources=passages.map((quote,block)=>({doc:'P',block,quote}));
  raw.occurrence.title='Revised workshop title';raw.occurrence.sources=sources.slice(0,3);raw.occurrence.correction_sources=[sources[3]];
  const accepted=validateFinding(raw,input);
  for(const field of ['kind','anchor','title'])assert.deepEqual(accepted.proofs[field].sources.map(s=>s.block),[0,1,2]);
  assert.deepEqual(accepted.changes.title.map(s=>s.block),[3]);
  for(const sources of [undefined,[]]){const missing=structuredClone(raw);missing.occurrence.sources=sources;assert.throws(()=>validateFinding(missing,input),/Direct source/);}
  const bad=structuredClone(raw);bad.occurrence.sources=[sources[0]];assert.throws(()=>validateFinding(bad,input),/anchor must appear/);
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
  const accepted=validateFinding(raw,input);assert.equal(accepted.details.response_due.value,'2026-10-15');assert.equal(accepted.details.committed_amount,5000);assert.equal(accepted.organizations[0].role,'funder');
  for(const field of ['deadline','application_url','start']){const bad=structuredClone(raw);bad.details[field]=raw.details.response_due;assert.throws(()=>validateFinding(bad,input),/Details must match/);}
  const funding=structuredClone(raw);funding.occurrence.kind='funding';assert.throws(()=>validateFinding(funding,input),/Supported kind/);
  const treaty={...raw,occurrence:{...raw.occurrence,kind:'treaty_status',anchor:'France ratified',title:'France ratification'},organizations:[],unknowns:{},details:{treaty:claim('BBNJ',text),jurisdiction:claim('France',text),action:claim('ratification',text),action_date:claim({value:'2026-10-15',precision:'day'},text),effective:null}};
  assert.throws(()=>validateFinding(treaty,input),/official UN/);
  const official=packet({...prepared,url:'https://treaties.un.org/fixture'}),candidate=validateFinding(treaty,official);
  assert.equal(candidate.details.action_date.value,'2026-10-15');
  for(const field of ['treaty','action']){const missing=structuredClone(treaty);missing.details[field]=null;assert.throws(()=>validateFinding(missing,official),/Required claim/);}
});
test('corrected final facts omit a demonstrated product and preserve the date, actual host and uncertainty',()=>{
  const text='Ocean workshop on 15 Oct 2026. Institute A hosts it. Tool Q is demonstrated.',input=packet(prepareDocument({url:'https://example.org/event',html:'<p>'+text+'</p>'})),raw=proposal(text);
  raw.details.start=claim({value:'2026-10-15',precision:'day'},text);
  raw.organizations=[{name:'Tool Q',role:'organizer',sources:claim(null,text).sources},{name:'Institute A',role:'host',sources:claim(null,text).sources}];
  raw.unknowns={};
  assert.equal(validateFinding(raw,input).organizations.length,2,'Mechanical validation alone does not judge arbitrary role meaning');
  // Inject the completion decision: remove the product role, without removing the supported host or date.
  const final=structuredClone(raw);final.organizations.shift();final.unknowns.organizations={reason:'unverified_evidence',explanation:'The demonstrated product does not establish an organizer.'};
  const accepted=validateFinding(final,input);
  assert.equal(accepted.details.start.value,'2026-10-15');assert.deepEqual(accepted.organizations,[{name:'Institute A',role:'host'}]);
  assert.equal(accepted.completeness.state,'provisional');assert.equal(accepted.unknowns.organizations.reason,'unverified_evidence');
  assert.deepEqual(Object.keys(accepted.proofs).filter(k=>k.startsWith('organizations.')),['organizations.0']);
  const unknown=validateFinding(proposal(text),input);assert.equal(unknown.details.start,null);assert.equal(unknown.unknowns['details.start'].reason,'not_announced');
});
test('final citation failures stay local for optional facts but cannot establish an occurrence',()=>{
  const text='Ocean workshop. Institute A is a host.',input=packet(prepareDocument({url:'https://example.org/event',html:'<p>'+text+'</p>'})),raw=proposal(text);
  raw.description=claim('A workshop.',text);raw.description.sources[0].doc='missing';
  const accepted=validateFinding(raw,input);assert.equal(accepted.description,null);assert.equal(accepted.title,'Ocean workshop');assert.equal(accepted.unknowns.description.reason,'unverified_evidence');
  for(const sources of [[{doc:'understanding',block:0,quote:text}],[{doc:'P',block:0,quote:'Invented source text.'}]]){
    const bad=structuredClone(raw);bad.occurrence.sources=sources;assert.throws(()=>validateFinding(bad,input),/supplied block/);
  }
});
test('final references can be corrected without overriding native dates or independent clock components',async()=>{
  const body='BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:day-event\r\nSUMMARY:Ocean workshop\r\nDTSTART;VALUE=DATE:20261015\r\nDTEND;VALUE=DATE:20261017\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:clock-event\r\nSUMMARY:Other workshop\r\nDTSTART;TZID=Europe/Paris:20261015T150000\r\nDTEND:20261015T150000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const prepared=await prepareResponse({url:'https://example.org/events.ics',status:200,headers:{'content-type':'text/calendar'},body},{sourceURL}),input=packet(prepared);
  const [day,clock]=prepared.blocks.filter(b=>b.calendar).map(b=>b.calendar),quote=prepared.text.slice(prepared.blocks[0].start,prepared.blocks[0].end),raw=proposal(quote);
  raw.identities=[{scheme:'calendar_uid',value:'day-event',sources:claim(null,'UID:day-event').sources}];
  raw.details.start=claim(day.dates.start,'DTSTART;VALUE=DATE:20261015');raw.details.end=claim(day.dates.end,'DTSTART;VALUE=DATE:20261015');
  const candidate=validateFinding(raw,input);assert.equal(candidate.details.end,null);assert.equal(candidate.details.start.value,'2026-10-15');
  const repaired=structuredClone(raw);repaired.details.end.sources=claim(null,'DTEND;VALUE=DATE:20261017').sources;
  assert.equal(validateFinding(repaired,input).details.end.value,'2026-10-16');
  repaired.details.start=null;assert.equal(validateFinding(repaired,input).details.end.value,'2026-10-16');
  const timed=proposal(quote);for(const key of ['anchor','title'])timed.occurrence[key]='Other workshop';
  timed.details.start=claim({...clock.dates.start,time:'16:00:00'},'DTSTART;TZID=Europe/Paris:20261015T150000');
  const badClock=validateFinding(timed,input);assert.equal(badClock.details.start.value,'2026-10-15');assert.equal(badClock.details.start.time,undefined);assert.equal(badClock.unknowns['details.start.time'].reason,'unverified_evidence');
  timed.details.start={...clock.dates.start,zone:'UTC',sources:timed.details.start.sources};
  const badZone=validateFinding(timed,input);assert.equal(badZone.details.start.time,'15:00:00');assert.equal(badZone.details.start.zone,undefined);assert.equal(badZone.details.start.utc,undefined);
  delete timed.details.start.time;delete timed.details.start.zone;timed.unknowns['details.start.time']={reason:'unverified_evidence',explanation:'Final clock uncertainty.'};
  const partial=validateFinding(timed,input);assert.equal(partial.details.start.time,undefined);assert.equal(partial.details.start.value,'2026-10-15');
  const recurring=await prepareResponse({url:prepared.url,status:200,headers:{'content-type':'text/calendar'},body:body.replace('UID:day-event','UID:day-event\r\nRRULE:FREQ=YEARLY')},{sourceURL});
  raw.occurrence.sources=claim(null,'SUMMARY:Ocean workshop').sources;
  assert.throws(()=>validateFinding(raw,packet(recurring)),/occurrence-specific review/);
  await assert.rejects(prepareResponse({url:prepared.url,status:200,headers:{'content-type':'text/calendar'},body:body.replace('END:VCALENDAR','')},{sourceURL}),/Incomplete calendar/);
});
test('native publication metadata and same-title occurrence identities remain mechanical boundaries',async()=>{
  const prepared=prepareDocument({url:'https://example.org/session',title:'',html:'<time class="published">2026-10-15</time><p>Ocean workshop. Date to follow.</p>'}),input=packet(prepared),raw=proposal('Ocean workshop. Date to follow.');
  raw.occurrence.sources[0].block=1;
  raw.details.start=claim({value:'2026-10-15',precision:'day'},'2026-10-15');
  assert.match(validateFinding(raw,input).unknowns['details.start'].explanation,/Publication metadata/);
  const body='BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:first\nSUMMARY:Ocean workshop\nDTSTART;VALUE=DATE:20261015\nEND:VEVENT\nBEGIN:VEVENT\nUID:second\nSUMMARY:Ocean workshop\nDTSTART;VALUE=DATE:20271015\nEND:VEVENT\nEND:VCALENDAR';
  const calendar=await prepareResponse({url:'https://example.org/events.ics',status:200,headers:{'content-type':'text/calendar'},body},{sourceURL}),finding=proposal('SUMMARY:Ocean workshop');
  finding.identities=[{scheme:'calendar_uid',value:'first',sources:claim(null,'UID:first').sources}];finding.details.start=claim({value:'2027-10-15',precision:'day'},'DTSTART;VALUE=DATE:20271015');
  const accepted=validateFinding(finding,packet(calendar));assert.equal(accepted.details.start,null);assert.equal(accepted.identities[0].key,'event:calendar_uid:first');
});
test('final source-linked native claims retain both sides of the association',()=>{
  const primary=prepareDocument({url:'https://example.org/events',title:'',html:'<p>Ocean workshop. hostOrg: org-17.</p>'}),organization=prepareDocument({url:'https://example.org/orgs/17',title:'',html:'<p>id: org-17. name: Institute A.</p>'});
  const input=packDocument({id:'capture'},{documents:[{id:'P',capture_id:'capture',url:primary.url,relationship:'primary',prepared:primary},{id:'O',capture_id:'org-capture',url:organization.url,relationship:'profile',prepared:organization}]}),raw=proposal(primary.text);
  raw.organizations=[{name:'Institute A',role:'host',sources:[...claim(null,primary.text).sources,{doc:'O',block:0,quote:organization.text}]}];
  const accepted=validateFinding(raw,input);
  assert.equal(raw.organizations[0].sources.length,2);
  assert.deepEqual(accepted.proofs['organizations.0'].sources.map(p=>p.url),[primary.url,organization.url]);
});
