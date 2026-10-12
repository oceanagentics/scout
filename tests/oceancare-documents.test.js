import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseDocument, DomUtils } from 'htmlparser2';
import { retrieveOceanCareDocuments, OCEANCARE_LISTING } from '../collector/oceancare-documents.js';
import { prepareDocument } from '../collector/octo-documents.js';
import { sourceURL } from '../collector/hsa.js';

const fixture=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/oceancare-website.json.gz',import.meta.url))));
const story=response=>DomUtils.findAll(n=>(n.attribs?.class??'').split(/\s+/).includes('story-single'),
  parseDocument(response.body,{withStartIndices:true,withEndIndices:true}).children)[0];
async function collect({overrides={},knownDocuments=[],pending=[],progress,limits={},budget,now,charge=0}={}){
  const responses=new Map(Object.values(fixture).filter(v=>v?.url&&typeof v.body==='string').map(v=>[v.url,v]));
  for(const [url,response] of Object.entries(overrides))responses.set(url,response);
  const requests=[];
  const result=await retrieveOceanCareDocuments({sourceURL,knownDocuments,pending,progress,now,
    limits:{documents:600,requests:650,bytes:2_000_000,...limits},budget:budget??{requests:0,deadline:Date.now()+20_000},
    read:async(url,shared)=>{shared.requests+=charge;requests.push(url);const response=responses.get(url);if(!response)throw new Error('Unsaved response');return response;}});
  return {...result,requests};
}

test('real listing retains all structural cards and four full stories/JSON-LD without topic or date selection',async()=>{
  const run=await collect();assert.equal(run.documents.length,4);assert.equal(run.inventory.length,508);
  assert.equal(run.inventory.filter(i=>i.state==='listed').length,387);assert.equal(run.inventory.filter(i=>i.state==='unfetched').length,121);
  assert.equal(run.requests.length,388);assert.ok(!run.requests.some(url=>/\.(pdf|jpg|png)$/i.test(url)));
  assert.ok(!run.documents.some(d=>d.url===OCEANCARE_LISTING));
  assert.ok(run.inventory.some(d=>d.url.includes('iwc70-ban-commercial-whaling')));
  assert.ok(run.requests.some(url=>url.includes('iwc70-ban-commercial-whaling')));
  assert.equal(run.listing.raw,fixture.list.body);assert.ok(run.listing.alternates.some(a=>a.hreflang==='de'));
  for(const doc of run.documents){
    const response=Object.values(fixture).find(v=>v?.url===doc.url);
    assert.equal(doc.raw,response.body);assert.equal(doc.identity,'oceancare:post:'+doc.id+':en');
    assert.equal(doc.prepared.version,'octo-documents-v6');assert.equal(doc.language,'en');assert.equal(doc.listing.via,OCEANCARE_LISTING);
    assert.ok(doc.html.startsWith(response.body.slice(story(response).startIndex,story(response).endIndex+1)));
    assert.ok(!doc.html.includes('class="related child-3"'));
    assert.ok(doc.prepared.text.includes(prepareDocument({title:'',url:doc.url,html:DomUtils.getOuterHTML(story(response))}).text));
    assert.equal(doc.prepared.chunks.map(c=>doc.prepared.text.slice(c.start,c.end)).join(''),doc.prepared.text);
    assert.ok(doc.prepared.blocks.some(b=>b.tag==='structured-data'));
    assert.ok(doc.metadata.some(m=>m.property==='article:published_time'));
    for(const key of ['kind','organization','starts_at','findings','translation_of','description'])assert.ok(!Object.hasOwn(doc,key));
  }
  assert.ok(run.documents.find(d=>d.url===fixture.detail0.url).prepared.text.length>8000);
  assert.ok(run.coverage.some(c=>c.state==='failed'));assert.ok(run.coverage.some(c=>c.reason.includes('archives')));
  assert.ok(!JSON.stringify(run.fetches).includes('last-modified'));
});

test('card reordering and duplicate cards keep stable bounded URL selection',async()=>{
  const dom=parseDocument(fixture.list.body,{withStartIndices:true,withEndIndices:true});
  const main=DomUtils.getElementsByTagName('main',dom.children)[0];
  const anchors=DomUtils.getElementsByTagName('a',main.children).filter(n=>DomUtils.findAll(c=>(c.attribs?.class??'').split(/\s+/).includes('headline'),n.children).length);
  const first=anchors[0],last=anchors.at(-1),a=fixture.list.body.slice(first.startIndex,first.endIndex+1),b=fixture.list.body.slice(last.startIndex,last.endIndex+1);
  const listing={...fixture.list,body:fixture.list.body.slice(0,first.startIndex)+b+fixture.list.body.slice(first.endIndex+1,last.startIndex)+a+fixture.list.body.slice(last.endIndex+1)};
  const one=await collect({limits:{documents:4}}),two=await collect({limits:{documents:4},overrides:{[listing.url]:listing}});
  assert.deepEqual(two.requests,one.requests);assert.deepEqual(two.documents.map(d=>d.identity),one.documents.map(d=>d.identity));
  const duplicate=await collect({overrides:{[listing.url]:{...fixture.list,body:fixture.list.body.replace('</main>',a+'</main>')}}});
  assert.ok(duplicate.coverage.some(c=>c.state==='duplicate'));assert.equal(duplicate.documents.length,4);
});

