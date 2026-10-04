import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {PGlite} from '@electric-sql/pglite';
import {collectHSA,LIMITS} from '../collector/hsa.js';
import {prepareDocument,CHUNK_BYTES,PREPARATION_VERSION} from '../collector/octo-documents.js';
import {stepState} from '../src/runs.js';

const fixture=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/octo-webinars.json.gz',import.meta.url))));
const mp=JSON.parse(fixture.posts.body).find(p=>p.id===16281),feedURL='https://octogroup.org/feed/';
const rawMP=[...fixture.feed.body.matchAll(/<item>[\s\S]*?<\/item>/g)].find(m=>m[0].includes('?p=16281')).at(0);
const rss=items=>'<rss><channel>'+items.join('')+'</channel></rss>';
const options={trackerId:fixture.tracker.id,validate:true,documents:true,now:()=>new Date().toISOString(),makeModel:()=>{throw new Error('Document preparation must not call a model');}};
async function database(){
  const db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');
    create table auth.identities(user_id uuid,provider text,identity_data jsonb);
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;`);
  for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
  await db.query('insert into scout.trackers(id,name,url,collector,cadence,enabled) values($1,$2,$3,$4,$5,false)',[fixture.tracker.id,fixture.tracker.name,fixture.tracker.url,'web','7 days']);
  return db;
}
function transport(posts=[mp],feed=rss([rawMP])){
  const requests=[];
  return {requests,read:async(url,budget)=>{budget.requests++;requests.push(url);const post=posts.find(p=>url.endsWith('/'+p.id));if(url!==feedURL&&!post)throw new Error('Unprovided fixture');return{url,status:200,headers:{authorization:'do-not-store'},body:url===feedURL?feed:JSON.stringify(post)};}};
}

test('actual MPAtlas document retains substantive context and exposes preparation through restricted report references',async()=>{
  const db=await database(),source=transport();
  try{
    const run=await collectHSA(db,{...options,read:source.read});assert.equal(run.prepared,1);assert.equal(run.outcome,'partial');
    const row=(await db.query('select * from scout.evidence')).rows[0],doc=row.parsed.document,prepared=doc.prepared_versions[PREPARATION_VERSION];
    assert.match(prepared.text,/allows users to complete MPA Guide assessments and submit additional data/);
    assert.match(prepared.text,/brief tour of the portal and tips on how to register and get started/);
    assert.ok(prepared.text.length>1200);assert.equal(doc.processing.state,'pending');assert.ok(!row.parsed.kind);
    assert.equal(prepared.chunks.map(c=>prepared.text.slice(c.start,c.end)).join(''),prepared.text);
    assert.equal(source.requests.length,2);assert.equal((await db.query('select count(*)::int n from scout.records')).rows[0].n,0);
    const report=(await db.query('select report from scout.collection_runs where id=$1',[run.run_id])).rows[0].report;
    assert.equal(report.path,'octo-documents');for(const s of ['generate','validate','save'])assert.equal(stepState(report,s),'Not reached');
    assert.ok(!JSON.stringify(report).includes('do-not-store'));assert.ok(!row.content.includes('do-not-store'));
    const key=Object.keys(report.artifacts).find(k=>report.artifacts[k].kind==='preparation');assert.ok(!report.artifacts[key].data);
    const member='00000000-0000-4000-8000-000000000001';
    await db.query('insert into auth.users(id) values($1)',[member]);
    await db.query("insert into auth.identities values($1,'google',$2)",[member,{iss:'https://accounts.google.com',email_verified:true,custom_claims:{hd:'oceanagentics.com'}}]);
    await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[member]);
    assert.deepEqual((await db.query('select scout.run_artifact($1,$2) a',[run.run_id,key])).rows[0].a,prepared);
    assert.equal((await db.query('select scout.run_detail($1) d',[run.run_id])).rows[0].d.counts.prepared,1);
    await assert.rejects(db.query('select * from scout.evidence'),{code:'42501'});
    await db.query("select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false)");
    assert.equal((await db.query('select scout.run_artifact($1,$2) a',[run.run_id,key])).rows[0].a,null);
  }finally{await db.close();}
});

test('non-webinar/no-keyword articles and multiple-event articles remain intact documents without inferred record fields',async()=>{
  const db=await database();
  try{
    const posts=[{...mp,id:99,link:'https://octogroup.org/staff-letter/',title:{rendered:'Staff letter'},content:{rendered:'<p>Office furniture is arriving next week.</p>'}},
      {...mp,id:100,link:'https://octogroup.org/two-meetings/',title:{rendered:'Two meetings'},content:{rendered:'<h2>First meeting</h2><p>October 21 in room A.</p><h2>Second meeting</h2><p>October 24 in room B.</p>'}}];
    const feed=rss(posts.map(p=>`<item><guid>https://octogroup.org/?p=${p.id}</guid><link>${p.link}</link><title>${p.title.rendered}</title><category>Uncategorized</category><description>Short feed excerpt</description></item>`));
    const run=await collectHSA(db,{...options,read:transport(posts,feed).read});assert.equal(run.prepared,2);
    const rows=(await db.query('select parsed from scout.evidence order by url')).rows;
    assert.ok(rows.some(r=>r.parsed.document.prepared_versions[PREPARATION_VERSION].text.includes('Office furniture')));
    const both=rows.find(r=>r.parsed.document.id==='100').parsed.document.prepared_versions[PREPARATION_VERSION].text;assert.match(both,/First meeting/);assert.match(both,/Second meeting/);
    for(const row of rows)for(const field of ['kind','priority','organization','starts_at','event_url'])assert.ok(!Object.hasOwn(row.parsed,field));
  }finally{await db.close();}
});

