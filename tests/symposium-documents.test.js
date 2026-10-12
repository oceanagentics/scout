import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {parseDocument,DomUtils} from 'htmlparser2';
import {retrieveSymposiumDocuments,SYMPOSIUM_HOME} from '../collector/symposium-documents.js';
import {prepareDocument} from '../collector/octo-documents.js';
import {sourceURL} from '../collector/hsa.js';
const fixture=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/symposium-website.json.gz',import.meta.url))));
const satellite=fixture['satellite-events-2026'],recordings=fixture.session_recordings_2026;
async function collect({overrides={},knownDocuments=[],pending=[],progress,limits={},budget,now}={}){
  const map=new Map(Object.values(fixture).filter(v=>v?.body).map(v=>[v.url,v]));
  for(const [url,response] of Object.entries(overrides))map.set(url,response);
  const requests=[];
  const run=await retrieveSymposiumDocuments({read:async url=>{requests.push(url);if(!map.has(url))throw new Error('Unsaved response');return map.get(url);},sourceURL,
    budget:budget??{requests:0,deadline:Date.now()+20000},limits:{documents:100,requests:120,bytes:2000000,...limits},knownDocuments,pending,progress,now});
  return {...run,requests};
}
test('whole saved pages retain every late session, timeline, metadata and observed support',async()=>{
  const run=await collect();assert.equal(run.documents.length,3);assert.equal(run.documents[0],run.home);assert.equal(run.home.raw,fixture.home.body);
  for(const doc of run.documents){
    const response=Object.values(fixture).find(v=>v?.url===doc.url),dom=parseDocument(response.body);
    const node=DomUtils.findAll(n=>n.attribs?.id==='allrecords',dom.children)[0];
    assert.equal(doc.raw,response.body);assert.ok(doc.prepared.text.includes(prepareDocument({title:'',url:doc.url,html:DomUtils.getOuterHTML(node)}).text));
    assert.equal(doc.prepared.chunks.map(c=>doc.prepared.text.slice(c.start,c.end)).join(''),doc.prepared.text);
    assert.ok(doc.metadata.length);assert.equal(doc.identity,'symposium:document:'+doc.id);
    for(const key of ['kind','organization','starts_at','ends_at','location','status','findings'])assert.ok(!Object.hasOwn(doc,key));
  }
  assert.ok(run.documents.find(d=>d.url===satellite.url).prepared.text.length>10000);
  assert.ok(run.documents.find(d=>d.url===recordings.url).prepared.links.some(l=>l.target.includes('youtube.com')));
  assert.ok(run.coverage.some(c=>c.state==='failed'&&c.url==='https://bbnjsymposium.org/2026'));
  assert.ok(!run.requests.some(u=>u.includes('youtube.com')));
});
test('repeat and reordered links preserve bounded selection and duplicate fragment provenance',async()=>{
  const first=await collect({limits:{documents:2}}),repeat=await collect({limits:{documents:2}});
  assert.deepEqual(first.requests,repeat.requests);
  const menu=/<a\b[^>]*role="menuitem"[^>]*>[\s\S]*?<\/a>/g,anchors=[...fixture.home.body.matchAll(menu)].map(m=>m[0]).reverse();let index=0;
  const home={...fixture.home,body:fixture.home.body.replace(menu,()=>anchors[index++]).replace(/Programme\s*<\/a>/,'Programme</a><a role="menuitem" href="/2026#later">Programme</a>')};
  const changed=await collect({limits:{documents:2},overrides:{[SYMPOSIUM_HOME]:home}});
  assert.deepEqual(first.requests,changed.requests);assert.ok(changed.inventory.some(i=>i.target?.endsWith('#later')&&i.state==='duplicate'));
});
test('known changed body/title is rechecked even when homepage fails',async()=>{
  const changed={...satellite,body:satellite.body.replace('<title>Satellite events 2026</title>','<title>Corrected programme</title>').replace('</body>','<p>Late appendix outside content boundary.</p></body>').replace('Friday Workshop:','Corrected Workshop:')};
  const run=await collect({knownDocuments:[{url:changed.url,id:'symposium:document:118021646'}],overrides:{[SYMPOSIUM_HOME]:{...fixture.home,status:503},[changed.url]:changed}});
  assert.equal(run.documents.length,1);assert.match(run.documents[0].prepared.text,/Corrected Workshop/);assert.equal(run.documents[0].identity,'symposium:document:118021646');assert.equal(run.documents[0].prepared.title,'Corrected programme');
});
test('bounded cursor visits past/current and failed URLs and unlisted known pages',async()=>{
  const known='https://bbnjsymposium.org/satellite-events-2027',response={...satellite,url:known,body:satellite.body.replaceAll(satellite.url,known)};
  const visited=new Set();let progress={},pending=[];
  for(let i=0;i<12;i++){
    const run=await collect({limits:{documents:2},progress,pending,knownDocuments:[{url:known,id:'118021646'}],overrides:{[known]:response}});
    run.requests.forEach(u=>visited.add(u));progress=run.progress;pending=run.pending;assert.ok(run.requests.length<=2);assert.ok(run.documents.length<=2);
  }
  for(const path of ['2025','2026','satellite-events','satellite-events-2026','satellite-events-2027','session_recordings','session_recordings_2026'])assert.ok(visited.has(SYMPOSIUM_HOME+path));
});
test('zero/multiple findings, long later tables and JSON-LD remain neutral',async()=>{
  for(const content of ['<p>Office furniture update.</p>','<h2>First session</h2><p>'+ 'Long context. '.repeat(2000)+'</p><table><tr><td>Later technical session</td><td>Explicit source clock only</td></tr></table>']){
    const dom=parseDocument(satellite.body,{withStartIndices:true,withEndIndices:true}),node=DomUtils.findAll(n=>n.attribs?.id==='allrecords',dom.children)[0];
    const body=satellite.body.slice(0,node.startIndex)+`<div id="allrecords" data-tilda-page-id="118021646" data-tilda-project-id="10782915">${content}</div>`+satellite.body.slice(node.endIndex+1);
    const response={...satellite,body:body.replace('</head>','<script type="application/ld+json">{"name":"Literal metadata"}</script></head>')};
    const run=await collect({overrides:{[satellite.url]:response}}),doc=run.documents.find(d=>d.url===satellite.url);
    assert.match(doc.prepared.text,/Literal metadata/);assert.match(doc.prepared.text,content.includes('furniture')?/furniture/:/Later technical session/);assert.ok(!Object.hasOwn(doc,'findings'));
  }
});
test('failed, ambiguous, wrong identity and unsupported responses remain inspectable',async()=>{
  for(const response of [{...satellite,status:403},{...satellite,headers:{'content-type':'application/pdf'},body:'PDF'},
    {...satellite,body:satellite.body.replace('</html>','')},
    {...satellite,body:satellite.body.replace('data-tilda-page-id="118021646"','data-tilda-page-id="99"')},
    {...satellite,body:satellite.body.replace('</body>','<div id="allrecords">ambiguous</div></body>')}]){
    const run=await collect({knownDocuments:[{url:satellite.url,id:'118021646'}],overrides:{[SYMPOSIUM_HOME]:{...fixture.home,status:503},[satellite.url]:response}});
    assert.equal(run.documents.length,0);assert.equal(run.fetches.at(-1).body,response.body);assert.ok(run.coverage.some(c=>c.url===satellite.url&&['failed','unsupported'].includes(c.state)));
  }
});
test('request/time/byte limits retain deferred cursor and never claim unread success',async()=>{
  const run=await collect({limits:{requests:1},progress:{after_url:satellite.url}});
  assert.equal(run.documents.length,1);assert.equal(run.progress.after_url,satellite.url);assert.ok(run.coverage.some(c=>c.reason==='Request/time limit'));
  assert.equal((await collect({budget:{requests:0,deadline:0}})).requests.length,0);
  assert.equal((await collect({limits:{bytes:10}})).documents.length,0);
});

