import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseDocument, DomUtils } from 'htmlparser2';
import { retrieveGOFDocuments, GOF_HOME, GOF_FEED } from '../collector/gof-documents.js';
import { prepareDocument } from '../collector/octo-documents.js';
import { sourceURL } from '../collector/hsa.js';

const fixture=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/gof-website.json.gz',import.meta.url))));
// Synthetic full HTML at an observed RSS association; no full RSS article was saved.
const articleURL=GOF_HOME+'2025/12/22/ocean-climate-news-15/';
const article={...fixture.glore,url:articleURL,body:fixture.glore.body.replaceAll(fixture.glore.url,articleURL).replaceAll('post-8624','post-8184')};
async function collect({overrides={},knownDocuments=[],pending=[],progress,limits={},budget,now,charge=0}={}){
  const responses=new Map(Object.values(fixture).filter(v=>v?.url&&typeof v.body==='string').map(v=>[v.url,v]));
  for(const [url,response] of Object.entries(overrides))responses.set(url,response);
  const requests=[];
  const result=await retrieveGOFDocuments({sourceURL,knownDocuments,pending,progress,now,
    limits:{documents:100,requests:150,bytes:2_000_000,...limits},budget:budget??{requests:0,deadline:Date.now()+20_000},
    read:async(url,shared)=>{shared.requests+=charge;requests.push(url);const response=responses.get(url);if(!response)throw new Error('Unsaved response');return response;}});
  return {...result,requests};
}

test('real homepage is a whole document; only RSS-associated articles are attempted and unsaved details stay gaps',async()=>{
  const run=await collect();assert.equal(run.documents.length,1);assert.equal(run.home.id,'1415');
  assert.equal(run.documents[0],run.home);
  assert.equal(run.home.raw,fixture.home.body);assert.equal(run.feed.raw,fixture.feed.body);
  assert.equal(run.inventory.filter(i=>i.via===GOF_FEED).length,10);
  for(const doc of run.documents){
    const response=Object.values(fixture).find(v=>v?.url===doc.url&&/text\/html/.test(v.headers?.['content-type']??''));
    assert.equal(doc.raw,response.body);assert.equal(doc.identity,'gof:document:'+doc.id);
    const body=DomUtils.findAll(n=>(n.attribs?.class??'').split(/\s+/).includes('post-content'),parseDocument(doc.html).children)[0];
    assert.ok(doc.prepared.text.includes(prepareDocument({title:'',url:doc.url,html:DomUtils.getOuterHTML(body)}).text));
    assert.equal(doc.prepared.chunks.map(c=>doc.prepared.text.slice(c.start,c.end)).join(''),doc.prepared.text);
    for(const key of ['kind','organization','starts_at','ends_at','findings','location','registration_url'])assert.ok(!Object.hasOwn(doc,key));
  }
  assert.ok(run.home.prepared.text.length>4000);assert.match(run.home.prepared.text,/Staying the Course and Stepping Up to New Challenges/);
  assert.ok(run.home.prepared.links.some(l=>l.target.includes('/registration-form')));
  assert.ok(run.coverage.some(c=>c.state==='failed'));assert.ok(run.coverage.some(c=>c.reason.includes('archives')));
  assert.ok(!run.requests.includes(fixture.iwlearn.url));assert.ok(!run.requests.includes(fixture.agenda.url));
  assert.ok(!run.requests.includes(fixture.glore.url));assert.ok(!run.requests.includes(fixture.csp.url));
  assert.equal(run.requests.length,12);assert.equal(run.pending.length,10);assert.equal(run.progress.articles.length,10);
  assert.ok(run.requests.every(url=>[GOF_HOME,GOF_FEED].includes(url)||run.inventory.some(i=>i.via===GOF_FEED&&i.url===url)));
  assert.ok(!JSON.stringify(run.fetches).includes('x-hacker'));
});

