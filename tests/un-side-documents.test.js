import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { parseDocument, DomUtils } from 'htmlparser2';
import { sourceURL, LIMITS } from '../collector/hsa.js';
import { UN_SIDE_EVENTS, prepareSideListing, prepareSideApi, retrieveUnSideDocuments } from '../collector/un-side-documents.js';

const fixture=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/un-side-events.json.gz',import.meta.url))));
const tracker={collector:'web',url:UN_SIDE_EVENTS};
const norm=text=>text.replace(/\s+/g,' ').trim();
const retrieve=(read,options={})=>retrieveUnSideDocuments({tracker,read,sourceURL,budget:{requests:0,deadline:Date.now()+10000},...options});
const requestTask=url=>{const u=new URL(url),q=JSON.parse(u.searchParams.get('q'));return q['sideEvent.id']?{kind:'session',id:String(q['sideEvent.id'])}:q._id.$oid?{kind:'meeting',id:q._id.$oid}:{kind:u.pathname.endsWith('inde-orgs')?'hosts':'rooms',ids:q._id.$in.map(v=>v.$oid).sort()};};
const jsonResponse=(url,rows)=>({url,status:200,headers:{'content-type':'application/json'},body:JSON.stringify(rows)});
const savedApi=task=>Object.values(fixture).find(r=>r.url?.startsWith('https://api.cbd.int/')&&JSON.stringify(requestTask(r.url))===JSON.stringify(task));
const savedRead=async url=>{if(url===UN_SIDE_EVENTS)return fixture[url];const saved=savedApi(requestTask(url));if(!saved)throw new Error('No saved API source');return {...saved,url};};
const session=JSON.parse(savedApi({kind:'session',id:'6915'}).body)[0];
const listing=ids=>({url:UN_SIDE_EVENTS,status:200,headers:{'content-type':'text/html'},body:'<html><body><main id="page"><h1>Whole listing</h1><article class="node" about="'+new URL(UN_SIDE_EVENTS).pathname+'"><p>Full source context.</p><ul>'+ids.map(id=>'<li><a href="https://www.cbd.int/side-events/'+id+'">Uninterpreted source title</a> unknown meeting year</li>').join('')+'</ul><a href="https://example.org/programme.pdf">Concept note</a></article></main></body></html>'});

// Match saved projected API responses by structural query; adapter requests no
// field projection, and fixture bodies remain exact rather than reconstructed.
test('whole saved listing retains all old/current links, programme/concept context and headings',()=>{
  const doc=prepareSideListing(fixture[UN_SIDE_EVENTS],{sourceURL});assert.equal(doc.raw,fixture[UN_SIDE_EVENTS].body);
  const dom=parseDocument(doc.raw),main=DomUtils.getElementsByTagName('main',dom.children).find(n=>n.attribs.id==='page');
  const stack=[main];let count=0;
  while(stack.length){const n=stack.pop();if(['script','style','nav'].includes(n.name))continue;
    if(n.type==='text'&&norm(n.data).length>40){assert.ok(norm(doc.prepared.text).includes(norm(n.data)),norm(n.data));count++;}
    stack.push(...n.children??[]);
  }
  assert.ok(count>5);assert.ok(doc.prepared.text.includes('Side Events'));
  for(const id of ['6915','5838','5378'])assert.ok(doc.prepared.links.some(l=>l.target==='https://www.cbd.int/side-events/'+id&&l.tag==='a'));
  assert.ok(doc.prepared.links.some(l=>l.label==='Concept note'));
  assert.equal(doc.prepared.chunks.map(c=>doc.prepared.text.slice(c.start,c.end)).join(''),doc.prepared.text);
});

