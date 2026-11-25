import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureTraffic,diagnoseTracker} from '../diagnostics/diagnose-tracker.js';
import dns from 'node:dns/promises';

async function output(t){
  const dir=await mkdtemp(join(tmpdir(),'scout-diagnostic-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));return join(dir,'traffic.jsonl');
}
const lines=async path=>(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);

test('local capture preserves raw errors/content and readable responses while excluding credentials and unrelated traffic',async t=>{
  const path=await output(t),key='private-api-key',body=JSON.stringify({candidates:[{content:{parts:[{text:'{"date":null}'},{thought:true,text:'Returned thought part'}]}}]});
  await writeFile(path,'old run');
  const seen=[],traffic=captureTraffic(path,{secrets:[key],fetch:async(url,options)=>{
    seen.push({url,options});
    if(url.includes('network-error'))throw new Error('Connection failed '+key);
    return new Response(url.includes('openai')?'{"error":{"message":"Invalid '+key+' sk-masked***"}}':body,{status:url.includes('openai')?401:200});
  }});
  try{
    const response=await traffic.fetch('https://generativelanguage.googleapis.com/v1beta/models/test:generateContent?key='+key,
      {method:'POST',headers:{'x-goog-api-key':key},body:JSON.stringify({prompt:'Exact prompt',schema:{type:'array'},secret:key})});
    assert.equal(await response.text(),body);
    assert.equal((await traffic.fetch('https://api.openai.com/v1/responses',{headers:{Authorization:'Bearer '+key}})).status,401);
    await assert.rejects(traffic.fetch('https://api.openai.com/network-error'),/Connection failed/);
    await traffic.fetch('https://example.supabase.co/database/query',{body:'PRIVATE DATABASE PAYLOAD'});
  }finally{traffic.close();}
  const saved=await readFile(path,'utf8'),entries=await lines(path);
  assert.equal(entries.length,6);assert.equal(entries[1].body,body);assert.equal(entries[3].status,401);
  assert.equal(entries[5].direction,'error');assert.match(entries[5].error,/\[REDACTED\]/);
  assert.equal(JSON.parse(entries[0].body).prompt,'Exact prompt');assert.ok(seen[0].url.includes(key));
  for(const secret of [key,'sk-masked','PRIVATE DATABASE PAYLOAD','Authorization','x-goog-api-key','old run'])assert.ok(!saved.includes(secret));
  assert.equal((await stat(path)).mode&0o777,0o600);
});

test('local response capture is bounded without truncating the response consumed by the model adapter',async t=>{
  const path=await output(t),body='x'.repeat(140000),traffic=captureTraffic(path,{fetch:async()=>new Response(body)});
  try{assert.equal(await (await traffic.fetch('https://api.openai.com/v1/responses')).text(),body);}finally{traffic.close();}
  const response=(await lines(path))[1];assert.equal(response.truncated,true);assert.equal(Buffer.byteLength(response.body),131072);
});

test('local tracker diagnostic uses an explicit model with only a tracker read shared remotely',async t=>{
  t.mock.method(dns,'lookup',async()=>[{address:'93.184.216.34',family:4}]);
  const path=await output(t),tracker='11111111-1111-4111-8111-111111111111',source='https://example.org/event';
  let generations=0;const sql=[];
  const ledger={query:async(q,p)=>{
    sql.push(q);
    if(q.startsWith('select id,name'))return {rows:[{id:tracker,name:'Diagnostic tracker',url:source,collector:'web_page',cadence:'6 hours',search_topic:'news'}]};
    assert.fail('Unexpected shared SQL: '+q);
  }};
  const result=await diagnoseTracker({tracker,model:'gpt-5.6-terra',output:path,env:{SCOUT_OPENAI_API_KEY:'openai-key'},ledger,fetch:async(url,request)=>{
    if(url===source)return new Response('<main>BBNJ data workshop</main>',{headers:{'content-type':'text/html'}});
    assert.equal(url,'https://api.openai.com/v1/responses');generations++;
    const event={description:'BBNJ data workshop',type:'event',score:85,organizations:['Organizer'],date:'2099-12-10',starttime:'13:30',timezone:'UTC'};
    const body=JSON.parse(request.body),output=body.input.find(i=>i.type==='function_call_output');
    assert.equal(body.model,'gpt-5.6-terra');assert.equal(body.reasoning.effort,'low');
    if(!output)return Response.json({status:'completed',output:[{type:'function_call',name:'search_findings',call_id:'search',arguments:JSON.stringify({queries:['Organizer'],urls:[]})}]});
    return Response.json({status:'completed',usage:{input_tokens:400,output_tokens:200,total_tokens:600},
      output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({status:'complete',decisions:[{action:'create',id:null,fields:{...event,details:null,supporting_urls:[]},reason:null}]})}]}]});
  }});
  assert.equal(generations,2);assert.equal(result.result.state,'saved');
  assert.equal(result.records.length,1);assert.equal(result.records[0].date,'2099-12-10');assert.equal(result.records[0].starttime,'13:30');
  const entries=await lines(path),requests=entries.filter(e=>e.direction==='request'),responses=entries.filter(e=>e.direction==='response');
  assert.equal(requests.length,2);assert.equal(responses.length,2);
  assert.match(requests[0].body,/json_schema/);
  assert.match(responses.at(-1).body,/output_text/);
  assert.equal(sql.length,1);assert.ok(sql[0].startsWith('select id,name'));
});

test('local diagnostics copy the search query and topic and enumerate URLs without a discovery model',async t=>{
 t.mock.method(dns,'lookup',async()=>[{address:'93.184.216.34',family:4}]);
 const path=await output(t),tracker='11111111-1111-4111-8111-111111111111',source='https://example.org/news';
 let searches=0,generations=0;
 const result=await diagnoseTracker({tracker,output:path,env:{SCOUT_OPENAI_API_KEY:'model-key',TAVILY_API_KEY:'search-key'},
  ledger:{query:async()=>({rows:[{id:tracker,name:'News',url:'https://api.tavily.com/search',collector:'web_index',cadence:'1 day',search_query:'BBNJ Secretariat news',search_topic:'general'}]})},
  fetch:async(url,request)=>{
   if(url==='https://api.tavily.com/search'){
    searches++;assert.equal(request.method,'POST');assert.equal(JSON.parse(request.body).query,'BBNJ Secretariat news');assert.equal(JSON.parse(request.body).topic,'general');
    return Response.json({results:[{url:source}],usage:{credits:1}});
   }
   if(url===source)return new Response('BBNJ news article',{headers:{'content-type':'text/plain'}});
   assert.equal(url,'https://api.openai.com/v1/responses');generations++;
   const body=JSON.parse(request.body);assert.ok(body.text.format.schema.properties.decisions);
   assert.equal(JSON.parse(body.input[0].content[0].text).input.url,source);
   return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({status:'complete',decisions:[]})}]}]});
  }});
 assert.equal(searches,1);assert.equal(generations,1);assert.equal(result.result.processed,1);assert.equal(result.result.state,'no_findings');
 assert.deepEqual(result.result.source.search,{requests:1,results:1,declared_credits:1});
});