test('known changed full story is rechecked behind unchanged or unavailable listing',async()=>{
  const node=story(fixture.detail0),end=node.endIndex-5;
  const changed={...fixture.detail0,body:fixture.detail0.body.slice(0,end)+'<p>New implementation appendix.</p>'+fixture.detail0.body.slice(end)};
  for(const failed of [false,true]){
    const overrides={[changed.url]:changed};if(failed)overrides[OCEANCARE_LISTING]={...fixture.list,status:503};
    const run=await collect({knownDocuments:[{id:failed?'oceancare:post:225194:en':'225194',url:changed.url}],overrides});
    assert.match(run.documents.find(d=>d.id==='225194').prepared.text,/New implementation appendix/);
  }
});

test('saved German alternate stays evidence; injected German edition is a separate source document',async()=>{
  const english=await collect(),doc=english.documents.find(d=>d.url===fixture.detail3.url);
  const alternate=doc.alternates.find(a=>a.hreflang==='de');assert.ok(alternate);
  assert.ok(doc.prepared.links.some(l=>l.target===alternate.href&&l.context==='Publisher language alternate'));
  assert.ok(!english.requests.includes(alternate.href));
  const german={...fixture.detail3,url:alternate.href,body:fixture.detail3.body.replaceAll(fixture.detail3.url,alternate.href)
    .replace('<html id="html" lang="en"','<html id="html" lang="de"')};
  const run=await collect({knownDocuments:[{id:'oceancare:post:'+doc.id+':de',url:alternate.href}],overrides:{[alternate.href]:german}});
  const edition=run.documents.find(d=>d.url===alternate.href);assert.equal(edition.language,'de');
  assert.notEqual(edition.identity,doc.identity);assert.equal(edition.raw,german.body);
  const unverified=await collect({pending:[{url:alternate.href,state:'model-pending'}],
    overrides:{[OCEANCARE_LISTING]:{...fixture.list,status:503},[alternate.href]:german}});
  assert.deepEqual(unverified.requests,[OCEANCARE_LISTING]);assert.ok(unverified.coverage.some(c=>c.reason?.includes('requires a known native ID')));
});

test('compact cursor rotates new, failed, deferred and unlisted known destinations',async()=>{
  const urls=['a-new','b-failed','c-deferred','d-unlisted'].map(name=>'https://www.oceancare.org/en/stories_and_news/'+name+'/');
  const listing={...fixture.list,body:'<html><head><link rel="canonical" href="'+OCEANCARE_LISTING+'"></head><body><main>'+
    urls.slice(0,3).map(url=>'<a href="'+url+'"><div class="headline">Office update without dates</div></a>').join('')+'</main></body></html>'};
  const overrides={[listing.url]:listing,...Object.fromEntries(urls.filter((_,i)=>i!==1).map(url=>[url,
    {...fixture.detail0,url,body:fixture.detail0.body.replaceAll(fixture.detail0.url,url)}]))};
  let progress={};const attempts=[],documents=[];
  for(let i=0;i<4;i++){
    const run=await collect({limits:{documents:1,requests:2},knownDocuments:[{id:'225194',url:urls[3]}],progress,overrides});
    progress=run.progress;attempts.push(...run.requests.slice(1));documents.push(...run.documents);
    assert.equal(run.requests.length,2);assert.equal(progress.after_url,urls[i]);
    if(i===0)assert.ok(run.coverage.some(c=>c.url===urls[2]&&c.state==='deferred'));
    if(i===1)assert.ok(run.coverage.some(c=>c.url===urls[1]&&c.state==='failed'));
  }
  assert.deepEqual(attempts,urls);assert.deepEqual(documents.map(d=>d.url),[urls[0],urls[2],urls[3]]);
});

