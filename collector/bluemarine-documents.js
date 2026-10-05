import { Buffer } from 'node:buffer';
import { parseDocument, DomUtils } from 'htmlparser2';
import { prepareDocument } from './octo-documents.js';

export const BLUE_MARINE_LISTING='https://www.bluemarinefoundation.com/our-events/';
const hasClass=(node,name)=>(node.attribs?.class??'').split(/\s+/).includes(name);

// One structural listing; no keyword/year/badge eligibility or session splits.
// Caller persists the cursor after failures and supplies unlisted known URLs.
export async function retrieveBlueMarineDocuments({read,sourceURL,budget,limits,knownDocuments=[],pending=[],progress={},now=Date.now}){
  if(['documents','requests','bytes'].some(k=>!Number.isSafeInteger(limits[k])||limits[k]<1))throw new Error('Invalid Blue Marine retrieval bounds');
  const result={source:BLUE_MARINE_LISTING,inventory:[],documents:[],fetches:[],coverage:[],pending:[],limits:{...limits},progress:{...progress}};
  const publisherURL=(value,base=BLUE_MARINE_LISTING)=>{
    if(typeof value!=='string'||!value.trim())throw new Error('Blue Marine source URL unavailable');
    const url=sourceURL(new URL(value,base).href);
    if(new URL(url).origin!=='https://www.bluemarinefoundation.com')throw new Error('Blue Marine publisher identity unavailable');
    return url;
  };
  async function fetch(url){
    if(budget.requests>=limits.requests||now()>=budget.deadline){result.coverage.push({url,state:'deferred',reason:'Request/time limit'});return null;}
    const entry={requested_url:url,state:'failed'};result.fetches.push(entry);
    const before=budget.requests;
    try{
      const response=await read(sourceURL(url),budget);
      Object.assign(entry,{url:response.url,status:response.status,mime:response.headers?.['content-type']??'',body:response.body});
      if(response.url!==url||response.status!==200||typeof response.body!=='string'||Buffer.byteLength(response.body)>limits.bytes)
        throw new Error('Response identity/status/byte bound');
      if(!/^text\/html\b/i.test(entry.mime)){entry.state='unsupported';throw new Error('Unsupported response format; PDF/media not prepared');}
      if(!/<\/html>\s*$/i.test(response.body.replace(/<!--[\s\S]*?-->/g,'')))throw new Error('Incomplete HTML document');
      const dom=parseDocument(response.body,{withStartIndices:true,withEndIndices:true});
      if(!DomUtils.getElementsByTagName('link',dom.children).some(n=>n.attribs.rel==='canonical'&&n.attribs.href===url))throw new Error('Canonical publisher identity disagreement');
      entry.state='fetched';return {entry,dom};
    }catch(error){entry.reason=error.message;result.coverage.push({url,state:entry.state==='unsupported'?'unsupported':'failed',reason:error.message});return null;}
    finally{if(budget.requests===before)budget.requests++;}
  }
  const listing=await fetch(BLUE_MARINE_LISTING);
  if(listing){
    try{
      const mains=DomUtils.getElementsByTagName('main',listing.dom.children),main=mains[0];
      if(mains.length!==1)throw new Error('Listing main boundary unavailable');
      const html=listing.entry.body.slice(main.startIndex,main.endIndex+1);
      result.listing={url:BLUE_MARINE_LISTING,raw:listing.entry.body,html,prepared:prepareDocument({title:'Our events',url:BLUE_MARINE_LISTING,html})};
      for(const node of DomUtils.getElementsByTagName('article',main.children)){
        const item={raw:listing.entry.body.slice(node.startIndex,node.endIndex+1),via:BLUE_MARINE_LISTING,state:'listed'};
        try{
          const anchor=DomUtils.getElementsByTagName('a',node.children)[0];
          item.url=publisherURL(anchor?.attribs.href);
          const heading=DomUtils.findAll(n=>hasClass(n,'featureCard__title')||hasClass(n,'cards__title'),node.children)[0];
          item.title=DomUtils.textContent(heading??anchor??{children:[]}).trim();item.identity='bluemarine:url:'+item.url;
          if(!item.title)throw new Error('Listing document title unavailable');
        }catch(error){item.state='failed';item.reason=error.message;}
        result.inventory.push(item);
      }
      result.coverage.push({url:BLUE_MARINE_LISTING,state:'partial',reason:'One listing only; older archive pages, other languages, attachments and external support unfetched',links:result.listing.prepared.links});
    }catch(error){result.coverage.push({url:BLUE_MARINE_LISTING,state:'failed',reason:error.message});}
  }
  const candidates=new Map();
  for(const item of [...result.inventory,...knownDocuments,...pending]){
    if(item.state==='failed'&&result.inventory.includes(item)){result.coverage.push({...item});continue;}
    try{
      const url=publisherURL(item.url),parsed=new URL(url);
      if(parsed.search||!/^\/our-events\/[^/]+\/$/.test(parsed.pathname))throw new Error('Outside associated announcement routes; support remains metadata');
      const id=item.id==null?undefined:String(item.id).replace(/^bluemarine:document:/,'');
      if(id!=null&&!/^\d+$/.test(id))throw new Error('Unsupported Blue Marine native source identity');
      const prior=candidates.get(url),states=[prior?.pending_state,item.state,item.pending_state];
      if(prior)result.coverage.push({url,state:'duplicate',reason:'Repeated known/pending/listing URL'});
      candidates.set(url,{...prior,...item,id:id??prior?.id,url,via:prior?.via??item.via??'known',
        pending_state:states.includes('model-repair')?'model-repair':states.includes('model-pending')?'model-pending':undefined});
    }catch(error){result.coverage.push({url:item.url,state:'unsupported',reason:error.message});}
  }
  const ordered=[...candidates.values()].sort((a,b)=>a.url<b.url?-1:a.url>b.url?1:0);
  const queue=typeof progress.after_url==='string'?[...ordered.filter(d=>d.url>progress.after_url),...ordered.filter(d=>d.url<=progress.after_url)]:ordered;
  const priority={'model-repair':0,'model-pending':1};
  queue.sort((a,b)=>(priority[a.pending_state]??2)-(priority[b.pending_state]??2));
  let selected=0;
  for(const item of queue){
    if(selected++>=limits.documents){const deferred={...item,state:'deferred',reason:'Document limit'};result.coverage.push(deferred);result.pending.push(deferred);continue;}
    const before=result.fetches.length,response=await fetch(item.url);
    if(result.fetches.length>before)result.progress.after_url=item.url;
    if(!response){const failure=result.coverage.at(-1);result.pending.push({...item,...failure,...result.fetches.length>before?{last_failure:{state:failure.state,reason:failure.reason}}:{}});continue;}
    try{
      const id=DomUtils.getElementsByTagName('body',response.dom.children)[0]?.attribs.class?.match(/\bpostid-(\d+)\b/)?.[1];
      if(!id||item.id!=null&&String(item.id)!==id)throw new Error('Detail post identity unavailable/disagrees with known ID');
      const links=DomUtils.getElementsByTagName('link',response.dom.children);
      if(!links.some(n=>n.attribs.rel==='shortlink'&&new URL(publisherURL(n.attribs.href,item.url)).searchParams.get('p')===id))throw new Error('Detail shortlink/post identity disagreement');
      const mains=DomUtils.getElementsByTagName('main',response.dom.children),main=mains[0];
      const banners=DomUtils.findAll(n=>hasClass(n,'page-banner'),main?.children??[]);
      const content=DomUtils.findAll(n=>n.attribs?.id==='post-content',main?.children??[]);
      const bodies=content.flatMap(n=>DomUtils.findAll(b=>hasClass(b,'postContent'),n.children));
      const headings=DomUtils.getElementsByTagName('h1',banners[0]?.children??[]),title=DomUtils.textContent(headings[0]??{children:[]}).trim();
      if(mains.length!==1||banners.length!==1||banners[0].parent!==main||content.length!==1||content[0].parent!==main||headings.length!==1||!title||!bodies.some(n=>DomUtils.textContent(n).trim()))throw new Error('Full detail body/title boundary unavailable; cards/excerpts are insufficient');
      const structured=DomUtils.getElementsByTagName('script',response.dom.children).filter(n=>n.attribs.type==='application/ld+json');
      const primary=[banners[0],content[0]];
      const regions=[...primary,...structured.filter(n=>!primary.some(p=>n.startIndex>=p.startIndex&&n.endIndex<=p.endIndex))].map(n=>({start:n.startIndex,end:n.endIndex+1}));
      const html=regions.map(r=>response.entry.body.slice(r.start,r.end)).join('\n');
      const metadata=DomUtils.getElementsByTagName('meta',response.dom.children).map(n=>({...n.attribs}));
      const alternates=links.filter(n=>n.attribs.rel==='alternate').map(n=>({...n.attribs,state:'unfetched'}));
      const prepared=prepareDocument({title,url:item.url,html}),identity='bluemarine:document:'+id;
      prepared.version='bluemarine-documents-v1'; // Primary announcement boundary differs from whole-main preparation.
      for(const alternate of alternates.filter(a=>a.hreflang)){
        try{const target=publisherURL(alternate.href,item.url);if(target!==item.url)prepared.links.push({target,label:alternate.hreflang,tag:'a',relationship:'support',context:'Publisher language alternate',state:'unfetched'});}
        catch(error){result.coverage.push({from:item.url,url:alternate.href,state:'unsupported',reason:error.message});}
      }
      result.documents.push({id,identity,url:item.url,raw:response.entry.body,html,regions,metadata,alternates,listing:item,prepared});
      result.coverage.push({url:item.url,identity,state:'prepared',reason:'Full title banner, primary post content/sidebar and JSON-LD retained; sibling related cards remain in raw HTML; no event/workshop records or schedules inferred'});
      for(const link of prepared.links)result.coverage.push({from:item.url,...link,state:'unfetched',reason:'Registration/programme/attachment/language/support retained as metadata; not opened for event extraction'});
    }catch(error){const failure={...item,state:'failed',reason:error.message,last_failure:{state:'failed',reason:error.message}};result.coverage.push(failure);result.pending.push(failure);}
  }
  return result;
}