test('feed and homepage anchor reordering preserve bounded selection and duplicate observations',async()=>{
  const rows=[...fixture.feed.body.matchAll(/<item>[\s\S]*?<\/item>/g)].map(m=>m[0]);let i=rows.length;
  const feed={...fixture.feed,body:fixture.feed.body.replace(/<item>[\s\S]*?<\/item>/g,()=>rows[--i])};
  const first=await collect({limits:{documents:4}}),second=await collect({limits:{documents:4},overrides:{[GOF_FEED]:feed}});
  assert.deepEqual(second.requests,first.requests);
  assert.ok(first.coverage.some(c=>c.state==='duplicate'));
  const dom=parseDocument(fixture.home.body,{withStartIndices:true,withEndIndices:true});
  const article=DomUtils.getElementsByTagName('article',dom.children)[0];
  const anchors=DomUtils.getElementsByTagName('a',article.children).filter(n=>DomUtils.textContent(n).includes('Common Oceans Cross-sectoral Project'));
  assert.ok(anchors.length>=2);
  const a=anchors[0],b=anchors.at(-1),rawA=fixture.home.body.slice(a.startIndex,a.endIndex+1),rawB=fixture.home.body.slice(b.startIndex,b.endIndex+1);
  const home={...fixture.home,body:fixture.home.body.slice(0,a.startIndex)+rawB+fixture.home.body.slice(a.endIndex+1,b.startIndex)+rawA+fixture.home.body.slice(b.endIndex+1)};
  const reordered=await collect({limits:{documents:4},overrides:{[GOF_HOME]:home}});
  assert.deepEqual(reordered.requests,first.requests);
});

test('known native article is independently rechecked behind unchanged or failed discovery with retained RSS association',async()=>{
  const first=await collect(),changed={...article,body:article.body.replace('</article>','<p>Changed implementation appendix.</p></article>')};
  for(const failed of [false,true]){
    const overrides={[changed.url]:changed};
    if(failed){overrides[GOF_HOME]={...fixture.home,status:503};overrides[GOF_FEED]={...fixture.feed,status:503};}
    const run=await collect({knownDocuments:[{id:failed?'gof:document:8184':'8184',url:changed.url}],progress:first.progress,overrides});
    const doc=run.documents.find(d=>d.id==='8184');assert.match(doc.prepared.text,/Changed implementation appendix/);
    assert.match(doc.prepared.text,/PROJECT AT-A-GLANCE/);assert.match(doc.prepared.text,/Workshop 9/);
    assert.equal(doc.identity,'gof:document:8184');assert.equal(doc.raw,changed.body);
  }
});

test('persisted cursor rotates observed RSS articles and retains associations after they leave the feed',async()=>{
  const first=await collect({limits:{documents:3}});
  const newURL=GOF_HOME+'new-structural-page/';
  const readable={...article,url:newURL,body:article.body.replaceAll(article.url,newURL)};
  const feed={...fixture.feed,body:fixture.feed.body.replace('</channel>',`<item><title>Office furniture without dates or topic</title><link>${newURL}</link><post-id>8184</post-id></item></channel>`)};
  const overrides={[GOF_FEED]:feed,[newURL]:readable,[article.url]:article};
  const attempts=new Set(first.requests),documents=[];
  let progress=first.progress,pending=first.pending;
  for(let i=0;i<8;i++){
    const run=await collect({limits:{documents:3},knownDocuments:[{id:'gof:document:8184',url:article.url}],pending,progress,overrides});
    run.requests.forEach(url=>attempts.add(url));documents.push(...run.documents);progress=run.progress;pending=run.pending;
    assert.ok(run.requests.length<=4);assert.ok(run.documents.length<=3);
    if(i===0)overrides[GOF_FEED]={...fixture.feed,body:fixture.feed.body.replace(/<item>[\s\S]*?<\/item>/g,'')};
  }
  for(const item of first.inventory.filter(d=>d.state==='listed'))assert.ok(attempts.has(item.url));
  assert.ok(documents.some(d=>d.url===newURL));assert.ok(documents.some(d=>d.url===article.url));
});

