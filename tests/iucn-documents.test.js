import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { parseDocument, DomUtils } from 'htmlparser2';
import { retrieveIUCNDocuments, IUCN_LISTING, PREPARATION_VERSION } from '../collector/iucn-documents.js';
import { collectDocuments, prepareDocument } from '../collector/octo-documents.js';

const fixture=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/iucn-website.json.gz',import.meta.url))));
const sourceURL=value=>{
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password)throw new Error('Unsupported source URL');
  return url.href;
};
async function collect({home=fixture.home,overrides={},knownDocuments=[],pending=[],progress,limits={},budget}={}){
  const responses=new Map(Object.values(fixture).filter(v=>v?.url&&typeof v.body==='string').map(v=>[v.url,v]));
  responses.set(IUCN_LISTING,home);
  for(const [url,response] of Object.entries(overrides))responses.set(url,response);
  const requests=[];
  const result=await retrieveIUCNDocuments({sourceURL,knownDocuments,pending,progress,
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
    assert.ok(['iucn-documents-v1',PREPARATION_VERSION].includes(doc.prepared.version));
    assert.equal(doc.html,doc.regions.map(r=>response.body.slice(r.start,r.end)).join('\n'));
    assert.equal(doc.prepared.chunks.map(c=>doc.prepared.text.slice(c.start,c.end)).join(''),doc.prepared.text);
    const node=parseDocument(doc.html,{withStartIndices:true});
    const body=DomUtils.findAll(n=>(n.attribs?.class??'').split(/\s+/).includes('field--name-field-body'),node.children)[0];
    const expected=prepareDocument({title:'',url:doc.url,html:DomUtils.getOuterHTML(body)}).text.replace(/ <https:\/\/iucn\.org\/cdn-cgi\/l\/email-protection#[\da-f]+>/gi,'');
    assert.ok(doc.prepared.text.includes(expected));
    const original=parseDocument(response.body);
    for(const region of DomUtils.findAll(n=>(n.attribs?.class??'').split(/\s+/).some(c=>
      ['content-title','content-lead','content-author-info','content-media-image','content-paragraphs','main-section'].includes(c)),original.children)){
      if(!DomUtils.textContent(region).trim())continue;
      const expected=prepareDocument({title:'',url:doc.url,html:DomUtils.getOuterHTML(region)});
      assert.ok(doc.prepared.text.includes(expected.text.replace(/ <https:\/\/iucn\.org\/cdn-cgi\/l\/email-protection#[\da-f]+>/gi,'')));
    }
    assert.ok(!Object.hasOwn(doc,'kind'));assert.ok(!Object.hasOwn(doc,'organization'));assert.ok(!Object.hasOwn(doc,'findings'));
  }
  const blog=run.documents.find(d=>d.url===fixture.blog.url);
  assert.ok(blog.prepared.text.length>4000);assert.ok(blog.prepared.links.length);
  assert.ok(blog.raw.includes('IUCN Food and Agricultural Systems'));
  assert.ok(!blog.prepared.text.includes('IUCN Food and Agricultural Systems'));
  assert.ok(!blog.html.includes('comp-featured-content'));
  assert.ok(run.documents.some(d=>d.url===fixture.dataset.url));
  assert.ok(run.coverage.some(c=>c.reason.includes('archives/pagination')));
  assert.ok(run.coverage.some(c=>c.state==='failed'));assert.ok(!JSON.stringify(run.fetches).includes('set-cookie'));
});

test('retained contact-token changes preserve literal content, ordinary links, raw offsets and preparation continuity',async()=>{
  const documents=[];
  for(const capture of fixture.retained_contacts){
    const response={url:capture.url,status:200,headers:{'content-type':'text/html'},body:capture.content};
    const run=await collect({home:{...fixture.home,status:503},knownDocuments:[{id:capture.parsed.document.id,url:capture.url}],overrides:{[capture.url]:response}});
    assert.deepEqual(run.requests,[IUCN_LISTING,capture.url]);assert.equal(run.documents.length,1);
    const doc=run.documents[0],old=capture.parsed.document.prepared_versions['iucn-documents-v1'];documents.push(doc);
    assert.equal(doc.raw,capture.content);assert.equal(doc.html,doc.regions.map(r=>doc.raw.slice(r.start,r.end)).join('\n'));
    assert.equal(doc.prepared.text,old.text.replace(/ <https:\/\/iucn\.org\/cdn-cgi\/l\/email-protection#[\da-f]+>/gi,''));
    assert.deepEqual(doc.prepared.links,old.links.filter(l=>!l.target.startsWith('https://iucn.org/cdn-cgi/l/email-protection#')));
    assert.deepEqual(doc.prepared.blocks.map(b=>[b.html_start,b.html_end]),old.blocks.map(b=>[b.html_start,b.html_end]));
    assert.equal(doc.prepared.chunks.map(c=>doc.prepared.text.slice(c.start,c.end)).join(''),doc.prepared.text);
  }
  for(const offset of [0,3])for(const doc of documents.slice(offset,offset+3)){
    assert.equal(doc.prepared.version,PREPARATION_VERSION);
    assert.deepEqual(doc.prepared,documents[offset].prepared);
  }
  assert.deepEqual(documents[6].prepared,fixture.retained_contacts[6].parsed.document.prepared_versions['iucn-documents-v1']);
  const capture=fixture.retained_contacts[0],doc=documents[0];
  const body=DomUtils.findAll(n=>(n.attribs?.class??'').split(/\s+/).includes('field--name-field-body'),parseDocument(capture.content,{withStartIndices:true}).children)[0];
  const start=capture.content.indexOf('>',body.startIndex)+1;
  const extra='<p>New contact hours: 10:00 UTC. <a href="mailto:public@example.org">Public contact</a> '+
    '<a href="/cdn-cgi/l/email-protection#aabbccdd">Ordinary unverified link</a> '+
    '<a href="/cdn-cgi/l/email-protection#aabbccdd"><span class="__cf_email__" data-cfemail="not-a-token">Malformed marker</span></a> '+
    '<a href="https://example.org/cdn-cgi/l/email-protection#aabbccdd"><span class="__cf_email__" data-cfemail="aabbccdd">External link</span></a> '+
    '<a title="Contact > transport" href="/cdn-cgi/l/email-protection#aabbccdd"><span class="__cf_email__" data-cfemail="aabbccdd">New visible contact text</span></a></p>';
  const changed=await collect({home:{...fixture.home,status:503},knownDocuments:[{id:doc.id,url:doc.url}],overrides:{[doc.url]:{
    url:doc.url,status:200,headers:{'content-type':'text/html'},body:capture.content.slice(0,start)+extra+capture.content.slice(start)}}});
  const prepared=changed.documents[0].prepared;assert.notDeepEqual(prepared,doc.prepared);
  assert.ok(prepared.text.includes('New contact hours: 10:00 UTC.'));assert.ok(prepared.text.includes('New visible contact text'));
  assert.ok(prepared.links.some(l=>l.target==='mailto:public@example.org'));
  assert.equal(prepared.links.filter(l=>l.target==='https://iucn.org/cdn-cgi/l/email-protection#aabbccdd').length,2);
  assert.ok(prepared.links.some(l=>l.target==='https://example.org/cdn-cgi/l/email-protection#aabbccdd'));
  assert.deepEqual(changed.requests,[IUCN_LISTING,doc.url]);
});

test('retained token captures carry pending, complete and exhausted processing without resetting old versions',async()=>{
  const db=new PGlite();
  try{
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
      create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');create table auth.identities(user_id uuid,provider text,identity_data jsonb);
      create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;`);
    for(const name of readdirSync(new URL('../supabase/migrations/',import.meta.url)).sort())await db.exec(readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
    await db.exec(readFileSync(new URL('../supabase/seeds/trackers.sql',import.meta.url),'utf8'));
    const tracker=(await db.query('select * from scout.trackers where url=$1',[IUCN_LISTING])).rows[0],documents=[];
    for(const capture of fixture.retained_contacts){
      await db.query('insert into scout.evidence(id,tracker_id,url,content_hash,content,parsed,last_seen_at) values($1,$2,$3,$4,$5,$6,$7)',
        [capture.id,tracker.id,capture.url,capture.content_hash,capture.content,JSON.stringify(capture.parsed),capture.last_seen_at]);
      const run=await collect({home:{...fixture.home,status:503},knownDocuments:[{id:capture.parsed.document.id,url:capture.url}],overrides:{[capture.url]:{
        url:capture.url,status:200,headers:{'content-type':'text/html'},body:capture.content}}});documents.push(run.documents[0]);
    }
    const inputs=[];let item=documents[0],mode='pending';
    const options={tracker,sourceURL,now:()=>new Date().toISOString(),deadline:Date.now()+100000,limits:{seconds:100,requests:4,pages:4},process:true,path:'iucn',
      retrieve:async()=>({documents:[item],coverage:[]}),model:async(_,supplied)=>{
        inputs.push(supplied[0]);
        if(mode==='pending'){if(inputs.length===1)throw Object.assign(new Error('Invalid JSON'),{rejected:'Injected invalid response'});throw new Error('Model quota reached');}
        return {complete:mode!=='exhausted',reason:'Injected storage/continuity decision only.',findings:[]};
      }};
    await collectDocuments(db,options);assert.equal(inputs.length,2);
    const first=(await db.query('select parsed from scout.evidence where id=$1',[fixture.retained_contacts[0].id])).rows[0].parsed.document;
    const version=first.processing.version,pending=first.processing_versions[version].pending;assert.equal(pending.round,1);
    mode='complete';item=documents[1];await collectDocuments(db,options);assert.equal(inputs.length,3);
    assert.deepEqual(inputs[2],{...pending.input,source_id:fixture.retained_contacts[1].id,repair:pending.repair});
    item=documents[2];const repeat=await collectDocuments(db,options);assert.equal(repeat.processed,1);assert.equal(inputs.length,3);
    const completed=(await db.query('select parsed from scout.evidence where id=$1',[fixture.retained_contacts[2].id])).rows[0].parsed.document;
    assert.equal(completed.processing.version,version);assert.equal(completed.processing_versions[version].state,'complete');
    item=(await collect({home:{...fixture.home,status:503},knownDocuments:[{id:item.id,url:item.url}],overrides:{[item.url]:{
      url:item.url,status:200,headers:{'content-type':'text/html'},body:item.raw.replace('Remmy Lema','Updated contact person')}}})).documents[0];
    await collectDocuments(db,options);assert.equal(inputs.length,4,'Visible contact change requires fresh processing');
    mode='exhausted';item=documents[3];await collectDocuments(db,options);assert.equal(inputs.length,7);
    const exhausted=(await db.query('select parsed from scout.evidence where id=$1',[fixture.retained_contacts[3].id])).rows[0].parsed.document;
    assert.equal(exhausted.processing_versions[exhausted.processing.version].exhausted,true);
    for(const next of documents.slice(4,6)){item=next;await collectDocuments(db,options);assert.equal(inputs.length,7,'Token change must not renew exhausted attempts');}
    for(const capture of fixture.retained_contacts){
      const retained=(await db.query('select content,parsed from scout.evidence where id=$1',[capture.id])).rows[0];
      assert.equal(retained.content,capture.content);
      for(const [key,value] of Object.entries(capture.parsed.document.prepared_versions))assert.deepEqual(retained.parsed.document.prepared_versions[key],value);
      for(const [key,value] of Object.entries(capture.parsed.document.processing_versions))assert.deepEqual(retained.parsed.document.processing_versions[key],value);
    }
    assert.deepEqual((await db.query('select * from scout.trackers where id=$1',[tracker.id])).rows[0],tracker);
  }finally{await db.close();}
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
  const body=DomUtils.findAll(n=>(n.attribs?.class??'').split(/\s+/).includes('field--name-field-body'),parseDocument(fixture.blog.body,{withStartIndices:true}).children)[0];
  const start=fixture.blog.body.indexOf('>',body.startIndex)+1;
  const changed={...fixture.blog,body:fixture.blog.body.slice(0,start)+'<p>New implementation appendix.</p>'+fixture.blog.body.slice(start)};
  for(const home of [fixture.home,{...fixture.home,status:503}]){
    const run=await collect({home,knownDocuments:[{id:'45913',url:fixture.blog.url}],overrides:{[fixture.blog.url]:changed}});
    const doc=run.documents.find(d=>d.id==='45913');assert.match(doc.prepared.text,/New implementation appendix/);
  }
});

test('pending model work leads known/listed documents without admitting unobserved URLs',async()=>{
  const pending=[{url:fixture.forum.url,state:'model-pending'},{url:fixture.blog.url,state:'model-repair'},
    {url:'https://iucn.org/story/unobserved',state:'model-repair'}];
  for(const home of [fixture.home,{...fixture.home,status:503}]){
    const run=await collect({home,pending,knownDocuments:[{id:'45913',url:fixture.blog.url},{id:'46802',url:fixture.forum.url}],
      progress:{after_url:fixture.blog.url},limits:{documents:2}});
    assert.deepEqual(run.requests,[IUCN_LISTING,fixture.blog.url,fixture.forum.url]);
    assert.equal(run.progress.after_url,fixture.forum.url);
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
    {...fixture.blog,body:fixture.blog.body.replaceAll('class="content-body"','class="unknown-body"')},
    {...fixture.blog,body:fixture.blog.body.replace('</article>','<div class="content-body">Another region</div></article>')},
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
