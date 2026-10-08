import { Buffer } from 'node:buffer';
import { parseDocument, DomUtils } from 'htmlparser2';
import { prepareDocument } from './octo-documents.js';

export const GFW_LISTING = 'https://globalfishingwatch.org/mediacenter/';
const origin = 'https://globalfishingwatch.org';

// Exact, reviewed public sources. Paths select publisher documents, never findings.
export const PUBLISHER_SOURCES = [
  {key:'skylight',name:'Skylight (Ai2)',url:'https://skylight.global/news',detail:/^\/news\/[^/]+\/?$/},
  {key:'oceans5',name:'Oceans 5',url:'https://www.oceans5.org/projects/',detail:/^\/project\/[^/]+\/$/},
  {key:'bloomberg-oceans',name:'Bloomberg Ocean Initiative',url:'https://www.bloomberg.org/environment/protecting-the-oceans/'},
  {key:'minderoo',name:'Minderoo Foundation',url:'https://www.minderoo.org/media/',detail:/^\/media\/[^/]+\/$/},
  {key:'oceankind',name:'Oceankind',url:'https://oceankind.org/',listings:['https://oceankind.org/','https://oceankind.org/approach/'],wholeBody:true},
  {key:'skytruth',name:'SkyTruth',url:'https://skytruth.org/blog',detail:/^\/blog\/[^/]+\/?$/},
  {key:'oceano-azul',name:'Oceano Azul Foundation',url:'https://oceanoazulfoundation.org/media/',listings:['https://oceanoazulfoundation.org/media/','https://oceanoazulfoundation.org/what-we-do/'],detail:/^\/what-we-do\/[^/]+\/$/},
  {key:'obis',name:'UNESCO-IOC OBIS',url:'https://obis.org/',detail:/^\/\d{4}\/\d\d\/\d\d\/[^/]+\/$/},
  {key:'geo-cop17',name:'GEO — CBD COP17 pavilion schedule',url:'https://earthobservations.org/about-us/events/cop17/schedule',detail:/^\/about-us\/events\/cop17\/schedule\/[^/]+\/?$/,daily:true,wholeBody:true},
  {key:'cbd-cop17',name:'CBD COP17 — Yerevan, Armenia',url:'https://www.cbd.int/conferences/2026',conference:'2026',daily:true},
];

export async function retrievePublisherDocuments({tracker,read,sourceURL,budget,limits,known=[],knownDocuments=[],pending=[],progress={}}) {
  const profile=PUBLISHER_SOURCES.find(p=>tracker.collector==='web'&&p.url===tracker.url);
  if(!profile)throw new Error('Unsupported publisher tracker');
  const documents=[],inventory=[],coverage=[],fetches=[],next={...progress},candidates=new Map();
  const publisherURL=value=>{
    const url=sourceURL(value),u=new URL(url),configured=new URL(profile.url);
    if(u.origin!==configured.origin||u.search)throw new Error('Outside configured publisher');
    return url;
  };
  async function capture(url,api=false) {
    if(documents.length>=limits.documents||budget.requests>=limits.requests||Date.now()>=budget.deadline){coverage.push({url,state:'deferred',reason:'Document/request/time bound'});return;}
    const receipt={requested_url:url,state:'failed'},before=budget.requests;fetches.push(receipt);
    try{
      const response=await read(sourceURL(url),budget);receipt.response=response;
      if(response.status!==200||sourceURL(response.url)!==url||typeof response.body!=='string'||Buffer.byteLength(response.body)>limits.bytes||Date.now()>=budget.deadline)
        throw new Error('Response identity/status/byte/time bound');
      let html,title='',region;
      if(api){
        if(!/json/i.test(response.headers?.['content-type']??''))throw new Error('Conference API format unavailable');
        const rows=JSON.parse(response.body);
        if(!Array.isArray(rows)||rows.length!==1||rows[0].code!==profile.conference||rows[0]._id!=='69a875b3475867d4716ad6bc')throw new Error('Conference identity unavailable');
        html='<pre>'+response.body.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')+'</pre>';
        region={kind:'complete-conference-response'};
      }else{
        if(!/text\/html/i.test(response.headers?.['content-type']??'')||!/<\/html>\s*$/i.test(response.body.replace(/<!--[\s\S]*?-->/g,'')))throw new Error('HTML format/integrity unavailable');
        const dom=parseDocument(response.body,{withStartIndices:true,withEndIndices:true});
        title=DomUtils.textContent(DomUtils.getElementsByTagName('title',dom.children)[0]??{});
        const mains=profile.wholeBody?[]:DomUtils.getElementsByTagName('main',dom.children);
        const selected=mains.length?mains:DomUtils.getElementsByTagName('body',dom.children);
        if(selected.length!==1)throw new Error('Document boundary ambiguous');
        const node=selected[0];html=response.body.slice(node.startIndex,node.endIndex+1);
        region={kind:node.name,start:node.startIndex,end:node.endIndex+1};
      }
      const prepared=prepareDocument({title,html,url,htmlWhitespace:true});
      if(!prepared.text.trim())throw new Error('Empty publisher document');
      const doc={id:url,identity:'publisher:'+url,url,raw:response.body,response,regions:[region],prepared,provenance:[{relationship:'configured-publisher',source_url:profile.url}]};
      documents.push(doc);receipt.state='prepared';coverage.push({url,state:'prepared',reason:'Whole source region retained; scripts, archives, media and external support unfetched'});
      return doc;
    }catch(error){receipt.reason=error.message;coverage.push({url,state:'failed',reason:error.message});}
    finally{if(budget.requests===before)budget.requests++;}
  }
  if(profile.conference){
    const url=sourceURL('https://api.cbd.int/api/v2016/conferences?'+new URLSearchParams({q:JSON.stringify({code:profile.conference})}));
    await capture(url,true);
  }else{
    for(const url of profile.listings??[profile.url]){
      const doc=await capture(sourceURL(url));
      for(const link of doc?.prepared.links??[]){
        try{
          const url=publisherURL(link.target);
          if(profile.detail?.test(new URL(url).pathname)){candidates.set(url,{id:url,url});inventory.push({id:url,url,state:'listed'});}
          else coverage.push({...link,state:'unfetched',reason:'Outside bounded publisher detail paths'});
        }catch{coverage.push({...link,state:'unfetched',reason:'External/support/media link'});}
      }
    }
    for(const item of [...known,...knownDocuments]){
      try{const url=publisherURL(item.url);if(item.id===url&&profile.detail?.test(new URL(url).pathname))candidates.set(url,{id:url,url});}
      catch{coverage.push({url:item.url,state:'failed',reason:'Known publisher identity conflict'});}
    }
    const ordered=[...candidates.values()],after=ordered.findIndex(i=>i.url===progress.after_url);
    const queue=after<0?ordered:[...ordered.slice(after+1),...ordered.slice(0,after+1)];
    const priority=new Map(pending.filter(i=>['model-repair','model-pending'].includes(i.state)).map(i=>[i.url,i.state==='model-repair'?0:1]));
    queue.sort((a,b)=>(priority.get(a.url)??2)-(priority.get(b.url)??2));
    for(const item of queue){
      const before=fetches.length;await capture(item.url);
      if(fetches.length>before)next.after_url=item.url;
    }
  }
  return {documents,inventory,coverage,fetches,progress:next,complete:false};
}

