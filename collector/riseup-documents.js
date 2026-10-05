import { isDeepStrictEqual } from 'node:util';
import { Buffer } from 'node:buffer';
import { parseDocument, DomUtils } from 'htmlparser2';
import { prepareDocument } from './octo-documents.js';

export const RISE_UP='https://riseupfortheocean.org/latest/rise-up-navigator/';
export const ARCHIVE='https://us11.campaign-archive.com/home/?id=e2f06a2916&u=740487e7a7306085143176166';
export const PREPARATION_VERSION='riseup-documents-v1';
const owner='740487e7a7306085143176166';
const issue=url=>url.origin==='https://mailchi.mp'&&/^\/riseupfortheocean\.org\/[^/]+$/.test(url.pathname)&&!url.search||
  url.origin==='https://us11.campaign-archive.com'&&url.pathname==='/'&&url.searchParams.get('u')===owner&&/^[a-f0-9]{10}$/.test(url.searchParams.get('id')??'')&&url.searchParams.size===2&&[...url.searchParams.keys()].every(k=>['u','id'].includes(k));
const short=url=>url.origin==='https://eepurl.com'&&/^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)&&!url.search;
const classes=node=>(node.attribs?.class??'').split(/\s+/);

export function prepareRiseupDocument(response,{sourceURL}) {
  const url=sourceURL(response.url),u=new URL(url),listing=url===sourceURL(RISE_UP),archive=url===sourceURL(ARCHIVE);
  if(!listing&&!archive&&!issue(u))throw new Error('Unsupported RISE UP document destination');
  if(response.status!=null&&(response.status<200||response.status>=300)||!/text\/html/i.test(response.headers?.['content-type']??'')||
    typeof response.body!=='string'||!/<\/html>(?:\s|<!--[\s\S]*?-->)*$/i.test(response.body))throw new Error('RISE UP HTML status/format/integrity unavailable');
  const dom=parseDocument(response.body,{withStartIndices:true,withEndIndices:true});
  let containers;
  if(listing){
    const page=DomUtils.getElementsByTagName('body',dom.children)[0]?.attribs.class?.match(/\bpage-id-(\d+)\b/)?.[1];
    containers=page?DomUtils.getElementsByTagName('section',dom.children).filter(n=>classes(n).some(c=>c.startsWith('bde-section-'+page+'-'))):[];
  }else if(archive)containers=DomUtils.findAll(n=>n.attribs?.id==='archive-list',dom.children);
  else{
    containers=DomUtils.findAll(n=>n.attribs?.id==='bodyTable',dom.children);
    if(!containers.length)containers=DomUtils.getElementsByTagName('body',dom.children).filter(n=>classes(n).includes('body'));
  }
  if(!containers.length||!listing&&containers.length!==1)throw new Error('RISE UP structural content boundary missing or ambiguous');
  const regions=containers.map(n=>({start:n.startIndex,end:n.endIndex+1}));
  const prepared=prepareDocument({title:'',url,html:regions.map(r=>response.body.slice(r.start,r.end)).join('\n')});
  prepared.version=PREPARATION_VERSION;prepared.input=listing?'configured-page':archive?'campaign-listing':'whole-newsletter';
  prepared.omissions.push({regions,reason:'Structural page/campaign regions prepared; surrounding navigation/share/translation UI excluded; full response retained'});
  // Common registration/organizer/support metadata remains evidence, without
  // prescribing finding fields or publisher authority.
  const id=u.origin==='https://us11.campaign-archive.com'&&issue(u)?'campaign:'+owner+':'+u.searchParams.get('id'):'page:'+url;
  return {id,identity:'riseup:'+id,url,raw:response.body,response,regions,prepared};
}