test('saved sessions retain full exact JSON, descriptions and literal references without acquiring supports',async()=>{
  const result=await retrieve(savedRead,{limits:{documents:12,requests:16}});
  for(const id of ['6915','5838','5378']){
    const doc=result.documents.find(d=>d.id==='un-side:session:'+id);assert.ok(doc,id);
    const saved=savedApi({kind:'session',id});assert.equal(doc.raw,saved.body);assert.ok(doc.prepared.blocks.some(b=>b.tag==='source-field'&&b.source_paths[0]==='$[0].sideEvent.description')); 
    const description=parseDocument(doc.rows[0].sideEvent.description),stack=[description];
    while(stack.length){const n=stack.pop();if(n.type==='text'&&norm(n.data).length>40)assert.ok(norm(doc.prepared.text).includes(norm(n.data)),norm(n.data));stack.push(...n.children??[]);}
    assert.equal(doc.prepared.chunks.map(c=>doc.prepared.text.slice(c.start,c.end)).join(''),doc.prepared.text);
    assert.ok(doc.via.some(v=>v.relationship==='session-link'&&v.link.tag==='a'));
    for(const value of [doc.rows[0].sideEvent.conference,...doc.rows[0].sideEvent.hostOrgs,doc.rows[0].location.room])assert.ok(doc.prepared.text.includes(value));
    assert.ok(result.coverage.some(c=>c.parent_id===doc.id&&c.relationship==='source-references'&&c.state==='unfetched'));
    for(const key of ['kind','title','organization','starts_at','status','candidate','findings'])assert.equal(Object.hasOwn(doc,key),false);
  }
  assert.equal(result.requests,4);assert.equal(result.documents.length,4);assert.equal(result.pending.length,0);
  assert.ok(result.responses.every(r=>r.requested_url===UN_SIDE_EVENTS||new URL(r.requested_url).pathname==='/api/v2016/reservations/'));
  assert.ok(result.coverage.some(c=>c.target?.includes('.pdf')&&c.state==='unsupported'));
  const programme=result.documents.find(d=>d.id==='un-side:session:6915').prepared.links.find(l=>l.tag==='api'&&l.target.includes('.pdf'));
  assert.ok(programme);assert.equal(result.complete,false);
});

test('repeat/reordered listing keeps source identity/payload separate from provenance; known content changes behind unchanged listing',async()=>{
  let ids=['6915','5838'],changed=false;
  const read=async url=>{
    if(url===UN_SIDE_EVENTS)return listing(ids);
    const task=requestTask(url),saved=await savedRead(url);
    if(changed&&task.kind==='session'&&task.id==='6915'){const rows=JSON.parse(saved.body);rows[0].sideEvent.description+='<p>Later changed source paragraph.</p>';return jsonResponse(url,rows);}return saved;
  };
  const first=await retrieve(read,{limits:{documents:12,requests:16}}),again=await retrieve(read,{limits:{documents:12,requests:16}});
  assert.deepEqual(first.documents.map(d=>[d.id,d.raw]),again.documents.map(d=>[d.id,d.raw]));
  ids=[...ids].reverse();const reordered=await retrieve(read,{limits:{documents:12,requests:16}});
  const a=first.documents.find(d=>d.id==='un-side:session:6915'),b=reordered.documents.find(d=>d.id===a.id);
  assert.equal(a.raw,b.raw);assert.equal(a.id,b.id);
  changed=true;const next=await retrieve(read,{known:first.documents,limits:{documents:12,requests:16}}),c=next.documents.find(d=>d.id===a.id);
  assert.ok(c.known);assert.notEqual(c.raw,a.raw);assert.ok(c.prepared.text.includes('Later changed source paragraph'));
});

test('unknown year/old/status/open/publication values and multiple reservations do not predecide eligibility or finding count',async()=>{
  const rows=[structuredClone(session),structuredClone(session)];rows[1]._id='aaaaaaaaaaaaaaaaaaaaaaaa';
  for(const row of rows){row.sideEvent.meta.status='archived';row.start=null;row.end=null;row.open=false;row.sideEvent.title='Unrelated source title';row.sideEvent.description='<p>Ancient unrelated contexte français. Complete context.</p>';}
  const result=await retrieve(async url=>url===UN_SIDE_EVENTS?listing(['6915']):requestTask(url).kind==='session'?jsonResponse(url,rows):savedRead(url),{limits:{documents:10,requests:12}});
  const doc=result.documents.find(d=>d.id==='un-side:session:6915');assert.ok(doc);assert.equal(doc.rows.length,2);
  assert.ok(doc.prepared.text.includes('archived'));assert.ok(doc.prepared.text.includes('contexte français'));
  assert.equal(Object.hasOwn(doc,'findings'),false);assert.equal(Object.hasOwn(doc,'candidate'),false);
});

