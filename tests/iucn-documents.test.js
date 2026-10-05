import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseDocument, DomUtils } from 'htmlparser2';
import { retrieveIUCNDocuments, IUCN_LISTING } from '../collector/iucn-documents.js';
import { prepareDocument } from '../collector/octo-documents.js';

const fixture=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/iucn-website.json.gz',import.meta.url))));
const sourceURL=value=>{
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password)throw new Error('Unsupported source URL');
  return url.href;
};
async function collect({home=fixture.home,overrides={},knownDocuments=[],progress,limits={},budget}={}){
  const responses=new Map(Object.values(fixture).filter(v=>v?.url&&typeof v.body==='string').map(v=>[v.url,v]));
  responses.set(IUCN_LISTING,home);
  for(const [url,response] of Object.entries(overrides))responses.set(url,response);
  const requests=[];
  const result=await retrieveIUCNDocuments({sourceURL,knownDocuments,progress,
    limits:{documents:20,requests:25,bytes:2_000_000,...limits},budget:budget??{requests:0,deadline:Date.now()+20_000},
    read:async url=>{requests.push(url);const response=responses.get(url);if(!response)throw new Error('Unsaved response');return response;}});
  return {...result,requests};
}

test('real fixture preserves whole articles, metadata, featured/listing identities and late body context',async()=>{
  const run=await collect();
  assert.equal(run.inventory.length,13);assert.equal(run.documents.length,7);
  assert.equal(run.inventory.filter(d=>d.via==='featured').length,7);
  assert.equal(run.listing.raw,fixture.home.body);assert.ok(run.listing.prepared.text.includes('high seas'));
  for(const doc of run.documents){
    const response=Object.values(fixture).find(v=>v?.url===doc.url);
    assert.equal(doc.raw,response.body);assert.ok(doc.metadata.length);assert.equal(doc.identity,'iucn:node:'+doc.id);
    assert.equal(doc.prepared.chunks.map(c=>doc.prepared.text.slice(c.start,c.end)).join(''),doc.prepared.text);
    const node=parseDocument(doc.html,{withStartIndices:true});
    const body=DomUtils.findAll(n=>(n.attribs?.class??'').split(/\s+/).includes('field--name-field-body'),node.children)[0];
    const expected=prepareDocument({title:'',url:doc.url,html:DomUtils.getOuterHTML(body)}).text;
    assert.ok(doc.prepared.text.includes(expected));
    assert.ok(!Object.hasOwn(doc,'kind'));assert.ok(!Object.hasOwn(doc,'organization'));assert.ok(!Object.hasOwn(doc,'findings'));
  }
  const blog=run.documents.find(d=>d.url===fixture.blog.url);
  assert.ok(blog.prepared.text.length>4000);assert.ok(blog.prepared.links.length);
  assert.ok(run.documents.some(d=>d.url===fixture.dataset.url));
  assert.ok(run.coverage.some(c=>c.reason.includes('archives/pagination')));
  assert.ok(run.coverage.some(c=>c.state==='failed'));assert.ok(!JSON.stringify(run.fetches).includes('set-cookie'));
});

test('structural listing reorder and duplicate cards preserve identities and bounded selection',async()=>{
  const rows=[...fixture.home.body.matchAll(/<li>\s*<div class="wrapper-line">[\s\S]*?<\/li>/g)].map(m=>m[0]);
  assert.equal(rows.length,6);
  let i=rows.length;
  const home={...fixture.home,body:fixture.home.body.replace(/<li>\s*<div class="wrapper-line">[\s\S]*?<\/li>/g,()=>rows[--i])};
  const first=await collect({limits:{documents:4}}),second=await collect({home,limits:{documents:4}});
  assert.deepEqual(second.requests,first.requests);
  assert.deepEqual(second.documents.map(d=>d.identity),first.documents.map(d=>d.identity));
  const duplicate=await collect({home:{...fixture.home,body:fixture.home.body.replace('</main>',rows[0]+'</main>')}});
  assert.ok(duplicate.coverage.some(c=>c.state==='duplicate'));assert.equal(duplicate.documents.length,7);
});

