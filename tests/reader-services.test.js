import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWebServices} from '../reader/services/gateway.js';

const url='https://example.org/article';
const jina=content=>Response.json({code:200,data:{httpStatus:200,title:'Ocean report',content}});
const firecrawl=content=>Response.json({success:true,data:{metadata:{statusCode:200},markdown:content}});

test('news and general search request twenty URLs without answers or scraping and report invocation-only usage',async()=>{
 for(const topic of ['news','general']){
 const metrics={requests:0,bytes:0};
 const services=createWebServices({keys:{tavily:'search-key'},metrics,fetch:async(target,options)=>{
  assert.equal(target,'https://api.tavily.com/search');assert.equal(options.redirect,'error');
  assert.equal(options.headers.Authorization,'Bearer search-key');
  assert.deepEqual(JSON.parse(options.body),{query:'BBNJ Secretariat news',topic,search_depth:'basic',max_results:20,
   auto_parameters:false,include_answer:false,include_raw_content:false,include_usage:true});
  return Response.json({results:[{url,title:'Article',content:'Do not pass this to investigation',id:'volatile'}],usage:{credits:1}});
 }});
 assert.deepEqual(await services.search('BBNJ Secretariat news',{topic}),{urls:[url],credits:1});
 assert.equal(metrics.requests,1);assert.ok(metrics.bytes>0);
 assert.deepEqual(metrics.search,{requests:1,results:1,declared_credits:1});
 }
});

test('search failures are bounded and sanitized; missing keys and cancellation do no HTTP work',async t=>{
 for(const response of [Response.json({error:'secret-key'},{status:429}),new Response('invalid JSON'),Response.json({results:[{}]})]){
  const services=createWebServices({keys:{tavily:'secret-key'},fetch:async()=>response});
  await assert.rejects(services.search('BBNJ'),error=>['source_unavailable','source_invalid'].includes(error.reason)&&!JSON.stringify(error).includes('secret-key'));
 }
 let calls=0;
 await assert.rejects(createWebServices({fetch:async()=>{calls++;}}).search('BBNJ'),{reason:'source_unavailable'});
 const cancelled=new AbortController();cancelled.abort();
 await assert.rejects(createWebServices({keys:{tavily:'key'},fetch:async()=>{calls++;}}).search('BBNJ',{signal:cancelled.signal}),{name:'AbortError'});
 assert.equal(calls,0);
 const timeout=new AbortController();t.mock.method(AbortSignal,'timeout',ms=>{assert.equal(ms,20000);return timeout.signal;});
 await assert.rejects(createWebServices({keys:{tavily:'key'},fetch:async(_url,{signal})=>{calls++;timeout.abort();signal.throwIfAborted();}}).search('BBNJ'),{reason:'source_unavailable'});
 assert.equal(calls,1);
});

test('quota failover skips exhausted allowances across pages and a new check can recover',async()=>{
 const calls=[],metrics={requests:0,bytes:0};let recovered=false;
 const fetch=async(target,options)=>{
  assert.equal(options.redirect,'error');calls.push(target);
  if(target.startsWith('https://r.jina.ai/')){
   assert.equal(options.headers.DNT,'1');assert.equal(options.headers['X-No-Cache'],'true');
   return recovered?jina('Recovered article'):Response.json({error:'rate limited'},{status:429});
  }
  if(target==='https://api.tavily.com/extract'){
   assert.equal(options.headers.Authorization,'Bearer tavily-key');
   assert.equal(JSON.parse(options.body).extract_depth,'advanced');
   return Response.json({error:'included credits exhausted'},{status:432});
  }
  assert.equal(target,'https://api.firecrawl.dev/v2/scrape');
  assert.equal(options.headers.Authorization,'Bearer firecrawl-key');
  assert.deepEqual(JSON.parse(options.body),{url:calls.length===3?url:url+'-two',formats:['markdown'],maxAge:0,storeInCache:false,timeout:15000});
  return firecrawl('Full article with [source](https://example.org/evidence)');
 };
 const options={keys:{tavily:'tavily-key',firecrawl:'firecrawl-key'},fetch,metrics};
 const services=createWebServices(options);
 assert.match((await services.scrape(url)).content,/Full article/);
 assert.match((await services.scrape(url+'-two')).content,/Full article/);
 assert.equal(calls.length,4);
 assert.deepEqual(metrics.scraping,{jina:1,tavily:1,firecrawl:2});assert.equal(metrics.requests,4);assert.ok(metrics.bytes>0);
 recovered=true;
 assert.equal((await createWebServices(options).scrape(url)).content,'Recovered article');
 assert.equal(calls.length,5);
});

