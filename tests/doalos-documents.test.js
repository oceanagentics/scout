import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { parseDocument, DomUtils } from 'htmlparser2';
import { sourceURL } from '../collector/hsa.js';
import { DOALOS, NOTIFICATIONS, prepareDoalosDocument, retrieveDoalosDocuments } from '../collector/doalos-documents.js';

const fixture=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/doalos-notices.json.gz',import.meta.url))));
const tracker={collector:'web',url:DOALOS},notice1=DOALOS+'/notification-2026-001',notice2=DOALOS+'/notification-2026-002';
const response=url=>({...fixture[url],status:200,headers:{'content-type':'text/html'}});
const html=(url,content)=>({url,status:200,headers:{'content-type':'text/html'},body:'<html><body><main id="page"><h1>Complete page heading</h1><main id="content"><article class="node" about="'+new URL(url).pathname+'">'+content+'</article></main></main></body></html>'});
const home=urls=>html(DOALOS,'<p>Configured source context.</p><a href="'+NOTIFICATIONS+'">Notifications</a><article class="pattern-vertical-card"><h2>New</h2><ul>'+urls.map(u=>'<li><a href="'+u+'">Observed HTML document</a></li>').join('')+'</ul></article>');
const listing=urls=>html(NOTIFICATIONS,'<article class="pattern-vertical-card"><h2>2026</h2><table class="table"><caption>Whole listing</caption><tbody>'+urls.map(u=>'<tr><td>Uninterpreted date string</td><td><p><a href="'+u+'">Source link</a></p></td></tr>').join('')+'</tbody></table></article>');
const prepare=source=>prepareDoalosDocument(source,{sourceURL});
const retrieve=(read,options={})=>retrieveDoalosDocuments({tracker,read,sourceURL,budget:{requests:0,deadline:Date.now()+10000},...options});
const norm=text=>text.replace(/\s+/g,' ').trim();

test('saved homepage/listing/notices preserve all headings, article text, tables and later context',()=>{
  for(const url of [DOALOS,NOTIFICATIONS,notice1,notice2]){
    const source=response(url),doc=prepare(source),dom=parseDocument(source.body);
    const main=DomUtils.getElementsByTagName('main',dom.children).find(n=>n.attribs.id==='page');
    assert.equal(doc.raw,source.body);assert.equal(doc.id,'doalos:'+new URL(url).pathname);
    const headings=DomUtils.findAll(n=>/^h[1-6]$/.test(n.name),main.children).map(n=>norm(DomUtils.textContent(n))).filter(Boolean);
    for(const text of headings)assert.ok(norm(doc.prepared.text).includes(text),text);
    const stack=[main];let substantial=0;
    while(stack.length){const n=stack.pop();if(['script','style','nav'].includes(n.name))continue;
      if(n.type==='text'&&norm(n.data).length>40){assert.ok(norm(doc.prepared.text).includes(norm(n.data)),norm(n.data).slice(0,100));substantial++;}
      stack.push(...n.children??[]);
    }
    assert.ok(substantial>0);assert.equal(doc.prepared.chunks.map(c=>doc.prepared.text.slice(c.start,c.end)).join(''),doc.prepared.text);
    for(const key of ['kind','organization','date','action','status','findings','candidate'])assert.equal(Object.hasOwn(doc,key),false);
  }
  assert.ok(prepare(response(NOTIFICATIONS)).prepared.blocks.some(b=>b.tag==='table'));
  assert.ok(prepare(response(notice1)).prepared.text.includes('Action required by 16 March 2026'));
  assert.ok(prepare(response(notice2)).prepared.text.includes('No action required'));
});

test('real saved source routes retain exact responses/provenance, both old notices and missing linked MGR coverage',async()=>{
  const calls=[];
  const result=await retrieve(async url=>{calls.push(url);if(!fixture[url]?.body)throw new Error('No saved response');return response(url);},
    {limits:{documents:8,requests:10}});
  for(const url of [DOALOS,NOTIFICATIONS,notice1,notice2]){
    const doc=result.documents.find(d=>d.url===url);assert.ok(doc,url);assert.equal(doc.raw,fixture[url].body);
    assert.ok(result.responses.some(r=>r.response.body===fixture[url].body));
  }
  const doc=result.documents.find(d=>d.url===notice1);
  assert.ok(doc.via.some(v=>v.parent_url===DOALOS));assert.ok(doc.via.some(v=>v.parent_url===NOTIFICATIONS&&v.link.tag==='a'));
  assert.ok(result.pending.some(i=>i.url.includes('/mgr-notifications/')&&i.state==='failed'));
  const external='https://www.deepoceanbbnj.cn/2026.html';
  assert.equal(calls.includes(external),false);assert.ok(result.coverage.some(c=>c.target===external&&c.state==='unfetched'));
  assert.ok(result.coverage.some(c=>c.target?.includes('.pdf')&&c.state==='unsupported'));
  assert.equal(result.complete,false);
});