test('bounded progress advances deferred sessions; known unlisted session remains recheckable after listing failure',async()=>{
  let known=[],pending=[];const visited=new Set();
  for(let run=0;run<7;run++){
    const result=await retrieve(savedRead,{known,pending,limits:{documents:2,requests:4}});pending=result.pending;
    for(const doc of result.documents){visited.add(doc.id);if(!known.some(k=>k.id===doc.id))known.push(doc);}
    assert.ok(result.documents.length<=2);assert.ok(result.requests<=4);
  }
  for(const id of ['6915','5838','5378'])assert.ok(visited.has('un-side:session:'+id));
  assert.ok([...visited].every(id=>id==='un-side:listing'||id.startsWith('un-side:session:')));assert.ok(pending.every(i=>i.task.kind==='session'));
  const knownSession=known.find(d=>d.id==='un-side:session:6915');
  const outage=await retrieve(async url=>{if(url===UN_SIDE_EVENTS)throw new Error('HTTP 403');return savedRead(url);},{known:[knownSession],limits:{documents:8,requests:10}});
  assert.ok(outage.documents.some(d=>d.id===knownSession.id&&d.known));assert.ok(outage.coverage.some(c=>c.url===UN_SIDE_EVENTS&&c.state==='failed'));
});

test('shared native ID/URL handoff resumes model work and rotates known sources within collection bounds',async()=>{
  const limits={...LIMITS,documents:LIMITS.pages-1},initial=await retrieve(savedRead,{limits});
  const original=initial.documents.find(d=>d.id==='un-side:session:6915'),known=initial.documents.map(({id,url})=>({id,url}));
  const resumed=await retrieve(async url=>url===UN_SIDE_EVENTS?listing([]):savedRead(url),
    {known,pending:[{id:original.id,url:original.url,state:'model-repair'}],limits:{...limits,documents:2}});
  assert.equal(resumed.documents[1]?.id,original.id);assert.equal(resumed.documents[1]?.known,true);
  assert.equal(resumed.documents[1].raw,original.raw);assert.deepEqual(resumed.documents[1].prepared,original.prepared);
  let pending=initial.pending;const visits=new Map();
  for(let run=0;run<12;run++){
    const budget={requests:0,deadline:Date.now()+10000},result=await retrieve(savedRead,{known,pending,limits,budget});pending=result.pending;
    for(const {id,url} of result.documents){visits.set(id,(visits.get(id)??0)+1);if(!known.some(k=>k.id===id))known.push({id,url});}
    assert.ok(result.documents.length<=limits.documents);assert.ok(budget.requests<=limits.requests);assert.equal(budget.requests,result.requests);
  }
  for(const item of known)assert.ok(visits.get(item.id)>=2,item.id+' must be rechecked');
  const outage=await retrieve(async url=>{if(url===UN_SIDE_EVENTS)throw new Error('Listing unavailable');return savedRead(url);},
    {known:[{id:original.id,url:original.url}],limits});
  assert.ok(outage.documents.some(d=>d.id===original.id&&d.known));
  const rejected=await retrieve(async url=>{assert.equal(url,UN_SIDE_EVENTS);return listing([]);},
    {known:[{id:original.id,url:'https://example.org/unrelated'},{id:'other:session:6915',url:original.url}],limits});
  assert.equal(rejected.requests,1);assert.equal(rejected.coverage.filter(c=>c.state==='unsupported'&&c.task).length,2);
});

