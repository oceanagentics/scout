import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseDocument, DomUtils } from 'htmlparser2';
import { retrieveBlueMarineDocuments, BLUE_MARINE_LISTING } from '../collector/bluemarine-documents.js';
import { prepareDocument } from '../collector/octo-documents.js';
import { sourceURL } from '../collector/hsa.js';

const fixture=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/bluemarine-website.json.gz',import.meta.url))));
async function collect({overrides={},knownDocuments=[],pending=[],progress,limits={},budget,now,charge=0}={}){
  const responses=new Map(Object.values(fixture).filter(v=>v?.url&&typeof v.body==='string').map(v=>[v.url,v]));
  for(const [url,response] of Object.entries(overrides))responses.set(url,response);
  const requests=[];
  const result=await retrieveBlueMarineDocuments({sourceURL,knownDocuments,pending,progress,now,
    limits:{documents:100,requests:120,bytes:2_000_000,...limits},budget:budget??{requests:0,deadline:Date.now()+20_000},
    read:async(url,shared)=>{shared.requests+=charge;requests.push(url);const response=responses.get(url);if(!response)throw new Error('Unsaved response');return response;}});
  return {...result,requests};
}

test('all five full announcements preserve primary sidebar and JSON-LD without sibling related cards',async()=>{
  const run=await collect();assert.equal(run.documents.length,5);assert.ok(run.inventory.length>=5);
  assert.equal(run.listing.raw,fixture.home.body);
  assert.ok(!run.documents.some(d=>d.url===BLUE_MARINE_LISTING));
  for(const doc of run.documents){
    const response=Object.values(fixture).find(v=>v?.url===doc.url);
    assert.equal(doc.raw,response.body);assert.equal(doc.identity,'bluemarine:document:'+doc.id);assert.equal(doc.listing.via,BLUE_MARINE_LISTING);
    const dom=parseDocument(response.body,{withStartIndices:true,withEndIndices:true});
    const main=DomUtils.getElementsByTagName('main',dom.children)[0],primary=main.children.filter(n=>n.attribs?.id==='post-content'||n.attribs?.class==='page-banner');
    const structured=DomUtils.getElementsByTagName('script',dom.children).filter(n=>n.attribs.type==='application/ld+json');
    assert.equal(primary.length,2);assert.deepEqual(doc.regions,[...primary,...structured].map(n=>({start:n.startIndex,end:n.endIndex+1})));
    assert.equal(doc.html,doc.regions.map(r=>doc.raw.slice(r.start,r.end)).join('\n'));
    const expected=prepareDocument({title:doc.prepared.title,url:doc.url,html:doc.html});expected.version='bluemarine-documents-v1';
    assert.deepEqual(doc.prepared,expected);
    const related=DomUtils.getElementById('media',main.children);assert.ok(related);
    assert.ok(doc.raw.includes(response.body.slice(related.startIndex,related.endIndex+1)));
    assert.ok(!doc.html.includes('id="media"'));assert.ok(!doc.prepared.text.includes('Related events'));
    for(const block of doc.prepared.blocks.filter(b=>b.html_start!=null))assert.ok(doc.html.slice(block.html_start,block.html_end).length);
    assert.equal(doc.prepared.chunks.map(c=>doc.prepared.text.slice(c.start,c.end)).join(''),doc.prepared.text);
    assert.ok(doc.metadata.length);assert.ok(doc.alternates.some(a=>a.title==='JSON'));
    for(const key of ['kind','organization','starts_at','ends_at','location','status','findings','registration_url'])assert.ok(!Object.hasOwn(doc,key));
  }
  const wild=run.documents.find(d=>d.url===fixture.wildlabs.url);
  assert.match(wild.prepared.text,/MPA Technology Workshop/);
  assert.ok(wild.prepared.links.some(l=>l.target.endsWith('Technology-for-MPA-monitoring.pdf')));
  assert.ok(run.coverage.some(c=>c.target?.endsWith('Technology-for-MPA-monitoring.pdf')&&c.state==='unfetched'));
  assert.ok(!run.requests.includes(fixture.registration.url));assert.ok(!JSON.stringify(run.fetches).includes('set-cookie'));
  const ocean=run.documents.find(d=>d.url===fixture.ocean.url);
  assert.ok(ocean.prepared.text.includes('16-18 June 2026'));assert.ok(ocean.prepared.text.includes('Mombasa, Kenya'));
  assert.ok(ocean.prepared.links.some(l=>l.label.trim()==='Register here'&&l.target==='https://www.surveymonkey.com/r/OOCFocalPoints'));
  assert.ok(run.requests.every(url=>url===BLUE_MARINE_LISTING||run.inventory.some(i=>i.url===url)));
  assert.ok(!run.coverage.some(c=>c.reason?.includes('require shared retrieval')));
  assert.ok(run.coverage.some(c=>c.reason.includes('archives')||c.reason.includes('archive')));
});

