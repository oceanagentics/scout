import { Buffer } from 'node:buffer';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument, DomUtils } from 'htmlparser2';
import { prepareDocument, prepareCbdPayload } from './octo-documents.js';

export const UN_SIDE_EVENTS='https://www.un.org/bbnjagreement/en/capacity-building-and-technical-assistance/side-events';
export const PREPARATION_VERSION='un-side-documents-v2';
const hex=id=>typeof id==='string'&&/^[a-f0-9]{24}$/.test(id);

function apiURL(task,sourceURL){
  if(task.kind!=='session'||!/^\d+$/.test(String(task.id))||!Number.isSafeInteger(+task.id)||+task.id<=0)throw new Error('Unsupported side-event source task/identity');
  return sourceURL('https://api.cbd.int/api/v2016/reservations/?'+new URLSearchParams({q:JSON.stringify({'sideEvent.id':+task.id})}));
}

export function prepareSideListing(response,{sourceURL}){
  const url=sourceURL(response.url);
  if(url!==sourceURL(UN_SIDE_EVENTS))throw new Error('Unexpected UN side-event listing identity');
  if(response.status!=null&&(response.status<200||response.status>=300)||!/text\/html/i.test(response.headers?.['content-type']??'')||
    typeof response.body!=='string'||!/<\/html>(?:\s|<!--[\s\S]*?-->)*$/i.test(response.body))throw new Error('UN side-event listing status/format/integrity unavailable');
  const dom=parseDocument(response.body,{withStartIndices:true,withEndIndices:true});
  const articles=DomUtils.getElementsByTagName('article',dom.children).filter(n=>n.attribs.about&&(n.attribs.class??'').split(/\s+/).includes('node'));
  if(articles.length!==1||sourceURL(new URL(articles[0].attribs.about,url).href)!==url)throw new Error('UN side-event article boundary/identity missing or ambiguous');
  const mains=DomUtils.getElementsByTagName('main',dom.children).filter(n=>n.attribs.id==='page'&&n.startIndex<articles[0].startIndex&&n.endIndex>articles[0].endIndex);
  if(mains.length>1)throw new Error('UN side-event main context ambiguous');
  const region=mains[0]??articles[0],start=region.startIndex,end=region.endIndex+1;
  const prepared=prepareDocument({title:'',url,html:response.body.slice(start,end)});prepared.version=PREPARATION_VERSION;prepared.input='whole-side-event-listing';
  prepared.omissions.push({start,end,reason:'Whole listing/article and main heading context prepared; surrounding navigation/UI excluded; exact response retained'});
  return {id:'un-side:listing',url,raw:response.body,response,prepared,regions:[{start,end}]};
}

export function prepareSideApi(response,{task,sourceURL}){
  const url=apiURL(task,sourceURL);
  if(sourceURL(response.url)!==url||response.status!=null&&(response.status<200||response.status>=300)||!/json/i.test(response.headers?.['content-type']??''))throw new Error('Side-event API destination/status/format conflict');
  const rows=JSON.parse(response.body);
  if(!Array.isArray(rows)||!rows.length||new Set(rows.map(r=>r?._id)).size!==rows.length||rows.some(r=>!hex(r?._id)))throw new Error('Missing/ambiguous side-event API source rows');
  if(rows.some(r=>r.sideEvent?.id!==+task.id||typeof r.sideEvent.description!=='string'))throw new Error('Side-event session identity/description conflict');
  const id='un-side:session:'+task.id;
  const document=prepareCbdPayload({id,url,raw:response.body,rows,task,provenance:[],sourceURL});
  document.prepared.version=PREPARATION_VERSION;document.prepared.input='whole-'+task.kind+'-api';
  return {...document,response};
}

