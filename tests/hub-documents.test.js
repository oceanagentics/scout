import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {HUB_CALENDAR,PREPARATION_VERSION,retrieveHubDocuments} from '../collector/hub-documents.js';

const saved=JSON.parse(readFileSync(new URL('./fixtures/hub-calendar.json',import.meta.url)));
const sourceURL=value=>{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password)throw Error('Unsupported URL');return u.href;};
const format=(url,type)=>{const u=new URL(url,HUB_CALENDAR);u.searchParams.set('format',type);return u.href;};
const response=(url,body,mime='application/json')=>({url,status:200,headers:{'content-type':mime},body});
async function collect({feed=saved,overrides={},known=[],pending=[],progress={},limits={},budget}={}){
  const calls=[],map=new Map([[format(HUB_CALENDAR,'json'),response(format(HUB_CALENDAR,'json'),JSON.stringify(feed))]]);
  for(const item of [...feed.upcoming??[],...feed.past??[]])if(item?.fullUrl){
    const url=new URL(item.fullUrl,HUB_CALENDAR).href;
    map.set(format(url,'ical'),response(format(url,'ical'),saved.calendar,'text/calendar'));
    map.set(format(url,'json'),response(format(url,'json'),JSON.stringify({item})));
  }
  for(const[url,r]of Object.entries(overrides))map.set(url,r);
  const result=await retrieveHubDocuments({tracker:{collector:'web',url:HUB_CALENDAR},sourceURL,known,pending,progress,
    limits:{requests:20,documents:10,pages:2,bytes:2_000_000,...limits},budget:budget??{requests:0,deadline:Date.now()+20_000},
    read:async url=>{calls.push(url);const r=map.get(url);if(!r)throw Error('Unsaved response');if(r instanceof Error)throw r;return r;}});
  return {...result,calls};
}
const items=run=>run.documents.filter(d=>d.id.startsWith('hub:item:'));

test('saved full JSON body and ICS retain late text, literal metadata and observed relationships',async()=>{
  const run=await collect(),doc=items(run)[0],ics=run.documents.find(d=>d.fields);
  assert.equal(run.documents.length,3);assert.equal(doc.raw,JSON.stringify(saved.upcoming[0]));
  assert.match(doc.prepared.text,/reliable, reproducible workflows/);assert.match(doc.prepared.text,/researchers, analysts, developers/);
  assert.equal(doc.prepared.version,PREPARATION_VERSION);assert.deepEqual(doc.item.location,saved.upcoming[0].location);
  assert.equal(ics.raw,saved.calendar);assert.ok(ics.fields.includes('DTSTART:20261022T133000Z'));
  assert.ok(ics.fields.includes('UID:6aad3109b87c753f927ebf61@squarespace.com'));
  assert.ok(doc.prepared.links.some(l=>l.relationship==='registration'));assert.ok(doc.prepared.links.some(l=>l.relationship==='calendar-export'));
  for(const d of run.documents){assert.equal(d.prepared.chunks.map(c=>d.prepared.text.slice(c.start,c.end)).join(''),d.prepared.text);
    for(const key of ['kind','organization','location','starts_at','ends_at','findings','record_id'])assert.ok(!Object.hasOwn(d,key));}
  assert.equal(run.complete,false);assert.ok(run.coverage.some(c=>c.tag==='img'&&c.state==='unfetched'));
});

test('past, unknown schedules, multiple sessions and contradictions stay whole and unfiltered',async()=>{
  const item={...saved.upcoming[0],id:'unknown',fullUrl:'/events-calendar/unknown',startDate:null,endDate:'contradictory',
    body:'<h2>Office notice</h2><p>No dates.</p><h2>Second session</h2><p>Conflicting schedule retained.</p>'};
  const run=await collect({feed:{...saved,upcoming:[],past:[item]}}),doc=items(run)[0];
  assert.equal(doc.item.endDate,'contradictory');assert.match(doc.prepared.text,/Second session/);assert.match(doc.prepared.text,/No dates/);
  const ics=run.documents.find(d=>d.fields);assert.ok(ics);assert.notEqual(ics.id,doc.id);
});

test('reorder, repeat and duplicate source occurrences retain stable item identities; changes retain full new body',async()=>{
  const other={...saved.upcoming[0],id:'aaa',fullUrl:'/events-calendar/other'};
  const feed={...saved,upcoming:[saved.upcoming[0],other],past:[saved.upcoming[0]]};
  const a=await collect({feed}),b=await collect({feed:{...feed,upcoming:[other,saved.upcoming[0]]}}),repeat=await collect({feed});
  assert.deepEqual(items(a).map(d=>[d.id,d.raw]),items(b).map(d=>[d.id,d.raw]));assert.deepEqual(items(a).map(d=>d.raw),items(repeat).map(d=>d.raw));
  assert.equal(items(a).length,2);assert.equal(items(a).find(d=>d.id.endsWith(saved.upcoming[0].id)).provenance.length,2);
  const changed={...saved.upcoming[0],body:saved.upcoming[0].body+'<p>Later correction.</p>'};
  const c=await collect({feed:{...saved,upcoming:[changed]}});assert.equal(items(c)[0].id,items(repeat).find(d=>d.id.endsWith(changed.id)).id);assert.match(items(c)[0].prepared.text,/Later correction/);
});

