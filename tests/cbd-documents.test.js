import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { parseDocument, DomUtils } from 'htmlparser2';
import { sourceURL } from '../collector/hsa.js';
import { CBD_REGISTRY, prepareCbdPayload, retrieveCbdDocuments } from '../collector/cbd-documents.js';

const fixture=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/cbd-registry.json.gz',import.meta.url))));
const meetings=JSON.parse(fixture.meetings.body),reservations=[...JSON.parse(fixture.reservations0.body),...JSON.parse(fixture.reservations1.body)];
const tracker={collector:'web',url:CBD_REGISTRY},limits={documents:100,requests:30,meetingPages:1,meetingsPerPage:2,reservationPages:2,reservationsPerPage:10};
const json=(url,rows)=>({url,status:200,headers:{'content-type':'application/json'},body:JSON.stringify(rows)});
const retrieve=(read,options={})=>retrieveCbdDocuments({tracker,read,sourceURL,budget:{requests:0,deadline:Date.now()+10000},limits,...options});
const norm=text=>text.replace(/\s+/g,' ').trim();

test('explicit COP17 priority is read before historic conference discovery under a document cap',async()=>{
  const id='69a875b3475867d4716ad6bc',session='69a875b3475867d4716ad6bd',requests=[];
  const result=await retrieve(async url=>{
    requests.push(url);if(url===CBD_REGISTRY)return fixture.home;
    const q=JSON.parse(new URL(url).searchParams.get('q'));
    if(q['location.conference']?.$in?.includes(id))return json(url,[{_id:session,location:{conference:id},sideEvent:{conference:id,id:1,description:'COP17 complete session description'}}]);
    return json(url,[]);
  },{priorityMeetings:[id],limits:{...limits,documents:1}});
  assert.ok(requests[1].includes('reservations'));assert.equal(result.documents[0].id,'cbd:reservation:'+session);
  assert.match(result.documents[0].prepared.text,/COP17 complete session description/);
});
const savedRead=async url=>{
  if(url===CBD_REGISTRY)return fixture.home;
  const u=new URL(url),q=JSON.parse(u.searchParams.get('q')??'{}'),id=q._id?.$oid;
  if(u.pathname.endsWith('/conferences')){
    if(id)return json(url,JSON.parse(fixture.conferences.body).filter(r=>r._id===id));
    return +(u.searchParams.get('sk')??0)===0?{...fixture.meetings,url}:json(url,[]);
  }
  if(u.pathname.endsWith('/reservations')){
    if(id)return json(url,reservations.filter(r=>r._id===id));
    const offset=+(u.searchParams.get('sk')??0);return offset===0?{...fixture.reservations0,url}:offset===10?{...fixture.reservations1,url}:json(url,[]);
  }
  if(u.pathname.endsWith('/countries'))return {...fixture.countries,url};
  const name=u.pathname.endsWith('/inde-orgs')?'hosts':u.pathname.endsWith('/venue-rooms')?'rooms':'types';
  const ids=q._id.$in.map(r=>r.$oid);return json(url,JSON.parse(fixture[name].body).filter(r=>ids.includes(r._id)));
};

// Historical fixtures used projections and phrase/status queries. Injected
// routing keeps their returned bodies; it does not prove the new unfiltered
// request's live response quality or completeness.
test('all saved registry/meeting/reservation/related metadata and complete descriptions can reach preparation intact',()=>{
  for(const key of ['meetings','conferences','reservations0','reservations1','hosts','rooms','countries','types']){
    const source=fixture[key],rows=JSON.parse(source.body);
    const doc=prepareCbdPayload({id:'fixture:'+key,url:source.url,raw:source.body,rows,task:{kind:key},provenance:[],sourceURL});
    assert.equal(doc.raw,source.body);assert.ok(doc.prepared.blocks.some(b=>b.tag==='source-field'));
    assert.equal(doc.prepared.chunks.map(c=>doc.prepared.text.slice(c.start,c.end)).join(''),doc.prepared.text);
    for(const row of rows)if(row.sideEvent?.description){
      const stack=[parseDocument(row.sideEvent.description)];
      while(stack.length){const n=stack.pop();if(n.type==='text'&&norm(n.data).length>50)assert.ok(norm(doc.prepared.text).includes(norm(n.data)),norm(n.data).slice(0,100));stack.push(...n.children??[]);}
    }
    for(const field of ['kind','title','organization','date','starts_at','status','findings','candidate'])assert.equal(Object.hasOwn(doc,field),false);
  }
});

