import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseDocument, DomUtils } from 'htmlparser2';
import { retrieveIDDRIDocuments, IDDRI_LISTINGS } from '../collector/iddri-documents.js';

const fixture=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/iddri-website.json.gz',import.meta.url))));
const sourceURL=value=>{
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password)throw new Error('Unsupported source URL');
  return url.href;
};
async function collect({overrides={},knownDocuments=[],pending=[],progress,limits={},budget}={}){
  const responses=new Map(Object.values(fixture).filter(v=>v?.url&&typeof v.body==='string').map(v=>[v.url,v]));
  for(const [url,response] of Object.entries(overrides))responses.set(url,response);
  const requests=[];
  const result=await retrieveIDDRIDocuments({sourceURL,knownDocuments,pending,progress,
    limits:{documents:30,requests:35,bytes:2_000_000,...limits},budget:budget??{requests:0,deadline:Date.now()+20_000},
    read:async url=>{requests.push(url);const response=responses.get(url);if(!response)throw new Error('Unsaved response');return response;}});
  return {...result,requests};
}

test('saved bilingual details retain whole bodies, publication metadata, alternate links and programme context',async()=>{
  const run=await collect();
  assert.equal(run.listings.length,2);assert.equal(run.inventory.length,24);assert.equal(run.documents.length,5);
  for(const doc of run.documents){
    const response=Object.values(fixture).find(v=>v?.url===doc.url);
    assert.equal(doc.raw,response.body);assert.equal(doc.identity,`iddri:node:${doc.id}:${doc.language}`);
    assert.ok(doc.metadata.some(m=>m.property==='og:type'));assert.ok(doc.alternates.length===2);
    assert.equal(doc.prepared.chunks.map(c=>doc.prepared.text.slice(c.start,c.end)).join(''),doc.prepared.text);
    for(const key of ['kind','organization','starts_at','ends_at','location','registration_url','findings','translation_of'])assert.ok(!Object.hasOwn(doc,key));
  }
  const english=run.documents.find(d=>d.url===fixture.brief.url),french=run.documents.find(d=>d.url===fixture['brief-fr'].url);
  assert.equal(english.id,french.id);assert.notEqual(english.identity,french.identity);
  assert.ok(english.prepared.links.some(l=>l.target===french.url));assert.ok(french.prepared.links.some(l=>l.target===english.url));
  assert.ok(french.prepared.text.includes('janvier'));assert.ok(english.prepared.text.length>1000);
  const event=run.documents.find(d=>d.url===fixture.event.url).prepared;
  for(const text of ['12pm EST','Speaker','IDDRI','concrete actions for ocean protection.'])assert.ok(event.text.includes(text));
  assert.ok(run.coverage.some(c=>/\.pdf/i.test(c.target??'')&&c.state==='unfetched'));
  assert.ok(run.coverage.some(c=>/zoom\.us/.test(c.target??'')&&c.state==='unfetched'));
  assert.ok(!run.requests.includes(fixture.zoom.url));assert.ok(!JSON.stringify(run.fetches).includes('traceresponse'));
  assert.ok(run.coverage.some(c=>c.reason.includes('pagination')));
});

test('publisher whitespace preserves literal clock text and registration URLs',async()=>{
  const source=fixture.event;assert.ok(source.body.includes('12pm EST'));
  const body=source.body.replace('12pm EST','12pm \t EST');
  const overrides=Object.fromEntries(IDDRI_LISTINGS.map(url=>[url,{...fixture.listing,url,status:503}]));
  overrides[source.url]={...source,body};
  const run=await collect({knownDocuments:[{id:'27670',url:source.url}],overrides}),doc=run.documents[0];
  assert.equal(doc.raw,body);assert.ok(doc.prepared.text.includes('12pm EST'));
  assert.ok(doc.prepared.links.some(l=>l.target==='https://us06web.zoom.us/webinar/register/WN_4MbKkHaqRWG20n3YivEmdQ#/registration'));
  assert.equal(doc.prepared.chunks.map(c=>doc.prepared.text.slice(c.start,c.end)).join(''),doc.prepared.text);
});

test('listing reorder and repeated URLs keep bounded selections and language identities stable',async()=>{
  const rows=[...fixture.listing.body.matchAll(/<article class="line-teaser">[\s\S]*?<\/article>/g)].map(m=>m[0]);
  assert.equal(rows.length,12);let i=rows.length;
  const listing={...fixture.listing,body:fixture.listing.body.replace(/<article class="line-teaser">[\s\S]*?<\/article>/g,()=>rows[--i])};
  const first=await collect({limits:{documents:4}}),second=await collect({limits:{documents:4},overrides:{[listing.url]:listing}});
  assert.deepEqual(second.requests,first.requests);assert.deepEqual(second.documents.map(d=>d.identity),first.documents.map(d=>d.identity));
  const duplicate=await collect({overrides:{[fixture.listing.url]:{...fixture.listing,body:fixture.listing.body.replace('</main>',rows[0]+'</main>')}}});
  assert.ok(duplicate.coverage.some(c=>c.state==='duplicate'));assert.equal(duplicate.documents.length,5);
});