test('shared captured source IDs resume calendar, item and ICS without adapter task metadata',async()=>{
  const first=await collect();
  const known=first.documents.map(({id,url})=>({id,url}));
  const repeat=await collect({known,pending:known.map(item=>({...item,state:'model-pending'})),progress:first.progress});
  assert.ok(!repeat.coverage.some(c=>['failed','unsupported'].includes(c.state)));
  assert.equal(repeat.calls.length,3);
  assert.deepEqual(repeat.documents.map(d=>[d.id,d.raw,d.prepared]).sort(),first.documents.map(d=>[d.id,d.raw,d.prepared]).sort());
});

test('conflicting source IDs retain both versions and publisher URL conflicts retain failed receipts',async()=>{
  const changed={...saved.upcoming[0],body:'<p>Different complete body.</p>'};
  const run=await collect({feed:{...saved,past:[changed]}});assert.equal(items(run).length,2);assert.ok(items(run).every(d=>d.state==='conflict'));
  const bounded=await collect({feed:{...saved,past:[changed]},limits:{documents:1}});
  assert.equal(items(bounded)[0].state,'conflict');assert.ok(bounded.coverage.some(c=>c.state==='conflict'));
  const bad={...saved.upcoming[0],fullUrl:'https://other.example/item'};
  const rejected=await collect({feed:{...saved,upcoming:[bad]}});assert.equal(items(rejected).length,0);assert.ok(rejected.coverage.some(c=>c.reason?.includes('publisher identity')));
  assert.equal(rejected.responses[0].response.body,JSON.stringify({...saved,upcoming:[bad]}));
});

test('bounded item progress rotates fairly and known changed items survive unavailable calendars',async()=>{
  const feed={...saved,upcoming:['a','b','c'].map(id=>({...saved.upcoming[0],id,fullUrl:'/events-calendar/'+id}))};
  let progress={};const visited=[];
  for(let i=0;i<3;i++){const run=await collect({feed,progress,limits:{documents:1,requests:2}});visited.push(items(run)[0].id);progress=run.progress;assert.ok(run.pending.length);assert.ok(run.calls.length<=2);}
  assert.deepEqual(visited,['hub:item:a','hub:item:b','hub:item:c']);
  const item={...saved.upcoming[0],body:'<p>Known correction behind missing listing.</p>'},url=new URL(item.fullUrl,HUB_CALENDAR).href;
  const run=await collect({known:[{url,id:item.id}],overrides:{[format(HUB_CALENDAR,'json')]:{...response(format(HUB_CALENDAR,'json'),'Unavailable'),status:503},
    [format(url,'json')]:response(format(url,'json'),JSON.stringify({item}))}});
  assert.match(items(run)[0].prepared.text,/Known correction/);assert.ok(run.coverage.some(c=>c.state==='failed'));
});

test('observed pagination and pending ICS resume without invented pages or UID joins',async()=>{
  const next=HUB_CALENDAR+'?offset=literal',feed={...saved,pagination:{nextPageUrl:next,cursor:'unchanged metadata'}};
  const second={...saved,upcoming:[],past:[{...saved.upcoming[0],id:'later',fullUrl:'/events-calendar/later'}]};
  const first=await collect({feed,limits:{pages:1}});assert.ok(first.pending.some(p=>p.task.kind==='calendar'&&p.url===format(next,'json')));
  const secondURL=format(next,'json');const run=await collect({feed,pending:first.pending,overrides:{[secondURL]:response(secondURL,JSON.stringify(second))}});
  assert.ok(items(run).some(d=>d.id==='hub:item:later'));assert.ok(run.responses.some(r=>r.requested_url===secondURL));
  const url=format(new URL(saved.upcoming[0].fullUrl,HUB_CALENDAR),'ical');
  const multiple=saved.calendar.replace('END:VCALENDAR','BEGIN:VEVENT\r\nUID:other@publisher\r\nDTSTART;TZID=Unknown:bad\r\nDESCRIPTION:First line\r\n folded continuation\r\nEND:VEVENT\r\nEND:VCALENDAR');
  const resumed=await collect({pending:[{task:{kind:'ical',url,parent_id:'source-parent'}}],overrides:{[url]:response(url,multiple,'text/calendar')}});
  assert.equal(resumed.documents.find(d=>d.fields).raw,multiple);assert.ok(resumed.documents.find(d=>d.fields).fields.includes('DESCRIPTION:First linefolded continuation'));
});