test('shell/conferences remain discovery; whole reservations retain explicit queries while support joins remain unfetched',async()=>{
  const calls=[];const result=await retrieve(async url=>{calls.push(url);return savedRead(url);});
  assert.equal(result.home.raw,fixture.home.body);assert.equal(result.home.prepared.input,'registry-shell');assert.equal(result.documents.some(d=>d.id==='cbd:registry-shell'||d.task?.kind==='meeting'),false);
  for(const row of reservations){const doc=result.documents.find(d=>d.id==='cbd:reservation:'+row._id);assert.ok(doc,row._id);assert.equal(doc.raw,JSON.stringify(row));}
  assert.equal(result.documents.filter(d=>d.task?.kind==='reservation').length,13);
  assert.ok(result.responses.some(r=>r.response.body===fixture.reservations0.body));assert.ok(result.responses.some(r=>r.response.body===fixture.reservations1.body));
  assert.equal(result.responses.some(r=>r.response.body===fixture.countries.body),false);assert.equal(calls.length,4);
  for(const url of calls.filter(url=>url!==CBD_REGISTRY)){
    const u=new URL(url);assert.equal(u.searchParams.has('f'),false);
    const q=JSON.parse(u.searchParams.get('q')??'{}');assert.equal(Object.hasOwn(q,'$text'),false);assert.equal(Object.hasOwn(q,'start'),false);assert.equal(Object.hasOwn(q,'meta.status'),false);assert.equal(Object.hasOwn(q,'type'),false);
    if(u.pathname.endsWith('/conferences'))assert.deepEqual(q,{});
    assert.ok(['/api/v2016/conferences','/api/v2016/reservations'].includes(u.pathname));
  }
  const page=result.inventory.find(i=>i.task.kind==='reservations-page');assert.deepEqual([...page.task.meetings].sort(),meetings.map(r=>r._id).sort());
  assert.ok(result.coverage.some(c=>c.relationship==='source-references'&&c.state==='unfetched'));
  assert.equal(result.pages.find(p=>p.task.kind==='meeting-page').raw,fixture.meetings.body);
  assert.ok(result.pending.some(i=>i.task.kind==='meeting-page'&&i.task.offset===2&&i.state==='deferred'));
  assert.equal(result.progress.meeting_offset,2);assert.equal(result.complete,false);
});

test('repeat/reordered API pages preserve stable row identity/payload; changed known row is rechecked independently',async()=>{
  const first=await retrieve(savedRead),again=await retrieve(savedRead);
  assert.deepEqual(first.documents.map(d=>[d.id,d.raw]),again.documents.map(d=>[d.id,d.raw]));
  const reordered=await retrieve(async url=>{
    const r=await savedRead(url),u=new URL(url);if(u.pathname.endsWith('/reservations')&&!JSON.parse(u.searchParams.get('q'))._id)return {...r,body:JSON.stringify(JSON.parse(r.body).reverse())};return r;
  });
  for(const row of reservations){const a=first.documents.find(d=>d.id==='cbd:reservation:'+row._id),b=reordered.documents.find(d=>d.id===a.id);assert.equal(a.raw,b.raw);assert.equal(a.id,b.id);}
  const original=first.documents.find(d=>d.task?.kind==='reservation');
  const changed=await retrieve(async url=>{
    const r=await savedRead(url),u=new URL(url);if(u.pathname.endsWith('/reservations')&&JSON.parse(u.searchParams.get('q'))._id?.$oid===original.task.id){const rows=JSON.parse(r.body);rows[0].sideEvent.description+='<p>Changed known content behind unchanged listing.</p>';return json(url,rows);}return r;
  },{known:[original]});
  assert.ok(changed.documents.some(d=>d.id===original.id&&d.raw!==original.raw&&d.known));
  assert.ok(changed.coverage.some(c=>c.id===original.id&&c.state==='conflict')); // Both snapshots retained, no first-arrival choice.
});

