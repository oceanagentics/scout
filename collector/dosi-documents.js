import { parseDocument, DomUtils } from 'htmlparser2';
import { isDeepStrictEqual } from 'node:util';
import { prepareDocument } from './octo-documents.js';

export const DOSI_WEB='https://www.dosi-project.org/biodiversity-beyond-national-jurisdiction-bbnj/';
export const PREPARATION_VERSION='dosi-documents-v1';
const origin='https://www.dosi-project.org';
const newsletter=url=>url.origin==='https://mailchi.mp'&&/^\/soton\.ac\.uk\/dosi-deep-sea-roundup-[^/]+$/.test(url.pathname);
const classes=node=>(node.attribs?.class??'').split(/\s+/);

export function prepareDosiDocument(response,{sourceURL}) {
  const url=sourceURL(response.url),u=new URL(url);
  if(u.origin!==origin&&!newsletter(u))throw new Error('Unsupported DOSI document source');
  if(response.status!=null&&(response.status<200||response.status>=300)||!/text\/html/i.test(response.headers?.['content-type']??'')||
    typeof response.body!=='string'||!/<\/html>(?:\s|<!--[\s\S]*?-->)*$/i.test(response.body))throw new Error('DOSI HTML status/format/integrity unavailable');
  const dom=parseDocument(response.body,{withStartIndices:true,withEndIndices:true});
  const canonicals=DomUtils.getElementsByTagName('link',dom.children).filter(n=>n.attribs.rel==='canonical');
  if(canonicals.length>1||canonicals.some(n=>sourceURL(new URL(n.attribs.href,url).href)!==url))throw new Error('DOSI canonical source identity conflict');
  const bodies=DomUtils.findAll(n=>newsletter(u)?n.attribs?.id==='bodyTable':classes(n).includes('entry-content'),dom.children);
  if(bodies.length!==1)throw new Error('DOSI structural content boundary missing or ambiguous');
  const headers=newsletter(u)?[]:DomUtils.findAll(n=>classes(n).includes('post_header_single'),dom.children);
  const regions=[...headers,bodies[0]].map(n=>({start:n.startIndex,end:n.endIndex+1}));
  const html=regions.map(r=>response.body.slice(r.start,r.end)).join('\n');
  const prepared=prepareDocument({title:'',html,url});prepared.version=PREPARATION_VERSION;
  prepared.input=newsletter(u)?'whole-newsletter':'website-document';
  prepared.omissions.push({reason:'Only structural content/header regions prepared; surrounding site or campaign UI framing excluded; full response retained',regions});
  // Preserve common observed link relationships as evidence for later fact
  // checks; they do not assign authority or preselect findings.
  return {id:'page:'+url,identity:'dosi:page:'+url,url,raw:response.body,response,regions,prepared};
}

