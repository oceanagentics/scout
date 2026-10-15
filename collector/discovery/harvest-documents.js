import { Buffer } from 'node:buffer';
import { parseDocument, DomUtils } from 'htmlparser2';
import { prepareDocument } from './octo-documents.js';

export const HARVEST_HOME='https://harveststrategies.org/abnj/';
export const HARVEST_WEBINARS='https://harveststrategies.org/what-are-harvest-strategies/resources-webinars/';

// One configured page and its observed webinar-index link, plus known URLs.
// Grid entries/media remain source evidence, not another crawling frontier.
export async function retrieveHarvestDocuments({read,sourceURL,budget,limits,knownDocuments=[],pending=[],progress={}}){
  const result={source:HARVEST_HOME,inventory:[],documents:[],fetches:[],coverage:[],limits:{...limits},progress:{...progress}};
  const publisherURL=(value,base=HARVEST_HOME)=>{
    if(typeof value!=='string'||!value.trim())throw new Error('Harvest source URL unavailable');
    const url=sourceURL(new URL(value,base).href);
    if(new URL(url).origin!=='https://harveststrategies.org')throw new Error('Harvest publisher identity unavailable');
    return url;
  };
  async function fetch(url){
    if(budget.requests>=limits.requests||Date.now()>=budget.deadline){result.coverage.push({url,state:'deferred',reason:'Request/time limit'});return null;}
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
      if(!DomUtils.getElementsByTagName('link',dom.children).some(n=>n.attribs.rel==='canonical'&&n.attribs.href===url))
        throw new Error('Canonical publisher identity disagreement');
      entry.state='fetched';return {entry,dom};
    }catch(error){entry.reason=error.message;result.coverage.push({url,state:entry.state==='unsupported'?'unsupported':'failed',reason:error.message});return null;}
    finally{if(budget.requests===before)budget.requests++;}
  }
  function document(response,item){
    const body=DomUtils.getElementsByTagName('body',response.dom.children)[0];
    const id=body?.attribs.class?.match(/\b(?:page-id|postid)-(\d+)\b/)?.[1];
    if(!id||item.id!=null&&String(item.id)!==id)throw new Error('Harvest page identity unavailable/disagrees with known ID');
    const nodes=DomUtils.findAll(n=>n.attribs?.id==='hrv-content',response.dom.children);
    if(nodes.length!==1||!DomUtils.textContent(nodes[0]).trim())throw new Error('Whole readable publisher content boundary unavailable');
    const node=nodes[0],title=DomUtils.textContent(DomUtils.getElementsByTagName('title',response.dom.children)[0]??{children:[]}).trim();
    const structured=DomUtils.getElementsByTagName('script',response.dom.children).filter(n=>n.attribs.type==='application/ld+json');
    const html=[node,...structured].map(n=>response.entry.body.slice(n.startIndex,n.endIndex+1)).join('\n');
    const prepared=prepareDocument({title,url:item.url,html});
    for(const link of prepared.links)result.coverage.push({from:item.url,...link,state:'unfetched',reason:'Registration/recording/attachment/support retained as link metadata; not fetched'});
    for(const grid of DomUtils.getElementsByTagName('li',node.children).filter(n=>/\beg-post-id-\d+\b/.test(n.attribs.class??''))){
      const anchors=DomUtils.getElementsByTagName('a',grid.children);
      result.inventory.push({id:grid.attribs.class.match(/\beg-post-id-(\d+)\b/)[1],via:item.url,
        raw:response.entry.body.slice(grid.startIndex,grid.endIndex+1),metadata:{...grid.attribs},
        links:anchors.map(n=>{
          const link={label:DomUtils.textContent(n).trim(),raw:n.attribs.href,state:'unfetched'};
          try{if(!n.attribs.href)throw new Error('Grid link URL unavailable');link.target=sourceURL(new URL(n.attribs.href,item.url).href);}
          catch(error){link.state='unsupported';link.reason=error.message;}
          return link;
        }),
        state:'unfetched',reason:'Embedded grid material retained in parent; individual documents/media not fetched in this pass'});
    }
    return {id,identity:'harvest:document:'+id,url:item.url,raw:response.entry.body,html,
      metadata:DomUtils.getElementsByTagName('meta',response.dom.children).map(n=>({...n.attribs})),listing:item,prepared};
  }
  const home=await fetch(HARVEST_HOME);
  const candidates=new Map();
  if(home){
    try{
      result.documents.push(document(home,{url:HARVEST_HOME,via:'configured'}));
      const link=DomUtils.getElementsByTagName('a',home.dom.children).find(n=>n.attribs.href===HARVEST_WEBINARS);
      if(link)candidates.set(HARVEST_WEBINARS,{url:HARVEST_WEBINARS,via:HARVEST_HOME,raw:home.entry.body.slice(link.startIndex,link.endIndex+1)});
      else result.coverage.push({url:HARVEST_WEBINARS,state:'unfetched',reason:'Webinar-index link not observed in configured page'});
      result.coverage.push({url:HARVEST_HOME,state:'partial',reason:'Whole configured page retained; one observed webinar index only; other site pages, grid details, archives, attachments and media unfetched'});
    }catch(error){result.coverage.push({url:HARVEST_HOME,state:'failed',reason:error.message});}
  }
  for(const item of knownDocuments){
    try{
      const url=publisherURL(item.url);
      if(url===HARVEST_HOME)continue;
      if(candidates.has(url))result.coverage.push({url,state:'duplicate',reason:'Repeated known/index URL'});
      candidates.set(url,{...item,url,via:'known'});
    }catch(error){result.coverage.push({url:item.url,state:'unsupported',reason:error.message});}
  }
  const ordered=[...candidates.values()].sort((a,b)=>a.url<b.url?-1:a.url>b.url?1:0);
  const queue=typeof progress.after_url==='string'?[...ordered.filter(d=>d.url>progress.after_url),...ordered.filter(d=>d.url<=progress.after_url)]:ordered;
  const priority=new Map(pending.filter(d=>['model-repair','model-pending'].includes(d.state)).map(d=>[d.url,d.state==='model-repair'?0:1]));
  queue.sort((a,b)=>(priority.get(a.url)??2)-(priority.get(b.url)??2)); // Reorder existing known/listed candidates only.
  let selected=0;
  for(const item of queue){
    if(selected++>=limits.documents){result.coverage.push({url:item.url,state:'deferred',reason:'Detail document limit'});continue;}
    const before=result.fetches.length,response=await fetch(item.url);
    if(result.fetches.length>before)result.progress.after_url=item.url;
    if(!response)continue;
    try{
      const doc=document(response,item);result.documents.push(doc);
      result.coverage.push({url:item.url,identity:doc.identity,state:'prepared',reason:'Whole publisher page/JSON-LD retained; no session, date or record eligibility inferred'});
    }catch(error){result.coverage.push({url:item.url,state:'failed',reason:error.message});}
  }
  return result;
}
