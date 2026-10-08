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

// One hop from retained primary links: three destinations/article, six/run.
// Registration/organizer relationships are link metadata, never arrival order.
export async function supportDocuments(db,{source,prepared,read,sourceURL,budget,limits,trace,recordId,companions=[],cache=new Map(),context,reuse}){
  const documents=[{id:'P',capture_id:source.id,hash:source.content_hash,url:prepared.url,relationship:'primary',
    preparation_version:prepared.version,prepared,start:0,end:prepared.text.length}];
  if(source.parsed.document.conflicted){
    const variants=(await db.query("select * from scout.evidence where tracker_id=$1 and record_id is null and parsed#>>'{document,identity}'=$2 and id<>$3 order by content_hash,id limit 4",
      [source.tracker_id,source.parsed.document.identity,source.id])).rows;
    if(!variants.length||variants.length>3)throw new Error('Source variants require two to four retained complete captures for joint review');
    for(const variant of variants){
      const document=variant.parsed.document,p=document.prepared_versions?.[document.preparation.version]??document.prepared;
      if(document.preparation.state!=='complete'||!p||document.feed_only)throw new Error('Source variant preparation is incomplete; retain all versions before review');
      await trace.capture(variant);
      documents.push({id:'S'+documents.length,capture_id:variant.id,hash:variant.content_hash,url:p.url,relationship:'source-variant',
        preparation_version:p.version,prepared:p});
    }
    context=undefined; // A single-capture resume key cannot certify a joint review.
  }
  if(!read){
  const coverage=prepared.links.map(link=>({...link,state:'unfetched',reason:'Citation/link metadata only; not opened for event extraction'}));
  context??=digest(JSON.stringify({primary:source.content_hash,mode:'announcement-events',...documents.length>1?{variants:documents.slice(1).map(d=>({hash:d.hash,preparation_version:d.preparation_version,text:d.prepared.text}))}:{}}));
  const artifact=await trace.artifact('support_coverage','Primary announcement and unopened citation links',
    {context,documents:documents.map(({prepared,...d})=>d),links:coverage,...reuse?{reuse}:{}});
  const op=await trace.start('prepare',{source_ids:[source.id],artifacts:[artifact],note:'Independent primary announcement; incidental links retained without retrieval or concatenation.'});
  await trace.finish(op,'pass');
  return {...prepared,documents,context,coverage};
  }
  const associated=(await db.query("select parsed->'finding' finding from scout.evidence where record_id is not null and tracker_id=$1 and parsed#>>'{document,identity}'=$2"+(recordId?' and record_id=$3':''),[source.tracker_id,source.parsed.document.identity,...recordId?[recordId]:[]])).rows;
  const findingURLs=new Set(associated.flatMap(r=>[r.finding?.candidate?.event_url,r.finding?.candidate?.registration_url,...r.finding?.urls??[]]).filter(Boolean).map(url=>{try{return sourceURL(url);}catch{return url;}}));
  const labels=recordId?associated.flatMap(r=>[r.finding?.anchor,r.finding?.candidate?.title]).filter(Boolean):[];
  const links=new Map(),coverage=[];
  const primaryLinks=[...prepared.links];
  if(recordId)for(const target of new Set(companions))primaryLinks.push({tag:'a',target,relationship:'discovery',label:'Independently supplied companion',context:'Requested for record '+recordId+'. Not a link in the primary source; same-finding identity and field roles require inspection.'});
  if(/^https:\/\/api\.cbd\.int\/api\/v2016\/reservations\/?\?/.test(source.url)){
    const meetings=[...new Set((prepared.blocks??[]).filter(b=>b.source_paths?.some(path=>/\.(?:sideEvent|location)\.conference$/.test(path))).map(b=>prepared.text.slice(...b.value_range)))];
    if(meetings.length===1&&/^[a-f0-9]{24}$/.test(meetings[0]))primaryLinks.push({tag:'a',relationship:'meeting',meeting:meetings[0],label:'Referenced CBD meeting identity',context:'Literal session conference reference. Parent meeting dates are not session dates.',
      target:'https://api.cbd.int/api/v2016/conferences?'+new URLSearchParams({q:JSON.stringify({_id:{$oid:meetings[0]}}),f:JSON.stringify({Title:1,Description:1,Venue:1})})});
    const hosts=(prepared.blocks??[]).filter(b=>b.source_paths?.some(path=>/\.sideEvent\.hostOrgs\[\d+\]$/.test(path))).map(b=>prepared.text.slice(...b.value_range));
    if(hosts.length&&hosts.length<=10&&hosts.every(id=>/^[a-f0-9]{24}$/.test(id)))
      primaryLinks.push({tag:'a',relationship:'organizer',hosts:[...new Set(hosts)],label:'Referenced CBD host organizations',context:'Literal sideEvent.hostOrgs references; returned names must match these IDs for this same session.',
        target:'https://api.cbd.int/api/v2016/inde-orgs?'+new URLSearchParams({q:JSON.stringify({_id:{$in:[...new Set(hosts)].sort().map(id=>({$oid:id}))}}),f:JSON.stringify({title:1,acronym:1})})});
    else if(hosts.length)coverage.push({relationship:'organizer',state:'unsupported',reason:'CBD host references lack a bounded unambiguous public-registry lookup'});
  }
  for(const link of primaryLinks){
    if(link.relationship==='taxonomy'){coverage.push({...link,state:'skipped',reason:'Publisher taxonomy link retained without support fetching'});continue;}
    const session=link.tag==='a'&&link.target.match(/^https:\/\/www\.cbd\.int\/side-events\/(\d+)$/)?.[1];
    let url;try{url=sourceURL(session?'https://api.cbd.int/api/v2016/reservations/?'+new URLSearchParams({q:JSON.stringify({'sideEvent.id':+session})}):link.target);}catch{coverage.push({...link,state:'unsupported',reason:'Public HTTPS document URL required'});continue;}
    if((link.tag!=='a'&&!(link.tag==='api'&&link.relationship==='calendar-export'))||/\.(?:png|jpe?g|gif|webp|mp4|mp3|zip)(?:$|\?)/i.test(url)){coverage.push({...link,url,state:'unsupported',reason:'Only linked HTML/text/JSON/PDF/calendar documents in this one-hop pass'});continue;}
    if(url===sourceURL(prepared.url)){coverage.push({...link,url,state:'skipped',reason:'Primary document already retained'});continue;}
    const prior=links.get(url);
    if(!prior||prior.relationship==='support')links.set(url,{...link,url,...session?{session}:{} });
  }
  let selected=0;
  const queue=[...links.values()].sort((a,b)=>Number(b.relationship==='discovery')-Number(a.relationship==='discovery')||Number(findingURLs.has(b.url)||findingURLs.has(b.target))-Number(findingURLs.has(a.url)||findingURLs.has(a.target))||Number(labels.some(label=>b.context?.includes(label)))-Number(labels.some(label=>a.context?.includes(label)))||(a.relationship==='support')-(b.relationship==='support')||(labels.length?(a.context?.length??0)-(b.context?.length??0):0));
  for(const link of queue){
    const relation={from:source.id,url:link.url,label:link.label,context:link.context,relationship:link.relationship,...link.actors?{actors:link.actors,mentions:link.mentions}:{},...link.session?{source_reference:link.target,session_id:link.session}:link.source_reference?{source_reference:link.source_reference}:{} };
    if(selected++>=3){coverage.push({...relation,state:'deferred',reason:'Three support destinations per article'});continue;}
    let result=cache.get(link.url);
    if(!result){
      if(cache.size>=limits.pages||budget.requests>=limits.requests||Date.now()>=budget.deadline){coverage.push({...relation,state:'deferred',reason:'Shared support/request/time bound'});continue;}
      result={state:'failed'};cache.set(link.url,result);
      const op=await trace.start('fetch',{url:link.url,note:'One-hop supporting document; shared public-fetch safeguards.'});
      const before=budget.requests;
      try{
        let r;
        try{r=await read(link.url,budget);}catch(error){
          if(!/peer closed connection without sending TLS close_notify/.test(error.message)||budget.requests>=limits.requests||Date.now()>=budget.deadline)throw error;
          const observed=(await db.query("select id,url from scout.evidence where record_id is null and tracker_id=$1 and parsed#>>'{document,identity}'=$2 and url<>$3 order by last_seen_at desc,collected_at desc,id limit 1",[source.tracker_id,'support:'+link.url,link.url])).rows[0];
          if(!observed)throw error;
          r=await read(sourceURL(observed.url),budget);result.redirect={observed_capture:observed.id,destination:observed.url,reason:error.message,rechecked:true};
        }
        if(budget.requests===before)budget.requests++;
        if(r.status!==200||typeof r.body!=='string'||Buffer.byteLength(r.body,r.encoding??'utf8')>limits.bytes)throw new Error('Support response status/byte bound');
        const url=sourceURL(r.url),mime=r.headers?.['content-type']?.split(';')[0]??'text/html';
        const payload={url,status:r.status,mime,body:r.body,...r.encoding?{encoding:r.encoding}:{}},hash=digest(JSON.stringify(payload));
        const capture=(await db.query("insert into scout.evidence(tracker_id,url,content_hash,content,parsed,last_seen_at) values($1,$2,$3,$4,$5,clock_timestamp()) "+
          "on conflict(record_id,tracker_id,url,content_hash) do update set last_seen_at=excluded.last_seen_at returning *",
          [source.tracker_id,url,hash,JSON.stringify(payload),JSON.stringify({document:{identity:'support:'+link.url}})])).rows[0];
        const ref=await trace.capture(capture);
        Object.assign(result,{capture_id:capture.id,hash,url});
        if(!['text/html','application/xhtml+xml','application/json','text/plain','application/pdf','text/calendar'].includes(mime)){
          Object.assign(result,{state:'unsupported',capture_id:capture.id,hash,url,reason:'Unsupported support MIME type: '+mime});
          await trace.finish(op,'skipped',{artifacts:[ref],note:result.reason});
        }else{
        const version=link.actors?'support-bsky-profiles-v2':link.meeting?'support-cbd-meeting-v1':link.session?'support-cbd-session-v1':link.hosts?'support-cbd-hosts-v1':mime==='application/pdf'?'support-pdf-v1':mime==='text/calendar'?'support-ical-v1':/\.qualtrics\.com$/.test(new URL(url).hostname)?'qualtrics-public-page-v1':['text/html','application/xhtml+xml'].includes(mime)?'support-html-publication-contact-v1':PREPARATION_VERSION;
        let clean=capture.parsed.document.prepared_versions?.[version];
        if(!clean){
          let body=r.body;
          if(link.actors){
            const expected='https://public.api.bsky.app/xrpc/app.bsky.actor.getProfiles?'+new URLSearchParams(link.actors.map(did=>['actors',did])),profiles=JSON.parse(body).profiles;
            if(link.relationship!=='profile'||url!==expected||mime!=='application/json'||!link.actors.length||link.actors.length>10||new Set(link.actors).size!==link.actors.length||!Array.isArray(profiles)||profiles.length!==link.actors.length||new Set(profiles.map(p=>p.did)).size!==profiles.length||profiles.some(p=>!link.actors.includes(p.did)||typeof p.handle!=='string'))throw new Error('Linked Bluesky profile identity conflict');
            body=JSON.stringify(profiles.map(p=>Object.fromEntries(['did','handle','displayName','description'].filter(k=>typeof p[k]==='string').map(k=>[k,p[k]]))),null,2);
          }
          if(mime==='text/calendar'){
            const lines=body.replace(/\r\n[ \t]/g,'').split(/\r?\n/).filter(Boolean),stack=[];
            for(const line of lines){if(line.startsWith('BEGIN:'))stack.push(line.slice(6));else if(line.startsWith('END:')&&stack.pop()!==line.slice(4))throw new Error('ICS component boundary conflict');}
            if(lines[0]!=='BEGIN:VCALENDAR'||lines.at(-1)!=='END:VCALENDAR'||stack.length)throw new Error('Incomplete ICS document');
          }
          if(mime==='application/pdf'){
            if(r.encoding!=='base64')throw new Error('Exact PDF bytes unavailable');
            const {getDocument}=await import('pdfjs-serverless');
            const task=getDocument({data:new Uint8Array(Buffer.from(body,'base64')),isEvalSupported:false,useSystemFonts:false});
            try{
              const pdf=await task.promise;
              if(pdf.numPages>30)throw new Error('Support PDF exceeds 30-page bound');
              const pages=[];
              for(let page=1;page<=pdf.numPages;page++){
                if(Date.now()>=budget.deadline)throw new Error('Support PDF preparation time bound');
                const text=await (await pdf.getPage(page)).getTextContent();
                pages.push('Page '+page+'\n'+text.items.map(item=>item.str??'').join(' '));
              }
              if(!pages.some(page=>page.replace(/^Page \d+\s*/,'').trim()))throw new Error('PDF has no readable text layer; image/OCR evidence remains unavailable');
              body=pages.join('\n\n');
            }finally{await task.destroy();}
          }
          if(link.actors){
            clean=prepareCbdPayload({id:'support:profile:'+link.actors.join(','),url,raw:r.body,rows:JSON.parse(body),task:{kind:'profile'},provenance:[],sourceURL}).prepared;
            clean.omissions.push({path:'$.profiles',reason:'Only public identity/affiliation fields rendered; transport metrics and profile timestamps retained in raw'});
          }else if(link.session||link.meeting||link.hosts){
            const rows=JSON.parse(body);
            if(mime!=='application/json'||!Array.isArray(rows)||!rows.length||rows.some(row=>link.meeting?row._id!==link.meeting:link.hosts?!link.hosts.includes(row._id):row.sideEvent?.id!==+link.session||typeof row.sideEvent.description!=='string'))throw new Error('Linked CBD '+(link.meeting?'meeting':link.hosts?'host':'session')+' identity/description conflict');
            clean=prepareCbdPayload({id:'support:'+ (link.meeting?'meeting:':link.hosts?'host:':'session:')+(link.meeting??link.hosts?.join(',')??link.session),url,raw:body,rows,task:{kind:link.meeting?'meeting':link.hosts?'organizer':'session',id:link.meeting??link.hosts?.join(',')??link.session},provenance:[],sourceURL}).prepared;
            if(link.meeting)clean.meeting_identity={id:link.meeting,title:rows[0].Title?.en,venue:rows[0].Venue?.en};
          }else{
            const html=['application/json','text/plain','application/pdf','text/calendar'].includes(mime)?'<pre>'+body.replaceAll('&','&amp;').replaceAll('<','&lt;')+'</pre>':body;
            const title=DomUtils.textContent(DomUtils.getElementsByTagName('title',parseDocument(html).children)[0]??{children:[]})||url;
            clean=prepareDocument({url,title,html,protectedContacts:true});
          }
          clean.version=version;
          if(mime==='application/pdf')clean.offset_basis='PDF text-layer item order with generated page markers; ranges refer to prepared UTF-16 text, not original HTML.';
          await db.query("update scout.evidence set parsed=jsonb_set(parsed,'{document,prepared_versions}',coalesce(parsed#>'{document,prepared_versions}','{}')||jsonb_build_object($2::text,$3::jsonb)) where id=$1",[capture.id,version,JSON.stringify(clean)]);
        }
        Object.assign(result,{state:'fetched',capture_id:capture.id,hash,url,prepared:clean});
        const artifact=await trace.artifact('preparation','Cleaned supporting document',undefined,{source_id:capture.id,content_hash:hash,preparation_version:version});
        await trace.finish(op,'pass',{artifacts:[ref,artifact],note:'Payload and cleaned support retained. Links from this page are not followed.'});
        }
      }catch(error){
        if(budget.requests===before)budget.requests++;
        result.reason=error.message;await trace.finish(op,'fail',{note:'Support unavailable: '+error.message});
      }
    }
    coverage.push({...relation,...Object.fromEntries(Object.entries(result).filter(([k])=>k!=='prepared'))});
    if(result.state==='fetched'&&!documents.some(d=>d.capture_id===result.capture_id))
      documents.push({id:'S'+documents.length,capture_id:result.capture_id,hash:result.hash,url:result.url,relationship:link.relationship,via:relation,preparation_version:result.prepared.version,prepared:result.prepared});
    if(link.session&&result.state==='fetched'){
      const meetings=[...new Set(result.prepared.blocks.filter(b=>b.source_paths?.some(path=>/\.(?:sideEvent|location)\.conference$/.test(path))).map(b=>result.prepared.text.slice(...b.value_range)))];
      if(meetings.length===1&&/^[a-f0-9]{24}$/.test(meetings[0])){
        const url=sourceURL('https://api.cbd.int/api/v2016/conferences?'+new URLSearchParams({q:JSON.stringify({_id:{$oid:meetings[0]}}),f:JSON.stringify({Title:1,Description:1,Venue:1})}));
        if(!queue.some(next=>next.url===url))queue.splice(queue.indexOf(link)+1,0,{url,target:url,meeting:meetings[0],source_reference:link.target,relationship:'meeting',label:'Referenced CBD meeting identity',context:'Conference ID retained in '+link.url+'. Parent meeting dates are not session dates.'});
      }
      const hosts=[...new Set(result.prepared.blocks.filter(b=>b.source_paths?.some(path=>/\.sideEvent\.hostOrgs\[\d+\]$/.test(path))).map(b=>result.prepared.text.slice(...b.value_range)))];
      if(hosts.length&&hosts.length<=10&&hosts.every(id=>/^[a-f0-9]{24}$/.test(id))){
        const url=sourceURL('https://api.cbd.int/api/v2016/inde-orgs?'+new URLSearchParams({q:JSON.stringify({_id:{$in:hosts.sort().map(id=>({$oid:id}))}}),f:JSON.stringify({title:1,acronym:1})}));
        if(!queue.some(next=>next.url===url))queue.splice(queue.indexOf(link)+1+Number(queue[queue.indexOf(link)+1]?.relationship==='meeting'),0,{url,target:url,hosts,source_reference:link.target,relationship:'organizer',label:'Referenced CBD host organizations',context:'Literal sideEvent.hostOrgs references retained in '+link.url+'; returned names must match these IDs for this same session.'});
      }else if(hosts.length)coverage.push({from:source.id,relationship:'organizer',state:'unsupported',reason:'CBD host references lack a bounded unambiguous public-registry lookup'});
    }
  }
  // Response framing can change while quoted support text stays identical.
  // Proofs still use the current raw captures; only the resume key uses prepared content.
  context=digest(JSON.stringify({primary:source.content_hash,documents:documents.map(d=>({url:d.url,relationship:d.relationship,via:d.via,preparation_version:d.preparation_version,title:d.prepared.title,text:d.prepared.text,source_fields:d.prepared.blocks.flatMap(b=>b.source_fields??[])}))}));
  const combined={...prepared,documents,context,coverage};
  const artifact=await trace.artifact('support_coverage','Primary/support relationships, versions and coverage',{context,documents:documents.map(({prepared,...d})=>d),links:coverage});
  const op=await trace.start('prepare',{source_ids:[source.id],artifacts:[artifact],note:'Bounded one-hop support context; every omitted/failed destination remains explicit.'});
  await trace.finish(op,'pass');
  return combined;
}

