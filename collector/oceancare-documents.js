import { Buffer } from 'node:buffer';
import { parseDocument, DomUtils } from 'htmlparser2';
import { prepareDocument } from './octo-documents.js';

export const OCEANCARE_LISTING='https://www.oceancare.org/en/stories-and-news/';
const hasClass=(node,name)=>(node.attribs?.class??'').split(/\s+/).includes(name);

// Current listing only; detail/support/translation links do not recurse.
// Persist returned progress after failed attempts and retain known editions.
export async function retrieveOceanCareDocuments({read,sourceURL,budget,limits,knownDocuments=[],pending=[],progress={},now=Date.now}){
  if(['documents','requests','bytes'].some(k=>!Number.isSafeInteger(limits[k])||limits[k]<1))throw new Error('Invalid OceanCare retrieval bounds');
  const result={source:OCEANCARE_LISTING,inventory:[],documents:[],fetches:[],coverage:[],pending:[],limits:{...limits},progress:{...progress}};
  const publisherURL=(value,base=OCEANCARE_LISTING)=>{
    if(typeof value!=='string'||!value.trim())throw new Error('OceanCare source URL unavailable');
    const url=sourceURL(new URL(value,base).href);
    if(new URL(url).origin!=='https://www.oceancare.org')throw new Error('OceanCare publisher identity unavailable');
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
      if(!DomUtils.getElementsByTagName('link',dom.children).some(n=>n.attribs.rel==='canonical'&&n.attribs.href===url))
        throw new Error('Canonical publisher identity disagreement');
      entry.state='fetched';return {entry,dom};
    }catch(error){entry.reason=error.message;result.coverage.push({url,state:entry.state==='unsupported'?'unsupported':'failed',reason:error.message});return null;}
    finally{if(budget.requests===before)budget.requests++;}
  }
  const listing=await fetch(OCEANCARE_LISTING);
  if(listing){
    try{
      const mains=DomUtils.getElementsByTagName('main',listing.dom.children),main=mains[0];
      if(mains.length!==1)throw new Error('Listing main content unavailable');
      const html=listing.entry.body.slice(main.startIndex,main.endIndex+1);
      const alternates=DomUtils.getElementsByTagName('link',listing.dom.children).filter(n=>n.attribs.rel==='alternate').map(n=>({...n.attribs,state:'unfetched'}));
      result.listing={url:OCEANCARE_LISTING,raw:listing.entry.body,html,alternates,prepared:prepareDocument({title:'Stories and news',url:OCEANCARE_LISTING,html})};
      for(const anchor of DomUtils.getElementsByTagName('a',main.children)){
        const headline=DomUtils.findAll(n=>hasClass(n,'headline'),anchor.children)[0];
        if(!headline)continue;
        const item={title:DomUtils.textContent(headline).trim(),raw:listing.entry.body.slice(anchor.startIndex,anchor.endIndex+1),via:OCEANCARE_LISTING,state:'listed'};
        try{
          item.url=publisherURL(anchor.attribs.href);item.identity='oceancare:url:'+item.url;
          if(new URL(item.url).search||!/^\/en\/stories_and_news\/[^/]+\/$/.test(new URL(item.url).pathname)){
            item.state='unfetched';item.reason='Outside listed English story routes; media/support/language references remain metadata';
          }
        }
        catch(error){item.state='unsupported';item.reason=error.message;}
        result.inventory.push(item);
      }
      result.coverage.push({url:OCEANCARE_LISTING,state:'partial',reason:'One English listing only; pagination/archives, alternate-language listings and support/media unfetched',
        links:[...result.listing.prepared.links,...alternates]});
    }catch(error){result.coverage.push({url:OCEANCARE_LISTING,state:'failed',reason:error.message});}
  }
  const candidates=new Map();
  for(const item of [...result.inventory,...knownDocuments,...pending]){
    if(result.inventory.includes(item)&&item.state!=='listed'){result.coverage.push({...item});continue;}
    try{
      const url=publisherURL(item.url),path=new URL(url);
      if(path.search||!/^\/(?:en\/)?stories_and_news\/[^/]+\/$/.test(path.pathname))throw new Error('Outside publisher story routes; generic/support URLs are not acquired');
      const native=/^oceancare:post:(\d+):([a-z]{2,8}(?:-[a-z0-9]{1,8})*)$/i.exec(String(item.id));
      const id=item.id==null?undefined:native?.[1]??String(item.id),language=native?.[2]??item.language;
      if(id!=null&&!/^\d+$/.test(id)||language!=null&&!/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(language))throw new Error('Unsupported OceanCare native source identity/language');
      if(!path.pathname.startsWith('/en/')&&id==null)throw new Error('Alternate-language story requires a known native ID; language links are not discovery');
      const prior=candidates.get(url),states=[prior?.pending_state,item.state,item.pending_state];
      if(prior)result.coverage.push({url,state:'duplicate',reason:'Repeated known/pending/listing URL'});
      const ids=[...new Set([...prior?.ids??[],...item.ids??[],id].filter(v=>v!=null))];
      const languages=[...new Set([...prior?.languages??[],...item.languages??[],item.language,language].filter(v=>v!=null))];
      candidates.set(url,{...prior,...item,id:id??prior?.id,language:language??prior?.language,url,ids,languages,via:prior?.via??item.via??'known',
        pending_state:states.includes('model-repair')?'model-repair':states.includes('model-pending')?'model-pending':undefined});
    }catch(error){result.coverage.push({url:item.url,state:'unsupported',reason:error.message});}
  }
  const ordered=[...candidates.values()].sort((a,b)=>a.url<b.url?-1:a.url>b.url?1:0);
  const queue=typeof progress.after_url==='string'?[...ordered.filter(d=>d.url>progress.after_url),...ordered.filter(d=>d.url<=progress.after_url)]:ordered;
  const priority={'model-repair':0,'model-pending':1};
  queue.sort((a,b)=>(priority[a.pending_state]??2)-(priority[b.pending_state]??2));
  let selected=0;
  for(const item of queue){
    if(item.ids.length>1||item.languages.length>1){const failure={...item,state:'failed',reason:'Conflicting known post ID/language'};result.coverage.push(failure);result.pending.push(failure);continue;}
    if(selected++>=limits.documents){const deferred={...item,state:'deferred',reason:'Document limit'};result.coverage.push(deferred);result.pending.push(deferred);continue;}
    const before=result.fetches.length,response=await fetch(item.url);
    if(result.fetches.length>before)result.progress.after_url=item.url;
    if(!response){const failure=result.coverage.at(-1);result.pending.push({...item,...failure,...result.fetches.length>before?{last_failure:{state:failure.state,reason:failure.reason}}:{}});continue;}
    try{
      const body=DomUtils.getElementsByTagName('body',response.dom.children)[0];
      const id=body?.attribs.class?.match(/\bpostid-(\d+)\b/)?.[1];
      if(!id||item.id!=null&&String(item.id)!==id)throw new Error('Detail post identity unavailable/disagrees with known ID');
      const mains=DomUtils.getElementsByTagName('main',response.dom.children),main=mains[0];
      const nodes=DomUtils.findAll(n=>hasClass(n,'story-single'),main?.children??[]);
      if(mains.length!==1||nodes.length!==1)throw new Error('Full story boundary unavailable');
      const node=nodes[0],title=DomUtils.textContent(DomUtils.getElementsByTagName('h1',node.children)[0]??{children:[]}).trim();
      const blocks=DomUtils.findAll(n=>['p','ul','ol','table','blockquote','pre','h2','h3','h4','h5','h6'].includes(n.name),node.children).filter(n=>{
        for(let parent=n.parent;parent&&parent!==node;parent=parent.parent)if(hasClass(parent,'introtext'))return false;
        return true;
      });
      if(!title||!blocks.some(n=>DomUtils.textContent(n).trim()))throw new Error('Full readable story body unavailable; intro/excerpt is insufficient');
      const structured=DomUtils.getElementsByTagName('script',response.dom.children).filter(n=>n.attribs.type==='application/ld+json');
      const html=[node,...structured].map(n=>response.entry.body.slice(n.startIndex,n.endIndex+1)).join('\n');
      const metadata=DomUtils.getElementsByTagName('meta',response.dom.children).map(n=>({...n.attribs}));
      const alternates=DomUtils.getElementsByTagName('link',response.dom.children).filter(n=>n.attribs.rel==='alternate').map(n=>({...n.attribs,state:'unfetched'}));
      const language=DomUtils.getElementsByTagName('html',response.dom.children)[0]?.attribs.lang;
      if(!/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(language??'')||item.language!=null&&language!==item.language||
        language.split('-')[0].toLowerCase()!==(new URL(item.url).pathname.startsWith('/en/')?'en':'de'))throw new Error('Detail language metadata unavailable/disagrees with known edition or route');
      const prepared=prepareDocument({title,url:item.url,html}),identity='oceancare:post:'+id+':'+language;
      for(const alternate of alternates){
        try{
          const target=publisherURL(alternate.href,item.url);
          if(target!==item.url)prepared.links.push({target,label:alternate.hreflang,tag:'a',relationship:'support',context:'Publisher language alternate',state:'unfetched'});
        }catch(error){result.coverage.push({from:item.url,url:alternate.href,state:'unsupported',reason:error.message});}
      }
      result.documents.push({id,identity,url:item.url,language,raw:response.entry.body,html,metadata,alternates,listing:item,prepared});
      result.coverage.push({url:item.url,identity,state:'prepared',reason:'Whole story and JSON-LD retained; no record/translation facts inferred'});
      for(const link of prepared.links)result.coverage.push({from:item.url,...link,state:'unfetched',reason:'Support/translation/registration/PDF/media retained as metadata; not opened for event extraction'});
    }catch(error){const failure={...item,state:'failed',reason:error.message,last_failure:{state:'failed',reason:error.message}};result.coverage.push(failure);result.pending.push(failure);}
  }
  return result;
}