test('old/unrelated/unknown/unpublished/archived/unscheduled and non-session source rows remain inspectable',async()=>{
  const result=await retrieve(async url=>{
    const r=await savedRead(url),u=new URL(url);if(url===CBD_REGISTRY)return r;
    const rows=JSON.parse(r.body);
    if(u.pathname.endsWith('/conferences'))for(const row of rows){row.StartDate='1900-01-01';row.institution='unknown';row.schedule={sideEvents:{sideEventsPublished:false}};}
    if(u.pathname.endsWith('/reservations'))for(const row of rows){row.start=null;row.end=null;row.open=false;row.meta.status='deleted';row.sideEvent.meta.status='archived';row.sideEvent.title='Unrelated source';row.sideEvent.description='<p>Ancient source contexte français. No topic test.</p>';}
    return json(url,rows);
  });
  assert.equal(result.documents.filter(d=>d.task?.kind==='reservation').length,13);
  assert.ok(result.pages.some(d=>d.rows?.[0]?.institution==='unknown'));
  assert.ok(result.documents.some(d=>d.rows?.[0]?.sideEvent?.meta.status==='archived'&&d.prepared.text.includes('contexte français')));
  const emptySession=structuredClone(reservations[0]);delete emptySession.sideEvent;
  const noSession=await retrieve(async url=>{
    if(url===CBD_REGISTRY)return fixture.home;const u=new URL(url);if(u.pathname.endsWith('/conferences'))return {...fixture.meetings,url};
    if(u.pathname.endsWith('/reservations'))return json(url,[emptySession]);return savedRead(url);
  });
  assert.ok(noSession.documents.some(d=>d.id==='cbd:reservation:'+emptySession._id));assert.ok(noSession.coverage.some(c=>c.id===emptySession._id&&c.state==='unsupported'));
});

test('returned progress/pending advances bounded primary pagination; native unlisted sources survive discovery outages',async()=>{
  let progress={},pending=[],known=[];const visited=new Set();
  for(let run=0;run<5;run++){
    const result=await retrieve(savedRead,{progress,pending,known,limits:{...limits,requests:4}});progress=result.progress;pending=result.pending;
    for(const doc of result.documents){visited.add(doc.id);if(doc.task&&!known.some(k=>k.id===doc.id))known.push(doc);}
    assert.ok(result.requests<=4);
  }
  assert.ok(visited.has('cbd:reservation:'+reservations[0]._id));assert.ok(visited.has('cbd:reservation:'+reservations.at(-1)._id));
  assert.equal([...visited].some(id=>!id.startsWith('cbd:reservation:')),false);assert.ok(pending.every(i=>!['hosts','rooms','types','countries','meeting'].includes(i.task.kind)));
  const source=known.find(d=>d.task.kind==='reservation');
  const outage=await retrieve(async url=>{const u=new URL(url);if(url===CBD_REGISTRY||u.pathname.endsWith('/conferences'))throw new Error('HTTP 403');return savedRead(url);},{knownDocuments:[{id:source.id,url:source.url}]});
  assert.ok(outage.documents.some(d=>d.id===source.id&&d.known));assert.ok(outage.coverage.some(c=>c.state==='failed'));
});

test('missing/duplicate/foreign joins and invalid formats preserve exact responses with explicit failure',async()=>{
  for(const change of [rows=>[rows[0],rows[0]],rows=>rows.map(r=>({...r,sideEvent:{...r.sideEvent,conference:'aaaaaaaaaaaaaaaaaaaaaaaa'}}))]){
    const result=await retrieve(async url=>{const r=await savedRead(url);if(new URL(url).pathname.endsWith('/reservations'))return json(url,change(JSON.parse(r.body)));return r;});
    assert.equal(result.documents.filter(d=>d.task?.kind==='reservation').length,0);assert.ok(result.pending.some(i=>i.state==='failed'));assert.ok(result.responses.some(r=>new URL(r.requested_url).pathname.endsWith('/reservations')));
  }
  for(const bad of [r=>({...r,status:403}),r=>({...r,url:'https://example.org/wrong'}),r=>({...r,headers:{'content-type':'text/plain'}})]){
    const result=await retrieve(async url=>bad(await savedRead(url)));assert.equal(result.documents.length,0);assert.ok(result.coverage.some(c=>c.state==='failed'));assert.ok(result.responses.length>0);
  }
});

