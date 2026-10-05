import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument, DomUtils } from 'htmlparser2';
import { startReport } from './report.js';
import { processDocument, DOCUMENT_VERSION } from './document-records.js';

const digest = text => createHash('sha256').update(text).digest('hex');
const FEED = 'https://octogroup.org/feed/';
export const PREPARATION_VERSION = 'octo-documents-v6';
export const CHUNK_BYTES = 4000; // Source text only; the future model stage must bound its entire request.
const framing = new Set(['head','script','style','nav','noscript','template']);
const blocks = new Set(['p','h1','h2','h3','h4','h5','h6','li','blockquote','pre','table','figcaption']);

// No finding fields or relevance rules. Ranges use UTF-16 offsets into the
// retained HTML and prepared text; chunks reference context rather than omit it.
export function prepareDocument({title,html,url}) {
  const dom=parseDocument(html,{withStartIndices:true,withEndIndices:true});
  const result={version:PREPARATION_VERSION,title:DomUtils.textContent(parseDocument(title)),url,text:'',blocks:[],links:[],insertions:[],omissions:[],chunks:[],chunk_bytes:CHUNK_BYTES};
  // Temporary markers distinguish our link annotations from identical literal
  // source prose. They disappear before storage; ranges resolve to HTML links.
  let marker='\0';while(html.includes(marker)||DomUtils.textContent(dom).includes(marker))marker+=marker;
  const annotations=new RegExp(marker+'(\\d+)'+marker,'g');
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
        const relationship=node.name==='a'&&(/\b(?:category|tag)\b/.test(node.attribs.rel??'')||(node.attribs.class??'').split(/\s+/).includes('elementor-post-info__terms-list-item'))?'taxonomy':
          node.name==='a'&&(/\bregistration\b/.test(node.attribs.rel??'')||/^(?:register|registration)\b/i.test(context))?'registration':
          node.name==='a'&&(/\bauthor\b/.test(node.attribs.rel??'')||/^(?:organizer|organiser|official event)\b/i.test(context))?'organizer':'support';
        result.links.push({label:label.replace(annotations,(_,index)=>' <'+result.links[index].target+'>'),target,tag:node.name,relationship,context,start:node.startIndex,end:node.endIndex+1,state:'unfetched'});
        value=label+marker+(result.links.length-1)+marker;
      }
    }
    if(blocks.has(node.name)||['br','tr','caption','div','section','article','ul','ol','dl','dt','dd','figure'].includes(node.name))value+='\n';
    if(node.name==='td'||node.name==='th')value+='\t';
    return value;
  }
  function walk(node) {
    if(framing.has(node.name)) {render(node);return;}
    if(blocks.has(node.name)||node.type==='text'&&node.data.trim()||['a','img','iframe'].includes(node.name)) {
      const insertions=[];let delta=0;
      const text=render(node).replace(/[ \r\f\v]+/g,' ').replace(/ *\n */g,'\n').trim().replace(annotations,(token,index,offset)=>{
        const text=' <'+result.links[index].target+'>',start=offset+delta;
        insertions.push({start,end:start+text.length,link:+index});delta+=text.length-token.length;return text;
      });
      if(!text)return;
      const level=/^h[1-6]$/.test(node.name)?+node.name[1]:null;
      if(level)headings.splice(level-1);
      const id=result.blocks.length;
      result.blocks.push({id,tag:node.name??'text',html_start:node.startIndex,html_end:node.endIndex+1,headings:headings.filter(x=>x!=null),text,insertions});
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
    }else{
      // Older public Zoom pages expose an object literal rather than JSON.
      // Preserve that complete data envelope as source text; never evaluate it.
      const literal=html.match(/\bwindow\.dataModel\s*=\s*(\{[\s\S]*?\n\})\s*(?:;|(?=window\.domainFromServer))/)?.[1];
      if(literal)result.blocks.push({id:result.blocks.length,tag:'structured-data',headings:[],text:'Zoom registration data literal\n'+literal});
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
    for(const i of block.insertions??[])result.insertions.push({...i,start:i.start+block.start,end:i.end+block.start});delete block.insertions;
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

// Incidental announcement links remain metadata; extraction uses only its own
// retained primary body. No registration/organizer/topic destinations are opened.
export async function supportDocuments(_db,{source,prepared,trace,context,reuse}){
  const coverage=prepared.links.map(link=>({...link,state:'unfetched',reason:'Citation/link metadata only; not opened for event extraction'}));
  const documents=[{id:'P',capture_id:source.id,hash:source.content_hash,url:prepared.url,relationship:'primary',
    preparation_version:prepared.version,prepared,start:0,end:prepared.text.length}];
  context??=digest(JSON.stringify({primary:source.content_hash,mode:'announcement-events'}));
  const artifact=await trace.artifact('support_coverage','Primary announcement and unopened citation links',
    {context,documents:documents.map(({prepared,...d})=>d),links:coverage,...reuse?{reuse}:{}});
  const op=await trace.start('prepare',{source_ids:[source.id],artifacts:[artifact],note:'Independent primary announcement; incidental links retained without retrieval or concatenation.'});
  await trace.finish(op,'pass');
  return {...prepared,documents,context,coverage};
}

// Opt-in fetch/prepare route. No call into the legacy scripted assessment/save
// path: every ready document, including unchanged pending work, is returned.
export async function collectDocuments(db,{tracker,read,sourceURL,now,since,deadline,limits,process=false,model,makeModel,documentVersion=DOCUMENT_VERSION,retrieve,path='octo'}) {
  const run=(await db.query('insert into scout.collection_runs(tracker_id,started_at,stats) values($1,$2,$3::jsonb) returning id',[tracker.id,now(),JSON.stringify({validation:true,documents_only:!process})])).rows[0];
  const trace=await startReport(db,run.id,path+(process?'-records':'-documents'));
  const budget={requests:0,deadline:Math.min(deadline,Date.now()+limits.seconds*1000)};
  const stats={documents:0,prepared:0,reused:0,feed_only:0,failed:0,uncertain:0,unfetched:0,processed:0,created:0,changed:0,warnings:[...process?[]:['Fetch/prepare only; generation, validation/repair and record saving are not requested.'],path==='octo'?'One RSS page; archives/media remain unfetched.':'Bounded source retrieval; inspect source coverage for failed/deferred items and unvisited pages.','Incidental links retained as citations/metadata; no support expansion.']};
  const ready=[],inventory=[];
  async function fetchDocument(url,withHeaders=false){
    const op=await trace.start('fetch',{url});
    if(budget.requests>=limits.requests||Date.now()>=budget.deadline){await trace.finish(op,'skipped',{note:'Shared request/time bound; document not fetched.'});return {op,error:'Shared request/time bound'};}
    const before=budget.requests;
    try{
      const response=await read(url,budget);
      if(budget.requests===before)budget.requests++;
      if(!withHeaders&&response.status!==200||typeof response.body!=='string'||Buffer.byteLength(response.body)>limits.bytes)throw new Error('Response status/byte bound');
      return {op,response:{url:response.url,status:response.status,body:response.body,...withHeaders?{headers:response.headers}:{}}}; // Headers are for parser checks only.
    }catch{if(budget.requests===before)budget.requests++;await trace.finish(op,'fail',{note:'Source retrieval failed or exceeded a guard; no response retained.'});return {op,error:'Source retrieval failed or exceeded a guard'};}
  }
  try{
    let selected,plan,retrievalFailed=false;
    if(retrieve){
      const previous=(await db.query("select stats->'document_source' state from scout.collection_runs where tracker_id=$1 and stats ? 'document_source' order by started_at desc,id desc limit 1",[tracker.id])).rows[0]?.state??{};
      const captured=(await db.query("select distinct on(parsed#>>'{document,identity}') parsed#>>'{document,id}' id,url,"+
        " parsed#>>'{document,processing,version}' version,parsed#>array['document','processing_versions',parsed#>>'{document,processing,version}'] progress"+
        " from scout.evidence where tracker_id=$1 and record_id is null and parsed#>>'{document,identity}' like $2 order by parsed#>>'{document,identity}',last_seen_at desc,scout.evidence.id",[tracker.id,path+':%'])).rows;
      const pending=captured.filter(d=>process&&d.version?.startsWith(documentVersion+'/')&&d.progress&&!['complete','uncertain'].includes(d.progress.state)&&!d.progress.exhausted)
        .map(d=>({id:d.id,url:d.url,state:d.progress.pending||d.progress.findings?.some(f=>f.pending)?'model-repair':'model-pending'}));
      const knownKey=['iucn','dosi','iddri'].includes(path)?'url':'id',known=new Map([...(previous.known??[]),...captured.map(({id,url})=>({id,url}))].map(item=>[String(item[knownKey]),item]));
      const result=await retrieve({tracker,sourceURL,budget,
        limits:{...limits,articles:4,documents:limits.pages-1,...path==='discovery'?{searchPages:1,postsPerPage:5,requests:4}:path==='dosi'?{documents:4,requests:8}:{}},
        ...path==='discovery'?{since:new Date(since).toISOString(),until:now()}:{},
        knownArticles:[...known.values()],knownDocuments:[...known.values()],known:[...known.values()],pending:[...pending,...(previous.pending??[])],progress:previous.progress??{},read:async url=>{
        const fetched=await fetchDocument(url,true);if(!fetched.response)throw new Error(fetched.error);
        const {headers,...payload}=fetched.response;
        const artifact=await trace.artifact('fetch_response','Source response',payload);
        await trace.finish(fetched.op,payload.status===200?'pass':'fail',{artifacts:[artifact],note:'Safe response body retained; adapter validates source identity/structure.'});
        if(payload.status!==200)throw new Error('Source response status '+payload.status);
        return fetched.response;
      }});
      for(const item of [...result.inventory??[],...result.documents])if(item[knownKey]&&item.url&&item.state!=='unsupported'){
        const key=String(item[knownKey]);known.set(key,{...known.get(key),url:item.url,...item.id?{id:String(item.id)}:{}});
      }
      if(result.progress||result.pending){
        stats.document_source={known:[...known.values()],progress:result.progress??{},...result.pending?{pending:result.pending}:{}};
        await db.query("update scout.collection_runs set stats=stats||$2::jsonb where id=$1",[run.id,JSON.stringify({document_source:stats.document_source})]);
      }
      const grouped=new Map(),versions=new Map();
      for(const entry of result.documents)for(const item of entry.variants??[entry]){
        const identity=item.identity??item.id,key=identity+':'+digest(item.raw),prior=grouped.get(key);
        const provenance=[item.provenance??{listing:item.listing,api_url:item.api_url,via:item.via,regions:item.regions,metadata:item.metadata,alternates:item.alternates}].flat();
        if(prior)prior.provenance.push(...provenance);
        else grouped.set(key,{...item,identity,provenance,conflicted:entry.state==='conflict'});
        if(!versions.has(identity))versions.set(identity,new Set());versions.get(identity).add(key);
      }
      selected=[...grouped.values()].map(item=>({...item,conflicted:item.conflicted||versions.get(item.identity).size>1}));
      const priority=new Map(pending.map(d=>[d.url,d.state==='model-repair'?0:1]));
      selected.sort((a,b)=>(priority.get(a.url)??2)-(priority.get(b.url)??2));
      stats.failed+=(result.coverage??[]).filter(c=>c.state==='failed').length;
      retrievalFailed=stats.failed>0;
      stats.unfetched+=(result.coverage??[]).filter(c=>['deferred','unfetched'].includes(c.state)).length;
      plan=await trace.artifact('coverage','Source documents and retrieval coverage',{documents:selected.map(({id,url,identity,provenance,conflicted})=>({id,url,identity,provenance,conflicted})),
        coverage:result.coverage,pagination:result.pagination,queries:result.queries,window:result.window,limits:result.limits,complete:result.complete,progress:result.progress});
    }else{
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
    selected=[...candidates.values()].sort((a,b)=>(checked.get(a.id)??0)-(checked.get(b.id)??0));
    plan=await trace.artifact('coverage','Document retrieval plan',{feed:FEED,documents:selected.map(i=>({id:i.id,url:i.url})),invalid:inventory,article_limit:limits.requests-1,supporting_links:'Not opened; full targets retained as citations/metadata'});
    }
    const selection=await trace.start('prepare',{checkpoint:true,artifacts:[plan]});await trace.finish(selection,retrievalFailed?'fail':'pass',{note:'Document identities selected without topic, category, date or finding filters; source failures remain in coverage.'});
    for(const [index,entry] of selected.entries()){
      if(Date.now()+5000>=budget.deadline){
        inventory.push(...selected.slice(index).map(d=>({id:d.id,url:d.url,state:'deferred',reason:'Collection runtime budget'})));
        stats.warnings.push('Collection runtime reached; remaining documents deferred');break;
      }
      // Stable serialization also when known feed metadata was read from JSONB.
      const item=retrieve?entry:{id:entry.id,url:entry.url,title:entry.title,published:entry.published,description:entry.description,raw:entry.raw,offsets:entry.offsets};
      if(!retrieve&&index>=limits.requests-1){inventory.push({id:item.id,url:item.url,state:'unfetched',reason:'Article count bound'});stats.unfetched++;continue;}
      const apiURL='https://octogroup.org/wp-json/wp/v2/posts/'+item.id;
      const fetched=retrieve?{}:await fetchDocument(apiURL);
      const content=retrieve?item.raw:JSON.stringify({feed:item,article:fetched.response??null});
      const {offsets,...payload}=item; // Enclosing-feed location is provenance, not document content.
      const hash=digest(retrieve?item.raw:JSON.stringify({feed:payload,article:fetched.response??null}));
      const identity=item.identity??'octo:post:'+item.id,preparationVersion=item.prepared?.version??PREPARATION_VERSION;
      const detect=await trace.start('detect',{url:item.url});
      const previous=(await db.query("select id,url,content_hash,parsed from scout.evidence where tracker_id=$1 and record_id is null and parsed#>>'{document,identity}'=$2 order by last_seen_at desc,id limit 1",[tracker.id,identity])).rows[0];
      const source=(await db.query(`insert into scout.evidence(tracker_id,url,content_hash,content,parsed,last_seen_at)
        values($1,$2,$3,$4,$5,clock_timestamp()) on conflict(record_id,tracker_id,url,content_hash) do update set last_seen_at=excluded.last_seen_at returning *`,
      [tracker.id,item.url,hash,content,JSON.stringify({document:{version:preparationVersion,id:item.id,identity,preparation:{state:'pending'},processing:{state:'pending'}}})])).rows[0];
      const capture=await trace.capture(source),refs=[capture];if(previous&&previous.id!==source.id)refs.push(await trace.capture(previous));
      if(fetched.response)await trace.finish(fetched.op,'pass',{artifacts:[capture],final_url:fetched.response.url,bytes:Buffer.byteLength(fetched.response.body),note:'Linked WordPress document captured; structural validation follows.'});
      if(retrieve)refs.push(await trace.artifact('provenance','Source item occurrences and coverage',{identity,provenance:item.provenance,coverage:item.coverage,conflicted:item.conflicted},{source_id:source.id}));
      await trace.finish(detect,previous?.content_hash===hash?'skipped':'pass',{source_ids:[source.id],artifacts:refs,note:retrieve?'SHA-256 of exact item/article payload; listing positions and response framing are separate provenance.':'SHA-256 of exact article response plus retained feed item, excluding enclosing-feed offsets; observation does not mark processing complete.'});
      const op=await trace.start('prepare',{source_ids:[source.id],artifacts:[capture]});stats.documents++;
      try{
        let prepared=source.parsed.document.prepared_versions?.[preparationVersion]??source.parsed.document.prepared,feedOnly=source.parsed.document.feed_only;
        const reused=source.parsed.document.preparation.state==='complete'&&prepared?.version===preparationVersion;
        if(!reused){
          if(Date.now()>=budget.deadline)throw new Error('Preparation time bound');
          if(retrieve){prepared=item.prepared;feedOnly=false;}else{
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
          }
          const document={...source.parsed.document,
            prepared_versions:{...source.parsed.document.prepared_versions,[preparationVersion]:prepared},feed_only:feedOnly,preparation:{state:'complete',version:preparationVersion}};
          await db.query("update scout.evidence set parsed=jsonb_set(parsed,'{document}',$2::jsonb) where id=$1",[source.id,JSON.stringify(document)]);
          source.parsed.document=document;
        }
        const artifact=await trace.artifact('preparation','Prepared document, chunks and unfetched links',undefined,{source_id:source.id,content_hash:hash,url:item.url,preparation_version:prepared.version});
        await trace.finish(op,reused?'skipped':'pass',{artifacts:[capture,artifact],note:(reused?'Identical successfully prepared input reused. ':'Full document prepared. ')+(feedOnly?'Feed-only: linked article unavailable or invalid. ':'')+'Downstream processing remains separate; ready inputs are returned even when unchanged.'});
        stats[reused?'reused':'prepared']++;if(feedOnly)stats.feed_only++;
        ready.push(source.id);inventory.push({id:item.id,url:item.url,source_id:source.id,state:feedOnly?'feed-only':'prepared',reused});
        if(item.conflicted){
          stats.uncertain++;inventory.at(-1).processing='uncertain';
          const conflict=await trace.start('validate',{source_ids:[source.id],artifacts:refs});
          await trace.finish(conflict,'uncertain',{note:'Conflicting payloads for one source identity in this retrieval; retain all versions without choosing observation order.'});continue;
        }
        if(process){
          if(feedOnly){
            stats.failed++;inventory.at(-1).processing='failed';
            stats.warnings.push('Full announcement unavailable; retained feed snippet is discovery only.');continue;
          }
          model??=makeModel?.(run.id,budget.deadline,trace);
          // Raw captures remain exact. Reuse only consecutive equivalent prepared inputs;
          // a real content/context change must not resurrect older completion or repair state.
          const prior=previous?.parsed.document.prepared_versions?.[preparationVersion]??previous?.parsed.document.prepared,prefix=documentVersion+'/'+prepared.version+'/';
          const omissions=prepared.omissions.map(({regions,...entry})=>entry);
          const equivalent=prior&&isDeepStrictEqual({...prior,omissions:prior.omissions.map(({regions,...entry})=>entry)},{...prepared,omissions})?
            (await db.query("select e.id,p.version,p.state from scout.evidence e cross join lateral (select e.parsed#>>'{document,processing,version}' version,"+
              " e.parsed#>array['document','processing_versions',e.parsed#>>'{document,processing,version}'] state) p"+
              " where e.tracker_id=$1 and e.record_id is null and e.parsed#>>'{document,identity}'=$2 and starts_with(p.version,$3) and p.state is not null"+
              " and (coalesce(e.parsed#>array['document','prepared_versions',$4],e.parsed#>'{document,prepared}')-'omissions')=($5::jsonb-'omissions')"+
              " and (select jsonb_agg(o-'regions') from jsonb_array_elements(coalesce(e.parsed#>array['document','prepared_versions',$4],e.parsed#>'{document,prepared}')->'omissions') o) is not distinct from $6::jsonb"+
              " order by (p.state->>'state'='complete') desc,e.last_seen_at desc,e.id limit 1",[tracker.id,identity,prefix,prepared.version,JSON.stringify(prepared),omissions.length?JSON.stringify(omissions):null])).rows[0]:null;
          if(equivalent&&equivalent.id!==source.id){
            const state=structuredClone(equivalent.state);if(state.pending?.input)state.pending.input.source_id=source.id;
            source.parsed.document={...source.parsed.document,processing:{state:state.state,version:equivalent.version},
              processing_versions:{...source.parsed.document.processing_versions,[equivalent.version]:state}};
            await db.query("update scout.evidence set parsed=jsonb_set(parsed,'{document}',$2::jsonb) where id=$1",[source.id,JSON.stringify(source.parsed.document)]);
          }
          const context=await supportDocuments(db,{source,prepared,trace,context:equivalent?.version.slice(prefix.length),
            reuse:equivalent&&equivalent.id!==source.id?{capture_id:equivalent.id,version:equivalent.version,comparison:'Exact prepared document including URL/context/structure and omissions; only raw structural region offsets excluded.'}:undefined});
          const result=await processDocument(db,{source,prepared:context,trace,model,deadline:budget.deadline,version:documentVersion,
            changed:Boolean(previous&&previous.content_hash!==hash&&!equivalent)});
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
    const coverage=await trace.artifact('coverage','Document outcomes',{documents:inventory,unvisited:'Source retrieval bounds remain explicit; incidental citation links and media are not opened for extraction.'});
    await trace.finish(selection,retrievalFailed?'fail':'pass',{artifacts:[plan,coverage],note:'Document identities selected without topic, category, date or finding filters; inspect bounded retrieval outcomes and failures.'});
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