test('repeat, reorder and duplicated cards preserve source identities and bounded URL selection',async()=>{
  const main=DomUtils.getElementsByTagName('main',parseDocument(fixture.home.body).children)[0];
  const listing=DomUtils.getOuterHTML(main);
  const rows=[...listing.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/g)].map(m=>m[0]);let i=rows.length;
  const home={...fixture.home,body:fixture.home.body.replace(listing,listing.replace(/<article\b[^>]*>[\s\S]*?<\/article>/g,()=>rows[--i]))};
  const one=await collect({limits:{documents:3}}),two=await collect({limits:{documents:3},overrides:{[BLUE_MARINE_LISTING]:home}});
  assert.deepEqual(two.requests,one.requests);assert.deepEqual(two.documents.map(d=>[d.identity,d.raw]),one.documents.map(d=>[d.identity,d.raw]));
  const repeat=await collect({limits:{documents:3}});assert.deepEqual(repeat.documents.map(d=>[d.identity,d.raw]),one.documents.map(d=>[d.identity,d.raw]));
  const duplicate=await collect({overrides:{[BLUE_MARINE_LISTING]:{...fixture.home,body:fixture.home.body.replace('</main>',rows[0]+'</main>')}}});
  assert.equal(duplicate.documents.length,5);assert.ok(duplicate.coverage.some(c=>c.state==='duplicate'));
});

test('known changed full body/title rechecks behind unchanged or unavailable listing',async()=>{
  const changed={...fixture.wildlabs,body:fixture.wildlabs.body.replaceAll('WILDLABS International Conservation Technology Conference 2026',
    'Corrected publisher title')};
  const content=DomUtils.getElementById('post-content',parseDocument(changed.body,{withEndIndices:true}).children);
  changed.body=changed.body.slice(0,content.endIndex-5)+'<p>New full implementation appendix.</p>'+changed.body.slice(content.endIndex-5);
  for(const failed of [false,true]){
    const overrides={[changed.url]:changed};if(failed)overrides[BLUE_MARINE_LISTING]={...fixture.home,status:503};
    const run=await collect({knownDocuments:[{id:failed?'bluemarine:document:14884':'14884',url:changed.url}],overrides});
    const doc=run.documents.find(d=>d.id==='14884');assert.match(doc.prepared.text,/New full implementation appendix/);
    assert.equal(doc.identity,'bluemarine:document:14884');assert.equal(doc.prepared.title,'Corrected publisher title');
  }
});

test('cursor advances across new, failed, deferred and unlisted known URLs',async()=>{
  const first=await collect({limits:{documents:2}});
  const newURL='https://www.bluemarinefoundation.com/our-events/office-update/';
  const absentURL='https://www.bluemarinefoundation.com/our-events/unlisted-known-page/';
  const readable=url=>({...fixture.wildlabs,url,body:fixture.wildlabs.body.replaceAll(fixture.wildlabs.url,url)});
  const home={...fixture.home,body:fixture.home.body.replace('</main>',
    `<article><a href="${newURL}"><h3 class="cards__title">Office furniture without year or keywords</h3></a></article></main>`)};
  const overrides={[BLUE_MARINE_LISTING]:home,[newURL]:readable(newURL),[absentURL]:readable(absentURL)};
  const attempts=new Set(first.requests),docs=[];let progress=first.progress,pending=first.pending;
  for(let i=0;i<Math.ceil((first.inventory.length+2)/2)+2;i++){
    const run=await collect({limits:{documents:2},knownDocuments:[{id:'bluemarine:document:14884',url:absentURL}],pending,progress,overrides});
    run.requests.forEach(url=>attempts.add(url));docs.push(...run.documents);progress=run.progress;pending=run.pending;assert.ok(run.requests.length<=3);
  }
  for(const item of first.inventory)assert.ok(attempts.has(item.url));
  assert.ok(docs.some(d=>d.url===newURL));assert.ok(docs.some(d=>d.url===absentURL));
  const failed=await collect({knownDocuments:[{url:absentURL}],overrides:{[BLUE_MARINE_LISTING]:{...fixture.home,status:503},
    [absentURL]:{...readable(absentURL),status:403}},limits:{documents:1}});
  assert.equal(failed.progress.after_url,absentURL);
  assert.equal(failed.pending[0].state,'failed');assert.equal(failed.pending[0].last_failure.state,'failed');
});

