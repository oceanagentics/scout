import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseDocument, DomUtils } from 'htmlparser2';
import { retrieveGFWDocuments, GFW_LISTING } from '../collector/publisher-documents.js';
import { prepareDocument } from '../collector/octo-documents.js';

const fixture=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/gfw-website.json.gz',import.meta.url))));
const article=JSON.parse(fixture['partnership-api'].body);
const identity='gfw:post:'+article.id;
const sourceURL=value=>{
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password)throw new Error('Unsupported source URL');
  return url.href;
};
async function collect({home=fixture.home,overrides={},knownArticles=[],linkedEvidence=[],limits={},budget,progress}={}){
  const responses=new Map(Object.values(fixture).filter(v=>v?.url&&typeof v.body==='string').map(v=>[v.url,v]));
  responses.set(GFW_LISTING,home);
  for(const [url,response] of Object.entries(overrides))responses.set(url,response);
  const requests=[];
  const result=await retrieveGFWDocuments({sourceURL,knownArticles,linkedEvidence,progress,
    limits:{articles:4,requests:8,bytes:2_000_000,...limits},budget:budget??{requests:0,deadline:Date.now()+10_000},
    read:async url=>{requests.push(url);const response=responses.get(url);if(!response)throw new Error('Unsaved response');return response;}});
  return {...result,requests};
}

test('saved full articles retain technical prose, raw payload and all context beyond legacy clipping',async()=>{
  const result=await collect({linkedEvidence:[{from:identity,target:'https://buff.ly/l7e7st4',relationship:'support',
    observed_destination:'https://skylight.global/news/ai2-gfw',via:'retained-post'}]});
  assert.equal(result.documents.length,4);assert.equal(result.inventory.filter(i=>i.state==='listed').length,28);
  const doc=result.documents.find(d=>d.identity===identity);
  assert.equal(doc.raw,fixture['partnership-api'].body);assert.equal(doc.html,article.content.rendered);
  assert.equal(doc.metadata.date_gmt,article.date_gmt);
  const paragraphs=DomUtils.getElementsByTagName('p',parseDocument(article.content.rendered,{withStartIndices:true}).children);
  const technical=paragraphs.find(p=>DomUtils.textContent(p).includes('jointly develop machine learning models'));
  assert.ok(technical.startIndex>4000);
  const technicalText=prepareDocument({title:'',url:doc.url,html:DomUtils.getOuterHTML(technical)}).text;
  assert.ok(doc.prepared.text.includes(technicalText));
  const tail=paragraphs.filter(p=>DomUtils.textContent(p).trim()).at(-1);
  assert.ok(doc.prepared.text.includes(DomUtils.textContent(tail).trim()));
  assert.equal(doc.prepared.chunks.map(c=>doc.prepared.text.slice(c.start,c.end)).join(''),doc.prepared.text);
  assert.ok(doc.prepared.links.length);assert.equal(doc.linked_evidence[0].state,'unfetched');
  for(const field of ['kind','organization','findings','starts_at','description'])assert.ok(!Object.hasOwn(doc,field));
  assert.equal(result.fetches[0].body,fixture.home.body);assert.ok(!JSON.stringify(result.fetches).includes('set-cookie'));
  assert.ok(result.coverage.some(c=>c.reason==='Article limit'));assert.ok(result.coverage.some(c=>c.reason.includes('pagination')));
});

test('listing reorder keeps identities and bounded selection stable; duplicates stay inspectable',async()=>{
  const rows=[...fixture.home.body.matchAll(/<article id="post-\d+"[\s\S]*?<\/article>/g)].map(m=>m[0]);
  let i=rows.length;
  const reordered={...fixture.home,body:fixture.home.body.replace(/<article id="post-\d+"[\s\S]*?<\/article>/g,()=>rows[--i])};
  const first=await collect(),second=await collect({home:reordered});
  assert.deepEqual(second.documents.map(d=>d.identity),first.documents.map(d=>d.identity));
  const duplicate=await collect({home:{...fixture.home,body:fixture.home.body.replace('</body>',rows[0]+'</body>')}});
  assert.equal(duplicate.documents.length,4);assert.ok(duplicate.coverage.some(c=>c.state==='duplicate'));
});

