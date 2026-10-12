import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseDocument, DomUtils } from 'htmlparser2';
import { retrieveHarvestDocuments, HARVEST_HOME, HARVEST_WEBINARS } from '../collector/harvest-documents.js';

const fixture=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/harvest-website.json.gz',import.meta.url))));
const sourceURL=value=>{
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password)throw new Error('Unsupported source URL');
  return url.href;
};
const content=response=>DomUtils.findAll(n=>n.attribs?.id==='hrv-content',parseDocument(response.body,{withStartIndices:true,withEndIndices:true}).children)[0];
async function collect({overrides={},knownDocuments=[],pending=[],progress,limits={},budget}={}){
  // Historical fixture records omit status. Only this injected transport supplies
  // 200 for those saved bodies; the production adapter requires explicit status.
  const responses=new Map(Object.values(fixture).filter(v=>v?.url&&typeof v.body==='string').map(v=>[v.url,{status:200,...v}]));
  for(const [url,response] of Object.entries(overrides))responses.set(url,response);
  const requests=[];
  const result=await retrieveHarvestDocuments({sourceURL,knownDocuments,pending,progress,
    limits:{documents:4,requests:6,bytes:2_000_000,...limits},budget:budget??{requests:0,deadline:Date.now()+20_000},
    read:async url=>{requests.push(url);const response=responses.get(url);if(!response)throw new Error('Unsaved response');return response;}});
  return {...result,requests};
}

test('both saved publisher pages remain whole documents including current and archived contexts',async()=>{
  const run=await collect(),[home,index]=run.documents;assert.equal(home.id,'4426');assert.equal(run.documents.length,2);assert.equal(index.id,'4323');
  assert.deepEqual(run.requests,[HARVEST_HOME,HARVEST_WEBINARS]);assert.ok(run.inventory.length>30);
  for(const doc of run.documents){
    const response=doc.url===HARVEST_HOME?fixture.home:fixture.webinars;
    assert.equal(doc.raw,response.body);assert.equal(doc.identity,'harvest:document:'+doc.id);
    assert.equal(doc.prepared.chunks.map(c=>doc.prepared.text.slice(c.start,c.end)).join(''),doc.prepared.text);
    for(const key of ['kind','organization','starts_at','ends_at','findings','status','registration_url'])assert.ok(!Object.hasOwn(doc,key));
  }
  for(const text of ['Exceptional Circumstances','recordings and resources from previous sessions.'])assert.ok(index.prepared.text.includes(text));
  assert.ok(home.prepared.links.some(l=>l.target===fixture.registration.url+'#/registration'&&l.relationship==='registration'));
  assert.ok(run.coverage.some(c=>c.target===fixture.registration.url+'#/registration'&&c.state==='unfetched'));
  assert.ok(run.inventory.some(i=>i.links.some(l=>l.target?.includes('youtube.com'))));
  assert.ok(run.coverage.some(c=>c.reason.includes('archives')));assert.ok(!JSON.stringify(run.fetches).includes('headers'));
});

test('repeat is identical and grid reorder preserves page identities, all entries and bounded requests',async()=>{
  const one=await collect(),two=await collect({progress:one.progress});
  assert.deepEqual(two.documents.map(d=>[d.identity,d.raw]),one.documents.map(d=>[d.identity,d.raw]));
  const dom=parseDocument(fixture.home.body,{withStartIndices:true,withEndIndices:true});
  const entries=DomUtils.getElementsByTagName('li',dom.children).filter(n=>/\beg-post-id-\d+\b/.test(n.attribs.class??''));
  const a=entries[0],b=entries.at(-1),rawA=fixture.home.body.slice(a.startIndex,a.endIndex+1),rawB=fixture.home.body.slice(b.startIndex,b.endIndex+1);
  const home={...fixture.home,status:200,body:fixture.home.body.slice(0,a.startIndex)+rawB+fixture.home.body.slice(a.endIndex+1,b.startIndex)+rawA+fixture.home.body.slice(b.endIndex+1)};
  const reordered=await collect({overrides:{[HARVEST_HOME]:home}});
  assert.deepEqual(reordered.requests,one.requests);assert.equal(reordered.documents[0].identity,one.documents[0].identity);
  assert.deepEqual(reordered.inventory.map(i=>i.id).sort(),one.inventory.map(i=>i.id).sort());
});

test('known changed full index is independently rechecked behind unchanged or failed configured page',async()=>{
  const node=content(fixture.webinars),end=node.endIndex-5;
  const response={...fixture.webinars,status:200,body:fixture.webinars.body.slice(0,end)+'<p>New implementation appendix.</p>'+fixture.webinars.body.slice(end)};
  for(const failed of [false,true]){
    const overrides={[response.url]:response};if(failed)overrides[HARVEST_HOME]={...fixture.home,status:503};
    const run=await collect({knownDocuments:[{id:'4323',url:response.url}],overrides});
    const index=run.documents.find(d=>d.url===HARVEST_WEBINARS);assert.match(index.prepared.text,/New implementation appendix/);assert.equal(index.identity,'harvest:document:4323');
  }
});

