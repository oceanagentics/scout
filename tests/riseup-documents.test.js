import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { parseDocument, DomUtils } from 'htmlparser2';
import { sourceURL } from '../collector/hsa.js';
import { ARCHIVE, RISE_UP, prepareRiseupDocument, retrieveRiseupDocuments } from '../collector/riseup-documents.js';

const fixture=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/riseup-website.json.gz',import.meta.url))));
const tracker={collector:'web',url:RISE_UP},owner='740487e7a7306085143176166';
const html=(url,body)=>({url,status:200,headers:{'content-type':'text/html'},body:'<html>'+body+'</html>'});
const home=urls=>html(RISE_UP,'<body class="page-id-1"><section class="bde-section-1-1"><p>Configured page.</p>'+urls.map(u=>'<a href="'+u+'">Observed issue</a>').join('')+'</section></body>');
const archive=urls=>html(ARCHIVE,'<body><ul id="archive-list">'+(urls.length?urls.map(u=>'<li><a href="'+u+'">Observed archive issue</a></li>').join(''):'<li>No linked issues returned.</li>')+'</ul></body>');
const issue=(url,text)=>html(url,'<body class="body"><h1>Whole issue</h1><p>'+text+'</p></body>');
const campaign=id=>'https://us11.campaign-archive.com/?id='+id+'&u='+owner;
const retrieve=(read,options={})=>retrieveRiseupDocuments({tracker,sourceURL,read,budget:{requests:0,deadline:Date.now()+10000},...options});
const norm=text=>text.replace(/\s+/g,' ').trim();

const savedRead=async url=>{
  if(url==='https://eepurl.com/7vsYN_Y4aE')return fixture.july;
  if(url==='https://eepurl.com/g-Klg8fh-2')return fixture.september;
  const response=Object.values(fixture).find(r=>r.url&&sourceURL(r.url)===url);
  if(!response)throw new Error('No saved response for '+url);return response;
};

test('both saved newsletters preserve all sections, substantial text and later context as whole documents',()=>{
  for(const key of ['july','september']){
    const doc=prepareRiseupDocument(fixture[key],{sourceURL}),dom=parseDocument(fixture[key].body);
    assert.equal(doc.raw,fixture[key].body);assert.equal(doc.prepared.input,'whole-newsletter');
    assert.equal(doc.identity,'riseup:'+doc.id);assert.equal(doc.prepared.version,'riseup-documents-v1');
    const body=DomUtils.getElementsByTagName('body',dom.children).find(n=>n.attribs.class==='body');
    const headings=DomUtils.findAll(n=>/^h[1-6]$/.test(n.name),body.children).map(n=>norm(DomUtils.textContent(n))).filter(Boolean);
    for(const heading of headings)assert.ok(norm(doc.prepared.text).includes(heading),heading);
    const nodes=[body];let retained=0;
    while(nodes.length){const n=nodes.pop();if(['script','style'].includes(n.name))continue;
      if(n.type==='text'&&norm(n.data).length>60){assert.ok(norm(doc.prepared.text).includes(norm(n.data)),norm(n.data).slice(0,100));retained++;}
      nodes.push(...n.children??[]);
    }
    assert.ok(retained>15);assert.ok(doc.prepared.text.includes('Member Spotlight'));assert.ok(doc.prepared.text.includes('Take Action'));
    assert.ok(doc.prepared.text.includes('Fiscal sponsorship for RISE UP is provided by The Ocean Foundation'));
    assert.equal(doc.prepared.chunks.map(c=>doc.prepared.text.slice(c.start,c.end)).join(''),doc.prepared.text);
    assert.ok(doc.prepared.text.length>15000);
    for(const field of ['kind','organization','date','findings','candidate'])assert.equal(Object.hasOwn(doc,field),false);
  }
  const september=prepareRiseupDocument(fixture.september,{sourceURL});
  assert.ok(september.prepared.text.includes('BBNJ Webinar: Designing the BBNJ Clearing-House Mechanism'));
  assert.ok(september.prepared.text.includes('Science & Policy Focus'));
});