test('only announcement-entry occurrences acquire documents; ordinary context remains complete evidence',async()=>{
  const topic=DOALOS+'/bbnj-agreement/about-agreement',pages=new Map(),calls=[];
  const context='<p>Ordinary context: <a href="'+topic+'">About the Agreement</a> <a href="'+notice1+'">Repeated context link</a></p>';
  for(const url of [DOALOS,NOTIFICATIONS]){
    const source=response(url),dom=parseDocument(source.body,{withStartIndices:true});
    const article=DomUtils.getElementsByTagName('article',dom.children).find(n=>n.attribs.about);
    const start=source.body.indexOf('>',article.startIndex)+1;
    const body=source.body.slice(start).replace(url===DOALOS?'<ul>':'<table class="table">',context+(url===DOALOS?'<ul>':'<table class="table">'));
    pages.set(url,{...source,body:source.body.slice(0,start)+context+body.replace('<strong>Full text: </strong>',
      '<a href="'+topic+'">Later row support</a><strong>Full text: </strong>')});
  }
  const result=await retrieve(async url=>{calls.push(url);if(!fixture[url])throw new Error('No saved response');return pages.get(url)??response(url);},
    {limits:{documents:8,requests:10}});
  assert.equal(calls.includes(topic),false);assert.equal(result.inventory.some(i=>i.url===topic),false);
  for(const [url,source] of pages){
    const doc=result.documents.find(d=>d.url===url);assert.equal(doc.raw,source.body);
    assert.ok(doc.prepared.text.includes('Ordinary context:'));
    assert.ok(doc.prepared.links.some(l=>l.target===topic));assert.ok(doc.coverage.some(l=>l.target===topic&&l.state==='unfetched'));
    const via=result.documents.find(d=>d.url===notice1).via.filter(v=>v.parent_url===url);
    assert.equal(via.length,1);assert.notEqual(via[0].link.label,'Repeated context link');
    assert.equal(source.body.slice(doc.regions[0].start+via[0].link.start).startsWith('<a '),true);
  }
  assert.ok(result.pending.some(i=>i.url.includes('/mgr-notifications/')&&i.state==='failed'));
});

test('identical repeats retain payload/identity; listing reorder and changed known pages remain independent',async()=>{
  let order=[notice1,notice2],body='Original full body. Later paragraph.';
  const read=async url=>url===DOALOS?home([]):url===NOTIFICATIONS?listing(order):html(url,'<p>'+body+'</p>');
  const first=await retrieve(read),again=await retrieve(read);
  assert.deepEqual(first.documents.map(d=>[d.id,d.raw]),again.documents.map(d=>[d.id,d.raw]));
  order=[...order].reverse();const reordered=await retrieve(read);
  const a=first.documents.find(d=>d.url===notice1),b=reordered.documents.find(d=>d.url===notice1);
  assert.equal(a.id,b.id);assert.equal(a.raw,b.raw);
  const unchangedListing=listing(order).body;body='Changed known body. Full later bilingual contexte français.';
  const changed=await retrieve(read,{known:first.documents});const c=changed.documents.find(d=>d.url===notice1);
  assert.equal(c.id,a.id);assert.notEqual(c.raw,a.raw);assert.ok(c.known);assert.equal(listing(order).body,unchangedListing);
  assert.ok(c.prepared.text.includes('contexte français'));
});

test('bounded pending progression reaches new/deferred/failed/known pages without dropping returned content',async()=>{
  const urls=[DOALOS+'/failed',DOALOS+'/source-a',DOALOS+'/source-b'];let known=[],pending=[];const visited=new Set(),calls=[];
  const read=async url=>{calls.push(url);if(url===DOALOS)return home([]);if(url===NOTIFICATIONS)return listing(urls);
    if(url===urls[0])throw new Error('HTTP 403');return html(url,'<p>All source content.</p>');};
  for(let run=0;run<6;run++){
    const result=await retrieve(read,{known,pending,limits:{documents:2,requests:4}});pending=result.pending;
    for(const doc of result.documents){visited.add(doc.url);if(!known.some(k=>k.url===doc.url))known.push(doc);}
    assert.ok(result.documents.length<=2);assert.ok(result.requests<=4);
  }
  assert.ok(visited.has(urls[1]));assert.ok(visited.has(urls[2]));assert.ok(calls.includes(urls[0]));
  assert.ok(pending.some(i=>i.url===urls[0]));
});

