import {Buffer} from 'node:buffer';

export async function scrapeFirecrawl(url,{apiKey,fetch:send=fetch,signal,metrics}={}){
 if(metrics)metrics.requests++;
 const response=await send('https://api.firecrawl.dev/v2/scrape',{method:'POST',signal,redirect:'error',
  headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},
  body:JSON.stringify({url,formats:['markdown'],maxAge:0,storeInCache:false,timeout:15000})});
 const body=await response.text();if(metrics)metrics.bytes+=Buffer.byteLength(body);
 if(!response.ok)throw Object.assign(new Error('source_unavailable'),{status:response.status});
 let data;try{data=JSON.parse(body);}catch{throw new Error('source_unavailable');}
 const page=data?.data,status=page?.metadata?.statusCode;
 if(!data?.success||status!=null&&!(status>=200&&status<300))throw new Error('source_unavailable');
 return {title:page?.metadata?.title,content:page?.markdown};
}
