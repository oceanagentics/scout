import { Buffer } from 'node:buffer';
import { parseDocument, DomUtils } from 'htmlparser2';
import { prepareDocument } from './octo-documents.js';

export const PREPARATION_VERSION='iddri-documents-v1';
export const IDDRI_LISTINGS=[
  'https://www.iddri.org/en/publications-and-events/high-seas?page=0',
  'https://www.iddri.org/fr/publications-et-evenements/haute-mer?page=0',
];
const hasClass=(node,name)=>(node.attribs?.class??'').split(/\s+/).includes(name);

// Caller persists the cursor even after failed attempts, and supplies known
// language editions independently. No translation merge or finding selection.
export async function retrieveIDDRIDocuments({read,sourceURL,budget,limits,knownDocuments=[],pending=[],progress={}}){
  const result={listings:[],inventory:[],documents:[],fetches:[],coverage:[],limits:{...limits},progress:{...progress}};
  const publisherURL=(value,base)=>{
    if(typeof value!=='string'||!value.trim())throw new Error('IDDRI source URL unavailable');
    const url=sourceURL(new URL(value,base).href);
    if(new URL(url).origin!=='https://www.iddri.org')throw new Error('IDDRI publisher identity unavailable');
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
      if(!/^text\/html\b/i.test(entry.mime)){entry.state='unsupported';throw new Error('Only HTML documents supported; PDF/media not prepared');}
      if(!/<\/html>\s*$/i.test(response.body.replace(/<!--[\s\S]*?-->/g,'')))throw new Error('Incomplete HTML document');
      const dom=parseDocument(response.body,{withStartIndices:true,withEndIndices:true});
      entry.state='fetched';return {entry,dom};
    }catch(error){entry.reason=error.message;result.coverage.push({url,state:entry.state==='unsupported'?'unsupported':'failed',reason:error.message});return null;}
    finally{if(budget.requests===before)budget.requests++;}
  }
  for(const url of IDDRI_LISTINGS){
    const response=await fetch(url);if(!response)continue;
    try{
      const main=DomUtils.getElementsByTagName('main',response.dom.children)[0];
      const links=DomUtils.getElementsByTagName('link',response.dom.children);
      const base=url.replace('?page=0','');
      if(!main||!links.some(n=>n.attribs.rel==='alternate'&&n.attribs.href===base))throw new Error('Listing source/layout identity unavailable');
      const html=response.entry.body.slice(main.startIndex,main.endIndex+1);
      result.listings.push({url,raw:response.entry.body,html,prepared:prepareDocument({title:base,url,html})});
      for(const node of DomUtils.getElementsByTagName('article',main.children).filter(n=>hasClass(n,'line-teaser'))){
        const item={via:url,raw:response.entry.body.slice(node.startIndex,node.endIndex+1),state:'listed'};
        try{
          const anchor=DomUtils.getElementsByTagName('a',node.children)[0];
          item.url=publisherURL(anchor?.attribs.href,url);item.identity='iddri:url:'+item.url;
          item.title=DomUtils.textContent(DomUtils.getElementsByTagName('h3',node.children)[0]??{children:[]}).trim();
          if(!item.title)throw new Error('Listing title unavailable');
        }catch(error){item.state='failed';item.reason=error.message;}
        result.inventory.push(item);
      }
      result.coverage.push({url,state:'partial',reason:'Page zero of English/French only; archives and further pagination unfetched',
        links:links.filter(n=>['next','prev','alternate'].includes(n.attribs.rel)).map(n=>({...n.attribs,state:'unfetched'}))});
    }catch(error){result.coverage.push({url,state:'failed',reason:error.message});}
  }
  const candidates=new Map();
  for(const item of [...knownDocuments.map(d=>({...d,via:'known',state:'listed'})),...result.inventory]){
    if(item.state!=='listed'){result.coverage.push({...item});continue;}
    try{
      item.url=publisherURL(item.url,IDDRI_LISTINGS[0]);
      if(candidates.has(item.url))result.coverage.push({url:item.url,state:'duplicate',reason:'Repeated known/listing URL'});
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
      const links=DomUtils.getElementsByTagName('link',response.dom.children);
      if(!links.some(n=>n.attribs.rel==='canonical'&&n.attribs.href===item.url))throw new Error('Canonical detail identity disagreement');
      const language=new URL(item.url).pathname.split('/')[1];
      if(!['en','fr'].includes(language)||DomUtils.getElementsByTagName('html',response.dom.children)[0]?.attribs.lang!==language)
        throw new Error('Detail language identity disagreement');
      const short=links.find(n=>n.attribs.rel==='shortlink');
      const shortURL=publisherURL(short?.attribs.href,item.url),id=new URL(shortURL).pathname.match(new RegExp('^/'+language+'/node/(\\d+)$'))?.[1];
      if(!id||item.id!=null&&String(item.id)!==id)throw new Error('Detail node identity disagreement');
      const articles=DomUtils.getElementsByTagName('article',response.dom.children).filter(n=>hasClass(n,'page-wrapper'));
      if(articles.length!==1)throw new Error('Full detail article boundary unavailable');
      const node=articles[0],title=DomUtils.textContent(DomUtils.getElementsByTagName('h1',node.children)[0]??{children:[]}).trim();
      const bodies=DomUtils.findAll(n=>hasClass(n,'field--name-body'),node.children);
      if(!title||!bodies.some(n=>DomUtils.textContent(n).trim()))throw new Error('Full readable body unavailable; intro/listing excerpt is insufficient');
      const structured=DomUtils.getElementsByTagName('script',response.dom.children).filter(n=>n.attribs.type==='application/ld+json');
      const html=[node,...structured].map(n=>response.entry.body.slice(n.startIndex,n.endIndex+1)).join('\n');
      const metadata=DomUtils.getElementsByTagName('meta',response.dom.children).map(n=>({...n.attribs}));
      const alternates=links.filter(n=>n.attribs.rel==='alternate').map(n=>({...n.attribs,state:'unfetched'}));
      const prepared=prepareDocument({title,url:item.url,html,htmlWhitespace:true});prepared.version=PREPARATION_VERSION;
      for(const alternate of alternates){
        try{
          const target=publisherURL(alternate.href,item.url);
          if(target!==item.url)prepared.links.push({target,label:alternate.hreflang,tag:'a',relationship:'support',context:'Publisher language alternate',state:'unfetched'});
        }catch(error){result.coverage.push({from:item.url,url:alternate.href,state:'unsupported',reason:error.message});}
      }
      const identity='iddri:node:'+id+':'+language;
      result.documents.push({id,identity,url:item.url,language,raw:response.entry.body,html,metadata,alternates,listing:item,prepared});
      result.coverage.push({url:item.url,identity,state:'prepared',reason:'Whole article and JSON-LD retained; no record/schedule/translation facts inferred'});
      for(const link of prepared.links)result.coverage.push({from:item.url,...link,state:'unfetched',reason:'Source-only adapter; support/registration/programme/PDF/media requires shared retrieval'});
    }catch(error){result.coverage.push({url:item.url,state:'failed',reason:error.message});}
  }
  return result;
}
