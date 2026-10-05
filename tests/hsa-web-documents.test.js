import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseDocument, DomUtils } from 'htmlparser2';
import { retrieveHSAWebDocuments, HSA_FEED } from '../collector/hsa-web-documents.js';
import { prepareDocument } from '../collector/octo-documents.js';

const fixture=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/hsa-website.json.gz',import.meta.url))));
// Older saved projected bodies support injected routing regressions only;
// the separate full-api fixture proves actual unprojected receipt/HTML links.
for(const response of Object.values(fixture))if(response?.url?.includes('?_fields=')){
  response.observed_url=response.url;response.url=response.url.split('?')[0];
}
const full=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/hsa-web-full-api.json.gz',import.meta.url))));
const resource=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/bluesky-discovery.json.gz',import.meta.url)))).supports[0];
const chm=JSON.parse(fixture['chm-api'].body);
const sourceURL=value=>{
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password)throw new Error('Unsupported source URL');
  return url.href;
};
async function collect({overrides={},knownDocuments=[],pending=[],progress,limits={},budget}={}){
  const responses=new Map([...Object.values(fixture),resource].filter(v=>v?.url&&typeof v.body==='string').map(v=>[v.url,v]));
  for(const [url,response] of Object.entries(overrides))responses.set(url,response);
  const requests=[];
  const result=await retrieveHSAWebDocuments({sourceURL,knownDocuments,pending,progress,
    limits:{documents:20,requests:30,bytes:2_000_000,...limits},budget:budget??{requests:0,deadline:Date.now()+20_000},
    read:async url=>{requests.push(url);const response=responses.get(url);if(!response)throw new Error('Unsaved response');return response;}});
  return {...result,requests};
}

test('real feed identities and saved projected bodies with injected full-route URLs preserve complete content without excerpt fallback',async()=>{
  const run=await collect();assert.equal(run.inventory.length,10);assert.equal(run.documents.length,5);
  assert.equal(run.feed.raw,fixture.feed.body);
  for(const doc of run.documents){
    const response=Object.values(fixture).find(v=>v?.url===doc.response_url),article=JSON.parse(response.body);
    assert.equal(doc.raw,response.body);assert.equal(doc.html,article.content.rendered);assert.equal(doc.route,'api');
    assert.equal(doc.identity,'hsa:document:'+article.id);assert.equal(doc.metadata.modified_gmt,article.modified_gmt);
    assert.equal(doc.prepared.text,prepareDocument({title:article.title.rendered,url:doc.url,html:article.content.rendered}).text);
    assert.equal(doc.prepared.chunks.map(c=>doc.prepared.text.slice(c.start,c.end)).join(''),doc.prepared.text);
    for(const key of ['kind','organization','starts_at','location','findings','registration_url'])assert.ok(!Object.hasOwn(doc,key));
  }
  assert.ok(run.documents.find(d=>d.id==='6824').prepared.text.length>4000);
  assert.ok(run.documents.find(d=>d.id==='6803').prepared.text.includes('two events'));
  assert.ok(run.coverage.some(c=>c.state==='failed'));assert.ok(run.coverage.some(c=>c.reason.includes('archives')));
  assert.ok(run.coverage.some(c=>c.target==='https://bit.ly/clhmreg1'&&c.state==='unfetched'));
  assert.ok(!run.requests.includes('https://bit.ly/clhmreg1'));assert.ok(!JSON.stringify(run.fetches).includes('set-cookie'));
});

test('actual advertised full API receipt retains entire metadata/raw after HTML failure; actual HTML remains preferred',async()=>{
  const item={id:'6800',url:full.html.url},body=JSON.parse(full.api.body);
  const dom=parseDocument(full.html.body);
  assert.ok(DomUtils.getElementsByTagName('link',dom.children).some(n=>n.attribs.rel==='alternate'&&n.attribs.type==='application/json'&&n.attribs.href===full.api.url));
  assert.ok(!full.api.url.includes('?'));assert.equal(full.api.status,200);
  const overrides={[HSA_FEED]:{...fixture.feed,status:503},[full.api.url]:full.api};
  const fallback=await collect({knownDocuments:[item],overrides});
  assert.deepEqual(fallback.requests,[HSA_FEED,item.url,full.api.url]);
  const doc=fallback.documents[0];assert.equal(doc.route,'api');assert.equal(doc.raw,full.api.body);assert.deepEqual(doc.metadata,body);assert.equal(doc.html,body.content.rendered);assert.ok(Object.hasOwn(doc.metadata,'yoast_head_json'));
  const preferred=await collect({knownDocuments:[item],overrides:{...overrides,[item.url]:full.html}});
  assert.equal(preferred.documents[0].route,'html');assert.equal(preferred.documents[0].raw,full.html.body);assert.ok(!preferred.requests.includes(full.api.url));
  for(const changed of [{...body,id:99},{...body,link:resource.url},{...body,status:'draft'},{...body,type:'page'},{...body,content:{protected:true,rendered:'<p>Protected</p>'}}]){
    const rejected=await collect({knownDocuments:[item],overrides:{...overrides,[full.api.url]:{...full.api,body:JSON.stringify(changed)}}});assert.equal(rejected.documents.length,0);assert.equal(rejected.progress.after_url,item.url);assert.ok(rejected.coverage.some(c=>c.reason.includes('Full API identity/body unavailable')));
  }
});

