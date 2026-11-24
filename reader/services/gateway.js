import {scrapeJina} from './jina.js';
import {scrapeTavily} from './tavily.js';
import {scrapeFirecrawl} from './firecrawl.js';
import {isBlockedPage} from '../url.js';

// One instance per collection check. Provider errors, never local credit counters,
// determine which free allowances are unavailable for the rest of that check.
export function createWebServices({keys={},fetch:send=fetch,metrics}={}){
 const unavailable=new Set();
 const services=[['jina',scrapeJina,null],['tavily',scrapeTavily,keys.tavily],['firecrawl',scrapeFirecrawl,keys.firecrawl]];
 return {async scrape(url,{signal}={}){
  for(const [name,read,apiKey] of services){
   signal?.throwIfAborted();
   if(unavailable.has(name)||name!=='jina'&&!apiKey)continue;
   if(metrics){metrics.scraping??={};metrics.scraping[name]=(metrics.scraping[name]??0)+1;}
   try{
    const bounded=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(20000)]);
    const page=await read(url,{apiKey,fetch:send,signal:bounded,metrics});
    if(typeof page.content!=='string'||!page.content.trim()||isBlockedPage(page.title??'')||isBlockedPage(page.content))
     throw new Error('source_unavailable');
    return {media_type:'text/markdown',content:page.content};
   }catch(error){
    if(signal?.aborted)throw error;
    if([401,402,403,429,432,433].includes(error.status)||error.status>=500)unavailable.add(name);
   }
  }
  throw new Error('source_unavailable');
 }};
}
