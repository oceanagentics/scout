import {parse} from 'parse5';
import dns from 'node:dns/promises';
import {isIP} from 'node:net';
import {Buffer} from 'node:buffer';

const fail=reason=>Object.assign(new Error(reason),{reason});

function publicAddress(address){
  if(isIP(address)===6)return /^[23]/i.test(address)&&!/^2001:db8:/i.test(address);
  if(isIP(address)!==4)return false;
  const [a,b,c]=address.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||a===100&&b>=64&&b<=127||a===169&&b===254||
    a===172&&b>=16&&b<=31||a===192&&(b===168||b===0&&(c===0||c===2))||
    a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
}

// Text retains document order, table rows, and the links/images beside their context.
function readable(html,url){
  const doc=parse(html),data=[],walk=node=>{
    if(node.tagName==='script'){
      if(node.attrs?.some(a=>a.name==='type'&&a.value==='application/ld+json')){
        try{data.push(JSON.parse(node.childNodes.map(n=>n.value??'').join('')));}catch{}
      }
    }
    for(const child of node.childNodes??[])walk(child);
  };
  walk(doc);
  const find=(node,tags)=>{
    if(tags.includes(node.tagName))return node;
    for(const child of node.childNodes??[]){const found=find(child,tags);if(found)return found;}
  };
  const baseNode=find(doc,['base']),baseHref=baseNode?.attrs?.find(a=>a.name==='href')?.value;
  let base=url;try{base=new URL(baseHref??url,url).href;}catch{}
  const absolute=value=>{try{const u=new URL(value,base);return ['http:','https:'].includes(u.protocol)?u.href:null;}catch{return null;}};
  const render=node=>{
    if(node.nodeName==='#text')return node.value;
    if(['script','style','nav','header','footer','noscript'].includes(node.tagName))return '';
    const attrs=Object.fromEntries((node.attrs??[]).map(a=>[a.name,a.value]));
    if(attrs.hidden!==undefined||attrs['aria-hidden']==='true')return '';
    const children=(node.childNodes??[]).map(render).join('');
    if(node.tagName==='a'){const href=absolute(attrs.href);return href?`[${children.trim()||href}](${href})`:children;}
    if(node.tagName==='img'){const src=absolute(attrs.src??attrs['data-src']);return src?` ![${attrs.alt??''}](${src}) `:'';}
    if(node.tagName==='br')return '\n';
    if(['td','th'].includes(node.tagName))return children+' | ';
    return ['p','div','section','article','main','h1','h2','h3','h4','h5','h6','li','tr','figure','figcaption'].includes(node.tagName)?'\n'+children+'\n':children;
  };
  const content=render(find(doc,['main'])??find(doc,['article'])??find(doc,['body'])??doc)
    .replace(/[\t \u00a0]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  return content+(data.length?'\n\nPublished structured data:\n'+JSON.stringify(data):'');
}

// Every HTTP operation is bounded, public, and cached only for this invocation.
export async function readUrl(value,{fetch:send=fetch,signal,cache=new Map(),metrics}={}){
  let url;try{url=new URL(value);url.hash='';}catch{throw fail('source_invalid');}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw fail('source_invalid');
  if(cache.has(url.href))return cache.get(url.href);
  const pending=(async()=>{
    const bounded=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(15000)]),visited=new Set();
    const request=async target=>{
      for(;;){
        bounded.throwIfAborted();
        if(visited.has(target.href))throw fail('source_invalid');
        visited.add(target.href);
        if(!['https:','http:'].includes(target.protocol)||target.username||target.password)throw fail('source_invalid');
        const host=target.hostname.replace(/^\[|\]$/g,'');
        const addresses=isIP(host)?[{address:host}]:await new Promise((resolve,reject)=>{
          const abort=()=>reject(fail(signal?.aborted?'runtime_bound':'source_unavailable'));
          bounded.addEventListener('abort',abort,{once:true});
          dns.lookup(host,{all:true}).then(resolve,reject).finally(()=>bounded.removeEventListener('abort',abort));
        });
        if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw fail('source_invalid');
        if(metrics)metrics.requests++;
        const response=await send(target.href,{signal:bounded,redirect:'manual'});
        if([301,302,303,307,308].includes(response.status)){
          await response.body?.cancel();
          const location=response.headers.get('location');if(!location)throw fail('source_invalid');
          target=new URL(location,target);continue;
        }
        if(!response.ok){await response.body?.cancel();throw fail('source_unavailable');}
        return {response,url:target};
      }
    };
    const readText=async response=>{const body=await response.text();if(metrics)metrics.bytes+=Buffer.byteLength(body);return body;};
    // CBD's conference shell loads these page-specific articles, including accordions.
    const article=url.hostname==='www.cbd.int'&&url.pathname.match(/^\/conferences\/(\d{4})\/parallel-meetings(?:\/([^/]+))?\/?$/);
    if(article){
      const tags=['conferences',article[1],'parallel-meetings',article[2]??'introduction'];
      const endpoint=new URL('https://www.cbd.int/api/v2017/articles');endpoint.searchParams.set('q',JSON.stringify({adminTags:{$all:tags}}));
      const {response}=await request(endpoint);let articles;
      try{articles=JSON.parse(await readText(response));}catch{throw fail('source_invalid');}
      if(!Array.isArray(articles)||!articles.length)throw fail('source_unavailable');
      const content=articles.filter(a=>tags.every(tag=>a.adminTags?.includes(tag))).map(a=>({
        title:a.title?.en??'',content:readable(a.content?.en??'',url.href)
      })).filter(a=>a.content);
      if(!content.length)throw fail('source_unavailable');
      return {url:url.href,media_type:'application/json',content};
    }
    const result=await request(url),type=(result.response.headers.get('content-type')??'').split(';')[0].trim().toLowerCase();
    const extension=result.url.pathname.match(/\.(pdf|png|jpe?g|webp|gif)$/i)?.[1].toLowerCase();
    const nativeType=type==='application/octet-stream'?{pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif'}[extension]:type;
    if(nativeType==='application/pdf'||/^image\/(?:png|jpeg|webp|gif)$/.test(nativeType??'')){
      await result.response.body?.cancel();
      return {url:result.url.href,media_type:nativeType};
    }
    const body=await readText(result.response);let content;
    if(type==='application/json'||type.endsWith('+json')){try{content=JSON.parse(body);}catch{throw fail('source_invalid');}}
    else if(type.includes('html')||/^\s*(?:<!doctype html|<html)/i.test(body)){
      if(/<ng-view\b[^>]*>\s*<\/ng-view>/i.test(body))throw fail('source_unavailable');
      content=readable(body,result.url.href);
    }
    else if(type.startsWith('text/'))content=body;
    else throw fail('source_invalid');
    if(!content||typeof content==='string'&&!content.trim())throw fail('source_unavailable');
    return {url:result.url.href,media_type:type,content};
  })().then(result=>{if(!cache.has(result.url))cache.set(result.url,Promise.resolve(result));return result;})
    .catch(error=>{throw fail(signal?.aborted?'runtime_bound':error.reason??'source_unavailable');});
  cache.set(url.href,pending);
  return pending;
}

