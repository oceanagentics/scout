import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { parseDocument, DomUtils } from 'htmlparser2';
import { startReport } from './report.js';
import { processDocument } from './document-records.js';

const digest = text => createHash('sha256').update(text).digest('hex');
const FEED = 'https://octogroup.org/feed/';
export const PREPARATION_VERSION = 'octo-documents-v3';
export const CHUNK_BYTES = 4000; // Source text only; the future model stage must bound its entire request.
const framing = new Set(['head','script','style','nav','noscript','template']);
const blocks = new Set(['p','h1','h2','h3','h4','h5','h6','li','blockquote','pre','table','figcaption']);

// No finding fields or relevance rules. Ranges use UTF-16 offsets into the
// retained HTML and prepared text; chunks reference context rather than omit it.
export function prepareDocument({title,html,url}) {
  const dom=parseDocument(html,{withStartIndices:true,withEndIndices:true});
  const result={version:PREPARATION_VERSION,title:DomUtils.textContent(parseDocument(title)),url,text:'',blocks:[],links:[],omissions:[],chunks:[],chunk_bytes:CHUNK_BYTES};
  const headings=[];
  function render(node) {
    if(framing.has(node.name)){result.omissions.push({start:node.startIndex,end:node.endIndex+1,reason:'Removed '+node.name+' framing'});return '';}
    if(node.type==='text')return node.data;
    let value=(node.children??[]).map(render).join('');
    if(node.name==='a'||node.name==='img'||node.name==='iframe') {
      const raw=node.attribs?.href??node.attribs?.src;
      if(raw){let target;try{target=new URL(raw,url).href;}catch{target=raw;}
        const label=value||node.attribs.alt||node.attribs.title||target;
        const context=DomUtils.textContent(node.parent??node).trim();
        const relationship=node.name==='a'&&(/\bregistration\b/.test(node.attribs.rel??'')||/^(?:register|registration)\b/i.test(context))?'registration':
          node.name==='a'&&(/\bauthor\b/.test(node.attribs.rel??'')||/^(?:organizer|organiser|official event)\b/i.test(context))?'organizer':'support';
        result.links.push({label,target,tag:node.name,relationship,context,start:node.startIndex,end:node.endIndex+1,state:'unfetched'});
        value=label+' <'+target+'>';
      }
    }
    if(blocks.has(node.name)||['br','tr','caption','div','section','article','ul','ol','dl','dt','dd','figure'].includes(node.name))value+='\n';
    if(node.name==='td'||node.name==='th')value+='\t';
    return value;
  }
  function walk(node) {
    if(framing.has(node.name)) {render(node);return;}
    if(blocks.has(node.name)||node.type==='text'&&node.data.trim()||['a','img','iframe'].includes(node.name)) {
      const text=render(node).replace(/[ \r\f\v]+/g,' ').replace(/ *\n */g,'\n').trim();
      if(!text)return;
      const level=/^h[1-6]$/.test(node.name)?+node.name[1]:null;
      if(level)headings.splice(level-1);
      const id=result.blocks.length;
      result.blocks.push({id,tag:node.name??'text',html_start:node.startIndex,html_end:node.endIndex+1,headings:headings.filter(x=>x!=null),text});
      if(node.name==='table')result.blocks.at(-1).table_context=DomUtils.findAll(n=>n.name==='caption'||n.name==='tr'&&DomUtils.getElementsByTagName('th',n.children).length,node.children)
        .map(n=>(n.name==='caption'?[n]:DomUtils.getElementsByTagName('th',n.children)).map(cell=>DomUtils.textContent(cell).replace(/\s+/g,' ').trim()).join('\t')).join('\n');
      if(level)headings[level-1]=id;
    }else for(const child of node.children??[])walk(child);
  }
  walk(dom);
  // Structural payloads, not scripted record fields. Never execute page JavaScript.
  const structured=DomUtils.getElementsByTagName('script',dom.children).filter(n=>n.attribs.type==='application/ld+json').map(n=>({label:'JSON-LD',body:DomUtils.textContent(n)}));
  if(/(^|\.)zoom\.us$/.test(new URL(url).hostname)){
    const raw=html.match(/\bregisterVO:(\{[^\n]+\}),\s*\n/)?.[1];
    if(raw){
      const data=JSON.parse(raw),keys=['uuid','meetingVO','recurringRegType','timezoneVO','shareVO','viewerEmail','recordVO','registrationTitle','fee'];
      const retained=Object.fromEntries(keys.filter(k=>Object.hasOwn(data,k)).map(k=>[k,data[k]]));
      if(retained.timezoneVO){retained.timezoneVO={...retained.timezoneVO};delete retained.timezoneVO.timezones;}
      structured.push({label:'Zoom registration payload',body:JSON.stringify(retained)});
      result.omissions.push({reason:'Zoom UI/auth/tracking configuration and timezone selection catalogue excluded; registration payload retained; full response captured.'});
    }
  }
  for(const data of structured){
    try{const value=JSON.parse(data.body);result.blocks.push({id:result.blocks.length,tag:'structured-data',headings:[],text:data.label+'\n'+JSON.stringify(value,null,2)});}
    catch{result.omissions.push({reason:'Malformed '+data.label+' could not be prepared; raw response retained.'});}
  }
  if(!result.blocks.length)throw new Error('Document has no readable body');
  for(const block of result.blocks){
    if(result.text)result.text+='\n\n';
    block.start=result.text.length;result.text+=block.text;block.end=result.text.length;delete block.text;
  }
  for(let start=0;start<result.text.length;){
    let end=start,bytes=0;
    for(const char of result.text.slice(start)){if(bytes+Buffer.byteLength(char)>CHUNK_BYTES)break;bytes+=Buffer.byteLength(char);end+=char.length;}
    if(end<result.text.length){
      const boundary=result.blocks.filter(b=>b.end>start&&b.end<=end).at(-1)?.end;
      const part=result.text.slice(start,end);
      const sentence=[...part.matchAll(/[.!?]\s+/g)].at(-1)??[...part.matchAll(/\s+/g)].at(-1);
      end=boundary??(sentence?.index>0?start+sentence.index+sentence[0].length:end);
    }
    const included=result.blocks.filter(b=>b.end>start&&b.start<end);
    let contextStart=Math.max(0,start-256);
    if(/[\uDC00-\uDFFF]/.test(result.text[contextStart]??''))contextStart--;
    result.chunks.push({start,end,block_ids:included.map(b=>b.id),context_block_ids:[...new Set(included.flatMap(b=>b.headings))],
      preceding_context:start?[contextStart,start]:null});
    start=end;
  }
  return result;
}

