import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { isIP } from 'node:net';
import { parseDocument, DomUtils } from 'htmlparser2';
import {processDocument,claimSource,finishSource} from './finding-jobs.js';
import {readCalendar} from '../src/finding.js';

export function sourceURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Unsupported source URL');
  if (isIP(url.hostname.replaceAll(/[\[\]]/g, '')) || !url.hostname.includes('.')) throw new Error('Source must use a public hostname');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.href;
}

const digest = text => createHash('sha256').update(text).digest('hex');
const FEED = 'https://octogroup.org/feed/';
export const PREPARATION_VERSION = 'octo-documents-v6';
export const CHUNK_BYTES = 4000; // Source text only; the future model stage must bound its entire request.
const framing = new Set(['head','script','style','nav','noscript','template']);
const blocks = new Set(['p','h1','h2','h3','h4','h5','h6','li','blockquote','pre','table','figcaption']);

// No finding fields or relevance rules. Ranges use UTF-16 offsets into the
// retained HTML and prepared text; chunks reference context rather than omit it.
// Source adapters opt into HTML whitespace with their own preparation version.
export function prepareDocument({title,html,url,htmlWhitespace=false,protectedContacts=false}) {
  const dom=parseDocument(html,{withStartIndices:true,withEndIndices:true});
  const result={version:PREPARATION_VERSION,title:DomUtils.textContent(parseDocument(title)),url,text:'',blocks:[],links:[],insertions:[],omissions:[],chunks:[],chunk_bytes:CHUNK_BYTES};
  // Temporary markers protect preformatted text and distinguish link annotations
  // from source prose. They disappear before storage; ranges resolve to HTML links.
  let marker='\0';while(html.includes(marker)||DomUtils.textContent(dom).includes(marker))marker+=marker;
  const annotations=new RegExp(marker+'(\\d+)'+marker,'g');
  const headings=[],literalText=[],literals=new RegExp(marker+'p(\\d+)'+marker,'g');
  function render(node,preformatted=false) {
    if(framing.has(node.name)){result.omissions.push({start:node.startIndex,end:node.endIndex+1,reason:'Removed '+node.name+' framing'});return '';}
    if(node.type==='text')return htmlWhitespace&&!preformatted?node.data.replace(/[ \t\r\n\f\u00a0]+/g,' '):node.data;
    const literal=htmlWhitespace&&['pre','textarea'].includes(node.name);
    let value=(node.children??[]).map(child=>render(child,preformatted||literal)).join('');
    if(node.name==='a'||node.name==='img'||node.name==='iframe') {
      const raw=node.attribs?.href??node.attribs?.src;
      const contact=protectedContacts&&node.name==='a'&&/^\/cdn-cgi\/l\/email-protection#(?:[\da-f]{2}){2,}$/i.test(raw??'')&&
        DomUtils.findAll(n=>(n.attribs?.class??'').split(/\s+/).includes('__cf_email__')&&/^(?:[\da-f]{2}){2,}$/i.test(n.attribs?.['data-cfemail']??''),node.children).length;
      if(contact)result.omissions.push({start:node.startIndex,end:node.endIndex+1,reason:'Opaque protected-contact href excluded; visible contact text and original HTML retained'});
      if(raw&&!contact){let target;try{target=new URL(raw,url).href;}catch{target=raw;}
        const label=value||node.attribs.alt||node.attribs.title||target;
        const context=DomUtils.textContent(node.parent??node).trim();
        const relationship=node.name==='a'&&(/\b(?:category|tag)\b/.test(node.attribs.rel??'')||(node.attribs.class??'').split(/\s+/).includes('elementor-post-info__terms-list-item'))?'taxonomy':
          node.name==='a'&&(/\bregistration\b/.test(node.attribs.rel??'')||/^(?:register|registration)\b/i.test(context))?'registration':
          node.name==='a'&&(/\bauthor\b/.test(node.attribs.rel??'')||/^(?:organizer|organiser|official event)\b/i.test(context))?'organizer':'support';
        result.links.push({label:label.replace(literals,(_,index)=>literalText[index]).replace(annotations,(_,index)=>' <'+result.links[index].target+'>'),target,tag:node.name,relationship,context,start:node.startIndex,end:node.endIndex+1,state:'unfetched'});
        value=label+marker+(result.links.length-1)+marker;
      }
    }
    if(literal&&!preformatted){literalText.push(value);value=marker+'p'+(literalText.length-1)+marker;}
    if(blocks.has(node.name)||['br','tr','caption','div','section','article','ul','ol','dl','dt','dd','figure'].includes(node.name))value+=htmlWhitespace&&(/^(?:p|h[1-6]|blockquote|pre)$/.test(node.name))?'\n\n':'\n';
    if(node.name==='td'||node.name==='th')value+='\t';
    return value;
  }
  function walk(node) {
    if(framing.has(node.name)) {render(node);return;}
    if(blocks.has(node.name)||htmlWhitespace&&node.name==='textarea'||node.type==='text'&&node.data.trim()||['a','img','iframe'].includes(node.name)) {
      const insertions=[];let delta=0;
      const text=render(node).replace(/[ \r\f\v]+/g,' ').replace(/ *\n */g,'\n').trim().replace(literals,(_,index)=>literalText[index]).replace(annotations,(token,index,offset)=>{
        const text=' <'+result.links[index].target+'>',start=offset+delta;
        insertions.push({start,end:start+text.length,link:+index});delta+=text.length-token.length;return text;
      });
      if(!text)return;
      const level=/^h[1-6]$/.test(node.name)?+node.name[1]:null;
      if(level)headings.splice(level-1);
      const id=result.blocks.length;
      result.blocks.push({id,tag:node.name??'text',html_start:node.startIndex,html_end:node.endIndex+1,headings:headings.filter(x=>x!=null),text,insertions});
      // Retain publication text, but preserve its structural role for date proof.
      for(let parent=node;parent;parent=parent.parent){
        const classes=(parent.attribs?.class??'').split(/\s+/),property=parent.attribs?.itemprop;
        const field=['datePublished','dateModified'].includes(property)?property:
          parent.name==='time'&&classes.some(c=>['published','updated'].includes(c))?(classes.includes('published')?'datePublished':'dateModified'):
          parent.name==='span'&&classes.includes('date')&&parent.parent?.children?.some(n=>n.name==='span'&&(n.attribs?.class??'').split(/\s+/).includes('label')&&DomUtils.textContent(n).trim()==='News')?'datePublished':
          new URL(url).hostname==='highseasalliance.org'&&classes.includes('date')&&parent.parent?.name==='article'&&(parent.parent.attribs?.class??'').split(/\s+/).includes('type-post')?'datePublished':null;
        if(field){result.blocks.at(-1).source_fields=[{field,start:0,end:text.length,attribution:{relationship:'publication-metadata'}}];break;}
      }
      if(node.name==='table')result.blocks.at(-1).table_context=DomUtils.findAll(n=>n.name==='caption'||n.name==='tr'&&DomUtils.getElementsByTagName('th',n.children).length,node.children)
        .map(n=>(n.name==='caption'?[n]:DomUtils.getElementsByTagName('th',n.children)).map(cell=>DomUtils.textContent(cell).replace(/\s+/g,' ').trim()).join('\t')).join('\n');
      if(level)headings[level-1]=id;
    }else for(const child of node.children??[])walk(child);
  }
  walk(dom);
  // Structural payloads, not scripted record fields. Never execute page JavaScript.
  const structured=DomUtils.getElementsByTagName('script',dom.children).filter(n=>n.attribs.type==='application/ld+json').map(n=>({label:'JSON-LD',body:DomUtils.textContent(n)}));
  if(/\.qualtrics\.com$/.test(new URL(url).hostname)){
    const encoded=DomUtils.getElementsByTagName('script',dom.children).map(n=>DomUtils.textContent(n))
      .map(text=>text.match(/^\s*q=JSON\.parse\(decodeURIComponent\(("(?:[^"\\]|\\.)*")\)\)/)?.[1]).find(Boolean);
    if(encoded)try{
      const data=JSON.parse(decodeURIComponent(JSON.parse(encoded))).init.appData;
      if(data.setup.survey.id!==new URL(url).pathname.match(/\/form\/(SV_[\w]+)$/)?.[1]||!Array.isArray(data.page.content.questions))throw new Error('Survey identity/content unavailable');
      structured.push({label:'Qualtrics public survey page',body:JSON.stringify({survey:data.setup.survey,questions:data.page.content.questions})});
      result.version='qualtrics-public-page-v1';
      result.omissions.push({reason:'Qualtrics session, response, authentication and UI configuration excluded; public survey page retained; full response captured.'});
    }catch{result.omissions.push({reason:'Malformed or mismatched Qualtrics public page payload; raw response retained.'});}
  }
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
    try{const value=JSON.parse(data.body),text=data.label+'\n'+JSON.stringify(value,null,2);
      result.blocks.push({id:result.blocks.length,tag:'structured-data',headings:[],text,
        source_fields:[...text.matchAll(/"(datePublished|dateModified)":\s*"([^"\n]+)"/g)].map(m=>({field:m[1],start:m.index,end:m.index+m[0].length,attribution:{relationship:'publication-metadata'}}))});}
    catch{result.omissions.push({reason:'Malformed '+data.label+' could not be prepared; raw response retained.'});}
  }
  if(!result.blocks.length)throw new Error('Document has no readable body');
  for(const block of result.blocks){
    if(result.text)result.text+='\n\n';
    block.start=result.text.length;result.text+=block.text;block.end=result.text.length;delete block.text;
    for(const field of block.source_fields??[]){field.start+=block.start;field.end+=block.start;}
    for(const i of block.insertions??[])result.insertions.push({...i,start:i.start+block.start,end:i.end+block.start});delete block.insertions;
  }
  if(new URL(url).hostname==='highseasalliance.org'&&result.blocks.some(b=>b.source_fields?.length))result.version='hsa-publication-metadata-v1';
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

export function prepareCbdPayload({id,url,raw,rows,task,provenance,sourceURL}){
  const original=JSON.parse(raw),array=Array.isArray(original);
  const prepared={version:'cbd-documents-v2',title:'',url,input:'whole-registry-source',text:'',blocks:[],chunks:[],links:[],omissions:[],
    offset_basis:'Prepared UTF-16 text; literal labels are generated. HTML offsets refer to the decoded field, not the raw JSON response.',
    source_rows:rows.map((row,index)=>({source_id:row._id??row.did,row:index,raw_path:Array.isArray(original.profiles)?'$.profiles['+index+']':array?'$['+index+']':'$'}))};
  const coverage=[];
  for(const[rowIndex,row]of rows.entries()){
    const root=Array.isArray(original.profiles)?'$.profiles['+rowIndex+']':array?'$['+rowIndex+']':'$',attribution={relationship:task.kind,source_id:row._id??row.did,row:rowIndex},fields=[];
    function walk(value,path,key){
      if(value&&typeof value==='object'&&Object.keys(value).length){
        for(const[k,v]of Object.entries(value))walk(v,path+(Array.isArray(value)?'['+k+']':'.'+k),k);
      }else fields.push({value,path,key});
    }
    walk(row,root,'');
    // Literal identity/name/schedule/reference fields precede long descriptions;
    // every returned field remains represented, without relevance selection.
    fields.sort((a,b)=>(a.key==='description')-(b.key==='description'));
    for(const{value,path,key}of fields){
      if(prepared.text)prepared.text+='\n\n';
      const start=prepared.text.length,label=path+': ',html=task.kind!=='profile'&&key==='description'&&typeof value==='string'&&/<\/?[a-z][^>]*>/i.test(value);
      let clean;
      if(html){
        try{clean=prepareDocument({title:'',url,html:value});}
        catch{prepared.omissions.push({path,reason:'HTML has no readable body; complete literal field retained below'});}
      }
      const text=clean?.text??(typeof value==='string'?value:JSON.stringify(value));
      prepared.text+=label+text;
      const field={id:prepared.blocks.length,tag:'source-field',field:key,attribution,source_paths:[path],start,end:prepared.text.length,headings:[],
        transformation:clean?'html-cleaned':'literal',value_range:[start+label.length,prepared.text.length]};
      prepared.blocks.push(field);
      if(clean){
        const base=prepared.blocks.length,offset=start+label.length;
        for(const block of clean.blocks)prepared.blocks.push({...block,id:base+block.id,start:offset+block.start,end:offset+block.end,
          headings:block.headings.map(id=>base+id),source_paths:[path],attribution,html_offset_basis:'Decoded '+path+' HTML; prepared ranges are cleaned text'});
        for(const link of clean.links)prepared.links.push({...link,source_paths:[path],attribution,html_offset_basis:'Decoded '+path+' HTML'});
        prepared.omissions.push(...clean.omissions.map(o=>({...o,path,offset_basis:'Decoded HTML field'})));
      }
      if(typeof value==='string'&&['uri','url','href'].includes(key)){
        try{prepared.links.push({target:sourceURL(value),label:value,tag:'api',relationship:'support',context:path,source_paths:[path],attribution,state:'unfetched'});}
        catch{coverage.push({target:value,path,state:'unsupported',reason:'Non-public-HTTPS API reference retained, not fetched'});}
      }
      prepared.chunks.push({start:prepared.chunks.at(-1)?.end??0,end:field.end,block_ids:[field.id],context_block_ids:[],preceding_context:null});
    }
  }
  if(!rows.length){
    prepared.text='$: []';prepared.blocks.push({id:0,tag:'source-field',field:'rows',attribution:{relationship:task.kind},source_paths:['$'],start:0,end:prepared.text.length,headings:[],transformation:'literal',value_range:[3,prepared.text.length]});
    prepared.chunks.push({start:0,end:prepared.text.length,block_ids:[0],context_block_ids:[],preceding_context:null});
  }
  prepared.coverage=coverage;
  return {id,url,raw,rows,task,provenance,prepared,coverage};
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

export async function prepareResponse(response,{sourceURL,deadline=Date.now()+20000,task={}}={}){
  const url=sourceURL(response.url),mime=(response.headers?.['content-type']??response.mime??'text/html').split(';')[0].trim().toLowerCase();
  if(response.status!==200||typeof response.body!=='string'||Buffer.byteLength(response.body,response.encoding??'utf8')>2097152)throw new Error('Source response status/byte bound');
  let body=response.body,prepared;
  if(task.kind){
    const raw=JSON.parse(body),rows=Array.isArray(raw)?raw:[raw];
    if(task.ids&&rows.some(row=>!task.ids.includes(row._id))||task.session&&rows.some(row=>row.sideEvent?.id!==task.session))throw new Error('Native reference response identity conflict');
    prepared=prepareCbdPayload({url,raw:body,rows,task,provenance:[],sourceURL}).prepared;
  }else if(mime==='application/pdf'){
    if(response.encoding!=='base64')throw new Error('Exact PDF bytes unavailable');
    const {getDocument,OPS}=await import('pdfjs-serverless');
    const imageOperations=new Set(Object.entries(OPS).filter(([name])=>/Image/.test(name)).map(([,value])=>value));
    const document=getDocument({data:new Uint8Array(Buffer.from(body,'base64')),isEvalSupported:false,useSystemFonts:false});
    try{
      const pdf=await document.promise;if(pdf.numPages>30)throw new Error('PDF exceeds 30-page reading bound');
      prepared={version:'pdf-2',title:url,url,text:'',blocks:[],links:[],omissions:[],pages:pdf.numPages,visual:false,visual_pages:[]};
      for(let page=1;page<=pdf.numPages;page++){
        if(Date.now()>=deadline)throw new Error('PDF preparation time bound');
        const view=await pdf.getPage(page),content=await view.getTextContent(),text=content.items.map(item=>item.str??'').join(' '),start=prepared.text.length;
        prepared.text+=text+'\n\n';prepared.blocks.push({id:page-1,page,start,end:prepared.text.length});
        if(!text.trim()||(await view.getOperatorList()).fnArray.some(op=>imageOperations.has(op))){prepared.visual=true;prepared.visual_pages.push(page);}
        if(Date.now()>=deadline)throw new Error('PDF preparation time bound');
      }
      // Image pages use the same provider/account and reservation as extraction.
      // Exact PDF bytes remain only in this invocation.
      if(prepared.visual)prepared.inline_data={mime_type:'application/pdf',data:body};
    }finally{await document.destroy();}
  }else{
    if(mime==='text/calendar'){
      body=body.replace(/\r?\n[ \t]/g,'');const stack=[];
      for(const line of body.split(/\r?\n/)){if(line.startsWith('BEGIN:'))stack.push(line.slice(6));else if(line.startsWith('END:')&&stack.pop()!==line.slice(4))throw new Error('Calendar component conflict');}
      if(!body.startsWith('BEGIN:VCALENDAR')||!body.trim().endsWith('END:VCALENDAR')||stack.length)throw new Error('Incomplete calendar');
    }
    if(!['text/html','application/xhtml+xml','application/json','text/plain','text/calendar'].includes(mime))throw new Error('Unsupported source MIME: '+mime);
    const html=['application/json','text/plain','text/calendar'].includes(mime)?'<pre>'+body.replaceAll('&','&amp;').replaceAll('<','&lt;')+'</pre>':body;
    prepared=prepareDocument({url,title:'',html,protectedContacts:true});
    if(mime==='text/calendar')for(const {properties,...calendar} of readCalendar(body)){
      const start=prepared.text.length;prepared.text+='\n\nCalendar occurrence (DATE end is inclusive below)\n'+JSON.stringify(calendar);
      prepared.blocks.push({id:prepared.blocks.length,tag:'calendar-event',start,end:prepared.text.length,calendar});
    }
  }
  return prepared;
}

// Native reference routing stays in the source adapter; extracted facts do not.
async function retrieveOcto({read,budget,sourceURL,known=[],limits}){
  const documents=[],coverage=[];let items=[];
  try{const response=await read(FEED,budget);if(response.status!==200)throw new Error('Feed unavailable');items=feedItems(response.body);}
  catch(error){coverage.push({url:FEED,state:'failed',reason:error.message});}
  const duplicates=new Set(items.filter((item,i)=>items.findIndex(other=>other.id===item.id)!==i).map(item=>item.id));
  const inventory=[...new Map([...known,...items].filter(item=>item.id).map(i=>[String(i.id),i])).values()];
  for(const item of inventory.sort((a,b)=>Number(known.some(k=>k.id===a.id&&k.captured))-Number(known.some(k=>k.id===b.id&&k.captured)))){
    if(item.error||duplicates.has(item.id)){coverage.push({url:item.url,state:'unsupported',reason:item.error??'Ambiguous feed identity'});continue;}
    const url='https://octogroup.org/wp-json/wp/v2/posts/'+item.id;
    let response,prepared,failure;
    try{
      if(budget.requests>=limits.requests||Date.now()+1000>=budget.deadline)throw new Error('Acquisition bound');
      response=await read(url,budget);
      if(Buffer.byteLength(response.body)>limits.bytes)throw new Error('Article byte bound');
      const post=JSON.parse(response.body);
      if(response.status!==200||response.url!==url||post.id!==+item.id||post.status!=='publish'||post.content?.protected||typeof post.content?.rendered!=='string')throw new Error('Full article unavailable');
      prepared=prepareDocument({url:sourceURL(post.link),title:post.title.rendered,html:post.content.rendered});
      prepared.input='linked-article';
    }catch(error){failure={url:item.url,state:error.message==='Acquisition bound'?'unfetched':'failed',reason:error.message};coverage.push(failure);
      if(failure.state==='unfetched'&&known.some(k=>k.id===item.id&&k.captured))continue;
      if(item.description)try{prepared=prepareDocument({url:sourceURL(item.url),title:item.title,html:item.description});prepared.input='feed-only';prepared.coverage=[failure];}catch{}
    }
    if(prepared)documents.push({id:String(item.id),identity:'octo:post:'+item.id,url:prepared.url,
      raw:prepared.input==='linked-article'?response.body:JSON.stringify({feed:item.raw,article:response?{url:response.url,status:response.status,body:response.body}:null}),prepared,coverage:failure?[failure]:[]});
  }
  coverage.push(...items.filter(item=>!item.id).map(item=>({url:item.url,state:'unsupported',reason:item.error})));
  return {documents,coverage,inventory:inventory.filter(item=>!item.error&&!duplicates.has(item.id)).map(({id,url})=>({id,url}))};
}
export async function collectDocuments(db,{tracker,read,sourceURL,now=()=>new Date().toISOString(),since,deadline,limits,model,makeModel,retrieve=retrieveOcto}){
  const root=await claimSource(db,{tracker_id:tracker.id,identity:'tracker',url:tracker.url});
  if(!root)return {outcome:'idle'};
  const budget={requests:0,deadline},counts={created:0,changed:0,processed:0};
  try{
    const known=(await db.query("select native_id id,identity,url,native_ref task,(processed_hash is not null) captured from scout.source_state where tracker_id=$1 and identity<>'tracker' order by due_at limit 200",[tracker.id])).rows;
    const result=await retrieve({tracker,read,sourceURL,budget,limits:{...limits,articles:1,documents:1,requests:8},since,until:now(),known,knownDocuments:known,knownArticles:known,pending:[],progress:JSON.parse(root.cursor??'{}')});
    const items=(result.documents??[]).slice(0,4),processedURLs=[];
    const generate=model??makeModel?.();
    for(const item of items){
      if(counts.processed||Date.now()+10000>=deadline)break;
      if(known.length>=200&&!known.some(s=>s.url===item.url))continue;
      const source={tracker_id:tracker.id,identity:String(item.identity??item.id??item.url),url:item.url,native_id:item.id==null?null:String(item.id),native_ref:item.task??{}};
      const outcome=await processDocument(db,{source,model:generate,deadline,prepared:item.prepared,
        read:url=>read(url,budget)});
      processedURLs.push(item.url);
      counts.created+=outcome.created;counts.changed+=outcome.changed;counts.processed++;
    }
    const progress=Object.fromEntries(Object.entries(result.progress??{}).filter(([key,value])=>['after_url','after_id','after_selected_id','cursor','next_page','total_pages','query','meeting_offset','history'].includes(key)&&['string','number','boolean'].includes(typeof value)));
    if(result.progress?.reservations)progress.reservations=Object.fromEntries(Object.entries(result.progress.reservations).filter(([key,value])=>/^[a-f0-9]{24}$/.test(key)&&Number.isSafeInteger(value)&&value>=0).slice(-4));
    const cursor=JSON.stringify(progress);
    if(cursor.length>512)throw new Error('cursor_bound');
    // URL-only inventory is capped; a cursor advances discovery without saving listing bodies.
    const urls=new Set([...known.map(i=>i.url),...processedURLs]);let added=0;
    for(const item of [...result.documents??[],...result.inventory??[]]){
      if(!item.url||urls.has(item.url)||urls.size>=200||added>=16)continue;
      let url;try{url=sourceURL(item.url);}catch{continue;}
      if(['unsupported','failed'].includes(item.state))continue;
      urls.add(url);
      added++;
      await db.query('insert into scout.source_state(tracker_id,identity,url,native_id,native_ref) values($1,$2,$3,$4,$5) on conflict do nothing returning id',[tracker.id,String(item.identity??item.id??url).slice(0,512),url,item.id==null?null:String(item.id).slice(0,256),item.task??{}]);
    }
    await finishSource(db,root,{cursor,retryAt:new Date(Date.now()+Math.max(6*3600000,Number(tracker.cadence?.days??0)*86400000+Number(tracker.cadence?.hours??0)*3600000)).toISOString()});
    return {outcome:counts.created||counts.changed?'success':'no_change',...counts};
  }catch(error){
    await finishSource(db,root,{state:'deferred',reason:'inaccessible_source',attempts:root.attempts,retryAt:new Date(Math.max(Date.parse(error.deferred?.retry_at)||0,Date.now()+3600000)).toISOString()});
    return {outcome:'deferred',reason:'inaccessible_source',...counts};
  }
}