test('only observed programme/session navigation enters frontier; generic and stale support routes stay metadata',async()=>{
  const extra='<a href="/privacy">Privacy</a><a href="/registration">Register</a><a href="/session_recordings_2027">Unrelated citation</a>';
  const home={...fixture.home,body:fixture.home.body.replaceAll('Programme','Programme complet').replace('</body>',extra+'</body>')};
  const run=await collect({overrides:{[SYMPOSIUM_HOME]:home},knownDocuments:[{id:'symposium:document:12',url:SYMPOSIUM_HOME+'photo'}],pending:[{id:'symposium:document:13',url:SYMPOSIUM_HOME+'registration',state:'model-repair'}]});
  assert.deepEqual(run.requests,[SYMPOSIUM_HOME,...['2025','2026','satellite-events','satellite-events-2026','session_recordings','session_recordings_2026'].map(p=>SYMPOSIUM_HOME+p)]);
  for(const path of ['privacy','registration','session_recordings_2027','photo_archive_2026','photo']){
    assert.ok(!run.requests.includes(SYMPOSIUM_HOME+path));assert.ok([...run.inventory,...run.coverage].some(i=>(i.url??i.target)===SYMPOSIUM_HOME+path&&['unfetched','unsupported'].includes(i.state)),path);
  }
  assert.ok(run.home.raw.includes(extra));assert.ok(run.home.prepared.text.includes('Photo Archive'));
  const wrong=await collect({overrides:{[SYMPOSIUM_HOME]:{...fixture.home,status:503}},knownDocuments:[{url:satellite.url,id:'other:document:118021646'}]});
  assert.deepEqual(wrong.requests,[SYMPOSIUM_HOME]);assert.ok(wrong.coverage.some(c=>/native source identity/.test(c.reason)));
});

test('shared redirect charges and UTF-8 bounds stop reads without clipping failed evidence',async()=>{
  const budget={requests:0,deadline:Date.now()+10000};let reads=0;
  const charged=await retrieveSymposiumDocuments({read:async()=>{reads++;budget.requests+=2;return fixture.home;},sourceURL,budget,limits:{documents:5,requests:2,bytes:524288}});
  assert.equal(reads,1);assert.equal(budget.requests,2);assert.equal(charged.documents.length,1);
  const body=satellite.body.replace('Friday Workshop:','🌊'.repeat(1000)+' Friday Workshop:');assert.ok(Buffer.byteLength(body)>body.length);
  const oversized=await collect({overrides:{[satellite.url]:{...satellite,body}},pending:[{id:'symposium:document:118021646',url:satellite.url,state:'model-pending'}],limits:{documents:2,bytes:body.length}});
  assert.equal(oversized.documents.length,1);assert.equal(oversized.fetches.at(-1).body,body);assert.match(oversized.pending.find(p=>p.url===satellite.url).reason,/byte bound/);
  for(const limits of [{documents:0},{requests:0},{bytes:0},{bytes:Infinity}])await assert.rejects(collect({limits}),/bounds/);
});
