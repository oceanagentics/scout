import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { parseDocument, DomUtils } from 'htmlparser2';
import { sourceURL } from '../collector/hsa.js';
import { UNTC, prepareUntcDocument, retrieveUntcDocuments } from '../collector/untc-documents.js';

const fixture=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/un-treaty.json.gz',import.meta.url))));
const response={...fixture.html,status:200,headers:{'content-type':'text/html; charset=utf-8'}};
const tracker={collector:'web',url:UNTC};
const prepare=source=>prepareUntcDocument(source,{sourceURL});
const retrieve=(read,options={})=>retrieveUntcDocuments({tracker,read,sourceURL,budget:{requests:0,deadline:Date.now()+10000},...options});
const norm=value=>value.replace(/\s+/g,' ').trim();
const page=(rows=['<tr><td>Opaque participant</td><td>Source date string</td><td>Uninterpreted symbol</td></tr>'],note='Full source footnote.',declaration='Complete declaration context.')=>({url:UNTC,status:200,headers:{'content-type':'text/html'},body:'<html><body><table class="contenttable"><tr><td><h1>Whole source context</h1>'+
  '<table id="source_tblgrid"><tr class="thead-one"><td>Participant</td><td>Signature</td><td>Source action label</td></tr>'+rows.join('')+'</table>'+
  '<table id="source_dgDec"><tr><td>'+declaration+'</td></tr></table>'+
  '<table id="source_dgNotesAll"><tr><td><a name="1">1</a>'+note+'</td></tr></table>'+
  '<a href="#1">1</a><a href="/doc/declaration.pdf">Linked declaration</a><a rel="author" href="https://example.org/publisher">Publisher reference</a>'+
  '</td></tr></table></body></html>'});

const sourceDom=parseDocument(response.body,{withStartIndices:true,withEndIndices:true});
const grid=DomUtils.getElementsByTagName('table',sourceDom.children).find(n=>n.attribs.id?.endsWith('_tblgrid'));
const notes=DomUtils.getElementsByTagName('table',sourceDom.children).find(n=>n.attribs.id?.endsWith('_dgNotesAll'));
const declarations=DomUtils.getElementsByTagName('table',sourceDom.children).find(n=>n.attribs.id?.endsWith('_dgDec'));

test('saved source preserves complete table cells, footnotes, inline declarations and surrounding context',()=>{
  const doc=prepare(response);assert.equal(doc.raw,fixture.html.body);assert.equal(doc.prepared.input,'whole-treaty-detail');
  assert.ok(doc.prepared.text.length>70000);assert.equal(doc.prepared.chunks.map(c=>doc.prepared.text.slice(c.start,c.end)).join(''),doc.prepared.text);
  const tableText=norm(doc.prepared.text.replace(/ <[^>]+>/g,'')); // Ignore appended link targets when comparing literal cells.
  for(const cell of DomUtils.getElementsByTagName('td',grid.children)){
    const text=norm(DomUtils.textContent(cell));if(text)assert.ok(tableText.includes(text),text);
  }
  assert.ok(tableText.includes(norm(DomUtils.textContent(notes))));
  const stack=[declarations];let textCount=0;
  while(stack.length){const n=stack.pop();if(['script','style'].includes(n.name))continue;
    if(n.type==='text'&&norm(n.data).length>40){assert.ok(norm(doc.prepared.text).includes(norm(n.data)),norm(n.data).slice(0,100));textCount++;}
    stack.push(...n.children??[]);
  }
  assert.ok(textCount>30);
  assert.ok(doc.prepared.text.includes('Marine Biological Diversity of Areas beyond National Jurisdiction'));
  assert.ok(doc.prepared.text.includes('Territorial exclusion in respect of the Faroe Islands and Greenland'));
  assert.ok(doc.prepared.blocks[0].table_context.includes('Participant\tSignature\tRatification, Accession(a), Acceptance(A), Approval(AA)'));
  for(const key of ['participants','country','action','date','status','kind','findings','candidate','organization'])assert.equal(Object.hasOwn(doc,key),false);
});