test('saved configured page/archive discover issue links without latest or topic selection, retaining all raw evidence',async()=>{
  const result=await retrieve(savedRead,{limits:{documents:80,requests:100}});
  for(const key of ['home','archive','july','september']){
    const doc=key==='archive'?result.archive:result.documents.find(d=>d.url===sourceURL(fixture[key].url));assert.ok(doc,key);assert.equal(doc.raw,fixture[key].body);
    assert.ok(result.responses.some(r=>r.response.body===fixture[key].body));
  }
  const sept=result.documents.find(d=>d.url===sourceURL(fixture.september.url));
  assert.ok(sept.aliases.includes('https://eepurl.com/g-Klg8fh-2'));
  assert.ok(sept.via.some(v=>v.parent_url===sourceURL(ARCHIVE)&&v.link.tag==='a'&&v.link.target==='http://eepurl.com/g-Klg8fh-2'));
  assert.ok(result.pending.length>10);assert.ok(result.pending.some(i=>i.state==='failed'));
  assert.ok(result.coverage.some(c=>c.state==='unfetched'));
  assert.ok(!result.documents.some(d=>d.url===sourceURL(ARCHIVE)));assert.equal(result.archive.prepared.input,'campaign-listing');
  assert.ok(result.inventory.some(i=>i.url==='https://eepurl.com/i0gUu-/'));
  assert.ok(!result.responses.some(r=>[fixture.ssf.url,fixture.registration.url].includes(r.requested_url)));
  assert.ok(!result.coverage.some(c=>c.reason?.includes('delegated to shared retrieval')));
  assert.equal(result.complete,false);
});

test('unchanged/reordered listing leaves identity/payload unchanged; changed known issue is re-fetched behind unchanged listing',async()=>{
  const urls=[campaign('aaaaaaaaaa'),campaign('bbbbbbbbbb')];let order=urls,text='Original issue. Later paragraph.';
  const read=async url=>url===RISE_UP?home(order):url===sourceURL(ARCHIVE)?archive([]):issue(url,text);
  const first=await retrieve(read);
  order=[...urls].reverse();const reordered=await retrieve(read);
  const a=first.documents.find(d=>d.url===urls[0]),b=reordered.documents.find(d=>d.url===urls[0]);
  assert.equal(a.id,b.id);assert.equal(a.raw,b.raw);assert.equal(a.prepared.text,b.prepared.text);
  text='Changed issue. Full later paragraph contains an additional announcement.';
  const changed=await retrieve(read,{known:first.documents});const c=changed.documents.find(d=>d.id===a.id);
  assert.ok(c.known);assert.notEqual(c.raw,a.raw);assert.ok(c.prepared.text.includes('additional announcement'));
});

test('publisher archive and known unlisted issues remain independently retrievable when website access fails',async()=>{
  const result=await retrieve(async url=>url===RISE_UP?{...fixture.home,status:403}:url===sourceURL(ARCHIVE)?archive([]):fixture.september,
    {known:[{url:fixture.september.url}]});
  assert.ok(result.documents.some(d=>d.id.endsWith(':108f68d54d')&&d.known));
  assert.equal(result.archive.url,sourceURL(ARCHIVE));
  assert.ok(result.coverage.some(c=>c.url===RISE_UP&&c.state==='failed'));
});