function feedItems(body) {
  if(!/<\/rss>\s*$/i.test(body))throw new Error('Incomplete RSS document');
  const dom=parseDocument(body,{xmlMode:true,withStartIndices:true,withEndIndices:true});
  const channel=DomUtils.getElementsByTagName('channel',dom.children)[0];
  if(!channel)throw new Error('RSS channel unavailable');
  return (channel.children??[]).filter(n=>n.name==='item').map(node=>{
    const field=name=>DomUtils.textContent(node.children.find(c=>c.name===name)??{children:[]}).trim();
    const raw=body.slice(node.startIndex,node.endIndex+1),guid=field('guid');
    const id=guid.match(/^https:\/\/octogroup\.org\/\?p=(\d+)$/)?.[1],url=field('link');
    let validURL=false;try{const u=new URL(url);validURL=u.origin==='https://octogroup.org'&&!u.username&&!u.password;}catch{}
    return {id,url,title:field('title'),published:field('pubDate'),description:field('content:encoded')||field('description'),raw,
      ...(id&&validURL?{}:{error:'Unfetchable feed identity or URL'}),offsets:[node.startIndex,node.endIndex+1]};
  });
}

// One hop from retained primary links: three destinations/article, six/run.
// Registration/organizer relationships are link metadata, never arrival order.
export async function supportDocuments(db,{source,prepared,read,sourceURL,budget,limits,trace,cache}){
  const links=new Map(),coverage=[],documents=[{id:'P',capture_id:source.id,hash:source.content_hash,url:prepared.url,relationship:'primary',prepared}];
  for(const link of prepared.links){
    let url;try{url=sourceURL(link.target);}catch{coverage.push({...link,state:'unsupported',reason:'Public HTTPS document URL required'});continue;}
    if(link.tag!=='a'||/\.(?:pdf|png|jpe?g|gif|webp|mp4|mp3|zip)(?:$|\?)/i.test(url)){coverage.push({...link,url,state:'unsupported',reason:'Only linked HTML/text/JSON documents in this one-hop pass'});continue;}
    if(url===sourceURL(prepared.url)){coverage.push({...link,url,state:'skipped',reason:'Primary document already retained'});continue;}
    const prior=links.get(url);
    if(!prior||prior.relationship==='support')links.set(url,{...link,url});
  }
  let selected=0;
  for(const link of [...links.values()].sort((a,b)=>(a.relationship==='support')-(b.relationship==='support'))){
    const relation={from:source.id,url:link.url,label:link.label,context:link.context,relationship:link.relationship};
    if(selected++>=3){coverage.push({...relation,state:'deferred',reason:'Three support destinations per article'});continue;}
    let result=cache.get(link.url);
    if(!result){
      if(cache.size>=limits.pages||budget.requests>=limits.requests||Date.now()>=budget.deadline){coverage.push({...relation,state:'deferred',reason:'Shared support/request/time bound'});continue;}
      result={state:'failed'};cache.set(link.url,result);
      const op=await trace.start('fetch',{url:link.url,note:'One-hop supporting document; shared public-fetch safeguards.'});
      const before=budget.requests;
      try{
        const r=await read(link.url,budget);if(budget.requests===before)budget.requests++;
        if(r.status!==200||typeof r.body!=='string'||Buffer.byteLength(r.body)>limits.bytes)throw new Error('Support response status/byte bound');
        const url=sourceURL(r.url),mime=r.headers?.['content-type']?.split(';')[0]??'text/html';
        const payload={url,status:r.status,mime,body:r.body},hash=digest(JSON.stringify(payload));
        const capture=(await db.query("insert into scout.evidence(tracker_id,url,content_hash,content,parsed,last_seen_at) values($1,$2,$3,$4,$5,clock_timestamp()) "+
          "on conflict(record_id,tracker_id,url,content_hash) do update set last_seen_at=excluded.last_seen_at returning *",
          [source.tracker_id,url,hash,JSON.stringify(payload),JSON.stringify({document:{identity:'support:'+link.url}})])).rows[0];
        const ref=await trace.capture(capture);
        Object.assign(result,{capture_id:capture.id,hash,url});
        if(!['text/html','application/xhtml+xml','application/json','text/plain'].includes(mime)){
          Object.assign(result,{state:'unsupported',capture_id:capture.id,hash,url,reason:'Unsupported support MIME type: '+mime});
          await trace.finish(op,'skipped',{artifacts:[ref],note:result.reason});
        }else{
        let clean=capture.parsed.document.prepared_versions?.[PREPARATION_VERSION];
        if(!clean){
          const html=mime==='application/json'||mime==='text/plain'?'<pre>'+r.body.replaceAll('&','&amp;').replaceAll('<','&lt;')+'</pre>':r.body;
          const title=DomUtils.textContent(DomUtils.getElementsByTagName('title',parseDocument(html).children)[0]??{children:[]})||url;
          clean=prepareDocument({url,title,html});
          await db.query("update scout.evidence set parsed=jsonb_set(parsed,'{document,prepared_versions}',coalesce(parsed#>'{document,prepared_versions}','{}')||jsonb_build_object($2::text,$3::jsonb)) where id=$1",[capture.id,PREPARATION_VERSION,JSON.stringify(clean)]);
        }
        Object.assign(result,{state:'fetched',capture_id:capture.id,hash,url,prepared:clean});
        const artifact=await trace.artifact('preparation','Cleaned supporting document',undefined,{source_id:capture.id,content_hash:hash,preparation_version:PREPARATION_VERSION});
        await trace.finish(op,'pass',{artifacts:[ref,artifact],note:'Payload and cleaned support retained. Links from this page are not followed.'});
        }
      }catch(error){
        if(budget.requests===before)budget.requests++;
        result.reason=error.message;await trace.finish(op,'fail',{note:'Support unavailable: '+error.message});
      }
    }
    coverage.push({...relation,...Object.fromEntries(Object.entries(result).filter(([k])=>k!=='prepared'))});
    if(result.state==='fetched'&&!documents.some(d=>d.capture_id===result.capture_id))
      documents.push({id:'S'+documents.length,capture_id:result.capture_id,hash:result.hash,url:result.url,relationship:link.relationship,via:relation,prepared:result.prepared});
  }
  const context=digest(JSON.stringify({primary:source.content_hash,coverage,documents:documents.map(({prepared,...d})=>d)}));
  const combined={...prepared,text:'',blocks:[],documents,context,coverage};
  for(const doc of documents){
    if(combined.text)combined.text+='\n\n';
    doc.start=combined.text.length;combined.text+=doc.prepared.text;doc.end=combined.text.length;
    for(const b of doc.prepared.blocks)combined.blocks.push({...b,id:doc.id+':'+b.id,doc:doc.id,start:b.start+doc.start,end:b.end+doc.start,headings:b.headings.map(i=>doc.id+':'+i)});
  }
  const artifact=await trace.artifact('support_coverage','Primary/support relationships, versions and coverage',{context,documents:documents.map(({prepared,...d})=>d),links:coverage});
  const op=await trace.start('prepare',{source_ids:[source.id],artifacts:[artifact],note:'Bounded one-hop support context; every omitted/failed destination remains explicit.'});
  await trace.finish(op,'pass');
  return combined;
}