test('shared requests and UTF-8 response byte bounds are enforced without double charging or clipping raw evidence',async()=>{
  const limits={documents:5,requests:3,bytes:524288},budget={requests:3,deadline:Date.now()+10000};
  const exhausted=await retrieve(async()=>{throw new Error('Must not read');},{limits,budget});
  assert.equal(exhausted.requests,0);assert.equal(budget.requests,3);assert.ok(exhausted.coverage.some(c=>c.state==='deferred'));
  budget.requests=1;
  const redirected=await retrieve(async(url,shared)=>{shared.requests+=2;return listing(['6915']);},{limits,budget});
  assert.equal(redirected.requests,1);assert.equal(budget.requests,3);assert.equal(redirected.pending[0].state,'deferred');
  const row=structuredClone(session);row.sideEvent.description='<p>'+('🌊'.repeat(2000))+'</p>';
  const body=JSON.stringify([row]),bytes=body.length,byteBudget={requests:0,deadline:Date.now()+10000};assert.ok(Buffer.byteLength(body)>bytes);
  const oversized=await retrieve(async url=>url===UN_SIDE_EVENTS?listing(['6915']):jsonResponse(url,[row]),
    {limits:{...limits,bytes},budget:byteBudget});
  assert.equal(oversized.documents.length,1);assert.equal(byteBudget.requests,2);
  assert.equal(oversized.responses[1].response.body,body);assert.match(oversized.pending[0].reason,/byte bound/);
  await assert.rejects(retrieve(savedRead,{limits:{...limits,bytes:0}}),/bounds/);
});

test('missing/ambiguous/mismatched sessions fail explicitly while preserving returned raw payloads',async()=>{
  const malformed=[[],[session,session],[{...session,sideEvent:{...session.sideEvent,id:999}}],
    [{...session,sideEvent:{...session.sideEvent,description:null}}]];
  for(const rows of malformed){
    const result=await retrieve(async url=>url===UN_SIDE_EVENTS?listing(['6915']):jsonResponse(url,rows));
    assert.equal(result.documents.length,1);assert.ok(result.pending.some(i=>i.task.kind==='session'&&i.state==='failed'));
    assert.ok(result.responses.some(r=>r.response.body===JSON.stringify(rows)));
  }
});

test('optional reference unknowns/conflicts and stale support tasks never gate or expand session acquisition',async()=>{
  const tasks=[{kind:'meeting',id:session.sideEvent.conference},{kind:'hosts',ids:session.sideEvent.hostOrgs},{kind:'rooms',ids:[session.location.room]}];
  const known=tasks.map(task=>({id:'un-side:'+task.kind+':'+(task.id??task.ids.join(',')),url:savedApi(task)?.url??'https://api.cbd.int/api/v2016/venue-rooms'}));
  const pending=tasks.map(task=>({task,state:'deferred',via:[{relationship:'source-reference',parent_id:'un-side:session:6915'}]}));
  const rows=[structuredClone(session),structuredClone(session),structuredClone(session)];
  rows[0].sideEvent.conference='unresolved-meeting';rows[0].sideEvent.hostOrgs=['unresolved-host'];rows[0].location={conference:'conflicting-meeting',room:'unresolved-room'};
  rows[1]._id='aaaaaaaaaaaaaaaaaaaaaaaa';rows[1].sideEvent.conference=null;rows[1].sideEvent.hostOrgs=null;rows[1].location=null;rows[1].start=null;rows[1].end=null;
  rows[2]._id='bbbbbbbbbbbbbbbbbbbbbbbb';delete rows[2].sideEvent.conference;delete rows[2].sideEvent.hostOrgs;delete rows[2].location;
  const reads=[],result=await retrieve(async url=>{reads.push(url);if(url===UN_SIDE_EVENTS)return listing(['6915']);assert.equal(requestTask(url).kind,'session');return jsonResponse(url,rows);},
    {known,pending:[...pending,...known.map(item=>({...item,state:'model-repair'}))],limits:{...LIMITS,documents:LIMITS.pages-1}});
  const doc=result.documents.find(d=>d.id==='un-side:session:6915');assert.ok(doc);assert.equal(doc.raw,JSON.stringify(rows));assert.deepEqual(doc.rows,rows);
  for(const value of ['unresolved-meeting','unresolved-host','conflicting-meeting','unresolved-room','$[1].sideEvent.conference: null','$[1].sideEvent.hostOrgs: null','$[1].location: null','$[1].start: null'])assert.ok(doc.prepared.text.includes(value),value);
  assert.equal(doc.prepared.blocks.some(b=>b.source_paths?.[0]==='$[2].sideEvent.conference'),false);
  assert.equal(reads.length,2);assert.equal(result.pending.length,0);assert.ok(result.inventory.every(i=>i.task.kind==='session'));
  for(const task of tasks){
    assert.ok(result.coverage.some(c=>c.task?.kind===task.kind&&c.state==='unfetched'));
    assert.ok(result.coverage.some(c=>c.task?.id?.startsWith('un-side:'+task.kind+':')&&c.state==='unfetched'));
    assert.throws(()=>prepareSideApi(jsonResponse(UN_SIDE_EVENTS,rows),{task,sourceURL}),/Unsupported/);
  }
});