test('bounded progress advances deferred, failed, new and known issues across runs',async()=>{
  const urls=[campaign('aaaaaaaaaa'),campaign('bbbbbbbbbb'),campaign('cccccccccc')];let pending=[],known=[],progress={};
  const observed=new Set(),calls=[];
  const read=async url=>{calls.push(url);if(url===RISE_UP)return home(urls);if(url===sourceURL(ARCHIVE))return archive([]);
    if(url===urls[0])throw new Error('HTTP 403');return issue(url,'All source content.');};
  for(let run=0;run<5;run++){
    const result=await retrieve(read,{known,pending,progress,limits:{documents:3,requests:4}});
    pending=result.pending;progress=result.progress;
    for(const doc of result.documents){observed.add(doc.url);if(!known.some(k=>k.url===doc.url))known.push(doc);}
    assert.ok(result.documents.length<=3);assert.ok(result.requests<=4);
  }
  assert.ok(observed.has(urls[1]));assert.ok(observed.has(urls[2]));assert.ok(calls.includes(urls[0]));
  assert.ok(pending.some(i=>i.url===urls[0]));assert.ok(calls.filter(u=>u===urls[1]).length>=2);
});

test('alias redirects retain canonical campaign identity and overlap provenance; conflicting payloads remain visible',async()=>{
  const urls=['http://eepurl.com/tokenA','https://eepurl.com/tokenB'],target=campaign('aaaaaaaaaa');
  const read=async url=>url===RISE_UP?home(urls):url===sourceURL(ARCHIVE)?archive([]):issue(target,'Same canonical issue.');
  const result=await retrieve(read,{limits:{documents:5,requests:6}});
  const doc=result.documents.find(d=>d.url===target);assert.equal(doc.id,'campaign:'+owner+':aaaaaaaaaa');
  assert.equal(result.documents.filter(d=>d.id===doc.id).length,1);assert.equal(doc.aliases.length,2);assert.equal(doc.via.length,2);
  const changed=await retrieve(async url=>url==='https://eepurl.com/tokenB'?issue(target,'Conflicting changed response.'):read(url),{limits:{documents:5,requests:6}});
  assert.equal(changed.documents.filter(d=>d.id===doc.id&&d.state==='conflict').length,2);
  assert.ok(changed.coverage.some(c=>c.id===doc.id&&c.state==='conflict'));
});

test('registration/organizer/support relationships retain common metadata without authority inference',()=>{
  const doc=prepareRiseupDocument(issue(campaign('aaaaaaaaaa'),'<a rel="registration" href="https://example.org/register">Book a place</a>'+
    '<a rel="author" href="https://example.org/about">Publisher</a><a href="https://example.org/info">Context</a>'),{sourceURL});
  assert.deepEqual(doc.prepared.links.map(l=>l.relationship),['registration','organizer','support']);
  assert.ok(doc.prepared.links.every(l=>l.tag==='a'&&l.state==='unfetched'));
  assert.equal(Object.hasOwn(doc,'authority'),false);assert.equal(Object.hasOwn(doc,'candidate'),false);
});

test('native page/campaign repair handoffs preserve priority and last failure across deferred passes',async()=>{
  const repair=campaign('bbbbbbbbbb'),waiting=campaign('aaaaaaaaaa'),page='https://mailchi.mp/riseupfortheocean.org/observed-page';
  const known=[{id:'riseup:page:'+RISE_UP,url:RISE_UP},{id:'riseup:page:'+page,url:page}];
  const pending=[{id:'riseup:campaign:'+owner+':aaaaaaaaaa',url:waiting,state:'model-pending'},
    {id:'riseup:campaign:'+owner+':bbbbbbbbbb',url:repair,state:'model-repair'},
    {url:repair,state:'deferred',pending_state:'model-pending'}];
  const read=async url=>url===RISE_UP?home([]):url===ARCHIVE?archive([]):issue(url,'Complete whole newsletter.');
  const failed=await retrieve(async url=>url===repair?{...issue(url,'Failed receipt.'),status:403}:read(url),{known,pending,limits:{documents:2,requests:3}});
  assert.deepEqual(failed.responses.map(r=>r.requested_url),[RISE_UP,ARCHIVE,repair]);assert.equal(failed.progress.after_url,repair);
  const failure=failed.pending.find(p=>p.url===repair);assert.equal(failure.pending_state,'model-repair');assert.equal(failure.id,'campaign:'+owner+':bbbbbbbbbb');assert.ok(failure.last_failure);
  const deferred=await retrieve(read,{known,pending:failed.pending,progress:failed.progress,limits:{documents:2,requests:2}});
  assert.equal(deferred.progress.after_url,repair);assert.deepEqual(deferred.pending.find(p=>p.url===repair).last_failure,failure.last_failure);
  const done=await retrieve(read,{known,pending:deferred.pending,progress:deferred.progress,limits:{documents:2,requests:6}});
  assert.deepEqual(done.documents.map(d=>d.identity),['riseup:page:'+RISE_UP,'riseup:campaign:'+owner+':bbbbbbbbbb']);
  const next=await retrieve(read,{known,pending:done.pending,progress:done.progress,limits:{documents:2,requests:6}});
  assert.equal(next.documents[1].url,waiting);
  const last=await retrieve(read,{known,pending:next.pending,progress:next.progress,limits:{documents:2,requests:6}});
  assert.equal(last.documents[1].identity,'riseup:page:'+page);
});