test('zero/multiple possible findings and literal JSON-LD remain whole source documents',async()=>{
  for(const text of ['<p>Office furniture update.</p>',
    '<h2>First session</h2><p>October 21.</p><h2>Second session</h2><p>October 24.</p>']){
    const dom=parseDocument(article.body,{withStartIndices:true,withEndIndices:true});
    const body=DomUtils.findAll(n=>(n.attribs?.class??'').split(/\s+/).includes('post-content'),dom.children)[0];
    const changed={...article,body:(article.body.slice(0,body.startIndex)+`<div class="post-content">${text}</div>`+
      article.body.slice(body.endIndex+1)).replace('</head>','<script type="application/ld+json">{"name":"Literal source metadata","@type":"Event"}</script></head>')};
    const run=await collect({knownDocuments:[{id:'gof:document:8184',url:changed.url}],overrides:{[changed.url]:changed}});
    const doc=run.documents.find(d=>d.id==='8184');assert.match(doc.prepared.text,/Literal source metadata/);
    assert.ok(doc.prepared.text.includes(text.includes('furniture')?'furniture':'Second session'));assert.ok(!Object.hasOwn(doc,'findings'));
  }
});

test('homepage uses the document cap and stale navigation/project/meeting/support handoffs cannot expand retrieval',async()=>{
  const single=await collect({limits:{documents:1},knownDocuments:[{id:'gof:document:1415',url:GOF_HOME}]});
  assert.deepEqual(single.requests,[GOF_HOME,GOF_FEED]);assert.deepEqual(single.documents.map(d=>d.identity),['gof:document:1415']);
  assert.equal(single.pending.length,10);assert.equal(single.progress.after_url,undefined);
  const forbidden=[fixture.glore.url,fixture.csp.url,GOF_HOME+'about/',GOF_HOME+'sids4/',
    GOF_HOME+'2021/06/30/chile/',GOF_HOME+'4th-international-conference-on-small-island-developing-states-sids4/',fixture.agenda.url];
  const handoffs=forbidden.map(url=>({id:'gof:document:8624',url,state:'model-repair',via:GOF_FEED}));
  const run=await collect({knownDocuments:handoffs,pending:handoffs});
  for(const url of forbidden){assert.ok(!run.requests.includes(url));assert.ok(run.coverage.some(c=>c.url===url&&['unfetched','unsupported'].includes(c.state)));}
  assert.equal(run.requests.length,12);assert.equal(run.documents.length,1);
  assert.ok(run.home.prepared.links.some(l=>l.target===fixture.csp.url));assert.ok(!run.coverage.some(c=>c.reason?.includes('requires shared retrieval')));
});

test('native model repair and pending work survive failures and unread deferrals in priority order',async()=>{
  const initial=await collect({limits:{documents:1}}),repair=initial.progress.articles.find(d=>d.id==='8055');
  const readable={...article,url:repair.url,body:article.body.replaceAll(article.url,repair.url).replaceAll('post-8184','post-8055')};
  const pending=[{id:'gof:document:8184',url:article.url,state:'model-pending'},{...repair,id:'gof:document:8055',state:'model-repair'},
    {...repair,state:'deferred',pending_state:'model-pending'}];
  const failed=await collect({pending,limits:{documents:2},progress:initial.progress,overrides:{[repair.url]:{...readable,status:403}}});
  assert.deepEqual(failed.requests,[GOF_HOME,GOF_FEED,repair.url]);assert.equal(failed.progress.after_url,repair.url);
  const failure=failed.pending.find(d=>d.url===repair.url);assert.equal(failure.id,'8055');assert.equal(failure.pending_state,'model-repair');assert.equal(failure.last_failure.state,'failed');
  const deferred=await collect({pending:failed.pending,progress:failed.progress,limits:{requests:2}});
  assert.deepEqual(deferred.requests,[GOF_HOME,GOF_FEED]);assert.equal(deferred.progress.after_url,repair.url);
  assert.deepEqual(deferred.pending.find(d=>d.url===repair.url).last_failure,failure.last_failure);
  const done=await collect({pending:deferred.pending,progress:deferred.progress,limits:{documents:2},overrides:{[repair.url]:readable}});
  assert.deepEqual(done.documents.map(d=>d.identity),['gof:document:1415','gof:document:8055']);assert.ok(!done.pending.some(d=>d.url===repair.url));
  const next=await collect({pending:done.pending,progress:done.progress,limits:{documents:2},overrides:{[article.url]:article}});
  assert.deepEqual(next.documents.map(d=>d.identity),['gof:document:1415','gof:document:8184']);
});

