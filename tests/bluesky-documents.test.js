import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { prepareAuthorItem, retrieveAuthorDocuments } from '../collector/bluesky-documents.js';


const hsa='highseasalliance.bsky.social';
const fixture=async name=>{const raw=await readFile(new URL('./fixtures/'+name,import.meta.url));return JSON.parse(name.endsWith('.gz')?gunzipSync(raw):raw);};
const sourceURL=value=>{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password)throw new Error('Unsupported URL');return url.href;};
const tracker={collector:'bluesky_feed',url:'https://bsky.app/profile/'+hsa};
const prepare=(item,actor=hsa)=>prepareAuthorItem(item,{actor,sourceURL});
const retrieve=(read,limits={feedPages:2,postsPerPage:20})=>retrieveAuthorDocuments({tracker,read,sourceURL,budget:{requests:0,deadline:Date.now()+10000},limits});
const response=(url,feed)=>({url,headers:{'content-type':'application/json'},body:typeof feed==='string'?feed:JSON.stringify(feed)});

test('saved HSA and three expansion author fixtures retain full structural payload without finding fields',async()=>{
  const inputs=[[hsa,await fixture('hsa-webinar.json')],...Object.entries(await fixture('expansion-feeds.json')).flatMap(([actor,data])=>data.feed.map(item=>[actor,item]))];
  for(const [actor,item] of inputs){
    const doc=prepare(item,actor);
    assert.equal(doc.raw,JSON.stringify(item));
    assert.ok(doc.prepared.text.startsWith(item.post.record.text));
    assert.equal(doc.id,item.post.uri);
    assert.equal(doc.url,'https://bsky.app/profile/'+item.post.uri.slice(5).replace('/app.bsky.feed.post/','/post/'));
    assert.equal(doc.prepared.chunks.map(c=>doc.prepared.text.slice(c.start,c.end)).join(''),doc.prepared.text);
    assert.ok(doc.prepared.text.includes(item.post.record.text));
    for(const key of ['kind','organization','title','date','findings','candidate'])assert.equal(Object.hasOwn(doc,key),false);
    assert.equal(doc.prepared.title,'');
  }
});

test('native mention profiles use exact UTF-8 references without inferring feed-author affiliation',async()=>{
  const item=await fixture('hsa-webinar.json'),did='did:plc:bzbqq3xierqt53aavlcvarby',label='@ceo.globalfishingwatch.org';
  item.post.record.text='🌊 At Climate Week '+label+' joined this session.';
  const byteStart=Buffer.byteLength(item.post.record.text.slice(0,item.post.record.text.indexOf(label)));
  item.post.record.facets=[{index:{byteStart,byteEnd:byteStart+Buffer.byteLength(label)},features:[{$type:'app.bsky.richtext.facet#mention',did}]}];
  item.post.author.description='Unrelated publisher affiliation';
  const doc=prepare(item),link=doc.prepared.links.find(l=>l.relationship==='profile');
  assert.deepEqual(new URL(link.target).searchParams.getAll('actors'),[did]);assert.equal(link.mentions[0].text,label);
  assert.equal(link.mentions[0].uri,item.post.uri);assert.equal(doc.raw,JSON.stringify(item));assert.equal(doc.prepared.version,'bluesky-mention-documents-v1');
  assert.ok(!doc.prepared.text.includes(item.post.author.description));assert.ok(!link.actors.includes(item.post.author.did));
  item.post.record.facets[0].index.byteStart=1;
  assert.ok(prepare(item).coverage.some(c=>c.relationship==='profile'&&c.state==='unsupported'));
  item.post.record.facets=Array.from({length:11},(_,i)=>({index:{byteStart,byteEnd:byteStart+Buffer.byteLength(label)},features:[{$type:'app.bsky.richtext.facet#mention',did:'did:plc:actor'+i}]}));
  assert.ok(!prepare(item).prepared.links.some(l=>l.relationship==='profile'));
});