// The caller persists returned pending/known inputs with existing capture and
// progress machinery. No persistence, hashing, extraction or save engine here.
export async function retrieveDosiDocuments({tracker,read,sourceURL,budget,known=[],pending=[],progress={},
  limits={documents:4,requests:8},now=Date.now}) {
  if(tracker.collector!=='web'||tracker.url!==DOSI_WEB)throw new Error('Unsupported DOSI tracker');
  if(!Number.isInteger(limits.documents)||limits.documents<1||!Number.isInteger(limits.requests)||limits.requests<1)
    throw new Error('Invalid DOSI retrieval bounds');
  const documents=[],responses=[],coverage=[],inventory=new Map(),queue=[],knownURLs=new Set();let requests=0,blocked;
  progress={...progress,provenance:{...progress.provenance}};
  const route=value=>{
    const url=sourceURL(value),u=new URL(url);u.hash='';
    if(u.origin!==origin&&!newsletter(u))throw new Error('Outside DOSI article/newsletter retrieval routes');
    if(u.origin===origin&&(u.search||/\.[a-z0-9]+$/i.test(u.pathname)||/^\/(?:wp-content|wp-json|wp-admin|feed)\//.test(u.pathname)))
      throw new Error('Attachment/API/feed route is not an HTML article');
    if(newsletter(u)&&u.search)throw new Error('Newsletter query variants require review');
    return u.href;
  };
  const enqueue=(value,via)=>{
    try {
      const url=route(value);if(url===DOSI_WEB)return;
      const existing=inventory.get(url);
      if(existing){if(!existing.via.some(v=>isDeepStrictEqual(v,via)))existing.via.push(via);return;}
      const item={id:'page:'+url,url,via:progress.provenance[url]?[progress.provenance[url]]:[],state:'pending'};
      if(!item.via.some(v=>isDeepStrictEqual(v,via)))item.via.push(via);
      inventory.set(url,item);queue.push(item);
    }catch(error){coverage.push({target:value,via,state:'unsupported',reason:error.message});}
  };
  for(const item of known){try{knownURLs.add(route(item.url));}catch{}}
  for(const item of pending){
    enqueue(item.url,{relationship:'pending',previous_state:item.state});
    for(const via of item.via??[])if(!['pending','known'].includes(via.relationship))enqueue(item.url,via);
  }
  const fetch=async url=>{
    if(blocked)throw new Error(blocked);
    if(requests>=limits.requests||budget.requests>=limits.requests||now()>=budget.deadline){blocked=now()>=budget.deadline?'Collection time limit reached':'DOSI request bound reached';throw new Error(blocked);}
    requests++;
    try{
      const response=await read(sourceURL(url),budget);responses.push({requested_url:url,response});
      if(sourceURL(response.url)!==sourceURL(url))throw new Error('Unexpected DOSI source destination');
      return response;
    }catch(error){if(error.quota||now()>=budget.deadline)blocked=error.message;throw error;}
  };
  let home;
  try{
    home=prepareDosiDocument(await fetch(DOSI_WEB),{sourceURL});documents.push({...home,via:[{relationship:'configured'}]});
    for(const link of home.prepared.links)if(link.tag==='a')
      coverage.push({...link,state:'unfetched',reason:'Configured-page links retained as metadata; articles come from observed RSS identities'});
  }catch(error){coverage.push({url:DOSI_WEB,state:blocked?'deferred':'failed',reason:error.message});}
  if(home){
    const dom=parseDocument(home.raw),feeds=DomUtils.getElementsByTagName('link',dom.children).filter(n=>n.attribs.type==='application/rss+xml'&&n.attribs.href===origin+'/feed/');
    if(!feeds.length)coverage.push({relationship:'feed',state:'unfetched',reason:'Root RSS link not observed on configured page'});
    else try{
      const url=sourceURL(feeds[0].attribs.href),response=await fetch(url);
      if(response.status!=null&&(response.status<200||response.status>=300)||!/xml/i.test(response.headers?.['content-type']??'')||!/<\/rss>\s*$/i.test(response.body))throw new Error('Invalid DOSI RSS status/format/integrity');
      const rss=parseDocument(response.body,{xmlMode:true,withStartIndices:true,withEndIndices:true});
      const channels=DomUtils.getElementsByTagName('channel',rss.children);if(channels.length!==1)throw new Error('DOSI RSS channel unavailable');
      for(const node of channels[0].children.filter(n=>n.name==='item')){
        const field=name=>DomUtils.textContent(node.children.find(n=>n.name===name)??{children:[]}).trim();
        const raw=response.body.slice(node.startIndex,node.endIndex+1),target=field('link'),guid=field('guid');
        if(!guid||!target){coverage.push({relationship:'rss-item',raw,state:'failed',reason:'RSS identity/link missing'});continue;}
        enqueue(target,{relationship:'rss-item',feed_url:url,guid,published:field('pubDate'),raw});
      }
      coverage.push({url,relationship:'feed',state:'retained',reason:'One RSS page; feed archives remain unfetched'});
    }catch(error){coverage.push({relationship:'feed',state:blocked?'deferred':'failed',reason:error.message});}
  }
  // Pending work goes first, then newly discovered documents, then known
  // rechecks. Repeated bounded runs do not restart at the listing's first item.
  for(const item of known){
    enqueue(item.url,{relationship:'known'});
    for(const via of item.via??[])if(!['pending','known'].includes(via.relationship))enqueue(item.url,via);
  }
  const priority=item=>item.via.some(v=>v.relationship==='pending'&&v.previous_state!=='failed')?(!progress.provenance[item.url]&&item.via.some(v=>v.relationship==='newsletter-link')?-1:0):
    item.via.some(v=>v.relationship==='pending')?2:knownURLs.has(item.url)?3:1;
  const ordered=queue.slice().sort((a,b)=>a.url<b.url?-1:a.url>b.url?1:0);
  const rotated=typeof progress.after_url==='string'?[...ordered.filter(i=>i.url>progress.after_url),...ordered.filter(i=>i.url<=progress.after_url)]:queue.slice();
  queue.sort((a,b)=>priority(a)-priority(b)||rotated.indexOf(a)-rotated.indexOf(b));
  for(let index=0;index<queue.length;index++){
    const item=queue[index];
    if(!item.via.some(v=>['rss-item','newsletter-link'].includes(v.relationship))){
      item.state='deferred';item.reason='RSS article or associated newsletter provenance unavailable; URL retained without fetching';continue;
    }
    if(documents.length>=limits.documents||blocked){item.state='deferred';item.reason=blocked??'DOSI document bound reached';continue;}
    try{
      const before=requests,parent=item.via.find(v=>v.relationship==='newsletter-link')?.parent_url;let response;
      // New/just-followed issues finish their parent; independent rechecks rotate normally.
      try{response=await fetch(item.url);}finally{if(requests>before)
        progress.after_url=parent&&(!progress.provenance[item.url]||documents.some(d=>d.url===parent))?parent:item.url;}
      const document=prepareDosiDocument(response,{sourceURL});
      item.state='retained';documents.push({...document,via:item.via,known:knownURLs.has(item.url)});
      if(new URL(item.url).origin===origin)for(const link of document.prepared.links)if(link.tag==='a'){
        let target;try{target=sourceURL(link.target);}catch(error){coverage.push({...link,parent_url:item.url,state:'unsupported',reason:error.message});continue;}
        if(newsletter(new URL(target))){
          enqueue(target,{relationship:'newsletter-link',parent_url:item.url,link});
          const at=queue.findIndex(next=>next.url===target);
          if(at>index+1)queue.splice(index+1,0,...queue.splice(at,1));
        }else coverage.push({...link,parent_url:item.url,state:'unfetched',reason:'Incidental article links retained as metadata'});
      }
    }catch(error){item.state=blocked?'deferred':'failed';item.reason=error.message;}
  }
  const items=[...inventory.values()];
  // Shared known entries retain only identity/URL; keep one acquisition proof
  // in the existing durable progress so valid unlisted sources can be rechecked.
  for(const item of items.filter(i=>i.state==='retained')){
    const via=item.via.find(v=>v.relationship==='newsletter-link')??item.via.find(v=>v.relationship==='rss-item');
    if(via)progress.provenance[item.url]=via;
  }
  coverage.push(...items,{relationship:'scope',state:'partial',reason:'Configured page, observed RSS articles and their explicitly linked newsletters only; incidental links and media remain unfetched'});
  return {documents,responses,coverage,inventory:items,pending:items.filter(i=>i.state!=='retained').sort((a,b)=>Number(a.state==='failed')-Number(b.state==='failed')),progress,requests,limits,complete:false};
}