test('archive is discovery within the cap and newsletter links do not expand the issue frontier',async()=>{
  const url=campaign('aaaaaaaaaa'),incidental=campaign('bbbbbbbbbb');
  const read=async target=>target===RISE_UP?home([url]):target===ARCHIVE?archive([url]):issue(target,
    `<a href="${incidental}">Another issue reference</a><a href="https://eepurl.com/related">Incidental link</a><a rel="registration" href="https://example.org/register">Register</a>`);
  const capped=await retrieve(read,{limits:{documents:1,requests:6}});
  assert.deepEqual(capped.documents.map(d=>d.url),[RISE_UP]);assert.equal(capped.archive.raw,archive([url]).body);
  assert.equal(capped.requests,2);assert.equal(capped.pending[0].state,'deferred');assert.equal(capped.progress.after_url,undefined);
  const run=await retrieve(read);assert.deepEqual(run.responses.map(r=>r.requested_url),[RISE_UP,ARCHIVE,url]);
  assert.ok(run.coverage.some(c=>c.target===incidental&&c.state==='unfetched'));
  assert.ok(run.documents[1].prepared.links.some(l=>l.target==='https://example.org/register'&&l.relationship==='registration'));
});

test('native identity disagreement and direct issue redirects stay visible without accepting a different issue',async()=>{
  const url=campaign('aaaaaaaaaa'),alias='https://eepurl.com/observed_alias',other=campaign('bbbbbbbbbb');
  const read=async target=>target===RISE_UP?home([]):target===ARCHIVE?archive([]):issue(url,'Whole response.');
  const wrong=await retrieve(read,{known:[{id:'riseup:campaign:'+owner+':bbbbbbbbbb',url:alias}]});
  assert.equal(wrong.documents.length,1);assert.ok(wrong.pending.some(p=>p.reason==='Known RISE UP issue identity disagreement'));
  assert.ok(wrong.responses.some(r=>r.response.body===issue(url,'Whole response.').body));
  const conflict=await retrieve(read,{known:[{id:'riseup:campaign:'+owner+':aaaaaaaaaa',url}],
    pending:[{id:'riseup:campaign:'+owner+':bbbbbbbbbb',url,state:'model-repair'}]});
  assert.equal(conflict.requests,2);assert.equal(conflict.pending[0].reason,'Conflicting known issue identities');assert.equal(conflict.progress.after_url,undefined);
  const repeated=await retrieve(read,{pending:conflict.pending});assert.equal(repeated.requests,2);assert.deepEqual(repeated.pending[0].ids,conflict.pending[0].ids);
  const page='https://mailchi.mp/riseupfortheocean.org/observed-page';
  const redirected=await retrieve(async target=>target===RISE_UP?home([page]):target===ARCHIVE?archive([]):issue(other,'Different issue.'));
  assert.equal(redirected.documents.length,1);assert.ok(redirected.pending[0].reason.includes('redirect/source identity'));
  const foreign=await retrieve(read,{known:[{id:'gof:document:1',url}]});
  assert.equal(foreign.requests,2);assert.ok(foreign.coverage.some(c=>c.reason==='Unsupported RISE UP native source identity'));
  assert.throws(()=>prepareRiseupDocument(issue(url+'&id=bbbbbbbbbb','Ambiguous campaign'),{sourceURL}));
});

