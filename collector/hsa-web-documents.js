import { Buffer } from 'node:buffer';
import { parseDocument, DomUtils } from 'htmlparser2';
import { prepareDocument } from './octo-documents.js';

export const HSA_FEED='https://highseasalliance.org/feed/';
const origin='https://highseasalliance.org';
const hasClass=(node,name)=>(node.attribs?.class??'').split(/\s+/).includes(name);

// Prefer full public HTML; the evidenced post endpoint is a bounded fallback.
// Persist progress after attempted failures and retain known/unlisted IDs/URLs.
export async function retrieveHSAWebDocuments({read,sourceURL,budget,limits,knownDocuments=[],pending=[],progress={}}){
  const result={source:HSA_FEED,inventory:[],documents:[],fetches:[],coverage:[],limits:{...limits},progress:{...progress}};
  const publisherURL=value=>{
    if(typeof value!=='string'||!value.trim())throw new Error('HSA source URL unavailable');
    const url=sourceURL(value);
    if(new URL(url).origin!==origin)throw new Error('HSA publisher identity unavailable');
    return url;
  };
  async function fetch(url,format){
    if(budget.requests>=limits.requests||Date.now()>=budget.deadline){result.coverage.push({url,state:'deferred',reason:'Request/time limit'});return null;}
    const entry={requested_url:url,state:'failed'};result.fetches.push(entry);
    const before=budget.requests;
    try{
      const response=await read(sourceURL(url),budget);
      Object.assign(entry,{url:response.url,status:response.status,mime:response.headers?.['content-type']??'',body:response.body});
      if(response.url!==url||response.status!==200||typeof response.body!=='string'||Buffer.byteLength(response.body)>limits.bytes)
        throw new Error('Response identity/status/byte bound');
      if(!(format==='xml'?/xml/i:format==='json'?/^application\/json\b/i:/^text\/html\b/i).test(entry.mime)){
        entry.state='unsupported';throw new Error('Unsupported response format; media/PDF not prepared');
      }
      entry.state='fetched';return entry;
    }catch(error){entry.reason=error.message;result.coverage.push({url,state:entry.state==='unsupported'?'unsupported':'failed',reason:error.message});return null;}
    finally{if(budget.requests===before)budget.requests++;}
  }
  const feed=await fetch(HSA_FEED,'xml');
  if(feed){
    result.feed={url:HSA_FEED,raw:feed.body};
    try{
      if(!/<\/rss>\s*$/i.test(feed.body))throw new Error('Incomplete RSS document');
      const dom=parseDocument(feed.body,{xmlMode:true,withStartIndices:true,withEndIndices:true});
      const channel=DomUtils.getElementsByTagName('channel',dom.children)[0];
      if(!channel)throw new Error('RSS channel unavailable');
      for(const node of (channel.children??[]).filter(n=>n.name==='item')){
        const field=name=>DomUtils.textContent(node.children.find(n=>n.name===name)??{children:[]}).trim();
        const item={id:field('post-id'),title:field('title'),published:field('pubDate'),guid:field('guid'),
          raw:feed.body.slice(node.startIndex,node.endIndex+1),via:HSA_FEED,state:'listed'};
        try{
          item.url=publisherURL(field('link'));
          if(!/^\d+$/.test(item.id))throw new Error('RSS document identity unavailable');
          item.identity='hsa:document:'+item.id;
        }catch(error){item.state='failed';item.reason=error.message;}
        result.inventory.push(item);
      }
      result.coverage.push({url:HSA_FEED,state:'partial',reason:'Current RSS page only; archives, other site pages, attachments and support not traversed; RSS excerpts never count as full documents'});
    }catch(error){result.coverage.push({url:HSA_FEED,state:'failed',reason:error.message});}
  }
  const candidates=new Map();
  for(const item of [...knownDocuments.map(d=>({...d,id:String(d.id),via:'known',state:'listed'})),...result.inventory]){
    if(item.state!=='listed'){result.coverage.push({...item});continue;}
    try{
      item.url=publisherURL(item.url);
      if(!/^\d+$/.test(item.id))throw new Error('Known document ID unavailable');
      const prior=candidates.get(item.url);
      if(prior){
        result.coverage.push({url:item.url,state:prior.id===item.id?'duplicate':'failed',reason:'Repeated known/feed URL identity'});
        if(prior.id!==item.id)prior.state='failed';
      }else candidates.set(item.url,item);
    }catch(error){result.coverage.push({url:item.url,state:'failed',reason:error.message});}
  }
  const ordered=[...candidates.values()].filter(d=>d.state!=='failed').sort((a,b)=>a.url<b.url?-1:a.url>b.url?1:0);
  const queue=typeof progress.after_url==='string'?[...ordered.filter(d=>d.url>progress.after_url),...ordered.filter(d=>d.url<=progress.after_url)]:ordered;
  const priority=new Map(pending.filter(d=>['model-repair','model-pending'].includes(d.state)).map(d=>[d.url,d.state==='model-repair'?0:1]));
  queue.sort((a,b)=>(priority.get(a.url)??2)-(priority.get(b.url)??2)); // Prioritize only existing known/listed candidates.
  let selected=0;
  for(const item of queue){
    if(selected++>=limits.documents){result.coverage.push({url:item.url,state:'deferred',reason:'Document limit'});continue;}
    const before=result.fetches.length;
    let response=await fetch(item.url,'html'),html,title,metadata,route;
    if(result.fetches.length>before)result.progress.after_url=item.url;
    if(response){
      try{
        if(!/<\/html>\s*$/i.test(response.body.replace(/<!--[\s\S]*?-->/g,'')))throw new Error('Incomplete HTML document');
        const dom=parseDocument(response.body,{withStartIndices:true,withEndIndices:true});
        if(!DomUtils.getElementsByTagName('link',dom.children).some(n=>n.attribs.rel==='canonical'&&n.attribs.href===item.url))throw new Error('Canonical HTML identity disagreement');
        const nodes=DomUtils.getElementsByTagName('article',dom.children).filter(n=>n.attribs.id==='post-'+item.id);
        if(nodes.length!==1)throw new Error('Full HTML article identity unavailable');
        const node=nodes[0],body=DomUtils.findAll(n=>hasClass(n,'entry-content'),node.children);
        title=DomUtils.textContent(DomUtils.getElementsByTagName('h1',node.children)[0]??{children:[]}).trim();
        if(!title||!body.some(n=>DomUtils.textContent(n).trim()))throw new Error('Full HTML body unavailable; excerpt is insufficient');
        const structured=DomUtils.getElementsByTagName('script',dom.children).filter(n=>n.attribs.type==='application/ld+json');
        html=[node,...structured].map(n=>response.body.slice(n.startIndex,n.endIndex+1)).join('\n');
        metadata=DomUtils.getElementsByTagName('meta',dom.children).map(n=>({...n.attribs}));route='html';
      }catch(error){result.coverage.push({url:item.url,state:'failed',reason:error.message});response=null;}
    }
    if(!response){
      const apiURL=origin+'/wp-json/wp/v2/posts/'+item.id;
      const beforeAPI=result.fetches.length;response=await fetch(apiURL,'json');
      if(result.fetches.length>beforeAPI)result.progress.after_url=item.url;
      if(!response)continue;
      try{
        const article=JSON.parse(response.body);
        if(String(article.id)!==item.id||publisherURL(article.link)!==item.url||article.status!=='publish'||article.type!=='post'||
          article.content?.protected!==false||typeof article.content.rendered!=='string'||!article.content.rendered.trim()||
          typeof article.title?.rendered!=='string'||!article.title.rendered.trim())throw new Error('Full API identity/body unavailable; excerpt is insufficient');
        html=article.content.rendered;title=article.title.rendered;metadata=article;route='api';
      }catch(error){result.coverage.push({url:item.url,state:'failed',reason:error.message});continue;}
    }
    try{
      const prepared=prepareDocument({title,url:item.url,html}),identity='hsa:document:'+item.id;
      result.documents.push({id:item.id,identity,url:item.url,raw:response.body,response_url:response.url,html,metadata,route,listing:item,prepared});
      result.coverage.push({url:item.url,identity,state:'prepared',reason:'Full document retained via '+route+'; no record/session/schedule interpretation'});
      for(const link of prepared.links)result.coverage.push({from:item.url,...link,state:'unfetched',reason:'Support/registration/programme/PDF/media requires shared retrieval'});
    }catch(error){result.coverage.push({url:item.url,state:'failed',reason:error.message});}
  }
  return result;
}