test('known unlisted document is rechecked when home/listing is unavailable; no guessed listing is fetched',async()=>{
  const result=await retrieve(async url=>url===notice1?response(notice1):({...response(DOALOS),status:403}),{known:[{url:notice1}]});
  assert.equal(result.documents.length,1);assert.equal(result.documents[0].url,notice1);assert.ok(result.documents[0].known);
  assert.ok(result.coverage.some(c=>c.url===DOALOS&&c.state==='failed'));
  const calls=[];
  const missing=await retrieve(async url=>{calls.push(url);return html(DOALOS,'<p>No observed listing link.</p>');});
  assert.deepEqual(calls,[DOALOS]);assert.ok(missing.coverage.some(c=>c.url===NOTIFICATIONS&&c.state==='unfetched'));
  const homepage=home([notice1]),table=listing([notice1]);
  for(const broken of [
    {...homepage,body:homepage.body.replace('<h2>New</h2>','<h2>Other</h2>')},
    {...homepage,body:homepage.body.replace('</ul></article>','</ul></article><article class="pattern-vertical-card"><h2>New</h2><ul></ul></article>')},
    {...table,body:table.body.replace('<table class="table">','<table>')},
    {...table,body:table.body.replace('Source link</a>','Source link</a><a href="'+notice2+'">Ambiguous notice</a>')}
  ]){
    const result=await retrieve(async url=>url===broken.url?broken:home([]));
    assert.equal(result.inventory.some(i=>i.url===notice1),false);
    assert.ok(result.coverage.some(c=>c.url===broken.url&&c.relationship==='discovery'&&c.state==='unfetched'));
    assert.equal(result.documents.find(d=>d.url===broken.url).raw,broken.body);
  }
});

test('full long/unrelated source, source dates and genuine link relationships survive without eligibility or inferred fields',()=>{
  const url=DOALOS+'/unrelated-source',text='Ancient date string. Contexte complet français. '.repeat(1000)+'Last paragraph with two separate announcements.';
  const source=html(url,'<p>'+text+'</p><a rel="registration" href="https://example.org/register">Book a place</a>'+
    '<a rel="author" href="https://example.org/publisher">Publisher</a><a href="https://example.org/context">Context</a>');
  const doc=prepare(source);assert.ok(doc.prepared.text.includes('Last paragraph with two separate announcements'));
  assert.ok(doc.prepared.text.length>40000);assert.deepEqual(doc.prepared.links.map(l=>l.relationship),['registration','organizer','support']);
  assert.ok(doc.prepared.links.every(l=>l.tag==='a'&&l.state==='unfetched'));
  assert.equal(Object.hasOwn(doc,'authority'),false);assert.equal(Object.hasOwn(doc,'findings'),false);
});

test('missing/ambiguous/identity-conflicting, failed and redirected sources retain raw evidence and explicit failure',async()=>{
  const valid=html(notice1,'<p>Source content.</p>');
  for(const source of [{...valid,status:403},{...valid,headers:{'content-type':'application/pdf'}},{...valid,body:'<html>truncated'},
    {...valid,body:valid.body.replace('class="node"','class="other"')},
    {...valid,body:valid.body.replace('about="/bbnjagreement/en/notification-2026-001"','about="/bbnjagreement/en/other"')},
    {...valid,body:valid.body.replace('</body>','<article class="node" about="/bbnjagreement/en/extra">Other</article></body>')},
    {...valid,url:'https://example.org/wrong'}])assert.throws(()=>prepare(source));
  const redirected=await retrieve(async url=>url===DOALOS?home([notice1]):url===NOTIFICATIONS?listing([]):html(notice2,'Wrong response identity.'));
  assert.ok(redirected.pending.some(i=>i.url===notice1&&i.state==='failed'));
  assert.ok(redirected.responses.some(r=>r.requested_url===notice1&&r.response.url===notice2));
  const failure=await retrieve(async()=>{throw new Error('HTTP 403');});assert.equal(failure.documents.length,0);assert.ok(failure.coverage.some(c=>c.state==='failed'));
});

