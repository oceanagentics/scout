import { Buffer } from 'node:buffer';
import { parseDocument, DomUtils } from 'htmlparser2';
import { prepareDocument } from './octo-documents.js';

export const GFW_LISTING = 'https://globalfishingwatch.org/mediacenter/';
const origin = 'https://globalfishingwatch.org';

// Retrieval only. Persistence, change detection, support fetching and finding
// processing belong to the shared document pipeline.
export async function retrieveGFWDocuments({read,sourceURL,budget,limits,knownArticles=[],linkedEvidence=[],progress={}}) {
  const result={source:GFW_LISTING,documents:[],inventory:[],fetches:[],coverage:[],limits:{...limits},progress:{...progress}};
  const publisherURL=value=>{
    const url=sourceURL(value);
    if(new URL(url).origin!==origin)throw new Error('GFW publisher identity unavailable');
    return url;
  };
  async function fetch(url,mime) {
    if(budget.requests>=limits.requests||Date.now()>=budget.deadline){
      result.coverage.push({url,state:'deferred',reason:'Request/time limit'});return null;
    }
    const entry={requested_url:url,state:'failed'};result.fetches.push(entry);
    const before=budget.requests;
    try{
      const response=await read(sourceURL(url),budget);
      Object.assign(entry,{url:response.url,status:response.status,mime:response.headers?.['content-type']??'',body:response.body});
      if(response.status!==200||response.url!==url||typeof response.body!=='string'||Buffer.byteLength(response.body)>limits.bytes||!entry.mime.includes(mime))
        throw new Error('Response identity/status/format/byte bound');
      entry.state='fetched';return entry;
    }catch(error){entry.reason=error.message;result.coverage.push({url,state:'failed',reason:error.message});return null;}
    finally{if(budget.requests===before)budget.requests++;}
  }
  const listing=await fetch(GFW_LISTING,'text/html');
  if(listing){
    try{
      if(!/<\/html>\s*$/i.test(listing.body.replace(/<!--[\s\S]*?-->/g,'')))throw new Error('Incomplete listing');
      const dom=parseDocument(listing.body,{withStartIndices:true,withEndIndices:true});
      const links=DomUtils.getElementsByTagName('link',dom.children);
      if(!links.some(n=>n.attribs.rel==='canonical'&&n.attribs.href===GFW_LISTING)||
        !links.some(n=>n.attribs.rel==='https://api.w.org/'&&n.attribs.href===origin+'/wp-json/'))throw new Error('Listing publisher/API identity unavailable');
      for(const node of DomUtils.getElementsByTagName('article',dom.children)){
        const id=node.attribs.id?.match(/^post-(\d+)$/)?.[1];
        const heading=DomUtils.getElementsByTagName('h3',node.children).find(n=>(n.attribs.class??'').split(/\s+/).includes('post-title'));
        const anchor=heading&&DomUtils.getElementsByTagName('a',heading.children)[0];
        const item={id,identity:id?'gfw:post:'+id:null,raw:listing.body.slice(node.startIndex,node.endIndex+1),via:GFW_LISTING};
        try{
          if(!id||!anchor)throw new Error('Listing article identity unavailable');
          item.url=publisherURL(anchor.attribs.href);item.title=DomUtils.textContent(heading).trim();
          item.state='listed';
        }catch(error){item.state='failed';item.reason=error.message;}
        result.inventory.push(item);
      }
      result.coverage.push({url:GFW_LISTING,state:'partial',reason:'One listing only; archives, pagination, languages and media are not traversed',
        links:prepareDocument({title:'Media centre',html:listing.body,url:GFW_LISTING}).links});
    }catch(error){result.coverage.push({url:GFW_LISTING,state:'failed',reason:error.message});listing.state='failed';listing.reason=error.message;}
  }
  const candidates=new Map();
  for(const item of [...knownArticles.map(a=>({...a,id:String(a.id),identity:'gfw:post:'+a.id,via:'known',state:'listed'})),...result.inventory]){
    if(item.state!=='listed')continue;
    try{
      if(!/^\d+$/.test(item.id))throw new Error('Invalid known article ID');
      item.url=publisherURL(item.url);
      const prior=candidates.get(item.id);
      if(prior){
        result.coverage.push({identity:item.identity,url:item.url,state:prior.url===item.url?'duplicate':'failed',reason:'Repeated listing/known identity'});
        if(prior.url!==item.url){prior.state='failed';item.state='failed';}
      }else candidates.set(item.id,item);
    }catch(error){item.state='failed';result.coverage.push({url:item.url,state:'failed',reason:error.message});}
  }
  let selected=0;
  // Caller persists progress.after_id after every run, including failed reads.
  // Rotate stable IDs after the last attempted detail, then wrap. Never advance
  // for a request/time deferral. Keep failed/unlisted known identities supplied
  // so both retries and independent rechecks participate in the same rotation.
  const ordered=[...candidates.values()].sort((a,b)=>Number(b.id)-Number(a.id));
  const after=Number(progress.after_id);
  const queue=Number.isFinite(after)?[...ordered.filter(a=>Number(a.id)<after),...ordered.filter(a=>Number(a.id)>=after)]:ordered;
  for(const item of queue){
    if(item.state==='failed')continue;
    if(selected++>=limits.articles){result.coverage.push({identity:item.identity,url:item.url,state:'deferred',reason:'Article limit'});continue;}
    const apiURL=origin+'/wp-json/wp/v2/posts/'+item.id;
    const before=result.fetches.length;
    const response=await fetch(apiURL,'application/json');
    if(result.fetches.length>before)result.progress.after_id=item.id;
    if(!response)continue;
    try{
      const article=JSON.parse(response.body);
      if(String(article.id)!==item.id||publisherURL(article.link)!==item.url||article.status!=='publish'||article.type!=='post'||
        typeof article.date_gmt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(article.date_gmt)||
        !Number.isFinite(Date.parse(article.date_gmt+'Z'))||new Date(article.date_gmt+'Z').toISOString()!==article.date_gmt+'.000Z'||
        article.content?.protected!==false||typeof article.content.rendered!=='string'||!article.content.rendered.trim())
        throw new Error('Full article identity/body unavailable; excerpt is not a full document');
      const prepared=prepareDocument({title:article.title?.rendered??item.title??'',html:article.content.rendered,url:item.url});
      const evidence=linkedEvidence.filter(link=>link.from===item.identity||link.from===item.url).map(link=>({...link,target:sourceURL(link.target),state:'unfetched'}));
      result.documents.push({id:item.id,identity:item.identity,url:item.url,listing:item,api_url:apiURL,raw:response.body,
        html:article.content.rendered,metadata:article,prepared,linked_evidence:evidence,coverage:'full-rendered-content'});
      result.coverage.push({identity:item.identity,url:item.url,state:'prepared',reason:'Entire rendered content retained, including related links; support/media unfetched'});
    }catch(error){result.coverage.push({identity:item.identity,url:item.url,state:'failed',reason:error.message});}
  }
  return result;
}