test('identity/raw payload independent of feed position; content changes retained under same identity',async()=>{
  const item=await fixture('hsa-webinar.json');
  const a=await retrieve(async url=>response(url,{feed:[item]}));
  const b=await retrieve(async url=>response(url,{feed:[item,item]}));
  assert.equal(a.documents[0].raw,b.documents[1].raw);
  assert.equal(a.documents[0].id,b.documents[1].id);
  assert.notDeepEqual(a.documents[0].provenance,b.documents[1].provenance);
  const changed=structuredClone(item);changed.post.record.text+='\nDeux annonces : atelier et rapport. 🌊';
  const doc=prepare(changed);
  assert.equal(doc.id,a.documents[0].id);
  assert.notEqual(doc.raw,a.documents[0].raw);
  assert.ok(doc.prepared.text.startsWith(changed.post.record.text));
  assert.equal(Object.hasOwn(doc,'findings'),false);
  const empty=structuredClone(item);empty.post.record.text='';
  assert.equal(prepare(empty).prepared.blocks[0].end,0);
});

test('reply/repost/quote/external/facets/media and bilingual evidence remain visible with limitations',async()=>{
  const item=await fixture('hsa-webinar.json');
  const quote='at://did:plc:quoted/app.bsky.feed.post/quote';
  item.post.author={handle:'another.bsky.social'};
  item.reason={$type:'app.bsky.feed.defs#reasonRepost',by:{handle:hsa,did:'did:plc:feed'},indexedAt:'2026-10-01T00:00:00Z'};
  item.post.record.text+='\nEnglish context. Contexte français : deux séances, aucune date inventée.';
  item.post.record.reply={root:{uri:quote,cid:'quote'},parent:{uri:quote,cid:'quote'}};
  item.post.embed={$type:'app.bsky.embed.recordWithMedia#view',record:{record:{uri:quote,value:{text:'Texte cité intégral'}}},media:{external:{uri:'https://example.org/full',title:'Résumé',description:'Full description'},images:[{fullsize:'https://example.org/image',alt:'Image caption'}]}};
  const doc=prepare(item);
  assert.ok(doc.prepared.text.startsWith(item.post.record.text));
  assert.ok(doc.prepared.links.some(l=>l.target==='https://example.org/full'));
  assert.ok(doc.coverage.some(c=>c.relationship==='quote'&&c.state==='embedded'));
  assert.ok(doc.coverage.some(c=>c.relationship==='reply'&&c.state==='partial'));
  assert.ok(doc.coverage.some(c=>c.relationship==='repost'&&c.state==='retained'));
  assert.ok(doc.coverage.some(c=>c.relationship==='media'&&c.state==='unfetched'));
  const conflict=structuredClone(item);conflict.post.author.did='did:plc:wrong';
  assert.throws(()=>prepare(conflict),/identity/);
  delete item.reason;assert.throws(()=>prepare(item),/requested feed actor/);
});

test('structural pagination keeps exact responses and all posts regardless of timestamp; bounds are incomplete',async()=>{
  const item=await fixture('hsa-webinar.json');let calls=0;
  const result=await retrieve(async(url,budget)=>{
    budget.requests++;calls++;
    const u=new URL(url);assert.equal(u.searchParams.get('filter'),'posts_with_replies');assert.equal(u.searchParams.get('includePins'),'true');
    assert.equal(u.searchParams.get('cursor'),calls===1?null:'next');
    return response(url,{feed:[item],cursor:calls===1?'next':'more'});
  });
  assert.equal(calls,2);assert.equal(result.documents.length,2);assert.equal(result.complete,false);
  assert.equal(result.pagination.state,'bounded');assert.equal(result.pagination.cursor,'more');
  assert.equal(JSON.parse(result.pages[0].response.body).feed[0].post.record.text,item.post.record.text);
  assert.ok(result.coverage.some(c=>c.relationship==='pagination'));
});