test('zero/multiple possible findings and JSON-LD remain neutral whole documents without schedule inference',async()=>{
  for(const html of ['<p>Office furniture update.</p>',
    '<h2>First session</h2><p>October 21.</p><h2>Second session</h2><p>October 24.</p>']){
    const dom=parseDocument(fixture.wildlabs.body,{withStartIndices:true,withEndIndices:true});
    const body=DomUtils.findAll(n=>(n.attribs?.class??'').split(/\s+/).includes('postContent'),dom.children)[0];
    const response={...fixture.wildlabs,body:(fixture.wildlabs.body.slice(0,body.startIndex)+
      `<section class="postContent">${html}</section>`+fixture.wildlabs.body.slice(body.endIndex+1)).replace('</head>',
      '<script type="application/ld+json">{"@type":"Event","name":"Literal source metadata"}</script></head>')};
    const run=await collect({overrides:{[response.url]:response}}),doc=run.documents.find(d=>d.id==='14884');
    assert.match(doc.prepared.text,/Literal source metadata/);
    assert.ok(doc.prepared.text.includes(html.includes('furniture')?'furniture':'Second session'));assert.ok(!Object.hasOwn(doc,'findings'));
  }
});

test('related-card changes leave primary preparation stable; language and body support stay literal and unfetched',async()=>{
  const baseline=await collect(),old=baseline.documents.find(d=>d.id==='14884');
  const related=DomUtils.getElementById('media',parseDocument(fixture.wildlabs.body,{withStartIndices:true,withEndIndices:true}).children);
  const changed={...fixture.wildlabs,body:fixture.wildlabs.body.slice(0,related.startIndex)+
    '<section id="media" class="related events"><article><h2>Different sibling announcement</h2></article></section>'+fixture.wildlabs.body.slice(related.endIndex+1)};
  const next=(await collect({overrides:{[changed.url]:changed}})).documents.find(d=>d.id==='14884');
  assert.notEqual(next.raw,old.raw);assert.equal(next.html,old.html);assert.deepEqual(next.prepared,old.prepared);
  const support='https://www.bluemarinefoundation.com/our-events/support-only-in-body/#programme';
  const language='https://www.bluemarinefoundation.com/fr/our-events/wildlabs/';
  const content=DomUtils.getElementById('post-content',parseDocument(changed.body,{withEndIndices:true}).children);
  const linked=changed.body.slice(0,content.endIndex-5)+`<a href="${support}">Publisher programme</a>`+changed.body.slice(content.endIndex-5);
  const body={...changed,body:linked.replace('</head>',`<link rel="alternate" hreflang="fr" href="${language}"></head>`)};
  const run=await collect({overrides:{[body.url]:body}}),doc=run.documents.find(d=>d.id==='14884');
  assert.ok(doc.prepared.links.some(l=>l.target===support&&l.state==='unfetched'));
  assert.ok(doc.prepared.links.some(l=>l.target===language&&l.label==='fr'&&l.state==='unfetched'));
  assert.ok(!run.requests.includes(sourceURL(support)));assert.ok(!run.requests.includes(language));
});

test('native model repair and pending work survive failed and deferred passes without losing priority',async()=>{
  const knownDocuments=[{id:'bluemarine:document:14884',url:fixture.wildlabs.url}];
  const pending=[{id:'bluemarine:document:14832',url:fixture.ocean.url,state:'model-repair'},
    {...knownDocuments[0],state:'model-pending'},{url:fixture.ocean.url,state:'deferred',pending_state:'model-pending'}];
  const overrides={[BLUE_MARINE_LISTING]:{...fixture.home,status:503},[fixture.ocean.url]:{...fixture.ocean,status:403}};
  const failed=await collect({knownDocuments,pending,overrides,limits:{documents:1},progress:{after_url:fixture.wildlabs.url}});
  assert.deepEqual(failed.requests,[BLUE_MARINE_LISTING,fixture.ocean.url]);assert.equal(failed.progress.after_url,fixture.ocean.url);
  const ocean=failed.pending.find(d=>d.url===fixture.ocean.url);assert.equal(ocean.id,'14832');assert.equal(ocean.pending_state,'model-repair');
  assert.equal(ocean.last_failure.state,'failed');assert.equal(failed.pending.length,2);
  const deferred=await collect({pending:failed.pending,progress:failed.progress,overrides,limits:{requests:1}});
  assert.deepEqual(deferred.requests,[BLUE_MARINE_LISTING]);assert.deepEqual(deferred.progress,failed.progress);
  assert.deepEqual(deferred.pending.find(d=>d.url===fixture.ocean.url).last_failure,ocean.last_failure);
  const repaired=await collect({pending:deferred.pending,progress:deferred.progress,limits:{documents:1},
    overrides:{[BLUE_MARINE_LISTING]:{...fixture.home,status:503}}});
  assert.deepEqual(repaired.documents.map(d=>d.identity),['bluemarine:document:14832']);
  assert.equal(repaired.pending.length,1);assert.equal(repaired.pending[0].pending_state,'model-pending');
  const remaining=await collect({pending:repaired.pending,progress:repaired.progress,limits:{documents:1},
    overrides:{[BLUE_MARINE_LISTING]:{...fixture.home,status:503}}});
  assert.deepEqual(remaining.documents.map(d=>d.identity),['bluemarine:document:14884']);assert.deepEqual(remaining.pending,[]);
});