test('shared request, time and UTF8 limits preserve exact failed bodies and unread cursors',async()=>{
  const url=campaign('aaaaaaaaaa'),read=async target=>target===RISE_UP?home([url]):target===ARCHIVE?archive([]):issue(url,'Whole issue.');
  const budget={requests:0,deadline:Date.now()+10000};
  const charged=await retrieve(async(target,shared)=>{shared.requests+=2;return read(target);},{budget,limits:{documents:4,requests:4},progress:{after_url:url}});
  assert.equal(charged.requests,2);assert.equal(budget.requests,4);assert.equal(charged.progress.after_url,url);
  const used={requests:3,deadline:Date.now()+10000},unread=await retrieve(read,{budget:used,pending:[{url}],limits:{documents:4,requests:3}});
  assert.equal(unread.requests,0);assert.equal(used.requests,3);assert.equal(unread.progress.after_url,undefined);
  const response=issue(url,'é'.repeat(150));assert.ok(Buffer.byteLength(response.body)>response.body.length);
  const bytes=await retrieve(async target=>target===RISE_UP?{...home([]),status:403}:target===ARCHIVE?archive([]):response,
    {known:[{url}],limits:{documents:4,requests:6,bytes:response.body.length}});
  assert.equal(bytes.documents.length,0);assert.equal(bytes.responses.at(-1).response.body,response.body);assert.equal(bytes.pending[0].reason,'RISE UP response byte bound');
  let ticks=0;const timed=await retrieve(read,{now:()=>ticks++?10:0,budget:{requests:0,deadline:10},progress:{after_url:url}});
  assert.equal(timed.requests,1);assert.equal(timed.progress.after_url,url);
  for(const limits of [{documents:4,requests:NaN},{documents:4,requests:6,bytes:1.5}])await assert.rejects(retrieve(read,{limits}),/bounds/);
});

test('malformed, unsupported, failed and redirected sources retain explicit limits and obtainable raw responses',async()=>{
  for(const response of [{...fixture.september,status:403},{...fixture.september,body:'<html>truncated'},
    html(fixture.september.url,'<body>No structural issue region</body>'),issue('https://example.org/wrong','Wrong publisher')])
    assert.throws(()=>prepareRiseupDocument(response,{sourceURL}));
  const url=campaign('aaaaaaaaaa');
  for(const final of [campaign('bbbbbbbbbb'),'https://us11.campaign-archive.com/?id=aaaaaaaaaa&u=wrong','https://example.org/wrong']){
    const result=await retrieve(async target=>target===RISE_UP?home([url]):target===sourceURL(ARCHIVE)?archive([]):issue(final,'Wrong identity'));
    assert.ok(result.pending.some(i=>i.url===url&&i.state==='failed'));assert.ok(result.responses.some(r=>r.response.url===final));
  }
  const unsupported=await retrieve(async target=>target===RISE_UP?home(['http://example.org/insecure','https://example.org/file.pdf']):archive([]));
  assert.ok(unsupported.coverage.filter(c=>c.state==='unsupported').length>=2);
  const bounded=await retrieve(async target=>home([url]),{limits:{documents:4,requests:1}});
  assert.equal(bounded.requests,1);assert.ok(bounded.pending.some(i=>i.state==='deferred'));
  const timed=await retrieve(async()=>{throw new Error('must not fetch');},{budget:{requests:0,deadline:10},now:()=>10,pending:[{url}]});
  assert.equal(timed.requests,0);assert.equal(timed.pending[0].state,'deferred');
  const quota=await retrieve(async()=>{throw Object.assign(new Error('Quota exhausted'),{quota:true});},{known:[{url}]});
  assert.equal(quota.requests,1);assert.equal(quota.pending[0].state,'deferred');
  await assert.rejects(retrieve(async()=>{}, {limits:{documents:0,requests:1}}),/bounds/);
});