test('actual HSA limit=25 response retains all 25 ordinary entries and the additional first-page pin',async()=>{
  const saved=await fixture('hsa-author-pinned.json.gz'),feed=JSON.parse(saved.response.body);
  assert.equal(createHash('sha256').update(saved.response.body).digest('hex'),saved.sha256);
  assert.equal(feed.feed.length,26);assert.equal(feed.feed[0].reason.$type,'app.bsky.feed.defs#reasonPin');
  const result=await retrieve(async url=>{
    assert.equal(new URL(url).searchParams.get('limit'),'25');assert.equal(new URL(url).searchParams.get('includePins'),'true');
    return response(url,saved.response.body);
  },{feedPages:1,postsPerPage:25});
  assert.equal(result.pages[0].response.body,saved.response.body);
  assert.equal(result.documents.length,26);assert.equal(result.pagination.state,'bounded');assert.equal(result.pagination.cursor,feed.cursor);
  assert.equal(result.complete,false);assert.ok(!result.coverage.some(c=>c.state==='failed'));
  for(const [position,item] of feed.feed.entries()){
    const doc=result.documents[position];assert.equal(doc.raw,JSON.stringify(item));assert.ok(doc.prepared.text.startsWith(item.post.record.text));
    assert.equal(doc.id,item.post.uri);assert.deepEqual(doc.provenance,{page:0,position,feed_url:result.pages[0].url});
  }
});

test('ordinary overflow, extra/misplaced/fake pins and malformed pinned posts cannot bypass author bounds',async()=>{
  const saved=await fixture('hsa-author-pinned.json.gz'),{feed}=JSON.parse(saved.response.body),[pin,...ordinary]=feed;
  const overflow=[...feed,ordinary[0]],extraPin=[pin,pin,...ordinary],misplaced=[...ordinary,pin];
  const fakePins=[undefined,'app.bsky.feed.defs#reasonPin',[],{$type:'reasonPin'},{$type:'app.bsky.feed.defs#reasonRepost'}];
  for(const items of [overflow,extraPin,misplaced,...fakePins.map(reason=>[{...pin,reason},...ordinary])]){
    const result=await retrieve(async url=>response(url,{feed:items}),{feedPages:1,postsPerPage:25});
    assert.equal(result.documents.length,0);assert.equal(result.pagination.state,'failed');assert.equal(result.complete,false);
    assert.ok(result.coverage.some(c=>c.state==='failed'&&/bounds/.test(c.reason)));
    assert.deepEqual(JSON.parse(result.pages[0].response.body).feed,JSON.parse(JSON.stringify(items)));
  }
  for(const post of [undefined,{...pin.post,uri:'invalid'},{...pin.post,author:{...pin.post.author,handle:'another.bsky.social'}}]){
    const result=await retrieve(async url=>response(url,{feed:[{...pin,post},...ordinary]}),{feedPages:1,postsPerPage:25});
    assert.equal(result.documents.length,25);assert.equal(result.complete,false);
    assert.ok(result.coverage.some(c=>c.state==='failed'&&c.position===0));
    assert.deepEqual(result.documents.map(d=>d.raw),ordinary.map(item=>JSON.stringify(item)));
  }
  const laterPin=await retrieve(async url=>response(url,new URL(url).searchParams.has('cursor')?{feed:[pin]}:{feed,cursor:'next'}),{feedPages:2,postsPerPage:25});
  assert.equal(laterPin.documents.length,26);assert.equal(laterPin.pages.length,2);assert.equal(laterPin.pagination.state,'failed');
});

test('empty feed can exhaust; malformed item, repeated cursor, oversized page, destination and transport failures cannot succeed',async()=>{
  assert.equal((await retrieve(async url=>response(url,{feed:[]}))).complete,true);
  const item=await fixture('hsa-webinar.json');
  const mixed=await retrieve(async url=>response(url,{feed:[{},item]}));
  assert.equal(mixed.complete,false);assert.equal(mixed.documents.length,1);assert.equal(mixed.coverage[0].position,0);
  for(const read of [async url=>response(url,{feed:[item],cursor:'repeat'}),async url=>response(url,{feed:Array(21).fill(item)}),async()=>response('https://example.org/wrong',{feed:[item]}),async()=>{throw new Error('quota exhausted');}]){
    const result=await retrieve(read);assert.equal(result.complete,false);assert.equal(result.pagination.state,'failed');assert.ok(result.coverage.some(c=>c.state==='failed'));
  }
  await assert.rejects(retrieve(async()=>{}, {feedPages:1,postsPerPage:101}),/bounds/);
});