test('known changed document is independently rechecked behind unchanged or failed listing',async()=>{
  const changed={...fixture.blog,body:fixture.blog.body.replace('</article>','<section><p>New implementation appendix.</p></section></article>')};
  for(const home of [fixture.home,{...fixture.home,status:503}]){
    const run=await collect({home,knownDocuments:[{id:'45913',url:fixture.blog.url}],overrides:{[fixture.blog.url]:changed}});
    const doc=run.documents.find(d=>d.id==='45913');assert.match(doc.prepared.text,/New implementation appendix/);
  }
});

test('cursor progresses across new/deferred/failed and no-longer-listed known documents',async()=>{
  const first=await collect({limits:{documents:2}});
  const newURL='https://iucn.org/story/new-structural-document';
  const absentURL='https://iucn.org/story/unlisted-known-document';
  const home={...fixture.home,body:fixture.home.body.replace('</main>',
    `<div class="wrapper-title"><a href="${newURL}">No keywords or publication date</a></div></main>`)};
  const readable=url=>({...fixture.blog,url,body:fixture.blog.body.replaceAll(fixture.blog.url,url)});
  let progress=first.progress;
  const attempted=new Set(first.requests),documents=[];
  for(let i=0;i<9;i++){
    const run=await collect({home,limits:{documents:2},progress,knownDocuments:[{id:'45913',url:absentURL}],
      overrides:{[newURL]:readable(newURL),[absentURL]:readable(absentURL)}});
    progress=run.progress;run.requests.forEach(url=>attempted.add(url));documents.push(...run.documents);
    assert.ok(run.requests.length<=3);
  }
  for(const item of first.inventory)assert.ok(attempted.has(item.url));
  assert.ok(attempted.has(newURL));assert.ok(attempted.has(absentURL));
  assert.ok(documents.some(d=>d.url===newURL));assert.ok(documents.some(d=>d.url===absentURL));
});

test('unsupported media, failed details, identity mismatch and excerpt-only body stay honest',async()=>{
  for(const response of [{...fixture.blog,status:403},{...fixture.blog,headers:{'content-type':'application/pdf'},body:'Saved PDF bytes'},
    {...fixture.blog,body:fixture.blog.body.replaceAll('field--name-field-body','removed-body-field')},
    {...fixture.blog,body:fixture.blog.body.replace('data-history-node-id="45913"','data-history-node-id="99"')}]){
    const run=await collect({home:{...fixture.home,status:503},knownDocuments:[{id:'45913',url:fixture.blog.url}],overrides:{[fixture.blog.url]:response}});
    assert.equal(run.documents.length,0);assert.equal(run.fetches.at(-1).body,response.body);
    assert.ok(run.coverage.some(c=>c.url===fixture.blog.url&&['failed','unsupported'].includes(c.state)));
  }
  const external=await collect({knownDocuments:[{url:'https://example.org/external'}]});
  assert.ok(external.coverage.some(c=>c.url==='https://example.org/external'&&c.state==='unsupported'));
  assert.ok(!external.requests.includes('https://example.org/external'));
});

test('request/time/byte limits never advance cursor for unread details or imply full coverage',async()=>{
  const run=await collect({progress:{after_url:fixture.blog.url},limits:{requests:1}});
  assert.equal(run.requests.length,1);assert.equal(run.progress.after_url,fixture.blog.url);
  assert.equal(run.documents.length,0);assert.ok(run.coverage.some(c=>c.reason==='Request/time limit'));
  const expired=await collect({budget:{requests:0,deadline:0}});assert.equal(expired.requests.length,0);
  const oversized=await collect({limits:{bytes:10}});assert.equal(oversized.documents.length,0);
  assert.equal(oversized.fetches[0].body,fixture.home.body);assert.ok(oversized.coverage.some(c=>c.state==='failed'));
});