test('known changed document is independently fetched behind unchanged and unavailable listings',async()=>{
  const changed={...fixture['brief-fr'],body:fixture['brief-fr'].body.replace('</article>','<p>Annexe technique supplémentaire.</p></article>')};
  for(const failed of [false,true]){
    const overrides={[changed.url]:changed};
    if(failed)for(const url of IDDRI_LISTINGS)overrides[url]={...fixture.listing,url,status:503};
    const run=await collect({knownDocuments:[{id:'27692',url:changed.url}],overrides});
    assert.match(run.documents.find(d=>d.url===changed.url).prepared.text,/Annexe technique supplémentaire/);
  }
});

test('cursor resumes bounded runs across failures, new and deferred entries plus unlisted known editions',async()=>{
  const first=await collect({limits:{documents:3}});
  const newURL='https://www.iddri.org/en/publications-and-events/letter/new-document';
  const unlistedURL='https://www.iddri.org/fr/publications-et-evenements/lettre/unlisted-document';
  const readable=(source,url)=>({...source,url,body:source.body.replaceAll(source.url,url)});
  const listing={...fixture.listing,body:fixture.listing.body.replace('</main>',
    `<article class="line-teaser"><a href="${newURL}"><h3>Office update without dates</h3></a></article></main>`)};
  const overrides={[listing.url]:listing,[newURL]:readable(fixture.brief,newURL),[unlistedURL]:readable(fixture['brief-fr'],unlistedURL)};
  let progress=first.progress;
  const attempted=new Set(first.requests),documents=[];
  for(let i=0;i<10;i++){
    const run=await collect({limits:{documents:3},knownDocuments:[{id:'27692',url:unlistedURL}],overrides,progress});
    run.requests.forEach(url=>attempted.add(url));documents.push(...run.documents);progress=run.progress;
    assert.ok(run.requests.length<=5);
  }
  for(const item of first.inventory)assert.ok(attempted.has(item.url));
  assert.ok(documents.some(d=>d.url===newURL));assert.ok(documents.some(d=>d.url===unlistedURL));
});

test('zero and multiple possible findings remain one full document; JSON-LD is retained without interpretation',async()=>{
  for(const content of ['<p>Office furniture update.</p>',
    '<h2>First session</h2><p>October 21 in Paris.</p><h2>Second session</h2><p>October 24 online.</p>']){
    const dom=parseDocument(fixture.event.body,{withStartIndices:true,withEndIndices:true});
    const body=DomUtils.findAll(n=>(n.attribs?.class??'').split(/\s+/).includes('field--name-body'),dom.children)[0];
    const structured='<script type="application/ld+json">{"@type":"Event","name":"Literal publisher metadata"}</script>';
    const response={...fixture.event,body:(fixture.event.body.slice(0,body.startIndex)+
      `<div class="field--name-body">${content}</div>`+fixture.event.body.slice(body.endIndex+1)).replace('</head>',structured+'</head>')};
    const run=await collect({knownDocuments:[{url:response.url}],overrides:{[response.url]:response}});
    const doc=run.documents.find(d=>d.url===response.url);
    assert.match(doc.prepared.text,/Literal publisher metadata/);
    assert.ok(doc.prepared.text.includes(content.includes('furniture')?'Office furniture':'Second session'));
    assert.ok(!Object.hasOwn(doc,'kind'));assert.ok(!Object.hasOwn(doc,'findings'));
  }
});

test('failed, unsupported, incomplete, excerpt-only and conflicting identity responses remain inspectable',async()=>{
  for(const response of [{...fixture.event,status:403},
    {...fixture.event,headers:{'content-type':'application/pdf'},body:'PDF payload'},
    {...fixture.event,body:fixture.event.body.replace('</html>','')},
    {...fixture.event,body:fixture.event.body.replaceAll('field--name-body','removed-body')},
    {...fixture.event,body:fixture.event.body.replace('en/node/27670','en/node/99')}]){
    const overrides={[response.url]:response};for(const url of IDDRI_LISTINGS)overrides[url]={...fixture.listing,url,status:503};
    const run=await collect({knownDocuments:[{id:'27670',url:response.url}],overrides});
    assert.equal(run.documents.length,0);assert.equal(run.fetches.at(-1).body,response.body);
    assert.ok(run.coverage.some(c=>c.url===response.url&&['failed','unsupported'].includes(c.state)));
  }
  const bound=await collect({progress:{after_url:fixture.event.url},limits:{requests:2}});
  assert.equal(bound.documents.length,0);assert.equal(bound.progress.after_url,fixture.event.url);
  assert.ok(bound.coverage.some(c=>c.reason==='Request/time limit'));
  const expired=await collect({budget:{requests:0,deadline:0}});assert.equal(expired.requests.length,0);
  const oversized=await collect({limits:{bytes:10}});assert.equal(oversized.documents.length,0);
  assert.equal(oversized.fetches[0].body,fixture.listing.body);
});