test('identical successful preparation is reused, minor article changes behind an unchanged feed reprocess, and absent-feed known articles are checked',async()=>{
  const db=await database();
  try{
    const first=await collectHSA(db,{...options,read:transport().read});
    const repeat=await collectHSA(db,{...options,read:transport().read});assert.equal(repeat.reused,1);assert.deepEqual(repeat.document_ids,first.document_ids);
    assert.equal(stepState((await db.query('select report from scout.collection_runs where id=$1',[repeat.run_id])).rows[0].report,'prepare'),'Skipped');
    const moved=await collectHSA(db,{...options,read:transport([mp],rss(['<!-- Item moved within the feed. -->',rawMP])).read});
    assert.equal(moved.reused,1);assert.deepEqual(moved.document_ids,first.document_ids);
    const changed={...mp,content:{...mp.content,rendered:mp.content.rendered+'<p>Minor correction.</p>'}};
    const next=await collectHSA(db,{...options,read:transport([changed]).read});assert.equal(next.prepared,1);assert.notEqual(next.document_ids[0],first.document_ids[0]);
    const absent=transport([changed],rss([]));const known=await collectHSA(db,{...options,read:absent.read});assert.equal(known.reused,1);assert.ok(absent.requests.some(url=>url.endsWith('/16281')));
    const seen=(await db.query('select parsed from scout.evidence where id=$1',[known.document_ids[0]])).rows[0];assert.equal(seen.parsed.document.identity,'octo:post:16281');
  }finally{await db.close();}
});

test('a failed preparation retries identical captured input; failed downstream processing remains ready on an unchanged observation',async()=>{
  const db=await database();let fail=true;
  try{
    const broken={query:(sql,args)=>{if(fail&&sql.startsWith("update scout.evidence set parsed=jsonb_set(parsed,'{document}',")){fail=false;throw new Error('Injected write interruption');}return db.query(sql,args);}};
    const failed=await collectHSA(broken,{...options,read:transport().read});assert.equal(failed.failed,1);assert.equal(failed.document_ids.length,0);
    const saved=(await db.query('select * from scout.evidence')).rows[0];assert.equal(saved.parsed.document.preparation.state,'failed');
    const recovered=await collectHSA(db,{...options,read:transport().read});assert.equal(recovered.prepared,1);assert.equal(recovered.document_ids[0],saved.id);
    await db.query("update scout.evidence set parsed=jsonb_set(parsed,'{document,processing,state}','\"failed\"') where id=$1",[saved.id]);
    const pending=await collectHSA(db,{...options,read:transport().read});assert.equal(pending.reused,1);assert.deepEqual(pending.document_ids,[saved.id]);
    assert.equal((await db.query('select parsed from scout.evidence where id=$1',[saved.id])).rows[0].parsed.document.processing.state,'failed');
  }finally{await db.close();}
});

