import { isDeepStrictEqual } from 'node:util';
import { parseDocument, DomUtils } from 'htmlparser2';
import { prepareDocument } from './octo-documents.js';

export const DOALOS='https://www.un.org/bbnjagreement/en';
export const NOTIFICATIONS=DOALOS+'/notifications';
export const PREPARATION_VERSION='doalos-documents-v1';
const classes=node=>(node.attribs?.class??'').split(/\s+/);

export function prepareDoalosDocument(response,{sourceURL}) {
  const url=sourceURL(response.url),u=new URL(url);
  if(u.origin!=='https://www.un.org'||!(u.pathname==='/bbnjagreement/en'||u.pathname.startsWith('/bbnjagreement/en/'))||u.search||/\.[a-z0-9]+$/i.test(u.pathname))
    throw new Error('Unsupported DOALOS HTML source');
  if(response.status!=null&&(response.status<200||response.status>=300)||!/text\/html/i.test(response.headers?.['content-type']??'')||
    typeof response.body!=='string'||!/<\/html>(?:\s|<!--[\s\S]*?-->)*$/i.test(response.body))throw new Error('DOALOS HTML status/format/integrity unavailable');
  const dom=parseDocument(response.body,{withStartIndices:true,withEndIndices:true});
  const articles=DomUtils.getElementsByTagName('article',dom.children).filter(n=>classes(n).includes('node')&&n.attribs.about);
  if(articles.length!==1)throw new Error('DOALOS article boundary missing or ambiguous');
  const article=articles[0],about=sourceURL(new URL(article.attribs.about,url).href);
  if(about!==url&&!(url===sourceURL(DOALOS)&&about===DOALOS+'/bbnj-agreement'))throw new Error('DOALOS article/source identity conflict');
  const mains=DomUtils.getElementsByTagName('main',dom.children).filter(n=>['page','content'].includes(n.attribs.id)&&n.startIndex<article.startIndex&&n.endIndex>article.endIndex);
  if(['page','content'].some(id=>mains.filter(n=>n.attribs.id===id).length>1))throw new Error('DOALOS main context boundary ambiguous');
  const region=mains.find(n=>n.attribs.id==='page')??mains[0]??article,start=region.startIndex,end=region.endIndex+1;
  const prepared=prepareDocument({title:'',html:response.body.slice(start,end),url});prepared.version=PREPARATION_VERSION;prepared.input='whole-article';
  prepared.omissions.push({start,end,reason:'Whole source article and available main heading context prepared; surrounding navigation/form/UI framing excluded; exact response retained'});
  const coverage=prepared.links.map(link=>{
    try{
      const target=new URL(link.target,url);sourceURL(target.href);
      if(target.hash&&sourceURL(target.href)===url)return {...link,relationship:'same-document-anchor',state:'retained',reason:'In-page context retained'};
      return {...link,state:/\.(?:pdf|xml|docx?|xlsx?|zip)(?:$|[?#])/i.test(target.href)?'unsupported':'unfetched',reason:'Linked attachment/support destination not fetched by this source-only adapter'};
    }catch{return {...link,state:'unsupported',reason:'Non-public-HTTPS or script/mail target retained; not executed or fetched'};}
  });
  for(const a of DomUtils.getElementsByTagName('a',article.children))if(a.attribs.rel?.split(/\s+/).includes('next')||/[?&]page=/.test(a.attribs.href??''))
    coverage.push({target:a.attribs.href,parent_url:url,relationship:'pagination',state:'unfetched',reason:'Current notification listing only; archive/pagination not followed'});
  prepared.coverage=coverage;
  return {id:'doalos:'+u.pathname,url,raw:response.body,response,regions:[{start,end}],prepared,coverage};
}

// One-hop homepage documents and the observed notification listing's links;
// arbitrary article supports are left for common support retrieval.
export async function retrieveDoalosDocuments({tracker,read,sourceURL,budget,known=[],pending=[],
  limits={documents:4,requests:6},now=Date.now}) {
  if(tracker.collector!=='web'||tracker.url!==DOALOS)throw new Error('Unsupported DOALOS tracker');
  if(!Number.isInteger(limits.documents)||limits.documents<1||!Number.isInteger(limits.requests)||limits.requests<1)throw new Error('Invalid DOALOS retrieval bounds');
  const documents=[],responses=[],coverage=[],inventory=new Map(),queue=[],knownURLs=new Set();let requests=0,blocked;
  const route=value=>{
    const url=sourceURL(value),u=new URL(url);
    if(u.origin!=='https://www.un.org'||!u.pathname.startsWith('/bbnjagreement/en/')||u.search||/\.[a-z0-9]+$/i.test(u.pathname))throw new Error('Outside DOALOS one-hop HTML retrieval routes');
    return url;
  };
  const enqueue=(value,via)=>{
    try{
      const url=route(value),existing=inventory.get(url);if(existing){if(!existing.via.some(v=>isDeepStrictEqual(v,via)))existing.via.push(via);return existing;}
      const item={id:'doalos:'+new URL(url).pathname,url,via:[via],state:'pending'};inventory.set(url,item);queue.push(item);return item;
    }catch(error){coverage.push({target:value,via,state:'unsupported',reason:error.message});}
  };
  for(const item of known){try{knownURLs.add(route(item.url));}catch{}}
  // Carry source relationships once; prior attempts stay in their run artifacts.
  for(const item of pending){
    const entry=enqueue(item.url,{relationship:'pending',previous_state:item.state,reason:item.reason});
    for(const via of item.via??[])if(via.relationship!=='pending')enqueue(item.url,via);
    if(entry&&item.last_failure)entry.last_failure=item.last_failure;
  }
  const fetch=async url=>{
    if(blocked)throw new Error(blocked);
    if(requests>=limits.requests||now()>=budget.deadline){blocked=requests>=limits.requests?'DOALOS request bound reached':'Collection time limit reached';throw new Error(blocked);}
    requests++;
    try{
      const response=await read(sourceURL(url),budget);responses.push({requested_url:url,response});
      if(sourceURL(response.url)!==sourceURL(url))throw new Error('Unexpected DOALOS source destination');return response;
    }catch(error){if(error.quota||now()>=budget.deadline)blocked=error.message;throw error;}
  };
  const discover=document=>{
    const dom=parseDocument(document.raw,{withStartIndices:true});
    const article=DomUtils.getElementsByTagName('article',dom.children).find(n=>classes(n).includes('node')&&n.attribs.about);
    const cards=DomUtils.getElementsByTagName('article',article.children).filter(n=>classes(n).includes('pattern-vertical-card'));
    const anchors=[];
    if(document.url===DOALOS){
      const listing=DomUtils.getElementsByTagName('a',dom.children).find(a=>{
        try{return sourceURL(new URL(a.attribs.href,DOALOS).href)===sourceURL(NOTIFICATIONS);}catch{return false;}
      });
      if(listing)enqueue(NOTIFICATIONS,{relationship:'listing-link',parent_url:DOALOS,link:{tag:'a',target:listing.attribs.href,label:DomUtils.textContent(listing)}});
      else coverage.push({url:NOTIFICATIONS,relationship:'listing',state:'unfetched',reason:'Notification listing hyperlink not observed; no guessed fetch'});
      const news=cards.filter(card=>DomUtils.getElementsByTagName('h2',card.children).some(h=>DomUtils.textContent(h).trim()==='New'));
      const lists=news.length===1?DomUtils.getElementsByTagName('ul',news[0].children):[];
      if(lists.length===1)for(const entry of lists[0].children.filter(n=>n.name==='li'))anchors.push(...DomUtils.getElementsByTagName('a',entry.children));
      else coverage.push({url:document.url,relationship:'discovery',state:'unfetched',reason:'New-card list boundary missing or ambiguous; source retained'});
    }else{
      const tables=cards.flatMap(card=>DomUtils.getElementsByTagName('table',card.children).filter(n=>classes(n).includes('table')));
      if(!tables.length)coverage.push({url:document.url,relationship:'discovery',state:'unfetched',reason:'Notification table boundary missing; source retained'});
      for(const table of tables)for(const row of DomUtils.getElementsByTagName('tr',table.children)){
        const cells=row.children.filter(n=>n.name==='td'),first=cells[1]?.children.find(n=>n.type==='tag');
        const links=cells.length===2&&first?.name==='p'?DomUtils.getElementsByTagName('a',first.children):[];
        if(links.length===1)anchors.push(links[0]);
        else coverage.push({url:document.url,start:row.startIndex,relationship:'discovery',state:'unfetched',reason:'Primary notice anchor missing or ambiguous; row retained'});
      }
    }
    const offsets=new Set(anchors.map(a=>a.startIndex-document.regions[0].start));
    for(const link of document.prepared.links)if(link.tag==='a'&&offsets.has(link.start)){
      try{
        const url=route(link.target);if(url!==document.url)enqueue(url,{relationship:'content-link',parent_url:document.url,link});
      }catch(error){coverage.push({...link,parent_url:document.url,state:'unsupported',reason:error.message});}
    }
  };
  try{const home=prepareDoalosDocument(await fetch(DOALOS),{sourceURL});documents.push({...home,via:[{relationship:'configured'}]});coverage.push(...home.coverage);discover(home);}
  catch(error){coverage.push({url:DOALOS,state:blocked?'deferred':'failed',reason:error.message});}
  for(const item of known){
    enqueue(item.url,{relationship:'known'});
    for(const via of item.via??[])if(via.relationship!=='pending')enqueue(item.url,via);
  }
  const priority=item=>item.via.some(v=>v.relationship==='pending'&&v.previous_state!=='failed')?0:
    item.via.some(v=>v.relationship==='pending')?2:knownURLs.has(item.url)?3:1;
  queue.sort((a,b)=>priority(a)-priority(b));
  for(const item of queue){
    if(documents.length>=limits.documents||blocked){item.state='deferred';item.reason=blocked??'DOALOS document bound reached';continue;}
    const before=requests;
    try{
      const document=prepareDoalosDocument(await fetch(item.url),{sourceURL});item.state='retained';delete item.last_failure;
      documents.push({...document,via:item.via,known:knownURLs.has(item.url)});coverage.push(...document.coverage);
      if(item.url===NOTIFICATIONS)discover(document);
    }catch(error){item.state=blocked?'deferred':'failed';item.reason=error.message;if(requests>before)item.last_failure={state:item.state,reason:item.reason};}
  }
  const progress=[...inventory.values()];coverage.push(...progress,
    {relationship:'scope',state:'partial',reason:'Configured page, observed current notification listing and one-hop HTML documents only; attachments, external supports/conferences, media, translations and archive pagination remain unfetched'});
  return {documents,responses,coverage,inventory:progress,pending:progress.filter(i=>i.state!=='retained').sort((a,b)=>Number(a.state==='failed')-Number(b.state==='failed')),requests,limits,complete:false};
}