test('zero and multiple possible findings stay whole neutral input',async()=>{
  for(const content of ['<p>Office furniture update.</p>','<table><tr><td>Office furniture table.</td></tr></table>',
    '<h2>First session</h2><p>October 21.</p><h2>Second session</h2><p>October 24.</p>']){
    const node=story(fixture.detail0),changed={...fixture.detail0,body:fixture.detail0.body.slice(0,node.startIndex)+
      `<div class="story-single"><h1>Source title</h1>${content}</div>`+fixture.detail0.body.slice(node.endIndex+1)};
    const run=await collect({overrides:{[changed.url]:changed}}),doc=run.documents.find(d=>d.id==='225194');
    assert.ok(doc.prepared.text.includes(content.includes('furniture')?'furniture':'Second session'));assert.ok(!Object.hasOwn(doc,'findings'));
  }
});

test('sibling related cards remain raw evidence and never alter the full story preparation or expand retrieval',async()=>{
  const old=await collect(),prior=old.documents.find(d=>d.url===fixture.detail0.url);
  const related=DomUtils.findAll(n=>(n.attribs?.class??'').split(/\s+/).includes('related'),
    parseDocument(fixture.detail0.body,{withStartIndices:true,withEndIndices:true}).children)[0];
  assert.ok(related.startIndex>story(fixture.detail0).endIndex);
  const target='https://www.oceancare.org/en/stories_and_news/related-only-document/';
  const changed={...fixture.detail0,body:fixture.detail0.body.slice(0,related.startIndex)+
    `<section class="related"><a href="${target}"><div class="headline">Different related story</div></a></section>`+fixture.detail0.body.slice(related.endIndex+1)};
  const run=await collect({overrides:{[changed.url]:changed}}),next=run.documents.find(d=>d.url===changed.url);
  assert.notEqual(next.raw,prior.raw);for(const field of ['id','identity','language','html','prepared','metadata','alternates'])assert.deepEqual(next[field],prior[field]);
  assert.ok(!next.prepared.text.includes('Different related story'));assert.ok(!run.requests.includes(target));
});

test('native repair and pending handoffs preserve ID/language, failure and priority through unread deferrals',async()=>{
  const listingFailed={[OCEANCARE_LISTING]:{...fixture.list,status:503}};
  const pending=[{id:'oceancare:post:225194:en',url:fixture.detail0.url,state:'model-pending'},
    {id:'oceancare:post:220850:en',url:fixture.detail3.url,state:'model-repair'},
    {url:fixture.detail3.url,state:'deferred',pending_state:'model-pending'}];
  const failed=await collect({pending,limits:{documents:1},progress:{after_url:fixture.detail0.url},
    overrides:{...listingFailed,[fixture.detail3.url]:{...fixture.detail3,status:403}}});
  assert.deepEqual(failed.requests,[OCEANCARE_LISTING,fixture.detail3.url]);assert.equal(failed.progress.after_url,fixture.detail3.url);
  const repair=failed.pending.find(d=>d.url===fixture.detail3.url);assert.equal(repair.id,'220850');assert.equal(repair.language,'en');
  assert.equal(repair.pending_state,'model-repair');assert.equal(repair.last_failure.state,'failed');
  const deferred=await collect({pending:failed.pending,progress:failed.progress,limits:{requests:1},overrides:listingFailed});
  assert.deepEqual(deferred.requests,[OCEANCARE_LISTING]);assert.equal(deferred.progress.after_url,failed.progress.after_url);
  assert.deepEqual(deferred.pending.find(d=>d.url===repair.url).last_failure,repair.last_failure);
  const done=await collect({pending:deferred.pending,progress:deferred.progress,limits:{documents:1},overrides:listingFailed});
  assert.deepEqual(done.documents.map(d=>d.identity),['oceancare:post:220850:en']);assert.equal(done.pending.length,1);
  const next=await collect({pending:done.pending,progress:done.progress,limits:{documents:1},overrides:listingFailed});
  assert.deepEqual(next.documents.map(d=>d.identity),['oceancare:post:225194:en']);assert.deepEqual(next.pending,[]);
});