test('bounded cursor admits new, deferred, failed and unlisted known URLs while rechecking index',async()=>{
  const urls=['https://harveststrategies.org/a-new/','https://harveststrategies.org/b-failed/','https://harveststrategies.org/c-unlisted/'];
  const knownDocuments=urls.map(url=>({url,id:'4323'}));
  const readable=url=>({...fixture.webinars,status:200,url,body:fixture.webinars.body.replaceAll(HARVEST_WEBINARS,url)});
  const overrides={[urls[0]]:readable(urls[0]),[urls[2]]:readable(urls[2])};
  let progress={};const attempts=[],docs=[];
  for(let i=0;i<5;i++){
    const run=await collect({knownDocuments,overrides,progress,limits:{documents:1}});
    assert.ok(run.requests.length<=2);attempts.push(...run.requests.slice(1));docs.push(...run.documents);progress=run.progress;
    assert.ok(run.coverage.some(c=>c.reason==='Detail document limit'));
  }
  for(const url of [...urls,HARVEST_WEBINARS])assert.ok(attempts.includes(url));
  assert.ok(docs.some(d=>d.url===urls[0]));assert.ok(docs.some(d=>d.url===urls[2]));
  const prioritized=await collect({knownDocuments,overrides,progress:{after_url:urls[2]},limits:{documents:1},
    pending:[{url:urls[2],state:'model-repair'},{url:HARVEST_WEBINARS,state:'model-pending'},{url:'https://harveststrategies.org/unobserved/',state:'model-repair'}]});
  assert.deepEqual(prioritized.requests,[HARVEST_HOME,urls[2]]);assert.equal(prioritized.progress.after_url,urls[2]);
});

test('zero/multiple possible findings and structured metadata never predecide records or schedules',async()=>{
  for(const text of ['<p>Office furniture update.</p>',
    '<h2>First session</h2><p>October 21.</p><h2>Second session</h2><p>October 24.</p>']){
    const node=content(fixture.home),response={...fixture.home,status:200,body:(fixture.home.body.slice(0,node.startIndex)+
      `<div id="hrv-content">${text}</div>`+fixture.home.body.slice(node.endIndex+1)).replace('</head>',
      '<script type="application/ld+json">{"@type":"Event","name":"Literal source metadata"}</script></head>')};
    const run=await collect({overrides:{[HARVEST_HOME]:response}});
    assert.match(run.documents[0].prepared.text,/Literal source metadata/);
    assert.ok(run.documents[0].prepared.text.includes(text.includes('furniture')?'furniture':'Second session'));assert.ok(!Object.hasOwn(run.documents[0],'findings'));
  }
});

test('missing status, malformed HTML, wrong identity/body and unsupported payloads remain failed/unfetched',async()=>{
  for(const response of [fixture.webinars,{...fixture.webinars,status:403},
    {...fixture.webinars,status:200,body:fixture.webinars.body.replace('</html>','')},
    {...fixture.webinars,status:200,body:fixture.webinars.body.replace('page-id-4323','page-id-99')},
    {...fixture.webinars,status:200,body:fixture.webinars.body.replace('id="hrv-content"','id="missing-content"')},
    {...fixture.webinars,status:200,headers:{'content-type':'application/pdf'},body:'PDF payload'}]){
    const run=await collect({knownDocuments:[{id:'4323',url:HARVEST_WEBINARS}],overrides:{[HARVEST_WEBINARS]:response}});
    assert.deepEqual(run.documents.map(d=>d.url),[HARVEST_HOME]);assert.equal(run.fetches.at(-1).body,response.body);
    assert.ok(run.coverage.some(c=>c.url===HARVEST_WEBINARS&&['failed','unsupported'].includes(c.state)));
  }
  const blocked=await collect({knownDocuments:[{url:'https://example.org/external'}]});
  assert.ok(blocked.coverage.some(c=>c.url==='https://example.org/external'&&c.state==='unsupported'));
});

test('request/time/byte bounds leave unread details deferred without cursor progress',async()=>{
  const run=await collect({limits:{requests:1},progress:{after_url:HARVEST_WEBINARS}});
  assert.deepEqual(run.documents.map(d=>d.url),[HARVEST_HOME]);assert.equal(run.progress.after_url,HARVEST_WEBINARS);
  assert.ok(run.coverage.some(c=>c.reason==='Request/time limit'));
  const expired=await collect({budget:{requests:0,deadline:0}});assert.equal(expired.requests.length,0);
  const bytes=await collect({limits:{bytes:10}});assert.equal(bytes.documents.length,0);
});