test('long source text is retained completely for shared bounded request packing',async()=>{
  const item=await fixture('hsa-webinar.json');
  item.post.record.text='English  text. Texte français 🌊\n'.repeat(1000)+'Final context: two separate announcements.';
  const doc=prepare(item);
  assert.equal(doc.raw,JSON.stringify(item));
  assert.ok(doc.prepared.text.startsWith(item.post.record.text));
  assert.ok(doc.prepared.text.length>8000);
  assert.equal(doc.prepared.blocks[0].end,item.post.record.text.length);
  assert.equal(doc.prepared.chunks.map(c=>doc.prepared.text.slice(c.start,c.end)).join(''),doc.prepared.text);
  assert.ok(doc.prepared.omissions.some(o=>o.path==='item.post.indexedAt'));
});

test('facet/embed/plain links are fetchable; registration authority comes from an explicit label, never URL spelling',async()=>{
  const item=await fixture('hsa-webinar-time.json'),prepared=prepare(item).prepared;
  assert.ok(prepared.links.length);assert.ok(prepared.links.every(l=>l.tag==='a'));
  assert.ok(prepared.links.some(l=>l.relationship==='registration'&&l.context.includes('Register:')));
  item.post.record.text=item.post.record.text.replace('Register:','Details:');
  item.post.embed={external:{uri:'https://register.example/organizer',title:'More information'}};
  assert.ok(prepare(item).prepared.links.every(l=>l.relationship==='support'&&l.tag==='a'));
});


test('retained HSA failures now supply complete post and embed fields with source attribution',async()=>{
  const saved=await fixture('hsa-social-preparation.json.gz');
  for(const source of saved.sources){
    const item=JSON.parse(source.content),doc=prepare(item);
    assert.equal(doc.raw,source.content);assert.equal(createHash('sha256').update(doc.raw).digest('hex'),source.content_hash);
    const input={documents:[{blocks:[{text:doc.prepared.text}]}]};
    assert.ok(input.documents[0].blocks.some(b=>b.text.includes(item.post.record.text)));
    const embed=item.post.embed;
    for(const text of embed.images?.map(i=>i.alt)??[embed.external.title,embed.external.description,embed.external.uri])
      assert.ok(input.documents[0].blocks.some(b=>b.text.includes(text)));
    assert.ok(doc.prepared.omissions.some(o=>o.path.includes('.author.avatar')));
    assert.ok(!doc.prepared.text.includes('"mimeType"'));
  }
});