test('generic/support/language handoffs stay unfetched and conflicting native IDs or languages stay unresolved',async()=>{
  const base={overrides:{[OCEANCARE_LISTING]:{...fixture.list,status:503}},progress:{after_url:fixture.detail0.url}};
  const forbidden=[fixture.home.url,OCEANCARE_LISTING,'https://www.oceancare.org/en/registration/',
    'https://www.oceancare.org/wp-content/uploads/programme.pdf','https://www.oceancare.org/en/stories_and_news/story/?download=1'];
  const handoffs=forbidden.map(url=>({id:'oceancare:post:225194:en',url,state:'model-repair'}));
  const stopped=await collect({...base,knownDocuments:handoffs,pending:handoffs});assert.deepEqual(stopped.requests,[OCEANCARE_LISTING]);
  for(const url of forbidden)assert.ok(stopped.coverage.some(c=>c.url===url&&c.state==='unsupported'));
  for(const id of ['oceancare:post:99:en','oceancare:post:225194:de']){
    const run=await collect({...base,knownDocuments:[{id:'oceancare:post:225194:en',url:fixture.detail0.url}],pending:[{id,url:fixture.detail0.url,state:'model-repair'}]});
    assert.deepEqual(run.requests,[OCEANCARE_LISTING]);assert.equal(run.progress.after_url,base.progress.after_url);
    assert.equal(run.pending[0].reason,'Conflicting known post ID/language');
    const repeated=await collect({...base,pending:run.pending});assert.deepEqual(repeated.requests,run.requests);
  }
  const nativeMismatch=await collect({...base,knownDocuments:[{id:'oceancare:post:225194:de',url:fixture.detail0.url}]});
  assert.equal(nativeMismatch.documents.length,0);assert.ok(nativeMismatch.pending[0].reason.includes('language metadata'));
  const routeMismatch=await collect({...base,knownDocuments:[{id:'225194',url:fixture.detail0.url}],
    overrides:{...base.overrides,[fixture.detail0.url]:{...fixture.detail0,body:fixture.detail0.body.replace('lang="en"','lang="de"')}}});
  assert.equal(routeMismatch.documents.length,0);assert.ok(routeMismatch.pending[0].reason.includes('route'));
  const foreign=await collect({...base,knownDocuments:[{id:'bluemarine:document:225194',url:fixture.detail0.url}]});
  assert.deepEqual(foreign.requests,[OCEANCARE_LISTING]);assert.ok(foreign.coverage.some(c=>c.reason==='Unsupported OceanCare native source identity/language'));
});

test('unsupported/failed/incomplete/excerpt-only/identity responses and request/time/byte limits remain honest',async()=>{
  const node=story(fixture.detail0);
  for(const response of [{...fixture.detail0,status:403},{...fixture.detail0,headers:{'content-type':'application/pdf'},body:'PDF payload'},
    {...fixture.detail0,body:fixture.detail0.body.replace('</html>','')},
    {...fixture.detail0,body:fixture.detail0.body.replace('postid-225194','postid-99')},
    {...fixture.detail0,body:fixture.detail0.body.replace('</main>','<div class="story-single"><h1>Another story</h1><p>Another boundary.</p></div></main>')},
    {...fixture.detail0,body:fixture.detail0.body.replace('</main>','</main><main>Another main</main>')},
    {...fixture.detail0,body:fixture.detail0.body.slice(0,node.startIndex)+'<div class="story-single"><h1>Excerpt</h1><div class="introtext"><p>Only introduction.</p></div></div>'+fixture.detail0.body.slice(node.endIndex+1)}]){
    const run=await collect({knownDocuments:[{id:'oceancare:post:225194:en',url:response.url}],
      overrides:{[OCEANCARE_LISTING]:{...fixture.list,status:503},[response.url]:response}});
    assert.equal(run.documents.length,0);assert.equal(run.fetches.at(-1).body,response.body);
    assert.ok(run.coverage.some(c=>c.url===response.url&&['failed','unsupported'].includes(c.state)));
    assert.ok(run.pending[0].last_failure);
  }
  const deferred=await collect({progress:{after_url:fixture.detail0.url},limits:{requests:1}});
  assert.equal(deferred.documents.length,0);assert.equal(deferred.progress.after_url,fixture.detail0.url);
  assert.ok(deferred.coverage.some(c=>c.reason==='Request/time limit'));
  const expired=await collect({budget:{requests:0,deadline:0}});assert.equal(expired.requests.length,0);
  const oversized=await collect({limits:{bytes:10}});assert.equal(oversized.documents.length,0);
  const utf8=await collect({knownDocuments:[{id:'225194',url:fixture.detail0.url}],limits:{bytes:fixture.detail0.body.length},
    overrides:{[OCEANCARE_LISTING]:{...fixture.list,status:503}}});
  assert.ok(Buffer.byteLength(fixture.detail0.body)>fixture.detail0.body.length);assert.equal(utf8.documents.length,0);assert.equal(utf8.fetches.at(-1).body,fixture.detail0.body);
  const budget={requests:0,deadline:Date.now()+20_000},charged=await collect({budget,charge:2,limits:{requests:4}});
  assert.equal(charged.requests.length,2);assert.equal(budget.requests,4);
  let ticks=0;const timed=await collect({now:()=>ticks++?10:0,budget:{requests:0,deadline:10},progress:{after_url:fixture.detail0.url}});
  assert.deepEqual(timed.requests,[OCEANCARE_LISTING]);assert.equal(timed.progress.after_url,fixture.detail0.url);
  for(const limits of [{documents:0},{requests:NaN},{bytes:1.5}])await assert.rejects(collect({limits}),/Invalid OceanCare retrieval bounds/);
});