export async function retrieveUnSideDocuments({tracker,read,sourceURL,budget,known=[],pending=[],limits={documents:8,requests:10},now=Date.now}){
  if(tracker.collector!=='web'||tracker.url!==UN_SIDE_EVENTS)throw new Error('Unsupported UN side-event tracker');
  limits={bytes:524288,...limits};
  if(['documents','requests','bytes'].some(k=>!Number.isSafeInteger(limits[k])||limits[k]<1))throw new Error('Invalid UN side-event retrieval bounds');
  const documents=[],responses=[],coverage=[],inventory=new Map(),queue=[],knownIds=new Set();let requests=0,blocked;
  const enqueue=(task,via)=>{
    try{
      const stored=task;
      if(['meeting','hosts','rooms'].includes(task?.kind)||/^un-side:(meeting|hosts|rooms):/.test(task?.id??'')){
        coverage.push({task,via,state:'unfetched',reason:'Optional meeting/host/room support retained as metadata; not fetched'});return;
      }
      // Shared capture history carries native IDs/URLs, not adapter tasks.
      if(!task?.kind){
        if(task?.id==='un-side:listing')return; // The configured listing is always read below.
        const match=/^un-side:session:(\d+)$/.exec(task?.id??'');
        if(!match)throw new Error('Unsupported side-event source task/identity');
        task={kind:'session',id:match[1]};
      }
      const url=apiURL(task,sourceURL),existing=inventory.get(url);
      if(stored.url&&sourceURL(stored.url)!==url)throw new Error('Side-event stored source URL/identity conflict');
      if(existing){if(!existing.via.some(v=>isDeepStrictEqual(v,via)))existing.via.push(via);return existing;}
      const item={task,url,via:[via],state:'pending'};inventory.set(url,item);queue.push(item);return item;
    }catch(error){coverage.push({task,via,state:'unsupported',reason:error.message});}
  };
  // Carry source relationships once; prior attempts stay in their run artifacts.
  for(const item of pending){
    const entry=enqueue(item.task??item,{relationship:'pending',previous_state:item.state,reason:item.reason});
    for(const via of item.via??[])if(via.relationship!=='pending')enqueue(item.task??item,via);
    if(entry&&item.last_failure)entry.last_failure=item.last_failure;
  }
  const fetch=async url=>{
    if(blocked)throw new Error(blocked);
    if(requests>=limits.requests||budget.requests>=limits.requests||now()>=budget.deadline){blocked=requests>=limits.requests||budget.requests>=limits.requests?'UN side-event request bound reached':'Collection time limit reached';throw new Error(blocked);}
    const before=budget.requests;requests++;
    try{
      const response=await read(sourceURL(url),budget);responses.push({requested_url:url,response});
      if(typeof response.body!=='string'||Buffer.byteLength(response.body)>limits.bytes)throw new Error('UN side-event response byte bound');
      return response;
    }
    catch(error){if(error.quota||now()>=budget.deadline)blocked=error.message;throw error;}
    finally{if(budget.requests===before)budget.requests++;}
  };
  try{
    const listing=prepareSideListing(await fetch(UN_SIDE_EVENTS),{sourceURL});documents.push({...listing,via:[{relationship:'configured'}]});
    for(const link of listing.prepared.links){
      const id=link.tag==='a'&&link.target.match(/^https:\/\/www\.cbd\.int\/side-events\/(\d+)$/)?.[1];
      if(id)enqueue({kind:'session',id},{relationship:'session-link',parent_url:listing.url,link});
      else coverage.push({...link,parent_url:listing.url,state:/\.(?:pdf|jpg|png)(?:$|[?#])/i.test(link.target)?'unsupported':'unfetched',reason:'Programme/concept/media/other source support not fetched; no text fabricated'});
    }
  }catch(error){coverage.push({url:UN_SIDE_EVENTS,state:blocked?'deferred':'failed',reason:error.message});}
  for(const item of known){
    const entry=enqueue(item.task??item,{relationship:'known'});if(entry)knownIds.add(entry.url);
    for(const via of item.via??[])if(via.relationship!=='pending')enqueue(item.task??item,via);
  }
  const priority=item=>item.via.some(v=>v.relationship==='pending'&&v.previous_state!=='failed')?0:
    item.via.some(v=>v.relationship==='pending')?2:knownIds.has(item.url)?3:1;
  queue.sort((a,b)=>priority(a)-priority(b));
  for(const item of queue){
    if(documents.length>=limits.documents||blocked){item.state='deferred';item.reason=blocked??'UN side-event document bound reached';continue;}
    const before=requests;
    try{
      const document=prepareSideApi(await fetch(item.url),{task:item.task,sourceURL});item.state='retained';delete item.last_failure;item.id=document.id;
      documents.push({...document,via:item.via,known:knownIds.has(item.url)});coverage.push(...document.coverage);
      coverage.push({parent_id:document.id,relationship:'source-references',state:'unfetched',reason:'Literal meeting/host/room references remain in the session source; optional supporting records not fetched'});
      for(const link of document.prepared.links)coverage.push({...link,parent_id:document.id,state:'unfetched',reason:'Observed API/description citation metadata only; not opened for event extraction'});
    }catch(error){item.state=blocked?'deferred':'failed';item.reason=error.message;if(requests>before)item.last_failure={state:item.state,reason:item.reason};}
  }
  const progress=[...inventory.values()];coverage.push(...progress,
    {relationship:'scope',state:'partial',reason:'One whole configured listing plus bounded linked session/reservation announcements; meeting/host/room records, programmes, concept notes, PDFs/media, other supports and archive pages remain unfetched. Source IDs/references are not finding identity or event facts.'});
  return {documents,responses,coverage,inventory:progress,pending:progress.filter(i=>i.state!=='retained').sort((a,b)=>Number(a.state==='failed')-Number(b.state==='failed')),requests,limits,complete:false};
}