export async function retrieveRiseupDocuments({tracker,read,sourceURL,budget,known=[],pending=[],progress={},
  limits={documents:4,requests:6},now=Date.now}) {
  if(tracker.collector!=='web'||tracker.url!==RISE_UP)throw new Error('Unsupported RISE UP tracker');
  limits={bytes:524288,...limits};
  if(['documents','requests','bytes'].some(k=>!Number.isSafeInteger(limits[k])||limits[k]<1))throw new Error('Invalid RISE UP retrieval bounds');
  const documents=[],responses=[],coverage=[],inventory=new Map(),queue=[],knownURLs=new Set();let requests=0,blocked,archive;
  progress={...progress};
  const route=value=>{
    const upgraded=value.replace(/^http:\/\/eepurl\.com\//,'https://eepurl.com/'),url=sourceURL(upgraded);
    if(!issue(new URL(url))&&!short(new URL(url)))throw new Error('Outside observed RISE UP issue retrieval routes');
    return url;
  };
  const enqueue=(value,via,source={})=>{
    try{
      if([RISE_UP,sourceURL(ARCHIVE)].includes(value))return;
      const url=route(value),ids=[...new Set([source.id??source.identity,...source.ids??[]].filter(v=>v!=null).map(v=>String(v).replace(/^riseup:/,'')))];
      for(const id of ids)if(!(id.startsWith('page:')&&issue(new URL(sourceURL(id.slice(5)))))&&!(new RegExp('^campaign:'+owner+':[a-f0-9]{10}$')).test(id))throw new Error('Unsupported RISE UP native source identity');
      let item=inventory.get(url);
      if(!item){item={url,via:[],ids:[],state:'pending'};inventory.set(url,item);queue.push(item);}
      if(!item.via.some(v=>isDeepStrictEqual(v,via)))item.via.push(via);
      item.ids=[...new Set([...item.ids,...ids])];if(item.ids.length===1)item.id=item.ids[0];
      const states=[item.pending_state,source.pending_state,source.state];
      item.pending_state=states.includes('model-repair')?'model-repair':states.includes('model-pending')?'model-pending':undefined;
      if(source.last_failure&&!item.last_failure)item.last_failure=source.last_failure;
      return item;
    }catch(error){coverage.push({target:value,via,state:'unsupported',reason:error.message});}
  };
  for(const item of known)for(const value of [item.url,...item.aliases??[]]){try{knownURLs.add(route(value));}catch{}}
  // Carry source relationships once; prior attempts stay in their run artifacts.
  for(const item of pending){
    for(const value of [item.url,...item.aliases??[]]){
      enqueue(value,{relationship:'pending'},item);
      for(const via of item.via??[])if(via.relationship!=='pending')enqueue(value,via,item);
    }
  }
  const fetch=async url=>{
    if(blocked)throw new Error(blocked);
    if(requests>=limits.requests||budget.requests>=limits.requests||now()>=budget.deadline){blocked=now()>=budget.deadline?'Collection time limit reached':'RISE UP request bound reached';throw new Error(blocked);}
    requests++;const before=budget.requests;
    try{
      const response=await read(sourceURL(url),budget);responses.push({requested_url:url,response});
      if(typeof response.body!=='string'||Buffer.byteLength(response.body)>limits.bytes)throw new Error('RISE UP response byte bound');
      return response;
    }
    catch(error){if(error.quota||now()>=budget.deadline)blocked=error.message;throw error;}
    finally{if(budget.requests===before)budget.requests++;}
  };
  // This explicit supplemental publisher archive is observed in saved Navigator
  // issues. It remains available when the configured website is blocked/stale.
  for(const url of [RISE_UP,ARCHIVE]){
    try{
      const response=await fetch(url);if(sourceURL(response.url)!==sourceURL(url))throw new Error('Unexpected RISE UP listing destination');
      const document=prepareRiseupDocument(response,{sourceURL});
      if([...known,...pending].some(d=>d.url===sourceURL(url)&&(d.id??d.identity)!=null&&String(d.id??d.identity).replace(/^riseup:/,'')!==document.id))throw new Error('Known configured page/archive identity disagreement');
      if(url===RISE_UP)documents.push({...document,via:[{relationship:'configured'}]});else archive=document;
      for(const link of document.prepared.links)if(link.tag==='a')enqueue(link.target,{relationship:'issue-link',parent_url:document.url,link});
    }catch(error){coverage.push({url,state:blocked?'deferred':'failed',reason:error.message});}
  }
  for(const item of known){
    for(const value of [item.url,...item.aliases??[]]){
      enqueue(value,{relationship:'known'},item);
      for(const via of item.via??[])if(via.relationship!=='pending')enqueue(value,via,item);
    }
  }
  const priority={'model-repair':0,'model-pending':1};
  queue.sort((a,b)=>(priority[a.pending_state]??2)-(priority[b.pending_state]??2)||
    Number(a.url<=progress.after_url)-Number(b.url<=progress.after_url)||(a.url<b.url?-1:a.url>b.url?1:0));
  for(const item of queue){
    if(item.ids.length>1){item.state='failed';item.reason='Conflicting known issue identities';continue;}
    if(documents.length>=limits.documents||blocked){item.state='deferred';item.reason=blocked??'RISE UP document bound reached';continue;}
    const before=requests;
    try{
      const response=await fetch(item.url),final=sourceURL(response.url);
      if(!issue(new URL(final))||!short(new URL(item.url))&&final!==item.url)
        throw new Error('RISE UP issue redirect/source identity conflict');
      const document=prepareRiseupDocument(response,{sourceURL});
      if(item.ids.some(id=>id!==document.id))throw new Error('Known RISE UP issue identity disagreement');
      item.state='retained';delete item.last_failure;item.id=document.id;item.destination_url=document.url;
      const existing=documents.find(d=>d.id===document.id);
      if(existing&&existing.raw===document.raw){for(const via of item.via)if(!existing.via.some(v=>isDeepStrictEqual(v,via)))existing.via.push(via);if(!existing.aliases.includes(item.url))existing.aliases.push(item.url);}
      else{
        if(existing){existing.state='conflict';coverage.push({id:document.id,state:'conflict',reason:'Differing payloads returned for one issue identity; retain both for shared change/conflict handling'});}
        documents.push({...document,via:item.via,aliases:[item.url],known:knownURLs.has(item.url),state:existing?'conflict':'retained'});
      }
      for(const link of document.prepared.links)coverage.push({...link,parent_url:document.url,state:'unfetched',reason:'Newsletter support/registration/project/media/translation links retained as metadata; not opened for event extraction'});
    }catch(error){item.state=blocked?'deferred':'failed';item.reason=error.message;if(requests>before)item.last_failure={state:item.state,reason:item.reason};}
    finally{if(requests>before)progress.after_url=item.url;}
  }
  const entries=[...inventory.values()];coverage.push(...entries,
    {relationship:'scope',state:'partial',reason:'Configured page and one observed publisher archive page; bounded whole issues only. Archive pagination, supports, media and translations remain unfetched'});
  return {documents,archive,responses,coverage,inventory:entries,pending:entries.filter(i=>i.state!=='retained'),progress,requests,limits,complete:false};
}