test('one real saved response reaches preparation intact; annex/XML/copies/archives stay explicitly unfetched',async()=>{
  let calls=0;
  const result=await retrieve(async(url,budget)=>{calls++;budget.requests++;assert.equal(url,sourceURL(UNTC));return response;});
  assert.equal(calls,1);assert.equal(result.requests,1);assert.equal(result.documents.length,1);assert.equal(result.complete,false);
  assert.equal(result.responses[0].response.body,fixture.html.body);
  assert.ok(result.documents[0].coverage.some(c=>c.relationship==='same-document-anchor'&&c.state==='retained'));
  assert.ok(result.coverage.some(c=>c.target?.includes('.pdf')&&c.state==='unsupported'));
  assert.ok(result.coverage.some(c=>c.relationship==='scope'&&c.reason.includes('XML')));
  assert.ok(result.coverage.some(c=>c.state==='unsupported'&&c.reason.includes('not executed')));
  assert.ok(fixture.xml.body.length>70000); // Supplied alternate XML is not silently substituted for the page.
});

test('repeat/query ordering leaves identity/raw/preparation stable; changed rows and footnotes retain one document identity',()=>{
  const original=page(['<tr><td>A</td><td>Unknown date</td><td>Unknown action</td></tr>','<tr><td>B</td><td>Other date</td><td>Other action</td></tr>']);
  const a=prepare(original),b=prepare({...original,url:sourceURL(UNTC)});
  assert.equal(a.id,b.id);assert.equal(a.raw,b.raw);assert.deepEqual(a.prepared,b.prepared);
  const rows=DomUtils.getElementsByTagName('tr',DomUtils.getElementsByTagName('table',parseDocument(original.body).children).find(n=>n.attribs.id==='source_tblgrid').children).slice(1).map(n=>DomUtils.getOuterHTML(n));
  const reordered=prepare(page([...rows].reverse()));assert.equal(reordered.id,a.id);assert.notEqual(reordered.raw,a.raw);
  assert.ok(reordered.prepared.text.indexOf('B\t')<reordered.prepared.text.indexOf('A\t'));
  const changed=prepare(page(rows,'Corrected source footnote with additional context.'));
  assert.equal(changed.id,a.id);assert.notEqual(changed.raw,a.raw);assert.ok(changed.prepared.text.includes('Corrected source footnote'));
  assert.equal(Object.hasOwn(changed,'findings'),false);
});

test('source dates/symbols/topic labels are not eligibility or scripted row facts; later and unknown content stays intact',()=>{
  const source=page(['<tr><td>Unrelated label</td><td>No date interpretation</td><td>?</td></tr>'],'Contexte complet français.','Long declaration. '.repeat(1000)+'Final annex context.');
  source.body=source.body.replace('Source action label','Arbitrary returned header');
  const doc=prepare(source);assert.ok(doc.prepared.text.includes('No date interpretation'));assert.ok(doc.prepared.text.includes('Final annex context.'));
  assert.ok(doc.prepared.text.includes('Contexte complet français.'));assert.ok(doc.prepared.blocks[0].table_context.includes('Arbitrary returned header'));
  assert.equal(doc.id,'untc:XXI-10:detail');assert.equal(doc.prepared.title,'');
});

test('common observed relationships and original hyperlinks survive; no authority or finding fields are inferred',()=>{
  const doc=prepare(page());
  assert.ok(doc.prepared.links.some(l=>l.tag==='a'&&l.relationship==='organizer'&&l.target==='https://example.org/publisher'));
  assert.ok(doc.prepared.links.some(l=>l.target.endsWith('#1')));
  assert.ok(doc.coverage.some(c=>c.relationship==='same-document-anchor'&&c.state==='retained'));
  assert.equal(Object.hasOwn(doc,'authority'),false);assert.equal(Object.hasOwn(doc,'candidate'),false);
});