test('page/request/deadline/quota bounds and valid empty pages disclose coverage instead of fabricating completion',async()=>{
  const oversized=await retrieve(async url=>url===CBD_REGISTRY?fixture.home:json(url,JSON.parse(fixture.conferences.body)));
  assert.ok(oversized.pending.some(i=>i.state==='failed'&&i.reason.includes('page bound')));
  const empty=await retrieve(async url=>url===CBD_REGISTRY?fixture.home:json(url,[]));assert.equal(empty.documents.length,0);assert.equal(empty.home.raw,fixture.home.body);assert.equal(empty.progress.meeting_offset,0);assert.equal(empty.complete,false);
  const bounded=await retrieve(savedRead,{limits:{...limits,requests:1}});assert.equal(bounded.requests,1);assert.ok(bounded.pending.some(i=>i.state==='deferred'));
  const timed=await retrieve(async()=>{throw new Error('must not fetch');},{budget:{requests:0,deadline:10},now:()=>10});assert.equal(timed.requests,0);assert.ok(timed.pending.every(i=>i.state==='deferred'));
  const quota=await retrieve(async()=>{throw Object.assign(new Error('Quota exhausted'),{quota:true});});assert.equal(quota.requests,1);assert.ok(quota.pending.every(i=>i.state==='deferred'));
  await assert.rejects(retrieve(savedRead,{progress:{meeting_offset:-1}}),/progress/);await assert.rejects(retrieve(savedRead,{limits:{...limits,requests:0}}),/bounds/);
});

test('long description/table context, genuine registration/organizer links and API references survive without inferred authority',()=>{
  const row=structuredClone(reservations[0]);row.sideEvent.description='<p>Complete contexte français. </p>'.repeat(1000)+'<table><tr><th>Column context</th></tr><tr><td>Last full cell</td></tr></table>'+
    '<a rel="registration" href="https://example.org/register">Book a place</a><a rel="author" href="https://example.org/publisher">Publisher</a>';
  const raw=JSON.stringify(row),doc=prepareCbdPayload({id:'source',url:fixture.reservations0.url,raw,rows:[row],task:{kind:'reservation',id:row._id},provenance:[],sourceURL});
  assert.equal(doc.raw,raw);assert.ok(doc.prepared.text.includes('Last full cell'));assert.ok(doc.prepared.text.length>25000);
  assert.ok(doc.prepared.blocks.some(b=>b.table_context?.includes('Column context')));
  assert.ok(doc.prepared.links.some(l=>l.tag==='a'&&l.relationship==='registration'));assert.ok(doc.prepared.links.some(l=>l.tag==='a'&&l.relationship==='organizer'));assert.ok(doc.prepared.links.some(l=>l.tag==='api'));
  assert.equal(Object.hasOwn(doc,'authority'),false);assert.equal(Object.hasOwn(doc,'findings'),false);
});

