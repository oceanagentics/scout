import {Buffer} from 'node:buffer';

export async function scrapeJina(url,{fetch:send=fetch,signal,metrics}={}){
 if(metrics)metrics.requests++;
 const response=await send('https://r.jina.ai/'+url,{signal,redirect:'error',
  headers:{Accept:'application/json','X-Engine':'browser','X-No-Cache':'true',DNT:'1'}});
 const body=await response.text();if(metrics)metrics.bytes+=Buffer.byteLength(body);
 if(!response.ok)throw Object.assign(new Error('source_unavailable'),{status:response.status});
 let data;try{data=JSON.parse(body);}catch{throw new Error('source_unavailable');}
 const page=data?.data;
 if(data?.code!==200||!(page?.httpStatus>=200&&page.httpStatus<300))throw new Error('source_unavailable');
 return {title:page.title,content:page.content};
}
