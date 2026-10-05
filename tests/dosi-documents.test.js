import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { parseDocument, DomUtils } from 'htmlparser2';
import { sourceURL } from '../collector/hsa.js';
import { DOSI_WEB, prepareDosiDocument, retrieveDosiDocuments } from '../collector/dosi-documents.js';
import { prepareDocument } from '../collector/octo-documents.js';

const saved=async name=>JSON.parse(gunzipSync(await readFile(new URL('./fixtures/'+name+'.json.gz',import.meta.url))));
const fixture=await saved('dosi-website');
const captures=await saved('dosi-roundup-captures');
const tracker={collector:'web',url:DOSI_WEB};
const html=(url,content)=>({url,status:200,headers:{'content-type':'text/html'},body:'<html><body>'+content+'</body></html>'});
const article=(url,text)=>html(url,'<div class="entry-content"><p>'+text+'</p></div>');
const feed=urls=>({url:'https://www.dosi-project.org/feed/',status:200,headers:{'content-type':'application/rss+xml'},body:'<rss><channel>'+urls.map((url,i)=>'<item><guid>https://www.dosi-project.org/?p='+i+'</guid><link>'+url+'</link><pubDate>Fri, 01 Jan 1999 00:00:00 GMT</pubDate></item>').join('')+'</channel></rss>'});
const home=urls=>html(DOSI_WEB,'<link type="application/rss+xml" href="https://www.dosi-project.org/feed/"><div class="entry-content"><p>Configured BBNJ page retained.</p>'+urls.map(url=>'<a href="'+url+'">Observed article</a>').join('')+'</div>');
const retrieve=(read,options={})=>retrieveDosiDocuments({tracker,sourceURL,read,budget:{requests:0,deadline:Date.now()+10000},...options});
const fixtureRead=async url=>{const r=Object.values(fixture).find(r=>r.url===url);if(!r)throw new Error('Fixture has no response for '+url);return r;};
const norm=text=>text.replace(/\s+/g,' ').trim();

test('whole real newsletter retains all sections/headings, later content and support links without preset records',()=>{
  const doc=prepareDosiDocument(fixture.newsletter,{sourceURL});
  assert.equal(doc.raw,fixture.newsletter.body);assert.equal(doc.prepared.input,'whole-newsletter');
  assert.equal(doc.id,'page:'+fixture.newsletter.url);
  const headings=DomUtils.findAll(n=>/^h[1-6]$/.test(n.name),parseDocument(fixture.newsletter.body).children).map(n=>norm(DomUtils.textContent(n))).filter(Boolean);
  for(const heading of headings)assert.ok(norm(doc.prepared.text).includes(heading),heading);
  for(const section of ['HOT OFF THE PRESS','EVENTS','OPPORTUNITIES','WANTED','And Finally...','Unlocking Dataset Value for AI-Enabled Scientific Discovery','NOAA Ocean Exploration 2027 Call for Input'])assert.ok(doc.prepared.text.includes(section));
  const body=DomUtils.getElementById('bodyTable',parseDocument(fixture.newsletter.body).children),nodes=[body];
  let retainedTextNodes=0;
  while(nodes.length){
    const node=nodes.pop();if(['script','style'].includes(node.name))continue;
    if(node.type==='text'&&norm(node.data).length>60){assert.ok(norm(doc.prepared.text).includes(norm(node.data)),norm(node.data).slice(0,100));retainedTextNodes++;}
    nodes.push(...node.children??[]);
  }
  assert.ok(retainedTextNodes>30);
  assert.ok(doc.prepared.text.length>30000);assert.equal(doc.prepared.chunks.map(c=>doc.prepared.text.slice(c.start,c.end)).join(''),doc.prepared.text);
  assert.ok(doc.prepared.links.filter(l=>l.tag==='a').length>60);
  assert.ok(doc.prepared.links.some(l=>l.tag==='a'&&l.relationship==='support'));
  for(const key of ['kind','organization','date','findings','candidate'])assert.equal(Object.hasOwn(doc,key),false);
});