test('malformed listings, failed/misdirected formats and request/deadline/quota limits cannot claim complete coverage',async()=>{
  const valid=listing(['6915']);
  for(const source of [{...valid,status:403},{...valid,body:'<html>truncated'},
    {...valid,body:valid.body.replace('class="node"','class="other"')},
    {...valid,body:valid.body.replace('about="'+new URL(UN_SIDE_EVENTS).pathname+'"','about="/wrong"')},
    {...valid,url:'https://example.org/wrong'}])assert.throws(()=>prepareSideListing(source,{sourceURL}));
  const redirected=await retrieve(async url=>url===UN_SIDE_EVENTS?valid:jsonResponse('https://example.org/wrong',[session]));
  assert.ok(redirected.pending.some(i=>i.state==='failed'));
  const failure=await retrieve(async()=>{throw new Error('HTTP 403');});assert.equal(failure.documents.length,0);assert.ok(failure.coverage.some(c=>c.state==='failed'));
  const bounded=await retrieve(async()=>valid,{limits:{documents:8,requests:1}});assert.equal(bounded.requests,1);assert.ok(bounded.pending.some(i=>i.state==='deferred'));
  const timed=await retrieve(async()=>{throw new Error('must not fetch');},{budget:{requests:0,deadline:10},now:()=>10,pending:[{task:{kind:'session',id:'6915'}}]});
  assert.equal(timed.requests,0);assert.equal(timed.pending[0].state,'deferred');
  const quota=await retrieve(async()=>{throw Object.assign(new Error('Quota exhausted'),{quota:true});},{known:[{task:{kind:'session',id:'6915'}}]});
  assert.equal(quota.requests,1);assert.equal(quota.pending[0].state,'deferred');
  await assert.rejects(retrieve(async()=>{}, {limits:{documents:0,requests:1}}),/bounds/);
});

test('common observed link relationships and very long source descriptions/raw metadata survive without prefix clipping',async()=>{
  const row=structuredClone(session);row.sideEvent.description='<p>Full bilingual context. Contexte français. '.repeat(500)+'Final section.</p>'+
    '<a rel="registration" href="https://example.org/register">Book a place</a><a rel="author" href="https://example.org/publisher">Publisher</a>';
  const result=await retrieve(async url=>url===UN_SIDE_EVENTS?listing(['6915']):requestTask(url).kind==='session'?jsonResponse(url,[row]):savedRead(url));
  const doc=result.documents.find(d=>d.id==='un-side:session:6915');assert.ok(doc.prepared.text.includes('Final section.'));
  assert.equal(doc.raw,JSON.stringify([row]));assert.ok(doc.prepared.text.length>20000);
  assert.ok(doc.prepared.links.some(l=>l.tag==='a'&&l.relationship==='registration'));assert.ok(doc.prepared.links.some(l=>l.tag==='a'&&l.relationship==='organizer'));
  assert.equal(Object.hasOwn(doc,'authority'),false);assert.equal(Object.hasOwn(doc,'findings'),false);
});