test('retained live listing separates its page wrapper from 28 owned cards and keeps the exclusion across failed listings',async()=>{
  const live=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/gfw-live-extraction.json.gz',import.meta.url))));
  const home={...live.artifacts.a1.data,headers:{'content-type':'text/html'}};
  const knownArticles=[{id:'58367',url:article.link},{id:'1',url:'https://globalfishingwatch.org/unlisted/article/'}];
  const first=await collect({home,knownArticles});
  assert.equal(first.inventory.length,28);assert.equal(first.inventory.filter(i=>i.state==='listed').length,28);
  assert.deepEqual(first.inventory.filter(i=>i.url===article.link).map(i=>i.id),['81556']);
  assert.deepEqual(first.progress.wrapper_ids,['58367']);assert.ok(first.coverage.some(c=>c.identity==='gfw:post:58367'&&c.state==='unsupported'));
  const known=[...knownArticles,...first.inventory.map(({id,url})=>({id,url}))],attempted=new Set();let progress=first.progress;
  for(let i=0;i<8;i++){
    const next=await collect({home:{...home,status:503},knownArticles:known,progress});progress=next.progress;
    next.requests.slice(1).forEach(url=>attempted.add(url));assert.deepEqual(progress.wrapper_ids,['58367']);
  }
  assert.ok(!attempted.has('https://globalfishingwatch.org/wp-json/wp/v2/posts/58367'));
  for(const {id} of known.filter(k=>k.id!=='58367'))assert.ok(attempted.has('https://globalfishingwatch.org/wp-json/wp/v2/posts/'+id));
  const nested={...home,body:home.body.replace('</body>','<article id="post-999"><article id="post-998"><h3 class="post-title"><a href="https://globalfishingwatch.org/nested/">Own title</a></h3></article></article></body>')};
  const guarded=await collect({home:nested});assert.equal(guarded.inventory.find(i=>i.id==='999').state,'failed');assert.equal(guarded.inventory.find(i=>i.id==='998').state,'listed');
});

test('known article is rechecked with unchanged or unavailable listing and retains changed full body',async()=>{
  const changed={...article,content:{...article.content,rendered:article.content.rendered+'<div><p>New technical appendix.</p></div>'}};
  const input={knownArticles:[{id:article.id,url:article.link}],limits:{articles:1},
    overrides:{[fixture['partnership-api'].url]:{...fixture['partnership-api'],body:JSON.stringify(changed)}}};
  for(const home of [fixture.home,{...fixture.home,status:503}]){
    const result=await collect({...input,home});
    assert.equal(result.documents[0].identity,identity);assert.match(result.documents[0].prepared.text,/New technical appendix/);
    assert.ok(result.requests.includes(fixture['partnership-api'].url));
  }
});

test('failed details and excerpt-only responses never become prepared full documents',async()=>{
  for(const response of [{...fixture['partnership-api'],status:403},
    {...fixture['partnership-api'],body:JSON.stringify({...article,content:{protected:false,rendered:''}})}]){
    const result=await collect({limits:{articles:1},overrides:{[response.url]:response}});
    assert.equal(result.documents.length,0);assert.ok(result.coverage.some(c=>c.state==='failed'));
    assert.equal(result.fetches.at(-1).body,response.body);
  }
});

test('request, time and byte limits expose deferred or failed coverage',async()=>{
  const request=await collect({limits:{requests:1}});assert.equal(request.requests.length,1);assert.equal(request.documents.length,0);
  assert.ok(request.coverage.some(c=>c.reason==='Request/time limit'));
  const timed=await collect({budget:{requests:0,deadline:0}});assert.equal(timed.requests.length,0);
  const bytes=await collect({limits:{bytes:10}});assert.equal(bytes.documents.length,0);
  assert.ok(bytes.coverage.some(c=>c.state==='failed'));
});