test('DOSI HTML spacing makes retained title/date excerpts literal while preserving words, URLs, offsets and preformatted tables',()=>{
  const source=fixture.retained_resume.sources.find(s=>s.url.includes('24-09-2026'));
  const old=source.parsed.document.prepared_versions['dosi-documents-v1'];
  const doc=prepareDosiDocument({...fixture.newsletter,url:source.url,body:source.content},{sourceURL}),p=doc.prepared;
  assert.equal(p.version,'dosi-documents-v2');assert.equal(doc.raw,source.content);assert.equal(norm(p.text),norm(old.text));
  for(const response of fixture.spacing_repairs)for(const finding of response.response.findings)for(const citation of finding.citations){
    assert.ok(!old.text.includes(citation.quote));assert.ok(p.text.includes(citation.quote),finding.anchor);
  }
  assert.deepEqual(p.links.map(l=>({...l,label:norm(l.label)})),old.links.map(l=>({...l,label:norm(l.label)})));
  for(const insertion of p.insertions)assert.equal(p.text.slice(insertion.start,insertion.end),' <'+p.links[insertion.link].target+'>');
  assert.deepEqual(p.blocks.map(({tag,html_start,html_end})=>({tag,html_start,html_end})),old.blocks.map(({tag,html_start,html_end})=>({tag,html_start,html_end})));
  assert.equal(p.chunks.map(c=>p.text.slice(c.start,c.end)).join(''),p.text);
  const literal='  exact  spaces\n\n\tand\u00a0NBSP\n',url='https://www.dosi-project.org/spacing/';
  const html='<div class="entry-content"><h3>Heading</h3>\n\n<h4>Date</h4>\nordinary\t words&nbsp;here'+
    '<pre>'+literal+'<a href="/kept">link</a></pre><textarea>'+literal+'</textarea>'+
    '<table><tr><td>A\t B</td><td>C</td></tr><tr><td>D</td><td>E</td></tr></table><a href="/wrapped"><pre>'+literal+'</pre></a></div>';
  const prepared=prepareDosiDocument({url,status:200,headers:{'content-type':'text/html'},body:'<html>'+html+'</html>'},{sourceURL}).prepared;
  assert.ok(prepared.text.includes('Heading\n\nDate\n\nordinary words here'));
  assert.ok(prepared.text.includes(literal+'link <https://www.dosi-project.org/kept>'));
  assert.ok(prepared.text.includes(literal+'\n\nA B\tC\t\nD\tE'));
  for(const insertion of prepared.insertions)assert.equal(prepared.text.slice(insertion.start,insertion.end),' <'+prepared.links[insertion.link].target+'>');
  assert.ok(prepared.links.every(link=>!link.label.includes('\0')));
  const unscoped=prepareDocument({title:'',html,url});assert.ok(unscoped.text.includes('ordinary\t words\u00a0here'),'Other adapters keep their existing preparation behavior');
});

test('real RSS roundup retrieves its whole newsletter before unrelated articles; home links stay metadata',async()=>{
  const legacy={url:'https://www.dosi-project.org/management/',via:[{relationship:'content-link',parent_url:DOSI_WEB}]};
  const requested=[],result=await retrieve(async url=>{requested.push(url);return fixtureRead(url);},
    {pending:[{...legacy,state:'deferred'}],known:[{url:legacy.url},{url:fixture.guide.url}]});
  assert.deepEqual(requested.slice(0,4),['home','feed','roundup','newsletter'].map(k=>fixture[k].url));
  assert.ok(!requested.includes(fixture.guide.url));assert.ok(!requested.includes('https://www.dosi-project.org/management/'));
  assert.equal(result.complete,false);
  for(const key of ['home','roundup','newsletter']){
    const doc=result.documents.find(d=>d.url===fixture[key].url);assert.ok(doc,key);assert.equal(doc.raw,fixture[key].body);
    assert.ok(result.responses.some(r=>r.response.body===fixture[key].body));
  }
  const round=result.documents.find(d=>d.url===fixture.roundup.url);
  const rss=round.via.find(v=>v.relationship==='rss-item');assert.ok(rss.raw.includes('<item>'));assert.equal(rss.guid,'https://www.dosi-project.org/?p=21004');
  const issue=result.documents.find(d=>d.url===fixture.newsletter.url);
  assert.ok(issue.via.some(v=>v.relationship==='newsletter-link'&&v.parent_url===fixture.roundup.url&&v.link.tag==='a'));
  assert.ok(result.coverage.some(c=>c.state==='unfetched'&&c.target==='https://www.dosi-project.org/management/'&&c.label==='Harriet Harden-Davies'));
  for(const url of [legacy.url,fixture.guide.url])assert.ok(result.pending.some(c=>c.url===url&&c.state==='deferred'&&c.reason.includes('provenance unavailable')));
  assert.ok(result.pending.some(i=>i.state==='failed')); // Saved fixture has no older article responses.
});