// Opt-in fetch/prepare route. No call into the legacy scripted assessment/save
// path: every ready document, including unchanged pending work, is returned.
export async function collectOCTODocuments(db,{tracker,read,sourceURL,now,deadline,limits,process=false,model,makeModel,documentVersion}) {
  const run=(await db.query('insert into scout.collection_runs(tracker_id,started_at,stats) values($1,$2,$3::jsonb) returning id',[tracker.id,now(),JSON.stringify({validation:true,documents_only:!process})])).rows[0];
  const trace=await startReport(db,run.id,process?'octo-records':'octo-documents');
  const budget={requests:0,deadline:Math.min(deadline,Date.now()+limits.seconds*1000)};
  const stats={documents:0,prepared:0,reused:0,feed_only:0,failed:0,uncertain:0,unfetched:0,processed:0,created:0,changed:0,warnings:[...process?[]:['Fetch/prepare only: generation, validation/repair and record saving are not implemented.'],process?'One RSS page; one-hop support limited to three destinations/article and six/run; archives, media and further hops remain unfetched.':'One RSS page; archive pages and all supporting links/media remain unfetched.']};
  const ready=[],inventory=[],supportCache=new Map();
  async function fetchDocument(url){
    const op=await trace.start('fetch',{url});
    if(budget.requests>=limits.requests||Date.now()>=budget.deadline){await trace.finish(op,'skipped',{note:'Shared request/time bound; document not fetched.'});return {op,error:'Shared request/time bound'};}
    const before=budget.requests;
    try{
      const response=await read(url,budget);
      if(budget.requests===before)budget.requests++;
      if(response.status!==200||typeof response.body!=='string'||Buffer.byteLength(response.body)>limits.bytes)throw new Error('Response status/byte bound');
      return {op,response:{url:response.url,status:response.status,body:response.body}}; // Never retain headers.
    }catch{if(budget.requests===before)budget.requests++;await trace.finish(op,'fail',{note:'Source retrieval failed or exceeded a guard; no response retained.'});return {op,error:'Source retrieval failed or exceeded a guard'};}
  }
  try{
    const known=(await db.query(`select distinct on(parsed#>>'{document,id}') content::jsonb->'feed' as feed,last_seen_at
      from scout.evidence where tracker_id=$1 and record_id is null and parsed#>>'{document,identity}' like 'octo:post:%'
      order by parsed#>>'{document,id}',last_seen_at desc,id`,[tracker.id])).rows;
    const feed=await fetchDocument(FEED);let items=[];
    if(feed.response){
      const artifact=await trace.artifact('fetch_response','RSS source document',feed.response);
      await trace.finish(feed.op,'pass',{artifacts:[artifact]});
      const parse=await trace.start('prepare',{checkpoint:true,artifacts:[artifact],note:'Read RSS document identities.'});
      try{if(feed.response.url!==FEED)throw new Error('Unexpected RSS destination');items=feedItems(feed.response.body);await trace.finish(parse,'pass');}
      catch{await trace.finish(parse,'fail',{note:'RSS identity parsing failed; only previously known documents can be checked.'});stats.warnings.push('RSS could not be parsed; only previously known article documents can be checked.');stats.failed++;}
    }else{stats.warnings.push('RSS unavailable; stored feed metadata is used for known documents.');stats.failed++;}
    const candidates=new Map(known.map(row=>[row.feed.id,row.feed]));
    for(const item of items){
      if(item.error){inventory.push({...item,raw:undefined,description:undefined,state:'unfetched',reason:item.error});stats.unfetched++;continue;}
      if(items.filter(other=>other.id===item.id).length>1){inventory.push({id:item.id,url:item.url,state:'unfetched',reason:'Duplicate feed identity; deferred'});candidates.delete(item.id);stats.unfetched++;continue;}
      candidates.set(item.id,item);
    }
    // Previously known documents are rechecked even if the feed is unchanged or
    // no longer contains them. Least-recently observed first avoids starvation.
    const checked=new Map(known.map(row=>[row.feed.id,Date.parse(row.last_seen_at)]));
    const selected=[...candidates.values()].sort((a,b)=>(checked.get(a.id)??0)-(checked.get(b.id)??0));
    const plan=await trace.artifact('coverage','Document retrieval plan',{feed:FEED,documents:selected.map(i=>({id:i.id,url:i.url})),invalid:inventory,article_limit:limits.requests-1,supporting_links:process?'One hop; three/article, six/run within shared request/byte/redirect/time guards':'Not fetched; full targets retained in preparation'});
    const selection=await trace.start('prepare',{checkpoint:true,artifacts:[plan]});await trace.finish(selection,'pass',{note:'Document identities selected without topic, category, date or finding filters.'});
    for(const [index,entry] of selected.entries()){
      // Stable serialization also when known feed metadata was read from JSONB.
      const item={id:entry.id,url:entry.url,title:entry.title,published:entry.published,description:entry.description,raw:entry.raw,offsets:entry.offsets};
      if(index>=limits.requests-1){inventory.push({id:item.id,url:item.url,state:'unfetched',reason:'Article count bound'});stats.unfetched++;continue;}
      const apiURL='https://octogroup.org/wp-json/wp/v2/posts/'+item.id;
      const fetched=await fetchDocument(apiURL);
      const content=JSON.stringify({feed:item,article:fetched.response??null});
      const {offsets,...payload}=item; // Enclosing-feed location is provenance, not document content.
      const hash=digest(JSON.stringify({feed:payload,article:fetched.response??null}));
      const detect=await trace.start('detect',{url:item.url});
      const previous=(await db.query("select id,url,content_hash from scout.evidence where tracker_id=$1 and record_id is null and parsed#>>'{document,id}'=$2 order by last_seen_at desc,id limit 1",[tracker.id,item.id])).rows[0];
      const source=(await db.query(`insert into scout.evidence(tracker_id,url,content_hash,content,parsed,last_seen_at)
        values($1,$2,$3,$4,$5,clock_timestamp()) on conflict(record_id,tracker_id,url,content_hash) do update set last_seen_at=excluded.last_seen_at returning *`,
      [tracker.id,item.url,hash,content,JSON.stringify({document:{version:PREPARATION_VERSION,id:item.id,identity:'octo:post:'+item.id,preparation:{state:'pending'},processing:{state:'pending'}}})])).rows[0];
      const capture=await trace.capture(source),refs=[capture];if(previous&&previous.id!==source.id)refs.push(await trace.capture(previous));
      if(fetched.response)await trace.finish(fetched.op,'pass',{artifacts:[capture],final_url:fetched.response.url,bytes:Buffer.byteLength(fetched.response.body),note:'Linked WordPress document captured; structural validation follows.'});
      await trace.finish(detect,previous?.content_hash===hash?'skipped':'pass',{source_ids:[source.id],artifacts:refs,note:'SHA-256 of exact article response plus retained feed item, excluding enclosing-feed offsets; observation does not mark processing complete.'});
      const op=await trace.start('prepare',{source_ids:[source.id],artifacts:[capture]});stats.documents++;
      try{
        let prepared=source.parsed.document.prepared_versions?.[PREPARATION_VERSION]??source.parsed.document.prepared,feedOnly=source.parsed.document.feed_only;
        const reused=source.parsed.document.preparation.state==='complete'&&prepared?.version===PREPARATION_VERSION;
        if(!reused){
          if(Date.now()>=budget.deadline)throw new Error('Preparation time bound');
          let post;
          try{
            post=JSON.parse(fetched.response?.body??'null');
            const url=new URL(post?.link);
            if(fetched.response.url!==apiURL||post?.id!==+item.id||url.origin!=='https://octogroup.org'||post.status!=='publish'||typeof post.content?.rendered!=='string'||post.content.protected||typeof post.title?.rendered!=='string')throw new Error('Article identity/content unavailable');
          }catch{post=null;}
          feedOnly=!post;
          prepared=prepareDocument({url:post?.link??item.url,title:post?.title.rendered??item.title,html:post?.content.rendered??item.description});
          prepared.input=feedOnly?'feed-only':'linked-article';prepared.feed_metadata={title:item.title,published:item.published,url:item.url,offsets:item.offsets,
            offset_basis:'Original RSS response where this retained item was observed; metadata may precede this article check.'};
          const document={...source.parsed.document,
            prepared_versions:{...source.parsed.document.prepared_versions,[PREPARATION_VERSION]:prepared},feed_only:feedOnly,preparation:{state:'complete',version:PREPARATION_VERSION}};
          await db.query("update scout.evidence set parsed=jsonb_set(parsed,'{document}',$2::jsonb) where id=$1",[source.id,JSON.stringify(document)]);
          source.parsed.document=document;
        }
        const artifact=await trace.artifact('preparation','Prepared document, chunks and unfetched links',undefined,{source_id:source.id,content_hash:hash,url:item.url,preparation_version:prepared.version});
        await trace.finish(op,reused?'skipped':'pass',{artifacts:[capture,artifact],note:(reused?'Identical successfully prepared input reused. ':'Full document prepared. ')+(feedOnly?'Feed-only: linked article unavailable or invalid. ':'')+'Downstream processing remains separate; ready inputs are returned even when unchanged.'});
        stats[reused?'reused':'prepared']++;if(feedOnly)stats.feed_only++;
        ready.push(source.id);inventory.push({id:item.id,url:item.url,source_id:source.id,state:feedOnly?'feed-only':'prepared',reused});
        if(process){
          model??=makeModel?.(run.id,budget.deadline,trace);
          const context=await supportDocuments(db,{source,prepared,read,sourceURL,budget,limits,trace,cache:supportCache});
          const result=await processDocument(db,{source,prepared:context,trace,model,deadline:budget.deadline,version:documentVersion,
            changed:Boolean(previous&&previous.content_hash!==hash)});
          stats.created+=result.created;stats.changed+=result.changed;
          if(result.state==='complete')stats.processed++;else{stats[result.state==='uncertain'?'uncertain':'failed']++;stats.warnings.push(result.error);}
          inventory.at(-1).processing=result.state;
        }
      }catch{
        stats.failed++;await db.query("update scout.evidence set parsed=jsonb_set(parsed,'{document,preparation}','{\"state\":\"failed\"}') where id=$1",[source.id]);
        await trace.finish(op,'fail',{note:'Preparation failed or exceeded a bound. Capture retained; identical input remains eligible for retry.'});
        inventory.push({id:item.id,url:item.url,source_id:source.id,state:'failed',reason:'Preparation failed; retry eligible'});
      }
    }
    if(!selected.length)await trace.skip('prepare','No structurally usable document identities found.');
    const coverage=await trace.artifact('coverage','Document outcomes',{documents:inventory,unvisited:process?'RSS archives, unsupported/deferred support and further hops; inspect support coverage':'RSS archive pages and supporting links/media'});
    await trace.finish(selection,'pass',{artifacts:[plan,coverage],note:'Document identities selected without topic, category, date or finding filters; inspect bounded retrieval outcomes.'});
    stats.requests=budget.requests;stats.pending=ready.length-stats.processed;
    // A successful preparation is not an end-to-end successful collection.
    const outcome=ready.length||!stats.failed?'partial':'failed';
    await db.query('update scout.collection_runs set finished_at=$2,outcome=$3,stats=stats||$4::jsonb where id=$1',[run.id,now(),outcome,JSON.stringify(stats)]);
    return {run_id:run.id,outcome,...stats,document_ids:ready};
  }catch(error){
    for(const [id,op]of Object.entries(trace.report.operations))if(op.state==='running')await trace.finish(id,'fail',{note:'Interrupted; inspect retained artifacts.'}).catch(()=>{});
    await db.query("update scout.collection_runs set finished_at=clock_timestamp(),outcome='failed' where id=$1",[run.id]).catch(()=>{});
    throw error;
  }
}