test('carried pending/known remains flat and bounded through failures, unread bounds and successful rechecks',async()=>{
  const initial=await retrieve(savedRead,{limits:{documents:12,requests:16}}),original=initial.documents.find(d=>d.id==='un-side:session:6915');
  let pending=initial.pending,known=[original];const sizes=[];
  for(let cycle=0;cycle<80;cycle++){
    const result=await retrieve(async url=>jsonResponse(url,[]),{pending,known,limits:{documents:12,requests:16}});
    for(const item of result.pending){
      assert.equal(item.state,'failed');assert.equal(item.last_failure.state,'failed');assert.equal(item.last_failure.reason,item.reason);
      assert.equal(new Set(item.via.map(v=>JSON.stringify(v))).size,item.via.length);
      assert.ok(item.via.filter(v=>v.relationship==='pending').length<=1);
      assert.ok(item.via.every(v=>!Object.hasOwn(v,'previous')&&!Object.hasOwn(v,'via')));
    }
    const session=result.pending.find(item=>item.task.kind==='session');
    assert.ok(session.via.some(v=>v.relationship==='session-link'&&v.parent_url===UN_SIDE_EVENTS&&v.link.target.endsWith('/6915')));
    assert.ok(result.responses.every(r=>r.response.body==='[]'));
    pending=result.pending;sizes.push(Buffer.byteLength(JSON.stringify(pending)));
  }
  assert.ok(Math.max(...sizes.slice(40))<=Math.max(...sizes.slice(10,40)));
  const unread=await retrieve(async()=>{throw new Error('Must not read');},{pending,known,budget:{requests:0,deadline:0},now:()=>0});
  assert.equal(unread.requests,0);
  for(const item of unread.pending)assert.deepEqual(item.last_failure,pending.find(p=>p.url===item.url)?.last_failure);
  const bound=await retrieve(savedRead,{pending:unread.pending,known,limits:{documents:12,requests:1}});assert.equal(bound.requests,1);
  for(const item of bound.pending)assert.deepEqual(item.last_failure,unread.pending.find(p=>p.url===item.url)?.last_failure);
  for(let cycle=0;cycle<30;cycle++){
    const result=await retrieve(savedRead,{pending,known,limits:{documents:12,requests:16}});pending=result.pending;
    const current=result.documents.find(d=>d.id===original.id);assert.ok(current);assert.equal(current.raw,original.raw);known=[current];
    assert.ok(current.via.some(v=>v.relationship==='session-link'&&v.link.target.endsWith('/6915')));
    assert.ok(current.via.every(v=>!Object.hasOwn(v,'previous')&&!Object.hasOwn(v,'via')));
    assert.equal(new Set(current.via.map(v=>JSON.stringify(v))).size,current.via.length);assert.ok(current.via.length<=3);
    assert.ok(result.inventory.filter(i=>i.state==='retained').every(i=>!i.last_failure));
  }
});

test('session6915 labels title/schedule/references before complete description and keeps full fields attributable',async()=>{
  const result=await retrieve(savedRead,{limits:{documents:12,requests:16}}),doc=result.documents.find(d=>d.id==='un-side:session:6915');
  const fields=doc.prepared.blocks.filter(b=>b.tag==='source-field'),description=fields.find(b=>b.source_paths[0]==='$[0].sideEvent.description');
  for(const path of ['$[0].sideEvent.title','$[0].start','$[0].end','$[0].sideEvent.conference','$[0].sideEvent.hostOrgs[0]']){
    const field=fields.find(b=>b.source_paths[0]===path);assert.ok(field.end<description.start);assert.equal(field.attribution.source_id,session._id);
  }
  assert.ok(doc.prepared.text.slice(...description.value_range).includes('Objective and description of the event'));assert.equal(description.transformation,'html-cleaned');
  const rows=[structuredClone(session),structuredClone(session)];rows[1]._id='aaaaaaaaaaaaaaaaaaaaaaaa';
  rows.forEach((row,index)=>{row.sideEvent.title='Literal session '+index;row.sideEvent.description='<h2>Session '+index+'</h2><p>'+('🌊 海洋 '.repeat(2000))+'Last '+index+'</p>';});
  const multi=await retrieve(async url=>url===UN_SIDE_EVENTS?listing(['6915']):requestTask(url).kind==='session'?jsonResponse(url,rows):savedRead(url));
  const source=multi.documents.find(d=>d.id===doc.id);assert.equal(source.raw,JSON.stringify(rows));
  for(const[index,row]of rows.entries()){
    const field=source.prepared.blocks.find(b=>b.tag==='source-field'&&b.source_paths[0]==='$['+index+'].sideEvent.description');
    const text=source.prepared.text.slice(...field.value_range);assert.ok(text.endsWith('Last '+index));assert.equal((text.match(/🌊/gu)??[]).length,2000);assert.equal(field.attribution.source_id,row._id);
  }
  assert.equal(source.prepared.chunks.map(c=>source.prepared.text.slice(c.start,c.end)).join(''),source.prepared.text);
});