test('malformed JSON, missing bodies, incomplete ICS, status, identity, MIME and byte failures remain inspectable',async()=>{
  const json=format(HUB_CALENDAR,'json'),ical=format(new URL(saved.upcoming[0].fullUrl,HUB_CALENDAR),'ical');
  for(const r of [response(json,'{'),response(json,'{}'),{...response(json,'error'),status:403},response(json,'PDF','application/pdf'),response('https://www.hubocean.earth/other','{}')]){
    const run=await collect({overrides:{[json]:r}});assert.equal(run.documents.length,0);assert.equal(run.responses[0].response.body,r.body);assert.ok(run.pending.some(p=>p.state==='failed'));}
  const missing=await collect({feed:{...saved,upcoming:[{...saved.upcoming[0],body:null}]}});assert.equal(items(missing).length,0);assert.equal(missing.documents.length,1);
  for(const body of ['BEGIN:VCALENDAR','BEGIN:VCALENDAR\nBEGIN:VEVENT\nEND:VCALENDAR']){
    const run=await collect({overrides:{[ical]:response(ical,body,'text/calendar')}});assert.equal(run.documents.filter(d=>d.fields).length,0);assert.equal(run.responses.at(-1).response.body,body);assert.ok(run.pending.some(p=>p.task.kind==='ical'));}
  const oversized=await collect({limits:{bytes:10}});assert.equal(oversized.documents.length,0);assert.equal(oversized.responses[0].response.body,JSON.stringify(saved));
});

test('expired/shared quotas stop requests, invalid bounds/configuration reject locally',async()=>{
  for(const budget of [{requests:0,deadline:0},{requests:20,deadline:Date.now()+1000}]){const run=await collect({budget});assert.equal(run.calls.length,0);assert.ok(run.pending.length);}
  await assert.rejects(collect({limits:{documents:0}}),/bounds/);
  await assert.rejects(retrieveHubDocuments({tracker:{collector:'web',url:'https://other.example'}}),/Unsupported/);
});


test('carried pending, known and progress rotate failed detail reads with calendar refresh and ICS work',async()=>{
  const feed={...saved,upcoming:['a','b','c'].map(id=>({...saved.upcoming[0],id,fullUrl:'/events-calendar/'+id}))};
  const knownURL=new URL('/events-calendar/unlisted',HUB_CALENDAR).href;
  const knownItem={...saved.upcoming[0],id:'z',fullUrl:'/events-calendar/unlisted',body:'<p>Independent known body.</p>'};
  const overrides=Object.fromEntries(feed.upcoming.map(item=>[format(item.fullUrl,'json'),new Error('Unavailable known detail')]));
  overrides[format(knownURL,'json')]=response(format(knownURL,'json'),JSON.stringify({item:knownItem}));
  overrides[format(knownURL,'ical')]=response(format(knownURL,'ical'),saved.calendar,'text/calendar');
  let pending=[],progress={};const calls=[],prepared=new Set(),exports=new Set();let failures=0,refreshes=0;const sizes=[];
  for(let cycle=0;cycle<80;cycle++){
    const run=await collect({feed,overrides,pending,progress,known:[{url:knownURL,id:'z'}],limits:{documents:1,requests:2}});
    assert.ok(run.calls.length<=2);calls.push(...run.calls);items(run).forEach(doc=>prepared.add(doc.id));
    run.documents.filter(doc=>doc.fields).forEach(doc=>exports.add(doc.url));
    refreshes+=run.calls.includes(format(HUB_CALENDAR,'json'));
    failures+=run.coverage.filter(c=>c.task?.kind==='item'&&c.state==='failed').length;
    pending=run.pending;progress=run.progress;
    sizes.push(Buffer.byteLength(JSON.stringify(pending)));
    assert.ok(!JSON.stringify(pending).includes('"previous":'));
    for(const entry of pending){
      assert.equal(new Set(entry.via.map(v=>JSON.stringify(v))).size,entry.via.length);
      assert.ok(entry.via.filter(v=>v.relationship==='pending').length<=1);
      assert.ok(entry.via.length<=3);
      if(entry.state==='failed')assert.deepEqual(entry.last_failure,{state:'failed',reason:'Unavailable known detail'});
    }
  }
  assert.ok(failures>=2);assert.ok(refreshes>=3);
  assert.ok(Math.max(...sizes.slice(40))<=Math.max(...sizes.slice(10,40)));
  assert.ok(pending.some(p=>p.via.some(v=>v.relationship==='deferred-item'&&v.from===format(HUB_CALENDAR,'json'))));
  assert.ok(pending.some(p=>p.last_failure?.reason==='Unavailable known detail'));
  for(const id of ['a','b','c','z'])assert.ok(prepared.has('hub:item:'+id));
  for(const url of [...feed.upcoming.map(item=>item.fullUrl),knownURL])assert.ok(exports.has(format(url,'ical')));
  const stopped=await collect({feed,overrides,pending,progress,known:[{url:knownURL,id:'z'}],limits:{documents:1,requests:2},budget:{requests:2,deadline:Date.now()+1000}});
  assert.equal(stopped.calls.length,0);assert.deepEqual(stopped.progress,progress);
  const expired=await collect({feed,pending,progress,budget:{requests:0,deadline:0}});
  assert.equal(expired.calls.length,0);assert.deepEqual(expired.progress,progress);
});