test('real saved HSA HTML resource proves preferred whole-document route including JSON-LD and late content',async()=>{
  const run=await collect({knownDocuments:[{id:'6753',url:resource.url}]});
  const doc=run.documents.find(d=>d.id==='6753');assert.equal(doc.route,'html');assert.equal(doc.raw,resource.body);
  assert.ok(!run.requests.some(url=>url.includes('/posts/6753')));
  const dom=parseDocument(resource.body),node=DomUtils.getElementsByTagName('article',dom.children).find(n=>n.attribs.id==='post-6753');
  assert.ok(doc.html.includes(DomUtils.getOuterHTML(node).slice(0,25)));
  const body=DomUtils.findAll(n=>(n.attribs?.class??'').split(/\s+/).includes('entry-content'),node.children)[0];
  assert.ok(doc.prepared.text.includes(prepareDocument({title:'',url:doc.url,html:DomUtils.getOuterHTML(body)}).text));
  assert.ok(doc.prepared.blocks.some(b=>b.tag==='structured-data'));
  assert.ok(doc.prepared.links.some(l=>/\.pdf/i.test(l.target)));
});

test('feed reorder and duplicates preserve stable bounded selection and known identity',async()=>{
  const rows=[...fixture.feed.body.matchAll(/<item>[\s\S]*?<\/item>/g)].map(m=>m[0]);let i=rows.length;
  const feed={...fixture.feed,body:fixture.feed.body.replace(/<item>[\s\S]*?<\/item>/g,()=>rows[--i])};
  const first=await collect({limits:{documents:3}}),second=await collect({limits:{documents:3},overrides:{[HSA_FEED]:feed}});
  assert.deepEqual(second.requests,first.requests);assert.deepEqual(second.documents.map(d=>d.identity),first.documents.map(d=>d.identity));
  const duplicate=await collect({overrides:{[HSA_FEED]:{...fixture.feed,body:fixture.feed.body.replace('</channel>',rows[0]+'</channel>')}}});
  assert.ok(duplicate.coverage.some(c=>c.state==='duplicate'));assert.equal(duplicate.documents.length,5);
});

test('known documents recheck changed full content behind unchanged or unavailable feed',async()=>{
  const changed={...resource,body:resource.body.replace('</article>','<p>New full technical appendix.</p></article>')};
  for(const failed of [false,true]){
    const overrides={[resource.url]:changed};if(failed)overrides[HSA_FEED]={...fixture.feed,status:503};
    const run=await collect({knownDocuments:[{id:'6753',url:resource.url}],overrides});
    assert.match(run.documents.find(d=>d.id==='6753').prepared.text,/New full technical appendix/);
  }
});

test('retained pending HTML articles resume within bounds without admitting unobserved URLs',async()=>{
  const knownDocuments=[{id:'6800',url:full.html.url},{id:'6753',url:resource.url}];
  const input={knownDocuments,overrides:{[full.html.url]:full.html},progress:{after_url:full.html.url},limits:{documents:2,requests:5}};
  const ordinary=await collect(input),pending=[{...knownDocuments[0],state:'model-pending'},
    {...knownDocuments[1],state:'model-repair'},{url:'https://highseasalliance.org/unobserved/',state:'model-repair'}];
  const before=JSON.stringify({pending,knownDocuments,input});
  const run=await collect({...input,pending});
  assert.deepEqual(run.requests,[HSA_FEED,resource.url,full.html.url]);
  assert.deepEqual(run.documents.map(d=>d.identity),['hsa:document:6753','hsa:document:6800']);
  assert.equal(run.documents[1].raw,full.html.body);assert.equal(run.documents[1].route,'html');
  const repeat=await collect({...input,pending,knownDocuments:run.documents.map(({id,url})=>({id,url})),progress:run.progress});
  assert.deepEqual(repeat.documents.map(d=>[d.identity,d.raw,d.prepared]),run.documents.map(d=>[d.identity,d.raw,d.prepared]));
  assert.equal(JSON.stringify({pending,knownDocuments,input}),before);
  for(const state of ['complete','exhausted'])assert.deepEqual((await collect({...input,pending:pending.map(p=>({...p,state}))})).requests,ordinary.requests);
  const deferred=await collect({...input,pending,limits:{documents:2,requests:1}});
  assert.deepEqual(deferred.requests,[HSA_FEED]);assert.equal(deferred.progress.after_url,input.progress.after_url);
});