test('carried pending/known/progress stay bounded across failed and unread cycles, then successful rechecks',async()=>{
  const initial=await retrieve(savedRead),original=initial.documents.find(d=>d.task?.kind==='reservation');
  let pending=initial.pending,known=[original],progress=initial.progress;const sizes=[];
  for(let cycle=0;cycle<80;cycle++){
    const reason='Current outage '+cycle%2;
    const result=await retrieve(async url=>({...json(url,{reason}),status:503}),{pending,known,progress});
    assert.equal(result.progress.meeting_offset,progress.meeting_offset);assert.deepEqual(result.progress.reservations,progress.reservations);assert.equal(result.progress.after_url,result.responses.at(-1).requested_url);assert.ok(result.responses.every(r=>r.response.body===JSON.stringify({reason})));
    for(const item of result.pending){
      assert.equal(item.state,'failed');assert.deepEqual(item.last_failure,{state:'failed',reason:'CBD response destination/status conflict'});
      assert.equal(new Set(item.via.map(v=>JSON.stringify(v))).size,item.via.length);
      assert.ok(item.via.filter(v=>v.relationship==='pending').length<=1);
      assert.ok(item.via.every(v=>!Object.hasOwn(v,'previous')&&!Object.hasOwn(v,'via')));
    }
    assert.ok(result.pending.some(item=>item.task.kind==='reservation'&&item.via.some(v=>v.source_url===original.provenance[0].source_url)));
    assert.ok(result.pending.some(item=>item.via.some(v=>v.relationship==='registry-discovery')));
    pending=result.pending;progress=result.progress;sizes.push(Buffer.byteLength(JSON.stringify(pending)));
  }
  assert.ok(Math.max(...sizes.slice(40))<=Math.max(...sizes.slice(10,40)));
  const unread=await retrieve(async()=>{throw new Error('Must not read');},{pending,known,progress,budget:{requests:0,deadline:0},now:()=>0});
  assert.equal(unread.requests,0);assert.deepEqual(unread.progress,progress);
  for(const item of unread.pending)assert.deepEqual(item.last_failure,pending.find(p=>p.url===item.url)?.last_failure);
  const bound=await retrieve(savedRead,{pending:unread.pending,known,progress,limits:{...limits,requests:1}});
  assert.equal(bound.requests,1);assert.deepEqual(bound.progress,progress);
  for(const item of bound.pending)assert.deepEqual(item.last_failure,unread.pending.find(p=>p.url===item.url)?.last_failure);
  for(let cycle=0;cycle<30;cycle++){
    const result=await retrieve(savedRead,{pending,known,progress});pending=result.pending;progress=result.progress;
    const current=result.documents.find(d=>d.id===original.id);assert.ok(current);assert.equal(current.raw,original.raw);
    known=[current];
    assert.ok(current.provenance[0].via.every(v=>!Object.hasOwn(v,'previous')&&!Object.hasOwn(v,'via')));
    assert.equal(new Set(current.provenance[0].via.map(v=>JSON.stringify(v))).size,current.provenance[0].via.length);
    assert.ok(current.provenance[0].via.length<=5);
    assert.ok(result.inventory.filter(i=>i.state==='retained').every(i=>!i.last_failure));
  }
});

test('native shared identities and durable repair priority survive outage/deferral without stale support acquisition',async()=>{
  const first=await retrieve(savedRead),knownDocuments=first.documents.map(({id,url})=>({id,url})),repair=knownDocuments.at(-1),waiting=knownDocuments[0];
  let pending=[{...waiting,state:'model-pending'},{...repair,state:'model-repair'}];
  for(let cycle=0;cycle<10;cycle++){
    const calls=[],result=await retrieve(async url=>{calls.push(url);if(url!==CBD_REGISTRY)throw new Error('Local primary outage');return fixture.home;},{knownDocuments,pending,limits:{...limits,requests:2}});
    assert.equal(JSON.parse(new URL(calls[1]).searchParams.get('q'))._id.$oid,repair.id.split(':').at(-1));
    const retained=result.pending.find(i=>i.id===repair.id);assert.equal(retained.pending_state,'model-repair');assert.equal(retained.last_failure.reason,'Local primary outage');
    pending=result.pending;
  }
  const unread=await retrieve(async()=>assert.fail('deadline must not read'),{knownDocuments,pending,budget:{requests:0,deadline:0},now:()=>0});
  assert.equal(unread.pending.find(i=>i.id===repair.id).pending_state,'model-repair');assert.deepEqual(unread.pending.find(i=>i.id===repair.id).last_failure,pending.find(i=>i.id===repair.id).last_failure);
  const recovered=await retrieve(savedRead,{knownDocuments,pending:unread.pending,limits:{...limits,requests:2}});
  assert.equal(recovered.documents[0].id,repair.id);assert.equal(recovered.documents[0].raw,first.documents.find(d=>d.id===repair.id).raw);
  for(const kind of ['meeting','hosts','rooms','types','countries']){
    const item={id:'cbd:'+kind+':'+meetings[0]._id,url:fixture[kind==='meeting'?'meetings':kind].url,task:{kind,id:meetings[0]._id,ids:[meetings[0]._id]}};
    const result=await retrieve(async url=>{assert.ok(url===CBD_REGISTRY||['/api/v2016/conferences','/api/v2016/reservations'].includes(new URL(url).pathname));return savedRead(url);},{known:[item],pending:[item,{id:item.id,url:item.url}]});
    assert.ok(result.coverage.some(c=>c.state==='unfetched'&&c.reason.includes('Optional')));assert.equal(result.pending.some(i=>i.task.kind===kind),false);assert.equal(result.documents.length,13);
  }
});

