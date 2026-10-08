import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PUBLISHER_SOURCES, retrievePublisherDocuments } from '../collector/publisher-documents.js';
import { sourceURL } from '../collector/hsa.js';

const profile=PUBLISHER_SOURCES.find(p=>p.key==='minderoo');
const html=body=>'<html><head><title>Publisher</title></head><body><nav>Navigation</nav><main>'+body+'</main></body></html>';
const run=(read,options={})=>retrievePublisherDocuments({tracker:{collector:'web',url:profile.url},read,sourceURL,budget:{requests:0,deadline:Date.now()+10000},limits:{requests:5,documents:2,bytes:10000},...options});
const response=(url,body)=>({url,status:200,headers:{'content-type':'text/html'},body});

test('whole documents retain tables, dates and support links, with bounded detail rotation',async()=>{
  const listing=html('<h1>Updates</h1>'+['a','b','c'].map(id=>'<a href="/media/'+id+'/">'+id+'</a>').join('')+'<a href="https://example.org/media/x/">External</a>');
  const read=async url=>response(url,url===profile.url?listing:html('<h1>Full document</h1><table><tr><th>Date</th><th>Room</th></tr><tr><td>19 October 2026</td><td>Hall A</td></tr></table><p>Complete appendix.</p><a href="https://example.org/support.pdf">Support</a>'));
  const first=await run(read),second=await run(read,{progress:first.progress});
  assert.equal(first.documents.length,2);assert.equal(first.inventory.length,3);
  assert.equal(first.documents[1].url,'https://www.minderoo.org/media/a/');
  assert.equal(second.documents[1].url,'https://www.minderoo.org/media/b/');
  assert.match(first.documents[1].prepared.text,/Complete appendix/);assert.match(first.documents[1].prepared.text,/19 October 2026/);
  assert.doesNotMatch(first.documents[1].prepared.text,/Navigation/);
  assert.ok(first.coverage.some(c=>c.reason==='External/support/media link'));
});

test('failed listing still rechecks known details; redirects, truncation and ambiguous boundaries fail closed',async()=>{
  const knownDocuments=[{id:'https://www.minderoo.org/media/known/',url:'https://www.minderoo.org/media/known/'}];
  const result=await run(async url=>url===profile.url?{...response(url,html('Unavailable')),status:503}:response(url,html('<p>Changed full body</p>')),{knownDocuments});
  assert.equal(result.documents.length,1);assert.match(result.documents[0].prepared.text,/Changed full body/);
  for(const body of [html('Text').replace('</html>',''),html('Text').replace('</body>','<main>Other</main></body>')]){
    const rejected=await run(async url=>response(url,body));assert.equal(rejected.documents.length,0);
  }
  const redirected=await run(async url=>response('https://example.org/',html('Wrong publisher')));assert.equal(redirected.documents.length,0);
  const oversized=await run(async url=>response(url,html('x'.repeat(10001))));assert.equal(oversized.documents.length,0);
});

test('request and document limits prevent extra fetches and preserve retry position',async()=>{
  let calls=0;
  const result=await run(async url=>{calls++;return response(url,html('<a href="/media/a/">A</a>'));},{limits:{requests:1,documents:2,bytes:10000},progress:{after_url:'unchanged'}});
  assert.equal(calls,1);assert.equal(result.progress.after_url,'unchanged');assert.ok(result.coverage.some(c=>c.state==='deferred'));
});

test('COP17 uses the complete official conference response and guards its exact identity',async()=>{
  const p=PUBLISHER_SOURCES.find(p=>p.conference),row={_id:'69a875b3475867d4716ad6bc',code:'2026',Title:{en:'COP17'},Venue:{en:'Yerevan, Armenia'},timezone:'Asia/Yerevan',customFooter:{html:{en:'<p>Full opening ceremony information</p>'}}};
  const options={tracker:{collector:'web',url:p.url}};
  const collect=rows=>run(async url=>({...response(url,JSON.stringify(rows)),headers:{'content-type':'application/json'}}),options);
  const result=await collect([row]);assert.equal(result.documents.length,1);assert.equal(result.documents[0].raw,JSON.stringify([row]));assert.match(result.documents[0].prepared.text,/Yerevan, Armenia/);
  assert.equal((await collect([{...row,code:'2024'}])).documents.length,0);assert.equal((await collect([row,row])).documents.length,0);
});

test('programme and conference pages retain source context outside partial main containers',async()=>{
  for(const key of ['oceankind','geo-cop17']){
    const p=PUBLISHER_SOURCES.find(p=>p.key===key);
    const result=await run(async url=>response(url,html('<p>Introduction</p>').replace('</body>','<section>Programme partners and conference venue</section></body>')),{tracker:{collector:'web',url:p.url}});
    assert.match(result.documents[0].prepared.text,/Programme partners and conference venue/);
  }
});
