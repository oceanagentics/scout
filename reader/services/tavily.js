import {Buffer} from 'node:buffer';

export async function searchTavily(query,{apiKey,fetch:send=fetch,signal,metrics}={}){
 if(metrics){metrics.requests++;metrics.search??={requests:0,results:0};metrics.search.requests++;}
 const response=await send('https://api.tavily.com/search',{method:'POST',signal,redirect:'error',
  headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},
  body:JSON.stringify({query,topic:'news',search_depth:'basic',max_results:20,auto_parameters:false,
   include_answer:false,include_raw_content:false,include_usage:true})});
 const body=await response.text();if(metrics)metrics.bytes+=Buffer.byteLength(body);
 if(!response.ok)throw Object.assign(new Error('source_unavailable'),{reason:'source_unavailable',status:response.status});
 let data;try{data=JSON.parse(body);}catch{throw Object.assign(new Error('source_invalid'),{reason:'source_invalid'});}
 if(!Array.isArray(data?.results)||data.results.some(result=>typeof result?.url!=='string'))
  throw Object.assign(new Error('source_invalid'),{reason:'source_invalid'});
 const credits=Number.isFinite(data.usage?.credits)?data.usage.credits:null;
 if(metrics){metrics.search.results+=data.results.length;if(credits!==null)metrics.search.declared_credits=(metrics.search.declared_credits??0)+credits;}
 return {urls:data.results.map(result=>result.url),credits};
}

export async function scrapeTavily(url,{apiKey,fetch:send=fetch,signal,metrics}={}){
 if(metrics)metrics.requests++;
 const response=await send('https://api.tavily.com/extract',{method:'POST',signal,redirect:'error',
  headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},
  body:JSON.stringify({urls:[url],extract_depth:'advanced',format:'markdown',timeout:15})});
 const body=await response.text();if(metrics)metrics.bytes+=Buffer.byteLength(body);
 if(!response.ok)throw Object.assign(new Error('source_unavailable'),{status:response.status});
 let data;try{data=JSON.parse(body);}catch{throw new Error('source_unavailable');}
 const page=data?.results?.find(result=>result.url===url);
 if(!page)throw new Error('source_unavailable');
 return {title:page.title,content:page.raw_content};
}
