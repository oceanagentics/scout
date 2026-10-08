import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { DISCOVERY_QUERIES, retrieveDiscoveryDocuments } from '../collector/bluesky-discovery-documents.js';

const fixture=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/bluesky-discovery.json.gz',import.meta.url))));
const sample=JSON.parse(fixture.queries[0].body).posts[0];
const sourceURL=value=>{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password)throw new Error('Unsupported URL');return u.href;};
const response=(url,posts=[],cursor)=>({url,status:200,headers:{'content-type':'application/json'},body:JSON.stringify({posts,...cursor?{cursor}:{}})});
const retrieve=(read,options={})=>retrieveDiscoveryDocuments({tracker:fixture.tracker,read,sourceURL,
  budget:{requests:0,deadline:Date.now()+10000},...options});
const variants=doc=>doc.variants??[doc];

test('real search fixture retains every returned post, exact response, bilingual context, links and provenance',async()=>{
  const result=await retrieve(async url=>{
    const q=new URL(url).searchParams.get('q');
    const saved=fixture.queries.find(r=>new URL(r.url).searchParams.get('q')===q);
    return {...saved,url};
  },{since:'2026-09-01T00:00:00Z',until:fixture.collected_at});
  assert.equal(result.requests,4);assert.equal(result.pages.length,4);assert.equal(result.complete,false);
  assert.deepEqual(result.queries.map(q=>q.q),DISCOVERY_QUERIES);
  assert.deepEqual(result.queries.map(q=>q.state),['bounded','bounded','bounded','exhausted']);
  for(const saved of fixture.queries){
    const q=new URL(saved.url).searchParams.get('q'),page=result.pages.find(p=>p.q===q);
    assert.equal(page.response.body,saved.body);
    for(const [position,post] of JSON.parse(saved.body).posts.entries()){
      const doc=result.documents.find(d=>d.id===post.uri);
      const version=variants(doc).find(v=>v.cid===post.cid&&v.raw===JSON.stringify({post}));
      assert.ok(version);assert.ok(version.prepared.text.startsWith(post.record.text));
      assert.ok(version.provenance.some(p=>p.q===q&&p.position===position&&p.search_url===page.url));
      assert.equal(version.prepared.blocks[0].end,post.record.text.length);
      assert.ok(version.prepared.omissions.some(o=>o.path==='item.post.cid'));
      for(const key of ['kind','organization','title','date','findings','candidate'])assert.equal(Object.hasOwn(version,key),false);
    }
  }
  assert.ok(result.documents.flatMap(variants).some(d=>d.prepared.links.length));
  assert.ok(result.documents.flatMap(variants).some(d=>d.coverage.some(c=>c.relationship==='media')));
  assert.ok(result.pages.some(p=>p.q.includes('traité')));
});

test('identical query overlap deduplicates URI/CID with all provenance; reordered results leave payload identity unchanged',async()=>{
  const result=await retrieve(async url=>response(url,[sample]));
  assert.equal(result.documents.length,1);assert.equal(result.documents[0].state,'retained');
  assert.equal(result.documents[0].provenance.length,4);
  assert.equal(result.documents[0].raw,JSON.stringify({post:sample}));
  const reordered=await retrieve(async url=>response(url,[sample,sample]));
  assert.equal(reordered.documents.length,1);assert.equal(reordered.documents[0].provenance.length,8);
  assert.equal(reordered.documents[0].raw,result.documents[0].raw);
  assert.equal(reordered.documents[0].id,result.documents[0].id);
});

test('different CIDs or payloads under the same URI retain all variants and cannot silently choose a prepared primary',async()=>{
  for(const changeCID of [true,false]){
    const changed=structuredClone(sample);
    if(changeCID)changed.cid+='a';else changed.record.text+='\nContexte français  complet 🌊.';
    const result=await retrieve(async url=>response(url,new URL(url).searchParams.get('q')==='BBNJ'?[sample]:[changed]));
    assert.equal(result.documents.length,1);
    const doc=result.documents[0];assert.equal(doc.state,'conflict');assert.equal(doc.variants.length,2);
    assert.equal(Object.hasOwn(doc,'prepared'),false);assert.equal(Object.hasOwn(doc,'raw'),false);
    assert.equal(doc.variants[0].raw,JSON.stringify({post:sample}));
    assert.equal(doc.variants[1].raw,JSON.stringify({post:changed}));
    assert.equal(doc.variants[1].provenance.length,3);
    assert.ok(result.coverage.some(c=>c.id===sample.uri&&c.state==='conflict'));
  }
});

test('valid empty pages preserve evidence without claiming exhaustive discovery; status/format/transport failures remain explicit',async()=>{
  const empty=await retrieve(async url=>response(url));
  assert.equal(empty.documents.length,0);assert.equal(empty.pages.length,4);assert.equal(empty.complete,false);
  assert.ok(empty.queries.every(q=>q.state==='empty'));
  for(const read of [async url=>({...response(url),status:403}),async url=>({...response(url),body:'{}'}),
    async url=>({...response(url),headers:{'content-type':'text/html'},body:'Forbidden'}),
    async url=>response('https://example.org/wrong'),async()=>{throw new Error('HTTP 403');}]){
    const result=await retrieve(read);assert.equal(result.complete,false);assert.equal(result.documents.length,0);
    assert.ok(result.queries.every(q=>q.state==='failed'));assert.ok(result.coverage.some(c=>c.state==='failed'));
  }
});