test('missing/ambiguous tables, header and footnote references, truncated or failed sources are rejected with raw evidence retained',async()=>{
  const valid=page();
  const bad=[{...valid,status:403},{...valid,headers:{'content-type':'application/xml'}},{...valid,body:valid.body.slice(0,-7)},
    {...valid,body:valid.body.replace('source_tblgrid','wrong_grid')},{...valid,body:valid.body.replace('thead-one','unknown-header')},
    {...valid,body:valid.body.replace('name="1"','name="2"')},{...valid,body:valid.body.replace('source_dgNotesAll','wrong_notes')},
    {...valid,body:valid.body.replace('</body>','<table class="contenttable"><tr><td>Other root</td></tr></table></body>')},
    {...valid,body:valid.body.replace('</td></tr></table></body>','<table id="duplicate_tblgrid"><tr class="thead-one"><td>Other</td></tr></table></td></tr></table></body>')},
    {...valid,url:UNTC.replace('XXI-10','XXI-9')}];
  for(const source of bad){assert.throws(()=>prepare(source));const result=await retrieve(async()=>source);
    assert.equal(result.documents.length,0);assert.equal(result.responses[0].response.body,source.body);assert.ok(result.coverage.some(c=>c.state==='failed'));}
  const failure=await retrieve(async()=>{throw new Error('HTTP 403');});assert.equal(failure.documents.length,0);assert.equal(failure.responses.length,1);
  assert.equal(failure.responses[0].response,undefined);assert.equal(failure.responses[0].reason,'HTTP 403');assert.ok(failure.coverage.some(c=>c.state==='failed'));
});

test('request/deadline/quota bounds disclose deferral without extra fetches or hidden alternate source fallback',async()=>{
  for(const options of [{limits:{requests:0}},{budget:{requests:0,deadline:10},now:()=>10}]){
    const result=await retrieve(async()=>{throw new Error('must not fetch');},options);
    assert.equal(result.requests,0);assert.equal(result.inventory[0].state,'deferred');assert.equal(result.complete,false);
  }
  const quota=await retrieve(async()=>{throw Object.assign(new Error('Quota exhausted'),{quota:true});});assert.equal(quota.requests,1);assert.equal(quota.inventory[0].state,'deferred');
  await assert.rejects(retrieve(async()=>response,{limits:{requests:-1}}),/bound/);
});

test('native shared handoffs preserve one whole document; repair/failure state survives repeated deferral and recovery',async()=>{
  const native={id:'untc:XXI-10:detail',url:UNTC},expected=prepare(response);
  for(const key of ['known','knownDocuments','pending']){
    const result=await retrieve(async()=>response,{[key]:[{...native,state:'model-pending'}]});
    assert.deepEqual(result.documents,[expected]);assert.deepEqual(result.pending,[]);assert.equal(result.requests,1);
  }
  let result=await retrieve(async()=>{throw new Error('Retained local outage');},{knownDocuments:[native],pending:[{...native,state:'model-repair'}]});
  const carried=structuredClone(result.pending);
  for(let cycle=0;cycle<40;cycle++){
    result=await retrieve(async()=>assert.fail('deferred source must not read'),{known:[native],pending:result.pending,limits:{requests:0}});
    assert.equal(result.requests,0);assert.equal(result.pending.length,1);assert.equal(result.pending[0].pending_state,'model-repair');
    assert.deepEqual(result.pending[0].last_failure,carried[0].last_failure);assert.deepEqual(result.pending[0].ids,[native.id]);assert.deepEqual(result.pending[0].urls,[sourceURL(UNTC)]);
  }
  result=await retrieve(async()=>response,{pending:result.pending});assert.deepEqual(result.documents,[expected]);assert.deepEqual(result.pending,[]);
  assert.equal(result.inventory[0].last_failure,undefined);assert.equal(result.progress,undefined);
});