test('neutral social fields retain quote/reply/external/alt attribution, every source offset and technical exclusions',async()=>{
  const item=await fixture('hsa-webinar.json'),uri='at://did:plc:other/app.bsky.feed.post/other';
  item.post.author={handle:'original.bsky.social'};item.reason={$type:'app.bsky.feed.defs#reasonRepost',by:{handle:hsa},createdAt:'2026-02-03T12:00:00Z'};
  item.post.record.text='First meeting. Second meeting. 🌊\nRegister: https://example.org/a';
  item.post.author.description='Profile biography must not precede or become post content.';
  item.post.embed={record:{uri,author:{handle:'quoted.bsky.social'},value:{text:'Quoted complete text: autre séance.',createdAt:'2026-01-02T03:00:00Z'}},
    external:{uri:'https://example.org/external',title:'External title',description:'External full description.'},images:[{alt:'Complete image schedule.',fullsize:'https://example.org/image.jpg'}]};
  item.reply={root:{uri,author:{handle:'reply.bsky.social'},record:{text:'Returned reply root in full.',createdAt:'2026-01-01T00:00:00Z'}},
    parent:{uri:'at://did:plc:parent/app.bsky.feed.post/parent'}};
  const doc=prepare(item);
  assert.equal(doc.raw,JSON.stringify(item));assert.ok(doc.prepared.text.startsWith(item.post.record.text));
  for(const block of doc.prepared.blocks)for(const path of block.source_paths){
    const original=path.split('.').slice(1).reduce((v,k)=>v[k],item);
    assert.equal(doc.prepared.text.slice(block.start,block.end),original);
  }
  const quoted=doc.prepared.blocks.find(b=>b.attribution.relationship==='quote'&&b.field==='text');
  assert.equal(quoted.attribution.author,'quoted.bsky.social');assert.equal(quoted.attribution.uri,uri);
  assert.equal(doc.prepared.blocks.find(b=>b.attribution.relationship==='reply-root'&&b.field==='text').attribution.author,'reply.bsky.social');
  assert.equal(doc.prepared.blocks.find(b=>b.attribution.relationship==='reply-parent').attribution.author,null);
  assert.ok(doc.prepared.blocks.filter(b=>b.attribution.relationship==='external').every(b=>b.attribution.author===null));
  assert.equal(doc.prepared.blocks[0].attribution.author,'original.bsky.social');
  assert.ok(!doc.prepared.text.includes(item.post.author.description));
  assert.ok(doc.prepared.omissions.some(o=>o.path==='item.post.author.description'));
  assert.ok(doc.prepared.omissions.some(o=>o.path==='item.reason.createdAt'));
  assert.ok(doc.prepared.blocks.every(b=>b.source_paths.every(p=>!p.startsWith('item.reason.'))));
  assert.ok(doc.coverage.some(c=>c.path==='item.reply.root'&&c.state==='embedded'));
  assert.ok(doc.coverage.some(c=>c.relationship==='repost'&&c.state==='retained'));
  assert.ok(doc.coverage.some(c=>c.relationship==='media'&&c.state==='unfetched'));
});

test('Unicode post and embedded alt text retain all content and original source paths',async()=>{
  const item=await fixture('hsa-webinar.json');
  item.post.record.text='Français 🌊 whitespace. '.repeat(1000)+'Final post session.';
  item.post.embed={images:[{alt:'Image evidence 🌊. '.repeat(100)+'Final image session.'}]};
  delete item.post.record.embed;delete item.post.record.facets;
  const doc=prepare(item),blocks=doc.prepared.blocks.map(b=>({...b,text:doc.prepared.text.slice(b.start,b.end)}));
  assert.ok(blocks.every(b=>b.text.isWellFormed()));
  assert.ok(blocks.some(b=>b.text.includes(item.post.record.text)));
  assert.ok(blocks.some(b=>b.text.includes(item.post.embed.images[0].alt)));
  assert.ok(blocks.some(b=>b.source_paths?.length));
});

test('background author turns check newest posts and continue a durable historical cursor through failures',async()=>{
  const item=await fixture('hsa-webinar.json');let progress={},seen=[];
  const run=async(fail=false)=>retrieveAuthorDocuments({tracker,sourceURL,progress,budget:{requests:0,deadline:Date.now()+10000},
    limits:{feedPages:2,postsPerPage:20},read:async url=>{
      const cursor=new URL(url).searchParams.get('cursor');seen.push(cursor);
      if(fail&&cursor)throw new Error('Temporary old-page failure');
      return response(url,{feed:[item],cursor:cursor==='older'?'oldest':cursor==='oldest'?undefined:'older'});
    }});
  let result=await run();progress=result.progress;assert.deepEqual(seen,[null,'older']);assert.equal(progress.cursor,'oldest');
  seen=[];result=await run(true);progress=result.progress;assert.deepEqual(seen,[null,'oldest']);assert.equal(progress.cursor,'oldest');
  seen=[];result=await run();assert.deepEqual(seen,[null,'oldest']);assert.deepEqual(result.progress,{});
});