test('source bodies with zero or multiple possible findings are neither selected nor split semantically',async()=>{
  for(const html of ['<p>Office furniture update.</p>','<h2>Meeting one</h2><p>October 21.</p><h2>Meeting two</h2><p>October 24.</p>']){
    const body=JSON.stringify({...article,link:'https://globalfishingwatch.org/other-category/example/',
      content:{protected:false,rendered:`<div data-elementor-id="${article.id}">${html}</div>`}});
    const result=await collect({home:{...fixture.home,status:503},knownArticles:[{id:article.id,url:'https://globalfishingwatch.org/other-category/example/'}],
      overrides:{[fixture['partnership-api'].url]:{...fixture['partnership-api'],body}}});
    assert.equal(result.documents.length,1);assert.ok(!Object.hasOwn(result.documents[0],'findings'));
    assert.ok(result.documents[0].prepared.text.includes(html.includes('furniture')?'furniture':'Meeting two'));
  }
});

test('persisted bounded rotation eventually attempts new, deferred, failed and unlisted known identities',async()=>{
  const first=await collect();
  const newURL='https://globalfishingwatch.org/new/article/';
  const newAPI='https://globalfishingwatch.org/wp-json/wp/v2/posts/999999';
  const home={...fixture.home,body:fixture.home.body.replace('</body>',
    `<article id="post-999999"><h3 class="post-title"><a href="${newURL}">New article</a></h3></article></body>`)};
  const knownArticles=[...first.documents.map(d=>({id:d.id,url:d.url,last_seen_at:'2026-10-04T00:00:00Z'})),
    {id:'1',url:'https://globalfishingwatch.org/unlisted/article/'}];
  const changed={...article,content:{protected:false,rendered:'<article><p>Changed known article.</p></article>'}};
  const overrides={
    [newAPI]:{...fixture['partnership-api'],url:newAPI,body:JSON.stringify({...article,id:999999,link:newURL,content:{protected:false,rendered:'<p>New full article.</p>'}})},
    [fixture['partnership-api'].url]:{...fixture['partnership-api'],body:JSON.stringify(changed)}};
  let progress=first.progress;
  const attempted=new Set(),documents=[];
  for(let i=0;i<9;i++){
    const run=await collect({home,knownArticles,overrides,progress});
    for(const fetch of run.fetches.slice(1))attempted.add(fetch.requested_url);
    documents.push(...run.documents);progress=run.progress;
    assert.ok(run.requests.length<=5);
    if(i===0){assert.equal(run.documents.length,0);assert.ok(run.coverage.some(c=>c.state==='failed'));}
  }
  for(const item of first.inventory)assert.ok(attempted.has('https://globalfishingwatch.org/wp-json/wp/v2/posts/'+item.id));
  assert.ok(attempted.has(newAPI));assert.ok(attempted.has('https://globalfishingwatch.org/wp-json/wp/v2/posts/1'));
  assert.ok(documents.some(d=>d.identity===identity&&d.prepared.text.includes('Changed known article')));
  assert.ok(documents.some(d=>d.id==='999999'));
});

test('ordinary full WordPress bodies need no Elementor and invalid publication/protected/missing bodies fail',async()=>{
  for(const html of ['<p>Ordinary full body.</p>','<article><h2>Details</h2><p>Ordinary full body.</p></article>']){
    const run=await collect({limits:{articles:1},overrides:{[fixture['partnership-api'].url]:{
      ...fixture['partnership-api'],body:JSON.stringify({...article,content:{protected:false,rendered:html}})}}});
    assert.equal(run.documents[0].html,html);assert.match(run.documents[0].prepared.text,/Ordinary full body/);
  }
  for(const change of [{date_gmt:'2026-02-30T00:00:00'},{content:{protected:true,rendered:'<p>Protected body</p>'}},
    {content:undefined,excerpt:{rendered:'<p>Excerpt only.</p>'}}]){
    const run=await collect({limits:{articles:1},overrides:{[fixture['partnership-api'].url]:{
      ...fixture['partnership-api'],body:JSON.stringify({...article,...change})}}});
    assert.equal(run.documents.length,0);assert.ok(run.coverage.some(c=>c.state==='failed'));
  }
  const deferred=await collect({progress:{after_id:'81556'},limits:{requests:1}});
  assert.equal(deferred.progress.after_id,'81556');
});
