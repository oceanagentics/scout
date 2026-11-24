import {Buffer} from 'node:buffer';

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