// Opt-in fetch/prepare route. No call into the legacy scripted assessment/save
// path: every ready document, including unchanged pending work, is returned.
export async function collectDocuments(db,{tracker,read,sourceURL,now,since,deadline,limits,process=false,model,makeModel,documentVersion=DOCUMENT_VERSION,retrieve,path='octo',rotation=false,runId}) {
  const run=runId?{id:runId}:(await db.query('insert into scout.collection_runs(tracker_id,started_at,stats) values($1,$2,$3::jsonb) returning id',[tracker.id,now(),JSON.stringify({validation:!rotation,documents_only:!process})])).rows[0];
  const trace=await startReport(db,run.id,path+(process?'-records':'-documents'));
  const budget={requests:0,deadline:Math.min(deadline,Date.now()+limits.seconds*1000)};
  const stats={documents:0,prepared:0,reused:0,feed_only:0,failed:0,fetch_failed:0,fetch_succeeded:0,uncertain:0,unfetched:0,processed:0,created:0,changed:0,warnings:[...process||rotation?[]:['Fetch/prepare only; generation, validation/repair and record saving are not requested.'],path==='octo'?'One RSS page; archives/media remain unfetched.':'Bounded source retrieval; inspect source coverage for failed/deferred items and unvisited pages.','Incidental links retained as citations/metadata; no support expansion.']};
  const ready=[],inventory=[];
  async function fetchDocument(url,withHeaders=false){
    const op=await trace.start('fetch',{url});
    if(budget.requests>=limits.requests||Date.now()>=budget.deadline){await trace.finish(op,'skipped',{note:'Shared request/time bound; document not fetched.'});return {op,error:'Shared request/time bound'};}
    const before=budget.requests;
    try{
      const response=await read(url,budget);
      if(budget.requests===before)budget.requests++;
      stats[response.status===200?'fetch_succeeded':'fetch_failed']++;
      if(!withHeaders&&response.status!==200||typeof response.body!=='string'||Buffer.byteLength(response.body)>limits.bytes)throw new Error('Response status/byte bound');
      return {op,response:{url:response.url,status:response.status,body:response.body,...withHeaders?{headers:response.headers}:{}}}; // Headers are for parser checks only.
    }catch{if(budget.requests===before)budget.requests++;stats.fetch_failed++;await trace.finish(op,'fail',{note:'Source retrieval failed or exceeded a guard; no response retained.'});return {op,error:'Source retrieval failed or exceeded a guard'};}
  }
  try{
    let selected,plan,retrievalFailed=false;
    const resumed=rotation&&process?(await db.query(`select latest.* from (
      select distinct on(parsed#>>'{document,identity}') * from scout.evidence
      where tracker_id=$1 and record_id is null and parsed#>>'{document,identity}' like $2
      order by parsed#>>'{document,identity}',last_seen_at desc,id
    ) latest cross join lateral (select parsed#>array['document','processing_versions',parsed#>>'{document,processing,version}'] state) p
    where parsed#>>'{document,preparation,state}'='complete' and coalesce(parsed#>>'{document,feed_only}','false')<>'true'
      and coalesce(parsed#>>'{document,conflicted}','false')<>'true'
      and (starts_with(parsed#>>'{document,processing,version}',$3) or
        parsed#>>'{document,processing,version}' is null and parsed#>>'{document,conflicted}'='false')
      and coalesce(p.state->>'state','pending') not in ('complete','uncertain') and coalesce(p.state->>'exhausted','false')<>'true'
    order by p.state->>'attempted_at' asc nulls first,collected_at,id limit 1`,[tracker.id,path+':%',documentVersion+'/'])).rows:[];
    if(resumed.length){
      selected=resumed.map(source=>({id:source.parsed.document.id,url:source.url,source}));
      stats.resumed=true;
      plan=await trace.artifact('coverage','Retained processing turn',{source_ids:resumed.map(s=>s.id),freshness:'Stored capture only; source observation timestamps are unchanged.'});
    }else if(retrieve){
      const previous=(await db.query("select stats->'document_source' state from scout.collection_runs where tracker_id=$1 and stats ? 'document_source' order by started_at desc,id desc limit 1",[tracker.id])).rows[0]?.state??{};
      const captured=(await db.query("select distinct on(parsed#>>'{document,identity}') parsed#>>'{document,id}' id,url,"+
        " parsed#>>'{document,processing,version}' version,parsed#>array['document','processing_versions',parsed#>>'{document,processing,version}'] progress"+
        " from scout.evidence where tracker_id=$1 and record_id is null and parsed#>>'{document,identity}' like $2 order by parsed#>>'{document,identity}',last_seen_at desc,scout.evidence.id",[tracker.id,path+':%'])).rows;
      const pending=captured.filter(d=>process&&d.version?.startsWith(documentVersion+'/')&&d.progress&&!['complete','uncertain'].includes(d.progress.state)&&
        (!d.progress.exhausted||d.progress.state==='failed'&&d.progress.error?.startsWith('Two resolve repair attempts exhausted: ')&&
          d.progress.findings?.filter(f=>!f.resolution&&!f.exhausted).length>1))
        .map(d=>({id:d.id,url:d.url,state:d.progress.exhausted||d.progress.pending||d.progress.findings?.some(f=>f.pending)?'model-repair':'model-pending'}));
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
      if(entry.source){
        const source=entry.source,document=source.parsed.document;
        const prepared=document.prepared_versions?.[document.preparation.version]??document.prepared;
        const prefix=documentVersion+'/'+prepared.version+'/';
        const capture=await trace.capture(source);ready.push(source.id);stats.documents++;stats.reused++;
        const context=await supportDocuments(db,{source,prepared,trace,context:document.processing.version?.slice(prefix.length)});
        model??=makeModel?.(run.id,budget.deadline,trace);
        const result=await processDocument(db,{source,prepared:context,trace,model,deadline:budget.deadline,version:documentVersion});
        stats.created+=result.created;stats.changed+=result.changed;
        if(result.deferred)stats.deferred=result.deferred;
        if(result.state==='complete')stats.processed++;else if(result.state!=='deferred'){stats[result.state==='uncertain'?'uncertain':'failed']++;stats.warnings.push(result.error);}
        inventory.push({id:entry.id,url:source.url,source_id:source.id,state:'prepared',processing:result.state,artifacts:[capture]});continue;
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
      [tracker.id,item.url,hash,content,JSON.stringify({document:{version:preparationVersion,id:item.id,identity,conflicted:Boolean(item.conflicted),preparation:{state:'pending'},processing:{state:'pending'}}})])).rows[0];
      if(item.conflicted&&!source.parsed.document.conflicted){
        source.parsed.document.conflicted=true;
        await db.query("update scout.evidence set parsed=jsonb_set(parsed,'{document,conflicted}','true') where id=$1",[source.id]);
      }
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
        if(source.parsed.document.conflicted){
          stats.uncertain++;inventory.at(-1).processing='uncertain';
          const conflict=await trace.start('validate',{source_ids:[source.id],artifacts:refs});
          await trace.finish(conflict,'uncertain',{note:'Conflicting payloads for one source identity in this retrieval; retain all versions without choosing observation order.'});continue;
        }
        if(feedOnly){
          if(process){
            stats.failed++;inventory.at(-1).processing='failed';
            stats.warnings.push('Full announcement unavailable; retained feed snippet is discovery only.');
          }
          continue;
        }
        {
          // Raw captures remain exact. Reuse only consecutive equivalent prepared inputs;
          // a real content/context change must not resurrect older completion or repair state.
          // The upsert just refreshed source.last_seen_at, so an older revisited source cannot certify its own progress.
          const prior=previous?.parsed.document.prepared_versions?.[preparationVersion]??previous?.parsed.document.prepared,prefix=documentVersion+'/'+prepared.version+'/';
          const [priorInput,input]=[prior,prepared].map(p=>p&&({...p,links:p.links.map(({start,end,...link})=>link),
            blocks:p.blocks.map(({html_start,html_end,...block})=>block),omissions:p.omissions.map(({regions,start,end,...omission})=>omission)}));
          const equivalentInput=prior&&isDeepStrictEqual(priorInput,input);
          const equivalent=equivalentInput?
            (await db.query("with captures as (select e.id,e.last_seen_at,p.version,p.state,coalesce((p.prepared-array['links','blocks','omissions'])=($5::jsonb-array['links','blocks','omissions'])"+
              " and (select coalesce(jsonb_agg(v-'start'-'end' order by n),'[]'::jsonb) from jsonb_array_elements(p.prepared->'links') with ordinality a(v,n))=$5::jsonb->'links'"+
              " and (select coalesce(jsonb_agg(v-'html_start'-'html_end' order by n),'[]'::jsonb) from jsonb_array_elements(p.prepared->'blocks') with ordinality a(v,n))=$5::jsonb->'blocks'"+
              " and (select coalesce(jsonb_agg(v-'regions'-'start'-'end' order by n),'[]'::jsonb) from jsonb_array_elements(p.prepared->'omissions') with ordinality a(v,n))=$5::jsonb->'omissions',false) equivalent"+
              " from scout.evidence e cross join lateral (select e.parsed#>>'{document,processing,version}' version,"+
              " e.parsed#>array['document','processing_versions',e.parsed#>>'{document,processing,version}'] state,"+
              " coalesce(e.parsed#>array['document','prepared_versions',$4],e.parsed#>'{document,prepared}') prepared) p"+
              " where e.tracker_id=$1 and e.record_id is null and e.parsed#>>'{document,identity}'=$2)"+
              " select id,version,state from captures where equivalent and starts_with(version,$3) and state is not null"+
              " and (id<>$6::uuid or id=$7::uuid)"+
              " and last_seen_at>coalesce((select max(last_seen_at) from captures where not equivalent),'-infinity'::timestamptz)"+
              " order by (state->>'state'='complete') desc,last_seen_at desc,id limit 1",[tracker.id,identity,prefix,prepared.version,JSON.stringify(input),source.id,previous.id])).rows[0]:null;
          if(equivalent&&equivalent.id!==source.id){
            const state=structuredClone(equivalent.state);if(state.pending?.input)state.pending.input.source_id=source.id;
            source.parsed.document={...source.parsed.document,processing:{state:state.state,version:equivalent.version},
              processing_versions:{...source.parsed.document.processing_versions,[equivalent.version]:state}};
            await db.query("update scout.evidence set parsed=jsonb_set(parsed,'{document}',$2::jsonb) where id=$1",[source.id,JSON.stringify(source.parsed.document)]);
          }
          if(equivalentInput&&!equivalent&&previous?.parsed.document.processing.version){
            source.parsed.document={...source.parsed.document,processing:previous.parsed.document.processing,
              processing_versions:{...source.parsed.document.processing_versions,...previous.parsed.document.processing_versions}};
            await db.query("update scout.evidence set parsed=jsonb_set(parsed,'{document}',$2::jsonb) where id=$1",[source.id,JSON.stringify(source.parsed.document)]);
          }
          if(previous&&previous.content_hash!==hash&&!equivalentInput){
            source.parsed.document.processing={state:'pending',changed:true};
            await db.query("update scout.evidence set parsed=jsonb_set(parsed,'{document}',$2::jsonb) where id=$1",[source.id,JSON.stringify(source.parsed.document)]);
          }
          const complete=source.parsed.document.processing_versions?.[source.parsed.document.processing.version];
          if(complete?.state==='complete')await db.query("update scout.evidence e set last_seen_at=s.last_seen_at from scout.evidence s,jsonb_array_elements($2::jsonb) f"+
            " where s.id=$1 and e.tracker_id=s.tracker_id and e.parsed#>>'{document,identity}'=s.parsed#>>'{document,identity}'"+
            " and e.record_id=(f->>'record_id')::uuid and e.parsed->'finding'=f->'finding'",[source.id,JSON.stringify(complete.findings)]);
          if(!process||stats.deferred)continue;
          model??=makeModel?.(run.id,budget.deadline,trace);
          const context=await supportDocuments(db,{source,prepared,trace,context:equivalent?.version.slice(prefix.length),
            reuse:equivalent&&equivalent.id!==source.id?{capture_id:equivalent.id,version:equivalent.version,comparison:'Exact prepared document including URL/context/structure, text ranges and omissions; only raw HTML link/block/omission positions and region offsets excluded.'}:undefined});
          const result=await processDocument(db,{source,prepared:context,trace,model,deadline:budget.deadline,version:documentVersion,
            changed:Boolean(previous&&previous.content_hash!==hash&&!equivalentInput)});
          stats.created+=result.created;stats.changed+=result.changed;
          if(result.deferred)stats.deferred=result.deferred;
          if(result.state==='complete')stats.processed++;else if(result.state!=='deferred'){stats[result.state==='uncertain'?'uncertain':'failed']++;stats.warnings.push(result.error);}
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
    if(stats.deferred)stats.warnings.push('Model '+(['network','runtime'].includes(stats.deferred.reason)?'processing':'quota')+' deferred: '+stats.deferred.reason);
    // A successful preparation is not an end-to-end successful collection.
    const outcome=process||!rotation?(ready.length||!stats.failed?'partial':'failed'):
      stats.failed?'partial':stats.prepared?'success':'no_change';
    await db.query('update scout.collection_runs set finished_at=$2,outcome=$3,stats=stats||$4::jsonb where id=$1',[run.id,now(),outcome,JSON.stringify(stats)]);
    return {run_id:run.id,outcome,...stats,document_ids:ready};
  }catch(error){
    for(const [id,op]of Object.entries(trace.report.operations))if(op.state==='running')await trace.finish(id,'fail',{note:'Interrupted; inspect retained artifacts.'}).catch(()=>{});
    await db.query("update scout.collection_runs set finished_at=clock_timestamp(),outcome='failed' where id=$1",[run.id]).catch(()=>{});
    throw error;
  }
}