export async function readSource(tracker,{through,fetch:send=fetch,signal,readUrl:read=value=>readUrl(value,{fetch:send,signal})}){
  let url;try{url=new URL(tracker.url);}catch{throw fail('source_invalid');}
  const profile=url.hostname==='bsky.app'&&url.pathname.match(/^\/profile\/([^/]+)\/?$/);
  if(profile)url=new URL('https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor='+encodeURIComponent(decodeURIComponent(profile[1])));
  if(url.origin!=='https://public.api.bsky.app'||url.pathname!=='/xrpc/app.bsky.feed.getAuthorFeed'){
    let content;try{content=await read(url.href);}catch(error){if(signal?.aborted)throw error;content={url:url.href,error:error.reason??'source_unavailable'};}
    return [{url:tracker.url,at:through,source_kind:'web',content}];
  }
  url.searchParams.delete('cursor');url.searchParams.set('includePins','false');
  if(!url.searchParams.has('limit'))url.searchParams.set('limit','100');
  const after=tracker.last_successful_check==null?null:new Date(tracker.last_successful_check).getTime(),until=Date.parse(through),items=[],seen=new Set(),cursors=new Set();
  if(after!==null&&!Number.isFinite(after))throw fail('source_cutoff_invalid');
  for(;;){
    let response;
    try{response=await send(url.href,{signal});}catch{throw fail(signal?.aborted?'runtime_bound':'source_unavailable');}
    if(!response.ok)throw fail('source_unavailable');
    let page;try{page=await response.json();}catch{throw fail('source_invalid');}
    if(!Array.isArray(page.feed))throw fail('source_invalid');
    let boundary=false;
    for(const entry of page.feed){
      if(entry.reason?.$type==='app.bsky.feed.defs#reasonPin')continue;
      const post=entry.post,repost=entry.reason?.$type==='app.bsky.feed.defs#reasonRepost';
      const at=repost?Date.parse(entry.reason.indexedAt):Math.min(Date.parse(post?.record?.createdAt),Date.parse(post?.indexedAt));
      const uri=post?.uri?.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/);
      if(!Number.isFinite(at)||!uri||typeof post.record?.text!=='string')throw fail('source_invalid');
      if(after!==null&&at<=after){boundary=true;continue;}
      if(at>until)continue;
      const key=post.uri+' '+at;
      if(seen.has(key))continue;
      seen.add(key);
      items.push({url:'https://bsky.app/profile/'+uri[1]+'/post/'+uri[2],at:new Date(at).toISOString(),source_kind:'post',content:entry});
    }
    if(boundary||!page.cursor)break;
    if(typeof page.cursor!=='string'||cursors.has(page.cursor))throw fail('source_cursor_repeated');
    cursors.add(page.cursor);url.searchParams.set('cursor',page.cursor);
  }
  return items.sort((a,b)=>a.at.localeCompare(b.at));
}