test('native identity/URL conflicts remain held across handoffs and cannot be bypassed by fresh page rows',async()=>{
  const row=reservations[0],id='cbd:reservation:'+row._id;
  for(const source of [{id,url:'https://example.org/unrelated'},{id,url:fixture.meetings.url},
    {id,url:fixture.reservations0.url.replaceAll(meetings[0]._id,JSON.parse(fixture.conferences.body)[2]._id).replaceAll(meetings[1]._id,JSON.parse(fixture.conferences.body)[2]._id)},
    {id:'cbd:reservation:aaaaaaaaaaaaaaaaaaaaaaaa',url:fixture.reservations0.url,task:{kind:'reservation',id:row._id}}]){
    let pending=[source];
    for(let cycle=0;cycle<5;cycle++){
      const result=await retrieve(savedRead,{pending});
      assert.equal(result.documents.some(d=>d.id===id),false);const held=result.pending.find(i=>i.id===id);assert.ok(held?.conflict);assert.equal(held.state,'failed');
      assert.equal(result.responses.some(r=>JSON.parse(new URL(r.requested_url).searchParams.get('q')??'{}')._id?.$oid===row._id),false);pending=result.pending;
    }
  }
  const url=new URL(fixture.reservations0.url);url.searchParams.set('q',JSON.stringify({'location.conference':{$in:[row.location.conference]}}));
  const changed=await retrieve(async value=>{const r=await savedRead(value),q=JSON.parse(new URL(value).searchParams.get('q')??'{}');
    if(new URL(value).pathname.endsWith('/reservations')&&!q._id){const rows=JSON.parse(r.body);for(const r of rows)if(r._id===row._id)r.location.conference=r.sideEvent.conference=meetings.find(m=>m._id!==row.location.conference)._id;return json(value,rows);}return r;
  },{pending:[{id,url:url.href,state:'model-repair'}]});
  assert.equal(changed.documents.find(d=>d.id===id).state,'conflict');assert.ok(changed.pending.some(i=>i.id===id&&i.conflict&&i.state==='failed'));
});

test('whole page tails resume under a document cap and native rechecks rotate without moving unread cursors',async()=>{
  const full=await retrieve(savedRead),expected=new Map(full.documents.map(d=>[d.id,d]));let pending=[],progress={},knownDocuments=[];const seen=new Set();
  for(let cycle=0;cycle<24;cycle++){
    const calls=[],result=await retrieve(async url=>{calls.push(url);return savedRead(url);},{pending,progress,knownDocuments,limits:{...limits,documents:3,requests:4}});
    assert.ok(result.documents.length<=3);assert.ok(result.requests<=4);assert.equal(result.requests,calls.length);
    assert.equal(result.progress.after_url,calls.filter(url=>url!==CBD_REGISTRY).at(-1)??progress.after_url);
    for(const doc of result.documents){assert.equal(doc.raw,expected.get(doc.id).raw);assert.equal(doc.prepared.text,expected.get(doc.id).prepared.text);seen.add(doc.id);}
    for(const item of result.pending.filter(i=>i.response)){assert.ok(item.remaining.length);assert.ok(item.remaining.every(id=>JSON.parse(item.response.body).some(r=>r._id===id)));}
    pending=result.pending;progress=result.progress;knownDocuments=[...new Map([...knownDocuments,...result.documents.map(({id,url})=>({id,url}))].map(d=>[d.id,d])).values()];
  }
  assert.equal(seen.size,13);
  const first=await retrieve(savedRead,{limits:{...limits,documents:3}}),tail=first.pending.find(i=>i.response);
  const resumed=await retrieve(async url=>{assert.equal(url,CBD_REGISTRY);return fixture.home;},{pending:[tail],progress:first.progress,limits:{...limits,documents:3,requests:1}});
  assert.equal(resumed.requests,1);assert.equal(resumed.documents.length,3);assert.equal(resumed.progress.after_url,first.progress.after_url);
  assert.deepEqual(resumed.responses.find(r=>r.state==='retained').response,tail.response);
});

