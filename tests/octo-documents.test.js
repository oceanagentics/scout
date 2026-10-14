import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareDocument,CHUNK_BYTES} from '../collector/octo-documents.js';

test('rotating protected-contact tokens do not reset supporting source text, while ordinary links remain literal',()=>{
  const url='https://example.org/event',html=token=>'<p>The conference is on June 16-18.</p><p>Contact <a href="/cdn-cgi/l/email-protection#'+token+'"><span class="__cf_email__" data-cfemail="'+token+'">[email protected]</span></a></p><p><a href="/registration">Register</a></p><a href="/cdn-cgi/l/email-protection#aabb">Ordinary link</a>';
  const a=prepareDocument({title:'Event',url,html:html('aabb'),protectedContacts:true}),b=prepareDocument({title:'Event',url,html:html('ccdd'),protectedContacts:true});
  assert.equal(a.text,b.text);assert.ok(a.text.includes('[email protected]'));
  assert.ok(a.text.includes('Register <https://example.org/registration>'));assert.ok(a.text.includes('Ordinary link <https://example.org/cdn-cgi/l/email-protection#aabb>'));
  assert.equal(a.omissions.filter(o=>o.reason.startsWith('Opaque protected-contact')).length,1);
  assert.notEqual(prepareDocument({title:'Event',url,html:html('aabb')}).text,prepareDocument({title:'Event',url,html:html('ccdd')}).text);
});
test('public Qualtrics registration text is retained without executing its script or borrowing session metadata',()=>{
  const url='https://ust.az1.qualtrics.com/jfe/form/SV_abmNabFBNGk2meW';
  const text='Please fill out this form if you wish to join the MOCSI/CliMetS thematic session @2026 IDSSD Global Conference online. We will share the meeting link in due course.';
  const payload={init:{appData:{setup:{survey:{id:'SV_abmNabFBNGk2meW'},session:{date:'2055-01-01'}},page:{content:{questions:[{id:'QID3',type:'db',display:text}],responses:{email:'private-fixture'}}},session:{token:'session-fixture'}}}};
  const html='<html><script>q=JSON.parse(decodeURIComponent('+JSON.stringify(encodeURIComponent(JSON.stringify(payload)))+'));throw new Error("must not execute");</script></html>';
  const prepared=prepareDocument({title:'',url,html});
  assert.ok(prepared.text.includes(text));assert.ok(prepared.text.includes('SV_abmNabFBNGk2meW'));
  for(const excluded of ['2055-01-01','private-fixture','session-fixture','must not execute'])assert.ok(!prepared.text.includes(excluded));
  assert.equal(prepared.chunks.map(c=>prepared.text.slice(c.start,c.end)).join(''),prepared.text);
  assert.throws(()=>prepareDocument({title:'',url:url.replace('SV_abmNabFBNGk2meW','SV_other'),html}),/no readable body/);
  assert.throws(()=>prepareDocument({title:'',url:'https://example.org/form/SV_abmNabFBNGk2meW',html}),/no readable body/);
});
test('structural preparation preserves context, tables, captions, dates, links and all long text with traceable bounded chunks',()=>{
  const html='<nav>Menu only</nav><h1>Main heading</h1><h2>Context heading</h2><p>'+('Long sentence with 🐳 context. '.repeat(400))+'</p><table><caption>Schedule caption</caption><tr><th>Date</th><th>Session</th></tr><tr><td>October 22</td><td>First and second sessions</td></tr></table><p>Register <a href="/registration">here</a><script>malicious()</script></p>';
  const prepared=prepareDocument({title:'Title &amp; context',html,url:'https://octogroup.org/webinar'});
  assert.equal(prepared.title,'Title & context');assert.match(prepared.text,/Schedule caption\nDate\tSession/);assert.match(prepared.text,/October 22/);assert.match(prepared.text,/here <https:\/\/octogroup.org\/registration>/);
  assert.ok(!/Menu only|malicious/.test(prepared.text));assert.equal(prepared.omissions.length,2);
  assert.equal(prepared.chunks.map(c=>prepared.text.slice(c.start,c.end)).join(''),prepared.text);assert.ok(prepared.chunks.length>2);
  for(const c of prepared.chunks)assert.ok(Buffer.byteLength(prepared.text.slice(c.start,c.end))<=CHUNK_BYTES);
  assert.ok(prepared.chunks.slice(1).some(c=>c.context_block_ids.length&&c.preceding_context));
  for(const b of prepared.blocks)assert.ok(html.slice(b.html_start,b.html_end).includes('<'+b.tag));
  assert.equal(prepared.links[0].state,'unfetched');
  const nested=prepareDocument({title:'Nested content',url:'https://octogroup.org/webinar',html:'<blockquote><p>First paragraph</p><p>Second paragraph</p></blockquote><ul><li><p>First item paragraph</p><p>Second item paragraph</p></li></ul><table><tr><td><div>First cell line</div><div>Second cell line</div></td></tr></table>'});
  assert.match(nested.text,/First paragraph\nSecond paragraph/);assert.match(nested.text,/First item paragraph\nSecond item paragraph/);assert.match(nested.text,/First cell line\nSecond cell line/);
});