test('cursor pagination is explicit, bounded and cycle-safe; later-page denial retains the first page',async()=>{
  const paged=await retrieve(async url=>response(url,[sample],new URL(url).searchParams.has('cursor')?undefined:'next'),
    {limits:{searchPages:2,postsPerPage:5,requests:8}});
  assert.equal(paged.requests,8);assert.ok(paged.queries.every(q=>q.state==='exhausted'));
  assert.equal(paged.documents[0].provenance.length,8);
  assert.ok(paged.pages.every(p=>new URL(p.url).searchParams.get('cursor')===(p.page?'next':null)));
  const cycle=await retrieve(async url=>response(url,[sample],'repeat'),{limits:{searchPages:2,postsPerPage:5,requests:8}});
  assert.ok(cycle.queries.every(q=>q.state==='failed'&&q.reason.includes('Repeated')));
  const denied=await retrieve(async url=>new URL(url).searchParams.has('cursor')?({...response(url),status:403}):response(url,[sample],'next'),
    {limits:{searchPages:2,postsPerPage:5,requests:8}});
  assert.equal(denied.documents[0].provenance.length,4);assert.equal(denied.pages.length,8);
  assert.ok(denied.queries.every(q=>q.state==='failed'));
});

test('request/time/quota bounds disclose unattempted queries; malformed posts and oversized pages do not succeed',async()=>{
  const bounded=await retrieve(async url=>response(url,[sample]),{limits:{searchPages:1,postsPerPage:5,requests:1}});
  assert.equal(bounded.requests,1);assert.deepEqual(bounded.queries.map(q=>q.state),['exhausted','bounded','unfetched','unfetched']);
  const timed=await retrieve(async()=>{throw new Error('must not fetch');},{budget:{requests:0,deadline:10},now:()=>10});
  assert.equal(timed.requests,0);assert.equal(timed.queries[0].state,'bounded');
  const quota=await retrieve(async()=>{throw Object.assign(new Error('Quota exhausted'),{quota:true});});
  assert.equal(quota.requests,1);assert.deepEqual(quota.queries.map(q=>q.state),['failed','unfetched','unfetched','unfetched']);
  const mixed=await retrieve(async url=>response(url,[{},sample]));
  assert.equal(mixed.documents.length,1);assert.equal(mixed.coverage.filter(c=>c.state==='failed').length,4);
  const oversized=await retrieve(async url=>response(url,Array(6).fill(sample)));
  assert.equal(oversized.documents.length,0);assert.ok(oversized.queries.every(q=>q.state==='failed'));
  await assert.rejects(retrieve(async()=>{}, {limits:{searchPages:0,postsPerPage:5,requests:4}}),/bounds/);
});

test('returned old/empty/unrelated/long text remains source evidence, without post-retrieval age or topic filters',async()=>{
  const post=structuredClone(sample);post.record.text='Sans rapport avec la requête  🌊.\n'.repeat(1000);
  post.record.createdAt='2001-01-01T00:00:00Z';
  const result=await retrieve(async url=>response(url,[post]),{since:'2026-09-01T00:00:00Z',until:fixture.collected_at});
  assert.ok(result.documents[0].prepared.text.startsWith(post.record.text));
  assert.ok(result.documents[0].prepared.text.length>8000);
  assert.ok(result.documents[0].prepared.links.length>0); // Original facets survive changed text.
  post.record.text='';
  assert.equal((await retrieve(async url=>response(url,[post]))).documents.length,1);
});


test('discovery keeps quoted/reply/media metadata and marks full context unfetched',async()=>{
  const post=structuredClone(sample),uri='at://did:plc:quoted/app.bsky.feed.post/quote';
  post.record.reply={root:{uri,cid:'bafquote'},parent:{uri,cid:'bafquote'}};
  post.embed={record:{uri,value:{text:'Texte cité  intégral 🌊.'}},external:{uri:'https://example.org/support',description:'Complete external description'},images:[{fullsize:'https://example.org/media',alt:'Caption'}]};
  const result=await retrieve(async url=>response(url,[post]));
  const doc=result.documents[0];assert.ok(doc.prepared.text.startsWith(post.record.text));
  assert.ok(doc.prepared.links.some(l=>l.target==='https://example.org/support'));
  assert.ok(doc.coverage.some(c=>c.relationship==='quote'&&c.state==='embedded'));
  assert.ok(doc.coverage.some(c=>c.relationship==='reply'&&c.state==='partial'));
  assert.ok(doc.coverage.some(c=>c.relationship==='media'&&c.state==='unfetched'));
  assert.ok(result.coverage.some(c=>c.relationship==='support'&&c.state==='unfetched'));
  post.author.did='did:plc:wrong';
  const invalid=await retrieve(async url=>response(url,[post]));assert.equal(invalid.documents.length,0);
  assert.ok(invalid.coverage.some(c=>c.state==='failed'));
});

test('background discovery alternates fresh checks with durable frozen-window pagination',async()=>{
  let progress={},seen=[];
  const run=()=>retrieve(async url=>{
    const p=new URL(url).searchParams;seen.push({cursor:p.get('cursor'),until:p.get('until')});
    return response(url,[sample],p.get('cursor')==='older'?'oldest':'older');
  },{since:'2026-09-01T00:00:00Z',until:progress.history?'2026-10-09T00:00:00Z':'2026-10-08T00:00:00Z',progress});
  let result=await run();progress=result.progress;assert.ok(seen.every(p=>p.cursor===null));
  seen=[];result=await run();progress=result.progress;
  assert.ok(seen.every(p=>p.cursor==='older'&&p.until==='2026-10-08T00:00:00Z'));
  seen=[];result=await run();progress=result.progress;assert.ok(seen.every(p=>p.cursor===null));
  seen=[];await run();assert.ok(seen.every(p=>p.cursor==='oldest'));
});