for(const mode of ['failed','limited','invalid','oversized'])test('linked article '+mode+' leaves inspectable feed-only context',async()=>{
  const db=await database();
  try{
    const read=async(url,budget)=>{budget.requests++;if(url===feedURL){if(mode==='limited')budget.requests=LIMITS.requests;return{url,status:200,body:rss([rawMP])};}
      if(mode==='failed')throw new Error('Injected failure');return{url,status:200,body:mode==='oversized'?'X'.repeat(LIMITS.bytes+1):'Invalid article JSON'};};
    const run=await collectHSA(db,{...options,read});assert.equal(run.feed_only,1);assert.equal(run.document_ids.length,1);
    const row=(await db.query('select * from scout.evidence')).rows[0],prepared=row.parsed.document.prepared_versions[PREPARATION_VERSION];assert.equal(prepared.input,'feed-only');assert.match(prepared.text,/MPAtlas Assessment Portal/);
    const report=(await db.query('select report from scout.collection_runs where id=$1',[run.run_id])).rows[0].report;
    assert.ok(Object.values(report.operations).some(o=>o.step==='prepare'&&/Feed-only/.test(o.note)));
    if(mode==='invalid')assert.ok(row.content.includes('Invalid article JSON'));
    if(mode==='limited')assert.ok(Object.values(report.operations).some(o=>o.step==='fetch'&&o.state==='skipped'));
    assert.ok(run.requests<=LIMITS.requests);
  }finally{await db.close();}
});

test('structural preparation preserves context, tables, captions, dates, links and all long text with traceable bounded chunks',()=>{
  const html='<nav>Menu only</nav><h1>Main heading</h1><h2>Context heading</h2><p>'+('Long sentence with 🐳 context. '.repeat(400))+'</p><table><caption>Schedule caption</caption><tr><th>Date</th><th>Session</th></tr><tr><td>October 22</td><td>First and second sessions</td></tr></table><p>Register <a href="/registration">here</a><script>malicious()</script></p>';
  const prepared=prepareDocument({title:'Title &amp; context',html,url:mp.link});
  assert.equal(prepared.title,'Title & context');assert.match(prepared.text,/Schedule caption\nDate\tSession/);assert.match(prepared.text,/October 22/);assert.match(prepared.text,/here <https:\/\/octogroup.org\/registration>/);
  assert.ok(!/Menu only|malicious/.test(prepared.text));assert.equal(prepared.omissions.length,2);
  assert.equal(prepared.chunks.map(c=>prepared.text.slice(c.start,c.end)).join(''),prepared.text);assert.ok(prepared.chunks.length>2);
  for(const c of prepared.chunks)assert.ok(Buffer.byteLength(prepared.text.slice(c.start,c.end))<=CHUNK_BYTES);
  assert.ok(prepared.chunks.slice(1).some(c=>c.context_block_ids.length&&c.preceding_context));
  for(const b of prepared.blocks)assert.ok(html.slice(b.html_start,b.html_end).includes('<'+b.tag));
  assert.equal(prepared.links[0].state,'unfetched');
  const nested=prepareDocument({title:'Nested content',url:mp.link,html:'<blockquote><p>First paragraph</p><p>Second paragraph</p></blockquote><ul><li><p>First item paragraph</p><p>Second item paragraph</p></li></ul><table><tr><td><div>First cell line</div><div>Second cell line</div></td></tr></table>'});
  assert.match(nested.text,/First paragraph\nSecond paragraph/);assert.match(nested.text,/First item paragraph\nSecond item paragraph/);assert.match(nested.text,/First cell line\nSecond cell line/);
});