test('cursor rotates across deferred/failed/new/unlisted documents without fixed-first starvation',async()=>{
  const first=await collect({limits:{documents:2}});
  const newURL='https://highseasalliance.org/new-structural-document/';
  const html={...resource,url:newURL,body:resource.body.replaceAll(resource.url,newURL).replaceAll('post-6753','post-999999')};
  const feed={...fixture.feed,body:fixture.feed.body.replace('</channel>',
    `<item><title>No dates or topic</title><link>${newURL}</link><post-id>999999</post-id></item></channel>`)};
  let progress=first.progress;
  const attempted=new Set(first.requests),documents=[];
  for(let i=0;i<8;i++){
    const run=await collect({limits:{documents:2},knownDocuments:[{id:'6753',url:resource.url}],progress,
      overrides:{[HSA_FEED]:feed,[newURL]:html}});
    run.requests.forEach(url=>attempted.add(url));documents.push(...run.documents);progress=run.progress;
    assert.ok(run.requests.length<=5);
  }
  for(const item of first.inventory)assert.ok(attempted.has(item.url));
  assert.ok(documents.some(d=>d.id==='999999'));assert.ok(documents.some(d=>d.id==='6753'));
});

test('zero/multiple possible findings preserve whole input and source relationships without classification',async()=>{
  for(const content of ['<p>Office furniture update.</p>',
    '<h2>First session</h2><p>October 21.</p><h2>Second session</h2><p>October 24.</p>']){
    const response={...fixture['chm-api'],body:JSON.stringify({...chm,content:{protected:false,rendered:content}})};
    const run=await collect({overrides:{[response.url]:response}});
    const doc=run.documents.find(d=>d.id==='6800');assert.equal(doc.html,content);
    assert.ok(doc.prepared.text.includes(content.includes('furniture')?'furniture':'Second session'));assert.ok(!Object.hasOwn(doc,'findings'));
  }
});

test('HTTP 400, missing/full-body failure and request/time/byte bounds never produce successful excerpts',async()=>{
  for(const api of [{...fixture['chm-api'],status:400},
    {...fixture['chm-api'],body:JSON.stringify({...chm,content:{protected:false,rendered:''}})},
    {...fixture['chm-api'],body:JSON.stringify({...chm,content:{protected:true,rendered:'<p>Protected</p>'}})}]){
    const run=await collect({knownDocuments:[{id:'6800',url:chm.link}],overrides:{[HSA_FEED]:{...fixture.feed,status:503},[api.url]:api}});
    assert.equal(run.documents.length,0);assert.equal(run.fetches.at(-1).body,api.body);
    assert.ok(run.coverage.some(c=>c.state==='failed'));assert.equal(run.progress.after_url,chm.link);
  }
  const deferred=await collect({progress:{after_url:chm.link},limits:{requests:1}});
  assert.equal(deferred.documents.length,0);assert.equal(deferred.progress.after_url,chm.link);
  assert.ok(deferred.coverage.some(c=>c.reason==='Request/time limit'));
  const expired=await collect({budget:{requests:0,deadline:0}});assert.equal(expired.requests.length,0);
  const oversized=await collect({limits:{bytes:10}});assert.equal(oversized.documents.length,0);
});

test('unsupported and mismatched HTML details retain payloads and cannot claim full-document success',async()=>{
  for(const response of [{...resource,headers:{'content-type':'application/pdf'},body:'PDF payload'},
    {...resource,body:resource.body.replaceAll('entry-content','excerpt-only')},
    {...resource,body:resource.body.replace('id="post-6753"','id="post-99"')},
    {...resource,body:resource.body.replace('</html>','')}]){
    const run=await collect({knownDocuments:[{id:'6753',url:resource.url}],
      overrides:{[HSA_FEED]:{...fixture.feed,status:503},[resource.url]:response}});
    assert.equal(run.documents.length,0);assert.equal(run.fetches.find(f=>f.requested_url===resource.url).body,response.body);
    assert.ok(run.coverage.some(c=>c.url===resource.url&&['failed','unsupported'].includes(c.state)));
  }
});