test('conflicting native IDs, URLs and aliases stay unresolved across retries without acquiring support or alternate treaty sources',async()=>{
  const native={id:'untc:XXI-10:detail',url:UNTC};
  for(const conflict of [{...native,id:'untc:XXI-9:detail'},{...native,identity:'untc:XXI-9:detail'},
    {...native,url:UNTC.replace('XXI-10','XXI-9')},{...native,url:'https://treaties.un.org/doc/declaration.pdf'},{...native,url:'javascript:void(0)'}]){
    let result=await retrieve(async()=>assert.fail('identity conflict must not read'),{knownDocuments:[native],pending:[conflict]});
    assert.equal(result.requests,0);assert.equal(result.documents.length,0);assert.equal(result.responses.length,0);assert.equal(result.pending[0].state,'failed');
    const carried=structuredClone(result.pending);
    for(let cycle=0;cycle<10;cycle++){
      result=await retrieve(async()=>assert.fail('conflict must remain held'),{known:[native],pending:result.pending});assert.deepEqual(result.pending,carried);
    }
  }
});

test('shared request allowance counts actual reads once, retains redirect charges and records failed attempts',async()=>{
  for(const options of [{budget:{requests:1,deadline:Date.now()+10000}},{limits:{requests:1,documents:0}}]){
    const result=await retrieve(async()=>assert.fail('shared/document bound must not read'),options);
    assert.equal(result.requests,0);assert.equal(result.responses.length,0);assert.equal(result.inventory[0].state,'deferred');
  }
  for(const charge of [0,1,2])for(const failed of [false,true]){
    const budget={requests:1,deadline:Date.now()+10000};
    const result=await retrieve(async(url,shared)=>{assert.equal(url,sourceURL(UNTC));shared.requests+=charge;if(failed)throw new Error('Local read failure');return response;},{budget,limits:{requests:3}});
    assert.equal(result.requests,1);assert.equal(budget.requests,1+Math.max(1,charge));assert.equal(result.responses.length,1);
    assert.equal(result.documents.length,failed?0:1);assert.equal(result.responses[0].state,failed?'failed':'fetched');
  }
  const budget={requests:0,deadline:Date.now()+10000};
  const over=await retrieve(async(url,shared)=>{shared.requests+=2;return response;},{budget});
  assert.equal(budget.requests,2);assert.equal(over.documents.length,0);assert.equal(over.pending[0].state,'deferred');assert.deepEqual(over.responses[0].response,response);
});

test('UTF8 byte and actual deadline bounds retain exact rejected receipts; invalid bounds never read',async()=>{
  const source=page(undefined,'Multibyte source note: é漢🌊.');
  const oversized=await retrieve(async()=>source,{limits:{requests:1,bytes:source.body.length}});
  assert.equal(oversized.documents.length,0);assert.equal(oversized.pending[0].state,'failed');assert.match(oversized.pending[0].reason,/byte/);assert.deepEqual(oversized.responses[0].response,source);
  assert.equal((await retrieve(async()=>source,{limits:{requests:1,bytes:Buffer.byteLength(source.body)}})).documents.length,1);
  for(const stage of ['read','prepare']){
    let clock=0,calls=0;
    const result=await retrieve(async()=>{if(stage==='read')clock=10;return source;},{budget:{requests:0,deadline:10},now:()=>stage==='prepare'&&++calls>=3?10:clock});
    assert.equal(result.documents.length,0);assert.equal(result.pending[0].state,'deferred');assert.equal(result.responses[0].state,'deferred');assert.deepEqual(result.responses[0].response,source);
  }
  for(const limits of [{requests:1.5},{requests:Number.MAX_SAFE_INTEGER+1},{requests:NaN},{requests:1,bytes:0},{requests:1,bytes:Infinity},{requests:1,documents:-1}])
    await assert.rejects(retrieve(async()=>assert.fail('invalid bound must not read'),{limits}),/bound/);
});