test('malformed, failed, unsupported, wrong-identity and missing-body responses stay inspectable',async()=>{
  for(const response of [{...fixture.wildlabs,status:403},
    {...fixture.wildlabs,headers:{'content-type':'application/pdf'},body:'PDF payload'},
    {...fixture.wildlabs,body:fixture.wildlabs.body.replace('</html>','')},
    {...fixture.wildlabs,body:fixture.wildlabs.body.replace('postid-14884','postid-99')},
    {...fixture.wildlabs,body:fixture.wildlabs.body.replaceAll('postContent','excerpt-only')},
    {...fixture.wildlabs,body:fixture.wildlabs.body.replace('</main>','<div id="post-content"><p>Another boundary</p></div></main>')},
    {...fixture.wildlabs,body:fixture.wildlabs.body.replace('</main>','<div class="page-banner"><h1>Another title</h1></div></main>')},
    {...fixture.wildlabs,body:fixture.wildlabs.body.replace('</main>','</main><main>Another main</main>')}]){
    const run=await collect({knownDocuments:[{id:'14884',url:response.url}],
      overrides:{[BLUE_MARINE_LISTING]:{...fixture.home,status:503},[response.url]:response}});
    assert.equal(run.documents.length,0);assert.equal(run.fetches.at(-1).body,response.body);
    assert.ok(run.coverage.some(c=>c.url===response.url&&['failed','unsupported'].includes(c.state)));
    assert.equal(run.pending.length,1);assert.ok(run.pending[0].last_failure);
  }
  const external=await collect({knownDocuments:[{url:'https://example.org/other'}]});
  assert.ok(external.coverage.some(c=>c.url==='https://example.org/other'&&c.state==='unsupported'));
  const foreign=await collect({knownDocuments:[{id:'symposium:document:14884',url:fixture.wildlabs.url}],
    pending:[{url:BLUE_MARINE_LISTING},{url:'https://www.bluemarinefoundation.com/wp-json/wp/v2/events/14884'},
      {url:'https://www.bluemarinefoundation.com/registration/'}],overrides:{[BLUE_MARINE_LISTING]:{...fixture.home,status:503}}});
  assert.deepEqual(foreign.requests,[BLUE_MARINE_LISTING]);assert.equal(foreign.documents.length,0);
  assert.equal(foreign.coverage.filter(c=>c.state==='unsupported').length,4);
});

test('request/time/byte bounds never claim success for unread details or advance their cursor',async()=>{
  const deferred=await collect({limits:{requests:1},progress:{after_url:fixture.wildlabs.url}});
  assert.equal(deferred.documents.length,0);assert.equal(deferred.progress.after_url,fixture.wildlabs.url);
  assert.ok(deferred.coverage.some(c=>c.reason==='Request/time limit'));
  const expired=await collect({budget:{requests:0,deadline:0}});assert.equal(expired.requests.length,0);
  const bytes=await collect({limits:{bytes:10}});assert.equal(bytes.documents.length,0);
  const utf8=await collect({knownDocuments:[{id:'14884',url:fixture.wildlabs.url}],limits:{bytes:fixture.wildlabs.body.length},
    overrides:{[BLUE_MARINE_LISTING]:{...fixture.home,status:503}}});
  assert.ok(Buffer.byteLength(fixture.wildlabs.body)>fixture.wildlabs.body.length);
  assert.equal(utf8.documents.length,0);assert.equal(utf8.fetches.at(-1).body,fixture.wildlabs.body);
  const budget={requests:0,deadline:Date.now()+20_000},charged=await collect({budget,charge:2,limits:{requests:4}});
  assert.equal(charged.requests.length,2);assert.equal(budget.requests,4);
  let ticks=0;const timed=await collect({now:()=>ticks++?10:0,budget:{requests:0,deadline:10},progress:{after_url:fixture.wildlabs.url}});
  assert.deepEqual(timed.requests,[BLUE_MARINE_LISTING]);assert.equal(timed.progress.after_url,fixture.wildlabs.url);
  for(const limits of [{documents:0},{requests:NaN},{bytes:1.5}])await assert.rejects(collect({limits}),/Invalid Blue Marine retrieval bounds/);
});