test('pagination/attachments and request/deadline/quota deferrals remain explicit without recursive retrieval',async()=>{
  const paged=html(NOTIFICATIONS,'<p>Current listing only.</p><nav><a rel="next" href="?page=1">Next</a></nav><a href="/bbnjagreement/sites/default/files/annex.pdf">Annex</a>');
  assert.ok(prepare(paged).coverage.some(c=>c.relationship==='pagination'&&c.state==='unfetched'));
  const bounded=await retrieve(async()=>home([notice1]),{limits:{documents:4,requests:1}});
  assert.equal(bounded.requests,1);assert.ok(bounded.pending.some(i=>i.state==='deferred'));
  const timed=await retrieve(async()=>{throw new Error('must not fetch');},{budget:{requests:0,deadline:10},now:()=>10,pending:[{url:notice1}]});
  assert.equal(timed.requests,0);assert.equal(timed.pending[0].state,'deferred');
  const quota=await retrieve(async()=>{throw Object.assign(new Error('Quota exhausted'),{quota:true});},{known:[{url:notice1}]});
  assert.equal(quota.requests,1);assert.equal(quota.pending[0].state,'deferred');
  await assert.rejects(retrieve(async()=>{}, {limits:{documents:0,requests:1}}),/bounds/);
});

test('carried pending/known stays bounded through failures, unread deferrals and successful source rechecks',async()=>{
  const read=async url=>url===DOALOS?home([notice1]):url===NOTIFICATIONS?listing([notice1]):response(url);
  const initial=await retrieve(read),original=initial.documents.find(d=>d.url===notice1);
  let pending=initial.pending,known=[original];const sizes=[];
  for(let cycle=0;cycle<80;cycle++){
    const result=await retrieve(async url=>({...html(url,'Full failed source receipt.'),status:503}),{pending,known});
    assert.ok(result.responses.every(r=>r.response.body.includes('Full failed source receipt.')));
    for(const entry of result.pending){
      assert.equal(entry.state,'failed');assert.deepEqual(entry.last_failure,{state:'failed',reason:entry.reason});
      assert.equal(new Set(entry.via.map(v=>JSON.stringify(v))).size,entry.via.length);
      assert.ok(entry.via.filter(v=>v.relationship==='pending').length<=1);
      assert.ok(entry.via.every(v=>!Object.hasOwn(v,'previous')&&!Object.hasOwn(v,'via')));
      assert.ok(entry.via.some(v=>v.relationship==='content-link'&&v.link.target===notice1));
    }
    pending=result.pending;sizes.push(Buffer.byteLength(JSON.stringify(pending)));
  }
  assert.ok(Math.max(...sizes.slice(40))<=Math.max(...sizes.slice(10,40)));
  const latest=await retrieve(async()=>{throw new Error('Latest source failure');},{pending,known});pending=latest.pending;
  assert.ok(pending.every(p=>p.last_failure.reason==='Latest source failure'));
  for(const options of [{budget:{requests:0,deadline:0},now:()=>0},{limits:{documents:4,requests:1}}]){
    const result=await retrieve(read,{pending,known,...options});assert.ok(result.requests<=1);
    for(const entry of result.pending)assert.deepEqual(entry.last_failure,pending.find(p=>p.url===entry.url)?.last_failure);
  }
  const quota=await retrieve(async()=>{throw Object.assign(new Error('Quota exhausted'),{quota:true});},{pending,known});
  assert.equal(quota.requests,1);assert.ok(quota.pending.every(p=>p.last_failure.reason==='Latest source failure'));
  for(let cycle=0;cycle<30;cycle++){
    const result=await retrieve(read,{pending,known});pending=result.pending;
    const current=result.documents.find(d=>d.url===notice1);assert.equal(current.id,original.id);assert.equal(current.raw,original.raw);known=[current];
    assert.ok(current.via.some(v=>v.relationship==='content-link'&&v.parent_url===NOTIFICATIONS));
    assert.equal(new Set(current.via.map(v=>JSON.stringify(v))).size,current.via.length);assert.ok(current.via.length<=4);
    assert.ok(current.via.every(v=>!Object.hasOwn(v,'previous')&&!Object.hasOwn(v,'via')));
    assert.ok(result.inventory.filter(e=>e.state==='retained').every(e=>!e.last_failure));
  }
});