test('feed outage and malformed RSS still recheck known articles with inspectable coverage failures',async()=>{
  const db=await database();
  try{
    const first=await collectHSA(db,{...options,read:transport().read});
    for(const malformed of [false,true]){
      const source=transport();
      const run=await collectHSA(db,{...options,read:async(url,budget)=>{
        if(url!==feedURL)return source.read(url,budget);
        budget.requests++;if(!malformed)throw new Error('Injected feed outage');return{url,status:200,body:'<rss><channel>'};
      }});
      assert.equal(run.failed,1);assert.equal(run.reused,1);assert.deepEqual(run.document_ids,first.document_ids);
      assert.ok(source.requests.some(url=>url.endsWith('/16281')));
      const report=(await db.query('select report from scout.collection_runs where id=$1',[run.run_id])).rows[0].report;
      assert.equal(stepState(report,malformed?'prepare':'fetch'),malformed?'Fail':'Fail · mixed outcomes');
      assert.ok(Object.values(report.artifacts).some(a=>a.kind==='coverage'&&a.data.documents.some(d=>d.reused)));
    }
  }finally{await db.close();}
});

test('retrieval bounds disclose omitted and invalid identities, then check previously deferred articles',async()=>{
  const db=await database();
  const posts=Array.from({length:25},(_,i)=>({...mp,id:20000+i,link:'https://octogroup.org/document-'+i+'/'}));
  const entries=posts.map(p=>'<item><guid>https://octogroup.org/?p='+p.id+'</guid><link>'+p.link+'</link><title>Document</title><description>Full feed context.</description></item>');
  const duplicate='<item><guid>https://octogroup.org/?p=30000</guid><link>https://octogroup.org/duplicate/</link><description>Ambiguous identity</description></item>';
  const feed=rss([...entries,duplicate,duplicate,'<item><link>https://octogroup.org/no-guid/</link></item>']);
  try{
    const source=transport(posts,feed),first=await collectHSA(db,{...options,read:source.read});
    assert.equal(first.requests,24);assert.equal(first.prepared,23);assert.equal(first.unfetched,5);
    const report=(await db.query('select report from scout.collection_runs where id=$1',[first.run_id])).rows[0].report;
    const [key,artifact]=Object.entries(report.artifacts).find(([,a])=>a.title==='Document outcomes');
    assert.equal(artifact.data.documents.filter(d=>d.reason==='Article count bound').length,2);
    assert.ok(Object.values(report.operations).some(o=>o.artifacts?.includes(key)));
    const next=transport(posts,feed),second=await collectHSA(db,{...options,read:next.read});
    assert.equal(second.requests,24);assert.equal(second.prepared,2);assert.equal(second.reused,21);
    assert.ok(next.requests.includes('https://octogroup.org/wp-json/wp/v2/posts/20023'));
    assert.ok(next.requests.includes('https://octogroup.org/wp-json/wp/v2/posts/20024'));
    assert.equal((await db.query('select count(*)::int n from scout.evidence')).rows[0].n,25);
  }finally{await db.close();}
});

test('document route rejects other trackers and assessment modes before source or model work',async()=>{
  const db=await database();let reads=0;
  try{
    for(const override of [{validate:false},{documents:'true'},{assessOnly:true,sourceId:fixture.tracker.id}]){
      await assert.rejects(()=>collectHSA(db,{...options,...override,read:async()=>{reads++;}}),{status:400});
    }
    await db.query("update scout.trackers set url='https://example.org/' where id=$1",[fixture.tracker.id]);
    await assert.rejects(()=>collectHSA(db,{...options,read:async()=>{reads++;}}),{status:400});
    assert.equal(reads,0);assert.equal((await db.query('select count(*)::int n from scout.collection_runs')).rows[0].n,0);
  }finally{await db.close();}
});