test('shared requests, UTF8 and actual deadlines retain failures and reject invalid bounds without extra reads',async()=>{
  const exhausted=await retrieve(async()=>assert.fail('shared bound must not read'),{budget:{requests:30,deadline:Date.now()+10000}});assert.equal(exhausted.requests,0);
  for(const charge of [0,1,2]){
    const budget={requests:0,deadline:Date.now()+10000},result=await retrieve(async(url,shared)=>{shared.requests+=charge;return savedRead(url);},{budget});
    assert.equal(budget.requests,result.requests*Math.max(1,charge));assert.equal(result.documents.length,13);
  }
  const budget={requests:0,deadline:Date.now()+10000},crossed=await retrieve(async(url,shared)=>{shared.requests+=2;return savedRead(url);},{budget,limits:{...limits,requests:3}});
  assert.equal(budget.requests,4);assert.equal(crossed.requests,2);assert.equal(crossed.documents.length,0);assert.ok(crossed.responses.some(r=>r.state==='deferred'&&r.response));
  assert.ok(Buffer.byteLength(fixture.reservations0.body)>fixture.reservations0.body.length);
  const oversized=await retrieve(savedRead,{limits:{...limits,bytes:fixture.reservations0.body.length}});assert.equal(oversized.documents.length,0);assert.ok(oversized.responses.some(r=>r.state==='failed'&&r.response.body===fixture.reservations0.body));
  let time=0;const timed=await retrieve(async url=>{time=10;return savedRead(url);},{budget:{requests:0,deadline:10},now:()=>time});
  assert.equal(timed.requests,1);assert.equal(timed.documents.length,0);assert.equal(timed.responses[0].response.body,fixture.home.body);assert.equal(timed.responses[0].state,'deferred');
  for(const value of [0,-1,1.5,Infinity,Number.MAX_SAFE_INTEGER+1])for(const key of ['requests','documents','bytes'])await assert.rejects(retrieve(async()=>assert.fail('invalid bound must not read'),{limits:{...limits,[key]:value}}),/bounds/);
});

test('synthetic pagination routing of saved conference rows retries a failed page and eventually reaches every associated reservation',async()=>{
  // The fixture contains ten projected selector rows, not these unfiltered page responses.
  const conferences=JSON.parse(fixture.conferences.body).sort((a,b)=>a._id.localeCompare(b._id)),offsets=new Set(),seen=new Set();let failed=false,progress={},pending=[];
  for(let cycle=0;cycle<30;cycle++){
    const result=await retrieve(async url=>{
      if(url===CBD_REGISTRY)return fixture.home;
      const u=new URL(url),q=JSON.parse(u.searchParams.get('q')),offset=Number(u.searchParams.get('sk')??0);
      if(u.pathname.endsWith('/conferences')){offsets.add(offset);if(offset===2&&!failed){failed=true;throw new Error('Synthetic conference-page outage');}return json(url,conferences.slice(offset,offset+2));}
      const rows=reservations.filter(r=>q['location.conference'].$in.includes(r.location.conference));return json(url,rows.slice(offset,offset+10));
    },{progress,pending,limits:{...limits,documents:3,requests:4,reservationPages:1}});
    assert.ok(result.requests<=4);assert.ok(result.documents.length<=3);
    if(result.pending.some(i=>i.reason==='Synthetic conference-page outage'))assert.equal(result.progress.meeting_offset,2);
    for(const doc of result.documents)seen.add(doc.id);progress=result.progress;pending=result.pending;
  }
  assert.equal(failed,true);assert.deepEqual([...offsets].sort((a,b)=>a-b),[0,2,4,6,8,10]);assert.equal(seen.size,13);
});

