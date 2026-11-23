import {parse} from 'parse5';
import dns from 'node:dns/promises';
import {isIP} from 'node:net';
import {Buffer} from 'node:buffer';
import {checkFreshness,checkContentFreshness} from './freshness.js';

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
export function readable(html,url){
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
    if(['script','style','nav','footer','noscript'].includes(node.tagName)||node.tagName==='header'&&node.parentNode?.tagName!=='article')return '';
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
export async function readUrl(value,{fetch:send=fetch,signal,cache=new Map(),metrics,lastSuccessfulCheck=null,previousRequestURL=value,previousFingerprint=null}={}){
  let url;try{url=new URL(value);url.hash='';}catch{throw fail('source_invalid');}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw fail('source_invalid');
  // A cached body can serve different checkpoints; a 304 cannot.
  let pending=cache.get(url.href);
  if(pending&&(await pending).unchanged)pending=null;
  const diagnostics={url:url.href,stage:'validate',http_status:null};
  pending??=(async()=>{
    const checked_at=new Date().toISOString();
    const bounded=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(15000)]),visited=new Set();
    const request=async target=>{
      for(;;){
        diagnostics.stage='validate';
        bounded.throwIfAborted();
        if(visited.has(target.href))throw fail('source_invalid');
        visited.add(target.href);
        if(!['https:','http:'].includes(target.protocol)||target.username||target.password)throw fail('source_invalid');
        diagnostics.url=target.href;diagnostics.http_status=null;diagnostics.stage='dns';
        const host=target.hostname.replace(/^\[|\]$/g,'');
        const addresses=isIP(host)?[{address:host}]:await new Promise((resolve,reject)=>{
          const abort=()=>reject(fail(signal?.aborted?'runtime_bound':'source_unavailable'));
          bounded.addEventListener('abort',abort,{once:true});
          dns.lookup(host,{all:true}).then(resolve,reject).finally(()=>bounded.removeEventListener('abort',abort));
        });
        if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw fail('source_invalid');
        if(metrics)metrics.requests++;
        diagnostics.stage='fetch';
        const {response,unchanged}=await checkFreshness(target.href,{lastSuccessfulCheck:target.href===previousRequestURL?lastSuccessfulCheck:null,signal:bounded,
          fetch:(url,options)=>send(url,{...options,headers:{...options.headers,'User-Agent':'Scout/0.1'},redirect:'manual'})});
        diagnostics.stage='response';diagnostics.http_status=response.status;
        if([301,302,303,307,308].includes(response.status)){
          await response.body?.cancel();
          const location=response.headers.get('location');if(!location)throw fail('source_invalid');
          target=new URL(location,target);continue;
        }
        if(unchanged)return {url:target,unchanged:true};
        if(!response.ok){await response.body?.cancel();throw fail('source_unavailable');}
        return {response,url:target};
      }
    };
    const readText=async response=>{diagnostics.stage='body';const body=await response.text();if(metrics)metrics.bytes+=Buffer.byteLength(body);return body;};
    const result=await request(url);
    if(result.unchanged)return {url:result.url.href,request_url:result.url.href,checked_at,unchanged:true};
    const type=(result.response.headers.get('content-type')??'').split(';')[0].trim().toLowerCase();
    const extension=result.url.pathname.match(/\.(pdf|png|jpe?g|webp|gif)$/i)?.[1].toLowerCase();
    const nativeType=type==='application/octet-stream'?{pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif'}[extension]:type;
    if(nativeType==='application/pdf'||/^image\/(?:png|jpeg|webp|gif)$/.test(nativeType??'')){
      await result.response.body?.cancel();
      return {url:result.url.href,request_url:result.url.href,checked_at,media_type:nativeType};
    }
    const body=await readText(result.response);diagnostics.stage='prepare';let content;
    if(type==='application/json'||type.endsWith('+json')){try{content=JSON.parse(body);}catch{throw fail('source_invalid');}}
    else if(type.includes('html')||/^\s*(?:<!doctype html|<html)/i.test(body)){
      if(/<ng-view\b[^>]*>\s*<\/ng-view>/i.test(body))throw fail('source_unavailable');
      content=readable(body,result.url.href);
    }
    else if(type.startsWith('text/')||type.includes('xml'))content=body;
    else throw fail('source_invalid');
    if(!content||typeof content==='string'&&!content.trim())throw fail('source_unavailable');
    return {url:result.url.href,request_url:result.url.href,checked_at,media_type:type,content};
  })().then(result=>{if(!cache.has(result.url))cache.set(result.url,Promise.resolve(result));return result;})
    .catch(error=>{throw Object.assign(fail(signal?.aborted?'runtime_bound':error.reason??'source_unavailable'),{diagnostics:{...diagnostics,
      error_name:String(error.name??'Error').slice(0,80),
      error_code:String(error.cause?.code??error.code??'').replace(/[^a-z0-9_]/gi,'').slice(0,80)||null,
      error_message:[error.message,error.cause?.message].filter(value=>typeof value==='string').join(': ')
        .replace(/\bsk-[a-z0-9_.*-]+/gi,'[REDACTED]').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,512)
    }});});
  cache.set(url.href,pending);
  const source=await pending,prior=source.request_url===previousRequestURL?previousFingerprint:null;
  if(source.unchanged)return {...source,fingerprint:prior};
  return Object.hasOwn(source,'content')?{...source,...checkContentFreshness(source,prior)}:source;
}