// Retrieval only. Persistence, change detection, support fetching and finding
// processing belong to the shared document pipeline.
export async function retrieveGFWDocuments({read,sourceURL,budget,limits,knownArticles=[],pending=[],linkedEvidence=[],progress={}}) {
  const result={source:GFW_LISTING,documents:[],inventory:[],fetches:[],coverage:[],limits:{...limits},progress:{...progress}};
  const wrappers=new Set(progress.wrapper_ids??[]);
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
        if(id&&(node.attribs.class??'').split(/\s+/).includes('type-page')&&DomUtils.getElementsByTagName('article',node.children).length){
          wrappers.add(id);continue; // A WordPress page wrapper is not one of its descendant cards.
        }
        const heading=DomUtils.getElementsByTagName('h3',node.children).find(n=>{
          let parent=n.parent;while(parent&&parent.name!=='article')parent=parent.parent;
          return parent===node&&(n.attribs.class??'').split(/\s+/).includes('post-title');
        });
        const anchor=heading&&DomUtils.getElementsByTagName('a',heading.children)[0];
        const item={id,identity:id?'gfw:post:'+id:null,raw:listing.body.slice(node.startIndex,node.endIndex+1),via:GFW_LISTING};
        try{
          if(!id||!anchor)throw new Error('Listing article identity unavailable');
          item.url=publisherURL(anchor.attribs.href);item.title=DomUtils.textContent(heading).trim();
          item.state='listed';wrappers.delete(id);
        }catch(error){item.state='failed';item.reason=error.message;}
        result.inventory.push(item);
      }
      result.coverage.push({url:GFW_LISTING,state:'partial',reason:'One listing only; archives, pagination, languages and media are not traversed',
        links:prepareDocument({title:'Media centre',html:listing.body,url:GFW_LISTING}).links});
    }catch(error){result.coverage.push({url:GFW_LISTING,state:'failed',reason:error.message});listing.state='failed';listing.reason=error.message;}
  }
  result.progress.wrapper_ids=[...wrappers];
  for(const id of wrappers)result.coverage.push({identity:'gfw:post:'+id,url:GFW_LISTING,state:'unsupported',reason:'Listing page wrapper; descendant card identity must not be borrowed. Known mapping retained but excluded from detail rotation.'});
  const candidates=new Map();
  for(const item of [...knownArticles.map(a=>({...a,id:String(a.id),identity:'gfw:post:'+a.id,via:'known',state:'listed'})),...result.inventory]){
    if(item.state!=='listed'||wrappers.has(item.id))continue;
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
  const priority=new Map(pending.filter(d=>['model-repair','model-pending'].includes(d.state)).map(d=>[d.url,d.state==='model-repair'?0:1]));
  queue.sort((a,b)=>(priority.get(a.url)??2)-(priority.get(b.url)??2)); // Prioritize only existing known/listed candidates.
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