test('both real roundup captures retain stable URL identity, complete content and newsletter relationship',()=>{
  const docs=captures.map(c=>prepareDosiDocument({...fixture.roundup,body:c.content},{sourceURL}));
  assert.equal(docs[0].id,docs[1].id);assert.notEqual(docs[0].raw,docs[1].raw);
  for(const [i,doc] of docs.entries()){
    assert.equal(doc.raw,captures[i].content);
    assert.ok(doc.prepared.links.some(l=>l.target===fixture.newsletter.url&&l.tag==='a'));
    assert.ok(doc.prepared.text.includes('DOSI Deep-Sea Round-Up'));
  }
});

test('RSS position and metadata stay provenance; changed known content is re-fetched behind unchanged listing',async()=>{
  const urls=['https://www.dosi-project.org/source-a/','https://www.dosi-project.org/source-b/'];let listing=feed(urls),body='Original body. Later paragraph.';
  const read=async url=>url===DOSI_WEB?home([]):url.endsWith('/feed/')?listing:article(url,body);
  const first=await retrieve(read);
  listing=feed([...urls].reverse());const reordered=await retrieve(read);
  const a=first.documents.find(d=>d.url===urls[0]),b=reordered.documents.find(d=>d.url===urls[0]);
  assert.equal(a.id,b.id);assert.equal(a.raw,b.raw);assert.equal(a.prepared.text,b.prepared.text);assert.notDeepEqual(a.via,b.via);
  const unchangedListing=listing.body;body='Changed known source. Later paragraph now contains another announcement.';
  const changed=await retrieve(read,{known:first.documents});
  const newA=changed.documents.find(d=>d.url===urls[0]);assert.equal(newA.id,a.id);assert.notEqual(newA.raw,a.raw);assert.ok(newA.known);
  assert.equal(listing.body,unchangedListing);assert.ok(newA.prepared.text.includes('another announcement'));
});

test('bounded progress advances new/deferred/failed/known work and follows whole newsletter on a later run',async()=>{
  const urls=['https://www.dosi-project.org/fails/','https://www.dosi-project.org/a/','https://www.dosi-project.org/b/'];
  const issue='https://mailchi.mp/soton.ac.uk/dosi-deep-sea-roundup-new';let known=[],pending=[],progress={};
  const observed=new Set(),attempted=[];
  const read=async url=>{
    attempted.push(url);
    if(url===DOSI_WEB)return home([]);if(url.endsWith('/feed/'))return feed(urls);
    if(url===urls[0])throw new Error('HTTP 403');
    if(url===urls[1])return article(url,'Complete article.<a href="'+issue+'">Whole issue</a>');
    if(url===issue)return html(url,'<table id="bodyTable"><tr><td><h2>ALL SECTIONS</h2><p>Later complete bilingual contexte.</p></td></tr></table>');
    return article(url,'Known article B.');
  };
  for(let run=0;run<8;run++){
    const result=await retrieve(read,{known,pending,progress,limits:{documents:2,requests:4}});
    if(run===1){assert.deepEqual(result.documents.map(d=>d.url),[DOSI_WEB,issue]);assert.equal(result.progress.after_url,urls[1]);}
    for(const doc of result.documents){observed.add(doc.url);if(!known.some(k=>k.url===doc.url))known.push(doc);}
    pending=result.pending;progress=result.progress;
    assert.ok(result.requests<=4);assert.ok(result.documents.length<=2);
  }
  for(const url of [...urls.slice(1),issue])assert.ok(observed.has(url),url);
  for(const url of [...urls.slice(1),issue])assert.ok(attempted.filter(u=>u===url).length>=2,'Known source rotation: '+url);
  assert.ok(attempted.filter(u=>u===urls[0]).length>=1);
  assert.ok(pending.some(i=>i.url===urls[0]));
});

test('known article/newsletter provenance survives identity-only storage and inaccessible listings',async()=>{
  const first=await retrieve(fixtureRead);
  const result=await retrieve(async url=>url===DOSI_WEB?({...fixture.home,status:403}):fixtureRead(url),
    {known:first.documents.map(({id,url})=>({id,url})),progress:first.progress});
  assert.deepEqual(result.documents.map(d=>d.url),[fixture.roundup.url,fixture.newsletter.url]);
  assert.ok(result.documents.every(d=>d.known));
  assert.ok(result.coverage.some(c=>c.url===DOSI_WEB&&c.state==='failed'));
});