test('a page failure does not disable that provider for another page',async()=>{
 const calls=[];
 const services=createWebServices({keys:{tavily:'key'},fetch:async(target,options)=>{
  calls.push(target);
  if(target.startsWith('https://r.jina.ai/'))return target.endsWith('-two')?jina('Second page'):Response.json({code:200,data:{httpStatus:403,content:'Forbidden'}});
  const requested=JSON.parse(options.body).urls[0];
  return Response.json({results:[{url:requested,raw_content:'First page'}]});
 }});
 assert.equal((await services.scrape(url)).content,'First page');
 assert.equal((await services.scrape(url+'-two')).content,'Second page');
 assert.equal(calls.length,3);
});

test('each provider has a fresh deadline and a provider timeout permits failover',async t=>{
 const timers=[],signals=[];
 t.mock.method(AbortSignal,'timeout',ms=>{
  assert.equal(ms,20000);const controller=new AbortController();timers.push(controller);return controller.signal;
 });
 const collection=new AbortController();
 const services=createWebServices({keys:{tavily:'key',firecrawl:'key'},fetch:async(target,options)=>{
  const index=signals.length;signals.push(options.signal);assert.equal(options.signal.aborted,false);
  if(target.startsWith('https://r.jina.ai/'))assert.equal(options.headers['X-Timeout'],'15');
  else assert.equal(JSON.parse(options.body).timeout,target==='https://api.tavily.com/extract'?15:15000);
  if(index<2){timers[index].abort(new DOMException('Provider deadline','TimeoutError'));options.signal.throwIfAborted();}
  return target.startsWith('https://r.jina.ai/')?jina('Recovered page'):firecrawl('Article after two provider timeouts');
 }});
 assert.equal((await services.scrape(url,{signal:collection.signal})).content,'Article after two provider timeouts');
 assert.equal(signals.length,3);assert.equal(new Set(signals).size,3);
 assert.equal(signals[0].aborted,true);assert.equal(signals[1].aborted,true);assert.equal(signals[2].aborted,false);
 assert.equal(collection.signal.aborted,false);
 assert.equal((await services.scrape(url+'-two',{signal:collection.signal})).content,'Recovered page');
 assert.equal(signals.length,4);
});

test('HTTP 200 challenges, mismatched results and upstream error pages cannot become article content',async()=>{
 const services=createWebServices({keys:{tavily:'secret-tavily',firecrawl:'secret-firecrawl'},fetch:async target=>{
  if(target.startsWith('https://r.jina.ai/'))return Response.json({code:200,data:{httpStatus:200,title:'Just a moment...',content:'Checking your browser'}});
  if(target==='https://api.tavily.com/extract')return Response.json({results:[{url:'https://other.org/article',raw_content:'Unrelated page'}]});
  return Response.json({success:true,data:{metadata:{statusCode:403},markdown:'Access denied'}});
 }});
 await assert.rejects(services.scrape(url),error=>error.message==='source_unavailable'&&!JSON.stringify(error).includes('secret-'));
});

test('missing credentials are skipped and cancellation never starts another provider',async()=>{
 let calls=0;
 const unconfigured=createWebServices({fetch:async()=>{calls++;return Response.json(null);}});
 await assert.rejects(unconfigured.scrape(url),/source_unavailable/);assert.equal(calls,1);
 const controller=new AbortController();
 const cancelled=createWebServices({keys:{tavily:'key',firecrawl:'key'},fetch:async()=>{calls++;controller.abort();throw controller.signal.reason;}});
 await assert.rejects(cancelled.scrape(url,{signal:controller.signal}),{name:'AbortError'});
 assert.equal(calls,2);
 await assert.rejects(cancelled.scrape(url,{signal:controller.signal}),{name:'AbortError'});
 assert.equal(calls,2);
});