test('actual known/feed ID conflicts stay pending without a read or cursor advance',async()=>{
  const progress={after_url:article.url,articles:[{id:'8184',url:article.url,via:GOF_FEED}]};
  const overrides={[GOF_HOME]:{...fixture.home,status:503},[GOF_FEED]:{...fixture.feed,status:503},[article.url]:article};
  const conflict=await collect({knownDocuments:[{id:'gof:document:99',url:article.url}],progress,overrides});
  assert.deepEqual(conflict.requests,[GOF_HOME,GOF_FEED]);assert.equal(conflict.progress.after_url,article.url);
  assert.equal(conflict.documents.length,0);assert.deepEqual(conflict.pending[0].conflicting_ids,['8184','99']);
  const repeated=await collect({pending:conflict.pending,progress:conflict.progress,overrides});
  assert.deepEqual(repeated.requests,conflict.requests);assert.deepEqual(repeated.pending[0].conflicting_ids,['8184','99']);
  const native=await collect({knownDocuments:[{id:'gof:document:8184',url:article.url}],progress,overrides});
  assert.deepEqual(native.documents.map(d=>d.identity),['gof:document:8184']);
  const foreign=await collect({knownDocuments:[{id:'bluemarine:document:8184',url:article.url}],progress,overrides});
  assert.ok(foreign.coverage.some(c=>c.state==='unsupported'&&c.reason==='Unsupported GOF native source identity'));
  const home=await collect({knownDocuments:[{id:'gof:document:99',url:GOF_HOME}],limits:{documents:1}});
  assert.ok(!home.documents.some(d=>d.url===GOF_HOME));assert.ok(home.coverage.some(c=>c.reason==='Known homepage identity disagreement'));
});

test('failed/unsupported/incomplete/excerpt-only/identity responses and exhausted budgets stay explicit',async()=>{
  const first=await collect();
  for(const detail of [{...article,status:403},{...article,headers:{'content-type':'application/pdf'},body:'PDF payload'},
    {...article,body:article.body.replace('</html>','')},
    {...article,body:article.body.replaceAll('post-content','excerpt-only')},
    {...article,body:article.body.replace('id="post-8184"','id="post-99"')}]){
    const run=await collect({knownDocuments:[{id:'gof:document:8184',url:detail.url}],progress:first.progress,
      overrides:{[GOF_HOME]:{...fixture.home,status:503},[GOF_FEED]:{...fixture.feed,status:503},[detail.url]:detail}});
    assert.equal(run.documents.length,0);assert.equal(run.fetches.find(f=>f.requested_url===detail.url).body,detail.body);
    assert.ok(run.coverage.some(c=>c.url===detail.url&&['failed','unsupported'].includes(c.state)));
    assert.ok(run.pending.find(d=>d.url===detail.url).last_failure);
  }
  const deferred=await collect({progress:{after_url:fixture.glore.url},limits:{requests:2}});
  assert.equal(deferred.documents.length,1);assert.equal(deferred.progress.after_url,fixture.glore.url);
  assert.ok(deferred.coverage.some(c=>c.reason==='Request/time limit'));
  const expired=await collect({budget:{requests:0,deadline:0}});assert.equal(expired.requests.length,0);
  const oversized=await collect({limits:{bytes:10}});assert.equal(oversized.documents.length,0);
  const utf8=await collect({limits:{bytes:fixture.home.body.length}});
  assert.ok(Buffer.byteLength(fixture.home.body)>fixture.home.body.length);assert.equal(utf8.documents.length,0);assert.equal(utf8.fetches[0].body,fixture.home.body);
  const budget={requests:0,deadline:Date.now()+20_000},charged=await collect({budget,charge:2,limits:{requests:4}});
  assert.deepEqual(charged.requests,[GOF_HOME,GOF_FEED]);assert.equal(budget.requests,4);
  let ticks=0;const timed=await collect({now:()=>ticks++?10:0,budget:{requests:0,deadline:10},progress:first.progress});
  assert.deepEqual(timed.requests,[GOF_HOME]);assert.equal(timed.progress.after_url,first.progress.after_url);
  for(const limits of [{documents:0},{requests:NaN},{bytes:1.5}])await assert.rejects(collect({limits}),/Invalid GOF retrieval bounds/);
});
