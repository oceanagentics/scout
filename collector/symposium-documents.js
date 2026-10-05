import { Buffer } from 'node:buffer';
import { parseDocument, DomUtils } from 'htmlparser2';
import { prepareDocument } from './octo-documents.js';

export const SYMPOSIUM_HOME='https://bbnjsymposium.org/';

// Observed programme/session navigation plus known URLs; no finding filters.
// Caller persists after_url after attempts, including failures.
export async function retrieveSymposiumDocuments({read,sourceURL,budget,limits,knownDocuments=[],pending=[],progress={},now=Date.now}){
  if(['documents','requests','bytes'].some(k=>!Number.isSafeInteger(limits[k])||limits[k]<1))throw new Error('Invalid Symposium retrieval bounds');
  const result={source:SYMPOSIUM_HOME,inventory:[],documents:[],fetches:[],coverage:[],pending:[],limits:{...limits},progress:{...progress}};
  const publisherURL=(value,base=SYMPOSIUM_HOME)=>{
    if(typeof value!=='string'||!value.trim())throw new Error('Symposium source URL unavailable');
    const url=new URL(sourceURL(new URL(value,base).href));url.hash='';
    if(url.origin!=='https://bbnjsymposium.org')throw new Error('Symposium publisher identity unavailable');
    if(url.search||!/^\/(?:\d{4}|satellite-events(?:-\d{4})?|session_recordings(?:_\d{4})?)?$/.test(url.pathname))throw new Error('Outside observed Symposium programme/session routes; support remains metadata');
    return url.href;
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
      if(!DomUtils.getElementsByTagName('link',dom.children).some(n=>n.attribs.rel==='canonical'&&new URL(n.attribs.href,url).href===url))
        throw new Error('Canonical publisher identity disagreement');
      entry.state='fetched';return {entry,dom};
    }catch(error){entry.reason=error.message;result.coverage.push({url,state:entry.state==='unsupported'?'unsupported':'failed',reason:error.message});return null;}
    finally{if(budget.requests===before)budget.requests++;}
  }
  function document(response,item){
    const nodes=DomUtils.findAll(n=>n.attribs?.id==='allrecords',response.dom.children);
    if(nodes.length!==1||!DomUtils.textContent(nodes[0]).trim())throw new Error('Whole readable publisher content boundary unavailable');
    const node=nodes[0],id=node.attribs['data-tilda-page-id'];
    if(!/^\d+$/.test(id??'')||node.attribs['data-tilda-project-id']!=='10782915'||item.id!=null&&String(item.id)!==id)
      throw new Error('Symposium page/project identity unavailable/disagrees with known ID');
    const title=DomUtils.textContent(DomUtils.getElementsByTagName('title',response.dom.children)[0]??{children:[]}).trim();
    if(!title)throw new Error('Publisher title unavailable');
    const structured=DomUtils.getElementsByTagName('script',response.dom.children).filter(n=>n.attribs.type==='application/ld+json');
    const html=[node,...structured].map(n=>response.entry.body.slice(n.startIndex,n.endIndex+1)).join('\n');
    const prepared=prepareDocument({title,url:item.url,html});
    for(const link of prepared.links)result.coverage.push({from:item.url,...link,state:'unfetched',reason:'Registration/media/attachment/support retained as metadata; not opened for event extraction'});
    return {id,identity:'symposium:document:'+id,url:item.url,raw:response.entry.body,html,
      metadata:DomUtils.getElementsByTagName('meta',response.dom.children).map(n=>({...n.attribs})),listing:item,prepared};
  }
  const home=await fetch(SYMPOSIUM_HOME);
  const candidates=new Map();
  if(home){
    try{
      result.home=document(home,{url:SYMPOSIUM_HOME,via:'configured'});
      result.documents.push(result.home);
      for(const anchor of DomUtils.getElementsByTagName('a',home.dom.children)){
        const item={via:SYMPOSIUM_HOME,raw:home.entry.body.slice(anchor.startIndex,anchor.endIndex+1),label:DomUtils.textContent(anchor).trim()};
        try{
          if(!anchor.attribs.href)continue;
          const target=new URL(anchor.attribs.href,SYMPOSIUM_HOME).href;item.target=target;
          const url=new URL(target);url.hash='';item.url=publisherURL(url.href);
          if(item.url===SYMPOSIUM_HOME)continue;
          let menu=anchor.parent;while(menu&&!(menu.attribs?.class??'').split(/\s+/).includes('t-menusub__menu'))menu=menu.parent;
          if(!menu||anchor.attribs.role!=='menuitem')throw new Error('Not an observed programme/session navigation relationship; retained as metadata');
          if(candidates.has(item.url)){item.state='duplicate';item.reason='Repeated homepage destination';}
          else{item.state='listed';candidates.set(item.url,item);}
        }catch(error){item.state='unfetched';item.reason=error.message;}
        result.inventory.push(item);
      }
      result.coverage.push({url:SYMPOSIUM_HOME,state:'partial',reason:'Whole homepage and observed programme/session navigation only; incidental pages, detail links, PDF/media and external support unfetched'});
    }catch(error){result.coverage.push({url:SYMPOSIUM_HOME,state:'failed',reason:error.message});}
  }
  for(const item of [...knownDocuments,...pending]){
    try{
      const url=publisherURL(item.url);
      if(url===SYMPOSIUM_HOME)continue;
      const id=item.id==null?undefined:String(item.id).replace(/^symposium:document:/,'');
      if(id!=null&&!/^\d+$/.test(id))throw new Error('Unsupported Symposium native source identity');
      const prior=candidates.get(url);
      if(prior)result.coverage.push({url,state:'duplicate',reason:'Repeated known/pending/index URL'});
      candidates.set(url,{...prior,...item,id:id??prior?.id,url,via:prior?.via??'known',
        pending_state:['model-repair','model-pending'].includes(item.state)?item.state:prior?.pending_state??item.pending_state});
    }catch(error){result.coverage.push({url:item.url,state:'unsupported',reason:error.message});}
  }
  const ordered=[...candidates.values()].sort((a,b)=>a.url<b.url?-1:a.url>b.url?1:0);
  const queue=typeof progress.after_url==='string'?[...ordered.filter(d=>d.url>progress.after_url),...ordered.filter(d=>d.url<=progress.after_url)]:ordered;
  const priority={'model-repair':0,'model-pending':1};
  queue.sort((a,b)=>(priority[a.pending_state]??2)-(priority[b.pending_state]??2));
  let selected=result.documents.length;
  for(const item of queue){
    if(selected++>=limits.documents){const deferred={...item,state:'deferred',reason:'Document limit'};result.coverage.push(deferred);result.pending.push(deferred);continue;}
    const before=result.fetches.length,response=await fetch(item.url);
    if(result.fetches.length>before)result.progress.after_url=item.url;
    if(!response){const failure=result.coverage.at(-1);result.pending.push({...item,...failure,...result.fetches.length>before?{last_failure:{state:failure.state,reason:failure.reason}}:{}});continue;}
    try{
      const doc=document(response,item);result.documents.push(doc);
      result.coverage.push({url:item.url,identity:doc.identity,state:'prepared',reason:'Whole publisher page/JSON-LD retained; no session, date or record eligibility inferred'});
    }catch(error){const failure={...item,state:'failed',reason:error.message,last_failure:{state:'failed',reason:error.message}};result.coverage.push(failure);result.pending.push(failure);}
  }
  return result;
}
