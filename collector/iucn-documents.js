import { Buffer } from 'node:buffer';
import { parseDocument, DomUtils } from 'htmlparser2';
import { prepareDocument } from './octo-documents.js';

export const IUCN_LISTING='https://iucn.org/our-work/topic/high-seas';
export const PREPARATION_VERSION='iucn-documents-v1';
const hasClass=(node,name)=>(node.attribs?.class??'').split(/\s+/).includes(name);

// Source-only adapter; the caller owns captures, reporting and model stages.
// Persist progress after failures too, and keep unlisted known URLs supplied.
export async function retrieveIUCNDocuments({read,sourceURL,budget,limits,knownDocuments=[],pending=[],progress={}}){
  const result={source:IUCN_LISTING,inventory:[],documents:[],fetches:[],coverage:[],limits:{...limits},progress:{...progress}};
  const publisherURL=value=>{
    if(typeof value!=='string'||!value.trim())throw new Error('IUCN source URL unavailable');
    const url=sourceURL(new URL(value,IUCN_LISTING).href);
    if(new URL(url).origin!=='https://iucn.org')throw new Error('IUCN publisher identity unavailable');
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
      if(!/^text\/html\b/i.test(entry.mime)){entry.state='unsupported';throw new Error('Only HTML readable documents supported; media/PDF payload not prepared');}
      if(!/<\/html>\s*$/i.test(response.body.replace(/<!--[\s\S]*?-->/g,'')))throw new Error('Incomplete HTML document');
      const dom=parseDocument(response.body,{withStartIndices:true,withEndIndices:true});
      if(!DomUtils.getElementsByTagName('link',dom.children).some(n=>n.attribs.rel==='canonical'&&n.attribs.href===url))
        throw new Error('Canonical publisher identity unavailable');
      entry.state='fetched';return {entry,dom};
    }catch(error){entry.reason=error.message;result.coverage.push({url,state:entry.state==='unsupported'?'unsupported':'failed',reason:error.message});return null;}
    finally{if(budget.requests===before)budget.requests++;}
  }
  const home=await fetch(IUCN_LISTING);
  if(home){
    try{
      const main=DomUtils.getElementsByTagName('main',home.dom.children)[0];
      if(!main)throw new Error('Topic main content unavailable');
      const html=home.entry.body.slice(main.startIndex,main.endIndex+1);
      result.listing={url:IUCN_LISTING,raw:home.entry.body,html,prepared:prepareDocument({title:'High Seas',url:IUCN_LISTING,html})};
      const scopes=DomUtils.findAll(n=>hasClass(n,'wrapper-title')||hasClass(n,'comp-featured-content'),main.children);
      for(const scope of scopes){
        for(const anchor of DomUtils.getElementsByTagName('a',scope.children).filter(n=>hasClass(scope,'wrapper-title')||hasClass(n,'primary-link'))){
          const item={title:DomUtils.textContent(anchor).trim(),raw:home.entry.body.slice(scope.startIndex,scope.endIndex+1),
            via:hasClass(scope,'wrapper-title')?'listing':'featured',state:'listed'};
          try{item.url=publisherURL(anchor.attribs.href);item.identity='iucn:url:'+item.url;}
          catch(error){item.state='unsupported';item.reason=error.message;}
          result.inventory.push(item);
        }
      }
      result.coverage.push({url:IUCN_LISTING,state:'partial',reason:'One topic listing and featured cards; archives/pagination, PDFs and support links are not traversed',links:result.listing.prepared.links});
    }catch(error){result.coverage.push({url:IUCN_LISTING,state:'failed',reason:error.message});}
  }
  const candidates=new Map();
  for(const item of [...knownDocuments.map(d=>({...d,via:'known',state:'listed'})),...result.inventory]){
    if(item.state!=='listed'){result.coverage.push({...item});continue;}
    try{
      item.url=publisherURL(item.url);
      const prior=candidates.get(item.url);
      if(prior)result.coverage.push({url:item.url,state:'duplicate',reason:'Repeated known/listing URL'});
      else candidates.set(item.url,item);
    }catch(error){result.coverage.push({url:item.url,state:'unsupported',reason:error.message});}
  }
  const ordered=[...candidates.values()].sort((a,b)=>a.url<b.url?-1:a.url>b.url?1:0);
  const queue=typeof progress.after_url==='string'?[...ordered.filter(d=>d.url>progress.after_url),...ordered.filter(d=>d.url<=progress.after_url)]:ordered;
  const priority=new Map(pending.filter(d=>['model-repair','model-pending'].includes(d.state)).map(d=>[d.url,d.state==='model-repair'?0:1]));
  queue.sort((a,b)=>(priority.get(a.url)??2)-(priority.get(b.url)??2)); // Prioritize only existing known/listed candidates.
  let selected=0;
  for(const item of queue){
    if(selected++>=limits.documents){result.coverage.push({url:item.url,state:'deferred',reason:'Document limit'});continue;}
    const before=result.fetches.length,response=await fetch(item.url);
    if(result.fetches.length>before)result.progress.after_url=item.url;
    if(!response)continue;
    try{
      const articles=DomUtils.getElementsByTagName('article',response.dom.children).filter(n=>/^\d+$/.test(n.attribs['data-history-node-id']??''));
      if(articles.length!==1)throw new Error('Full detail node identity unavailable');
      const node=articles[0],id=node.attribs['data-history-node-id'];
      if(item.id!=null&&String(item.id)!==id)throw new Error('Known node identity changed');
      const shortlinks=DomUtils.getElementsByTagName('link',response.dom.children).filter(n=>n.attribs.rel==='shortlink');
      if(!shortlinks.some(n=>publisherURL(n.attribs.href).endsWith('/node/'+id)))throw new Error('Detail shortlink/node identity disagreement');
      const title=DomUtils.textContent(DomUtils.getElementsByTagName('h1',node.children)[0]??{children:[]}).trim();
      const bodies=DomUtils.findAll(n=>hasClass(n,'field--name-field-body'),node.children);
      if(!title||bodies.length!==1||!DomUtils.textContent(bodies[0]).trim())throw new Error('Full readable detail body unavailable; listing/lead excerpt is insufficient');
      const containers=DomUtils.findAll(n=>hasClass(n,'content-body'),node.children),primary=containers.length===1?containers[0].parent:null;
      if(!primary||!(hasClass(node,'node--type-article')&&hasClass(primary,'col-md-10')||hasClass(node,'node--type-resource')&&hasClass(primary,'main-section'))||
        DomUtils.getElementsByTagName('h1',primary.children).length!==1||
        !DomUtils.findAll(n=>n===bodies[0],primary.children).length||DomUtils.findAll(n=>hasClass(n,'comp-featured-content'),primary.children).length)
        throw new Error('Primary body/header boundary unavailable or ambiguous');
      const sections=[primary,...DomUtils.findAll(n=>hasClass(n,'article-interactive-story')||hasClass(n,'resource-interactive-component'),node.children)
        .filter(n=>n.startIndex>primary.endIndex||n.endIndex<primary.startIndex)].sort((a,b)=>a.startIndex-b.startIndex);
      const regions=sections.map(n=>({start:n.startIndex,end:n.endIndex+1}));
      const html=regions.map(r=>response.entry.body.slice(r.start,r.end)).join('\n');
      const metadata=DomUtils.getElementsByTagName('meta',response.dom.children).map(n=>({...n.attribs}));
      const prepared=prepareDocument({title,url:item.url,html});prepared.version=PREPARATION_VERSION;
      prepared.omissions.push({reason:'Primary header, lead, body, media and resource metadata retained; breadcrumbs, sharing, taxonomy and related cards excluded; full response retained',regions});
      result.documents.push({id,identity:'iucn:node:'+id,url:item.url,raw:response.entry.body,html,regions,metadata,node_attributes:{...node.attribs},listing:item,prepared});
      result.coverage.push({url:item.url,identity:'iucn:node:'+id,state:'prepared',reason:'Whole primary announcement retained; related cards excluded and embedded links unfetched',links:prepared.links});
    }catch(error){result.coverage.push({url:item.url,state:'failed',reason:error.message});}
  }
  return result;
}