test('real API leaves are fully accounted as attributable literal or honestly cleaned source fields',()=>{
  for(const key of ['reservations0','hosts','countries','meetings','rooms','types']){
    const source=fixture[key],rows=JSON.parse(source.body),doc=prepareCbdPayload({id:key,url:source.url,raw:source.body,rows,task:{kind:key},provenance:[],sourceURL});
    const fields=doc.prepared.blocks.filter(b=>b.tag==='source-field'),expected=[];
    function leaves(value,path,row){if(value&&typeof value==='object'&&Object.keys(value).length){for(const[k,v]of Object.entries(value))leaves(v,path+(Array.isArray(value)?'['+k+']':'.'+k),row);}else expected.push({path,value,row});}
    rows.forEach((row,index)=>leaves(row,'$['+index+']',index));assert.equal(fields.length,expected.length);
    for(const leaf of expected){
      const block=fields.find(b=>b.source_paths[0]===leaf.path);assert.ok(block,leaf.path);
      assert.equal(block.attribution.source_id,rows[leaf.row]._id);assert.equal(block.attribution.row,leaf.row);assert.equal(doc.prepared.url,source.url);
      const value=doc.prepared.text.slice(...block.value_range);
      if(block.transformation==='literal')assert.equal(value,typeof leaf.value==='string'?leaf.value:JSON.stringify(leaf.value));
      else{assert.equal(block.transformation,'html-cleaned');assert.ok(leaf.path.endsWith('.description'));assert.match(doc.prepared.offset_basis,/not the raw JSON/);}
    }
    assert.equal(doc.raw,source.body);assert.equal(doc.prepared.chunks.map(c=>doc.prepared.text.slice(c.start,c.end)).join(''),doc.prepared.text);
  }
  const row=reservations.find(r=>r.sideEvent.id===6915),raw=JSON.stringify(row),doc=prepareCbdPayload({id:'source',url:fixture.reservations0.url,raw,rows:[row],task:{kind:'reservation'},provenance:[],sourceURL});
  const fields=doc.prepared.blocks.filter(b=>b.tag==='source-field'),description=fields.find(b=>b.source_paths[0]==='$.sideEvent.description');
  for(const path of ['$.sideEvent.title','$.start','$.end','$.sideEvent.conference','$.sideEvent.hostOrgs[0]'])assert.ok(fields.find(b=>b.source_paths[0]===path).end<description.start);
  assert.equal(doc.prepared.source_rows[0].raw_path,'$');
});

test('multiple long Unicode descriptions retain row attribution, table/HTML context, unknowns and empty fields',()=>{
  const rows=[structuredClone(reservations[0]),structuredClone(reservations[0])];rows[1]._id='aaaaaaaaaaaaaaaaaaaaaaaa';
  rows.forEach((row,index)=>{row.sideEvent.title='Session '+index;row.sideEvent.description='<h2>Programme '+index+'</h2><p>'+('🌊 français 日本語 '.repeat(1000))+'Final row '+index+'</p><table><tr><th>Session context</th></tr><tr><td>Last table '+index+'</td></tr></table><script>Never execute</script>';
    row.unknown={literal:'Uninterpreted source metadata',nil:null,empty:[],object:{},flag:false};});
  const raw=JSON.stringify(rows),doc=prepareCbdPayload({id:'multi',url:fixture.reservations0.url,raw,rows,task:{kind:'reservations-page'},provenance:[],sourceURL});
  for(const[index,row]of rows.entries()){
    const field=doc.prepared.blocks.find(b=>b.tag==='source-field'&&b.source_paths[0]==='$['+index+'].sideEvent.description');
    const text=doc.prepared.text.slice(...field.value_range);assert.ok(text.includes('Final row '+index));assert.ok(text.includes('Last table '+index));assert.equal((text.match(/🌊/gu)??[]).length,1000);
    assert.equal(field.attribution.source_id,row._id);assert.equal(field.transformation,'html-cleaned');
    assert.ok(doc.prepared.blocks.some(b=>b.table_context?.includes('Session context')&&b.attribution.source_id===row._id));
    assert.ok(doc.prepared.omissions.some(o=>o.path==='$['+index+'].sideEvent.description'&&o.reason==='Removed script framing'));
    for(const key of ['literal','nil','empty','object','flag'])assert.ok(doc.prepared.blocks.some(b=>b.source_paths?.[0]==='$['+index+'].unknown.'+key));
  }
  assert.equal(doc.raw,raw);assert.ok(!doc.prepared.text.includes('Never execute'));assert.equal(doc.prepared.chunks.map(c=>doc.prepared.text.slice(c.start,c.end)).join(''),doc.prepared.text);
  const empty=prepareCbdPayload({id:'empty',url:fixture.reservations0.url,raw:'[]',rows:[],task:{kind:'hosts'},provenance:[],sourceURL});assert.equal(empty.prepared.text,'$: []');
});