test('failed, malformed, ambiguous and unsupported responses cannot become successful documents',async()=>{
  for(const response of [{...fixture.guide,status:403},{...fixture.guide,body:'<html>truncated'},
    html(fixture.guide.url,'<p>No structural region</p>'),html(fixture.guide.url,'<div class="entry-content">A</div><div class="entry-content">B</div>'),
    {...fixture.guide,url:'https://example.org/wrong'},html(fixture.guide.url,'<link rel="canonical" href="https://www.dosi-project.org/wrong/"><div class="entry-content">A</div>')])
    assert.throws(()=>prepareDosiDocument(response,{sourceURL}));
  const url='https://www.dosi-project.org/fails/';
  const failure=await retrieve(async target=>target===DOSI_WEB?home([url]):target.endsWith('/feed/')?{...feed([]),body:'<rss>'}:({...article(target,'No'),status:403}),
    {pending:[{url,via:[{relationship:'rss-item',feed_url:fixture.feed.url,guid:url}]}]});
  assert.ok(failure.coverage.some(c=>c.relationship==='feed'&&c.state==='failed'));
  assert.ok(failure.pending.some(c=>c.url===url&&c.state==='failed'));
  const unsupported=await retrieve(async target=>target===DOSI_WEB?home(['https://www.dosi-project.org/doc.pdf','https://example.org/article']):feed([]));
  assert.equal(unsupported.documents.length,1);assert.ok(unsupported.coverage.filter(c=>c.state==='unfetched').length>=2);
});

test('request/time/quota bounds preserve deferred work and exact obtainable failed responses',async()=>{
  const url='https://www.dosi-project.org/later/',entry={url,via:[{relationship:'rss-item',feed_url:fixture.feed.url,guid:url}]};
  const bounded=await retrieve(async target=>target===DOSI_WEB?home([url]):feed([]),{pending:[entry],limits:{documents:4,requests:1}});
  assert.equal(bounded.requests,1);assert.ok(bounded.pending.some(i=>i.url===url&&i.state==='deferred'));
  const timed=await retrieve(async()=>{throw new Error('must not fetch');},{budget:{requests:0,deadline:10},now:()=>10,pending:[entry]});
  assert.equal(timed.requests,0);assert.equal(timed.pending[0].state,'deferred');
  const spent=await retrieve(async()=>{throw new Error('must not fetch');},{budget:{requests:8,deadline:Date.now()+10000},pending:[entry],progress:{after_url:url}});
  assert.equal(spent.requests,0);assert.equal(spent.progress.after_url,url);assert.equal(spent.pending[0].state,'deferred');
  const quota=await retrieve(async()=>{throw Object.assign(new Error('Quota exhausted'),{quota:true});},{known:[entry]});
  assert.equal(quota.requests,1);assert.equal(quota.pending[0].state,'deferred');
  const wrong=await retrieve(async()=>({...fixture.home,url:'https://example.org/wrong'}));
  assert.equal(wrong.documents.length,0);assert.equal(wrong.responses[0].response.body,fixture.home.body);
  await assert.rejects(retrieve(async()=>{}, {limits:{documents:0,requests:1}}),/bounds/);
});


test('observed registration/organizer relationships survive beside generic support without finding fields',()=>{
  const url='https://www.dosi-project.org/link-evidence/';
  const response=article(url,'<p>Register here: <a rel="registration" href="https://example.org/register">Book a place</a></p>'+
    '<p>Publisher details: <a rel="author" href="https://example.org/organizer">Named organizer</a></p>'+
    '<p>Background: <a href="https://example.org/context">Full context</a></p>');
  const doc=prepareDosiDocument(response,{sourceURL});
  const links=doc.prepared.links.filter(l=>l.tag==='a');
  assert.deepEqual(links.map(l=>l.relationship),['registration','organizer','support']);
  assert.deepEqual(links.map(l=>l.label),['Book a place','Named organizer','Full context']);
  assert.ok(links[0].context.includes('Register here:'));
  assert.ok(links[1].context.includes('Publisher details:'));
  assert.ok(links.every(l=>l.state==='unfetched'&&Number.isInteger(l.start)&&Number.isInteger(l.end)));
  assert.equal(doc.raw,response.body);assert.ok(doc.raw.includes('rel="registration"'));assert.ok(doc.raw.includes('rel="author"'));
  for(const key of ['kind','organization','candidate','findings','authority'])assert.equal(Object.hasOwn(doc,key),false);
});