test('carried pending/known preserves flat newsletter and alias relationships without history growth',async()=>{
  const canonical=campaign('aaaaaaaaaa'),alias='https://eepurl.com/source_alias';
  const read=async url=>url===RISE_UP?home([alias,canonical]):url===ARCHIVE?archive([canonical]):issue(canonical,'Complete whole newsletter body.');
  const initial=await retrieve(read),original=initial.documents.find(d=>d.url===sourceURL(canonical));
  assert.ok(original.aliases.includes(alias));
  let pending=initial.pending,known=[original];const sizes=[];
  for(let cycle=0;cycle<80;cycle++){
    const result=await retrieve(async url=>({...issue(url,'Full failed newsletter receipt.'),status:503}),{pending,known});
    assert.ok(result.responses.every(r=>r.response.body.includes('Full failed newsletter receipt.')));
    for(const entry of result.pending){
      assert.equal(entry.state,'failed');assert.deepEqual(entry.last_failure,{state:'failed',reason:entry.reason});
      assert.equal(new Set(entry.via.map(v=>JSON.stringify(v))).size,entry.via.length);
      assert.ok(entry.via.filter(v=>v.relationship==='pending').length<=1);
      assert.ok(entry.via.every(v=>!Object.hasOwn(v,'previous')&&!Object.hasOwn(v,'via')));
      assert.ok(entry.via.some(v=>v.relationship==='issue-link'&&v.link.target===alias));
      assert.ok(entry.via.some(v=>v.relationship==='issue-link'&&v.parent_url===sourceURL(ARCHIVE)));
    }
    pending=result.pending;sizes.push(Buffer.byteLength(JSON.stringify(pending)));
  }
  assert.ok(Math.max(...sizes.slice(40))<=Math.max(...sizes.slice(10,40)));
  const latest=await retrieve(async()=>{throw new Error('Latest newsletter failure');},{pending,known});pending=latest.pending;
  assert.ok(pending.every(p=>p.last_failure.reason==='Latest newsletter failure'));
  for(const options of [{budget:{requests:0,deadline:0},now:()=>0},{limits:{documents:4,requests:2}}]){
    const result=await retrieve(read,{pending,known,...options});assert.ok(result.requests<=2);
    for(const entry of result.pending)assert.deepEqual(entry.last_failure,pending.find(p=>p.url===entry.url)?.last_failure);
  }
  const quota=await retrieve(async()=>{throw Object.assign(new Error('Quota exhausted'),{quota:true});},{pending,known});
  assert.equal(quota.requests,1);assert.ok(quota.pending.every(p=>p.last_failure.reason==='Latest newsletter failure'));
  for(let cycle=0;cycle<30;cycle++){
    const result=await retrieve(read,{pending,known});pending=result.pending;
    const current=result.documents.find(d=>d.id===original.id);assert.equal(current.raw,original.raw);known=[current];
    assert.ok(current.aliases.includes(alias));assert.ok(current.aliases.includes(sourceURL(canonical)));
    assert.ok(current.via.some(v=>v.relationship==='issue-link'&&v.link.target===alias));
    assert.ok(current.via.some(v=>v.relationship==='issue-link'&&v.parent_url===sourceURL(ARCHIVE)));
    assert.equal(new Set(current.via.map(v=>JSON.stringify(v))).size,current.via.length);assert.ok(current.via.length<=5);
    assert.ok(current.via.every(v=>!Object.hasOwn(v,'previous')&&!Object.hasOwn(v,'via')));
    assert.ok(result.inventory.filter(e=>e.state==='retained').every(e=>!e.last_failure));
  }
});
