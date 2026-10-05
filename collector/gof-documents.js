import { Buffer } from 'node:buffer';
import { parseDocument, DomUtils } from 'htmlparser2';
import { prepareDocument } from './octo-documents.js';

export const GOF_HOME='https://globaloceanforum.com/';
export const GOF_FEED=GOF_HOME+'feed/';
const hasClass=(node,name)=>(node.attribs?.class??'').split(/\s+/).includes(name);

// Whole configured homepage plus observed RSS article associations. Other links
// remain evidence; caller persists the cursor and observed article identities.
export async function retrieveGOFDocuments({read,sourceURL,budget,limits,knownDocuments=[],pending=[],progress={},now=Date.now}){
  if(['documents','requests','bytes'].some(k=>!Number.isSafeInteger(limits[k])||limits[k]<1))throw new Error('Invalid GOF retrieval bounds');
  const result={inventory:[],documents:[],fetches:[],coverage:[],pending:[],limits:{...limits},progress:{...progress}};
  const publisherURL=(value,base=GOF_HOME)=>{
    if(typeof value!=='string'||!value.trim())throw new Error('GOF source URL unavailable');
    const url=sourceURL(new URL(value,base).href);
    if(new URL(url).origin!==new URL(GOF_HOME).origin)throw new Error('GOF publisher identity unavailable');
    return url;
  };
  async function fetch(url,xml=false){
    if(budget.requests>=limits.requests||now()>=budget.deadline){result.coverage.push({url,state:'deferred',reason:'Request/time limit'});return null;}
    const entry={requested_url:url,state:'failed'};result.fetches.push(entry);
    const before=budget.requests;
    try{
      const response=await read(sourceURL(url),budget);
      Object.assign(entry,{url:response.url,status:response.status,mime:response.headers?.['content-type']??'',body:response.body});
      if(response.url!==url||response.status!==200||typeof response.body!=='string'||Buffer.byteLength(response.body)>limits.bytes)
        throw new Error('Response identity/status/byte bound');
      if(!(xml?/xml/i:/^text\/html\b/i).test(entry.mime)){entry.state='unsupported';throw new Error('Unsupported format; PDF/media not prepared');}
      if(!(xml?/<\/rss>\s*$/i:/<\/html>\s*$/i).test(response.body.replace(/<!--[\s\S]*?-->/g,'')))throw new Error('Incomplete source document');
      entry.state='fetched';return {entry,dom:parseDocument(response.body,{xmlMode:xml,withStartIndices:true,withEndIndices:true})};
    }catch(error){entry.reason=error.message;result.coverage.push({url,state:entry.state==='unsupported'?'unsupported':'failed',reason:error.message});return null;}
    finally{if(budget.requests===before)budget.requests++;}
  }
  function document(response,item){
    const links=DomUtils.getElementsByTagName('link',response.dom.children);
    if(!links.some(n=>n.attribs.rel==='canonical'&&n.attribs.href===item.url))throw new Error('Canonical publisher identity disagreement');
    const articles=DomUtils.getElementsByTagName('article',response.dom.children).filter(n=>/^post-\d+$/.test(n.attribs.id??''));
    if(articles.length!==1)throw new Error('Full article identity/boundary unavailable');
    const node=articles[0],id=node.attribs.id.slice(5);
    if(item.id!=null&&String(item.id)!==id)throw new Error('Known/feed article identity disagreement');
    const body=DomUtils.findAll(n=>hasClass(n,'post-content'),node.children);
    if(!body.some(n=>DomUtils.textContent(n).trim()))throw new Error('Full readable body unavailable; excerpt is insufficient');
    const title=DomUtils.textContent(DomUtils.getElementsByTagName('h1',node.children)[0]??
      DomUtils.getElementsByTagName('title',response.dom.children)[0]??{children:[]}).trim();
    const structured=DomUtils.getElementsByTagName('script',response.dom.children).filter(n=>n.attribs.type==='application/ld+json');
    const html=[node,...structured].map(n=>response.entry.body.slice(n.startIndex,n.endIndex+1)).join('\n');
    const prepared=prepareDocument({title,url:item.url,html});
    for(const link of prepared.links)result.coverage.push({from:item.url,...link,state:'unfetched',reason:'Support/registration/programme/PDF/media retained as metadata; not opened for event extraction'});
    return {id,identity:'gof:document:'+id,url:item.url,raw:response.entry.body,html,
      metadata:DomUtils.getElementsByTagName('meta',response.dom.children).map(n=>({...n.attribs})),listing:item,
      prepared};
  }
  const home=await fetch(GOF_HOME);
  if(home){
    try{
      const doc=document(home,{url:GOF_HOME,via:'homepage'});
      if([...knownDocuments,...pending].some(d=>d.url===GOF_HOME&&d.id!=null&&String(d.id).replace(/^gof:document:/,'')!==doc.id))throw new Error('Known homepage identity disagreement');
      result.home=doc;
      result.documents.push(result.home);
      const scopes=[...DomUtils.getElementsByTagName('nav',home.dom.children),...DomUtils.getElementsByTagName('article',home.dom.children)];
      for(const scope of scopes)for(const anchor of DomUtils.getElementsByTagName('a',scope.children)){
        const item={via:GOF_HOME,label:DomUtils.textContent(anchor).trim(),raw:home.entry.body.slice(anchor.startIndex,anchor.endIndex+1),state:'unfetched',reason:'Navigation/body reference lacks a structured full-announcement association'};
        try{
          item.target=new URL(anchor.attribs.href,GOF_HOME).href;
          item.url=publisherURL(anchor.attribs.href);
          const url=new URL(item.url);
          if(url.hash||/\.(?:pdf|png|jpe?g|webp|gif|mp4|mp3|zip)(?:$|\?)/i.test(item.url)||item.url===GOF_HOME||item.url===GOF_FEED)
            throw new Error('Root/feed, fragment or media link not a detail destination');
        }catch(error){item.state='unfetched';item.reason=error.message;}
        result.inventory.push(item);
      }
      result.coverage.push({url:GOF_HOME,state:'partial',reason:'Whole homepage retained; RSS association required for detail acquisition; navigation/project/topic/meeting/programme/support references unfetched',links:result.home.prepared.links});
    }catch(error){result.coverage.push({url:GOF_HOME,state:'failed',reason:error.message});}
  }
  const feed=await fetch(GOF_FEED,true);
  if(feed){
    result.feed={url:GOF_FEED,raw:feed.entry.body};
    const channel=DomUtils.getElementsByTagName('channel',feed.dom.children)[0];
    if(!channel)result.coverage.push({url:GOF_FEED,state:'failed',reason:'RSS channel unavailable'});
    for(const node of (channel?.children??[]).filter(n=>n.name==='item')){
      const field=name=>DomUtils.textContent(node.children.find(c=>c.name===name)??{children:[]}).trim();
      const item={id:field('post-id'),title:field('title'),published:field('pubDate'),guid:field('guid'),
        raw:feed.entry.body.slice(node.startIndex,node.endIndex+1),via:GOF_FEED,state:'listed'};
      try{
        item.url=publisherURL(field('link'));
        if(!/^\d+$/.test(item.id))throw new Error('RSS article ID unavailable');
        if(item.url===GOF_HOME||item.url===GOF_FEED||/\.(?:pdf|png|jpe?g|webp|gif|mp4|mp3|zip)(?:$|[?#])/i.test(item.url))throw new Error('Root/feed/media is not a full article destination');
      }
      catch(error){item.state='failed';item.reason=error.message;}
      result.inventory.push(item);
    }
    result.coverage.push({url:GOF_FEED,state:'partial',reason:'One RSS page; older feed pages and archives unfetched; feed-only body is not a full detail capture'});
  }
  const associated=new Map((progress.articles??[]).map(d=>[d.url+'\0'+d.id,d]));
  for(const item of result.inventory.filter(d=>d.via===GOF_FEED&&d.state==='listed'))associated.set(item.url+'\0'+item.id,{id:item.id,url:item.url,via:GOF_FEED});
  result.progress.articles=[...associated.values()];
  const urls=new Set(result.progress.articles.map(d=>d.url)),candidates=new Map();
  for(const item of [...result.progress.articles,...result.inventory,...knownDocuments,...pending]){
    if(result.inventory.includes(item)&&item.state!=='listed'){result.coverage.push({...item});continue;}
    try{
      const url=publisherURL(item.url);
      if(url===GOF_HOME)continue;
      if(!urls.has(url)){result.coverage.push({...item,url,state:'unfetched',reason:'No retained RSS article association; stale navigation/project/meeting/support handoffs are not acquired'});continue;}
      const id=item.id==null?undefined:String(item.id).replace(/^gof:document:/,'');
      if(id!=null&&!/^\d+$/.test(id))throw new Error('Unsupported GOF native source identity');
      const prior=candidates.get(url),states=[prior?.pending_state,item.state,item.pending_state];
      if(prior)result.coverage.push({url,state:'duplicate',reason:'Repeated known/pending/feed URL'});
      const conflicting_ids=[...new Set([...prior?.conflicting_ids??[],...item.conflicting_ids??[],prior?.id,id].filter(v=>v!=null))];
      candidates.set(url,{...prior,...item,id:id??prior?.id,url,via:GOF_FEED,conflicting_ids,
        pending_state:states.includes('model-repair')?'model-repair':states.includes('model-pending')?'model-pending':undefined});
    }catch(error){result.coverage.push({url:item.url,state:'unsupported',reason:error.message});}
  }
  const ordered=[...candidates.values()].sort((a,b)=>a.url<b.url?-1:a.url>b.url?1:0);
  const queue=typeof progress.after_url==='string'?[...ordered.filter(d=>d.url>progress.after_url),...ordered.filter(d=>d.url<=progress.after_url)]:ordered;
  const priority={'model-repair':0,'model-pending':1};
  queue.sort((a,b)=>(priority[a.pending_state]??2)-(priority[b.pending_state]??2));
  let selected=result.documents.length;
  for(const item of queue){
    if(item.conflicting_ids.length>1){const failure={...item,state:'failed',reason:'Conflicting known/feed IDs'};result.coverage.push(failure);result.pending.push(failure);continue;}
    if(selected++>=limits.documents){const deferred={...item,state:'deferred',reason:'Document limit'};result.coverage.push(deferred);result.pending.push(deferred);continue;}
    const before=result.fetches.length,response=await fetch(item.url);
    if(result.fetches.length>before)result.progress.after_url=item.url;
    if(!response){const failure=result.coverage.at(-1);result.pending.push({...item,...failure,...result.fetches.length>before?{last_failure:{state:failure.state,reason:failure.reason}}:{}});continue;}
    try{
      const doc=document(response,item);result.documents.push(doc);
      result.coverage.push({url:item.url,identity:doc.identity,state:'prepared',reason:'Whole article/programme and JSON-LD retained; no findings preselected'});
    }catch(error){const failure={...item,state:'failed',reason:error.message,last_failure:{state:'failed',reason:error.message}};result.coverage.push(failure);result.pending.push(failure);}
  }
  return result;
}
