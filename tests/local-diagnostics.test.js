import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {captureTraffic,diagnoseSource} from '../dev/diagnose-source.js';

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
    await assert.rejects(traffic.fetch('https://api.tavily.com/network-error'),/Connection failed/);
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
  try{assert.equal(await (await traffic.fetch('https://api.tavily.com/search')).text(),body);}finally{traffic.close();}
  const response=(await lines(path))[1];assert.equal(response.truncated,true);assert.equal(Buffer.byteLength(response.body),131072);
});

test('local source diagnostic captures intake, search and follow-up with only quota writes shared remotely',async t=>{
  const path=await output(t),tracker='11111111-1111-4111-8111-111111111111',source='https://example.org/event',support='https://example.org/programme';
  let generations=0,searches=0,savedId;const sql=[];
  const ledger={query:async(q,p)=>{
    sql.push(q);
    if(q.startsWith('select enabled'))return {rows:[{allowed:true}]};
    if(q.startsWith('select id,name'))return {rows:[{id:tracker,name:'Diagnostic tracker',url:source,collector:'web',cadence:'6 hours'}]};
    if(q.includes('reserve_provider'))return {rows:[{allowed:true}]};
    if(q.includes('settle_provider'))return {rows:[{settled:true}]};
    assert.fail('Unexpected shared SQL: '+q);
  }};
  const result=await diagnoseSource({tracker,source,output:path,env:{GEMINI_API_KEY:'gemini-key',TAVILY_API_KEY:'tavily-key'},ledger,fetch:async(url,request)=>{
    if(url.endsWith('/usage'))return Response.json({account:{plan_limit:1000,plan_usage:0},key:{limit:null}});
    if(url.endsWith('/search')){searches++;return Response.json({results:[{url:support,content:'Time in search body: 13:30 UTC'}]});}
    generations++;const body=JSON.parse(request.body),event={description:'BBNJ data workshop',type:'event',priority:'high',organizations:['Organizer'],date:'2026-10-22',starttime:null,timezone:null};
    if(generations===2){
      const input=JSON.parse(body.contents[0].parts[1].text);savedId=input.records[0].record_id;
      assert.equal(input.research,'event_schedule');assert.deepEqual(input.search_results[0].urls,[support]);
      Object.assign(event,{record_id:savedId,date_source_url:support,starttime:'13:30',timezone:'UTC'});
    }
    return Response.json({responseId:'response-'+generations,usageMetadata:{promptTokenCount:400,toolUsePromptTokenCount:100,candidatesTokenCount:200,totalTokenCount:700},
      candidates:[{finishReason:'STOP',urlContextMetadata:{urlMetadata:[{retrievedUrl:generations===1?source:support,urlRetrievalStatus:'URL_RETRIEVAL_STATUS_SUCCESS'}]},
        content:{parts:[{text:JSON.stringify([event])}]}}]});
  }});
  assert.equal(generations,2);assert.equal(searches,1);assert.equal(result.result.improvement,'improved');
  assert.equal(result.records.length,1);assert.equal(result.records[0].id,savedId);assert.equal(result.records[0].details.start.utc,'2026-10-22T13:30:00.000Z');
  const entries=await lines(path),requests=entries.filter(e=>e.direction==='request'),responses=entries.filter(e=>e.direction==='response');
  assert.equal(requests.length,4);assert.equal(responses.length,4);
  assert.match(requests[3].body,/When is this event scheduled/);assert.match(requests[3].body,/responseJsonSchema/);
  assert.ok(!requests[3].body.includes('Time in search body'));assert.match(responses[2].body,/Time in search body/);
  assert.match(responses[3].body,/date_source_url/);assert.match(responses[3].body,/urlContextMetadata/);
  assert.equal(sql.filter(q=>q.includes('reserve_provider')).length,2);assert.equal(sql.filter(q=>q.includes('settle_provider')).length,2);
});

test('diagnostic refuses an unverified model window without creating a capture or making HTTP calls',async t=>{
  const path=await output(t),result=await diagnoseSource({tracker:'unused',source:'https://example.org',env:{},output:path,
    ledger:{query:async()=>({rows:[{allowed:false}]})},fetch:()=>assert.fail('No HTTP')});
  assert.deepEqual(result,{state:'deferred',reason:'unverified_budget',traffic_file:null});await assert.rejects(stat(path),{code:'ENOENT'});
});

test('production function and frontend import graphs exclude the local diagnostic',async()=>{
  const seen=new Set(),entry=fileURLToPath(new URL('../supabase/functions/scout-collect-hsa/index.ts',import.meta.url)),local=fileURLToPath(new URL('../dev/',import.meta.url));
  const visit=async path=>{
    if(seen.has(path))return;seen.add(path);assert.ok(!path.startsWith(local));
    const code=await readFile(path,'utf8');assert.ok(!code.includes('captureTraffic'));
    for(const match of code.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g))
      if(match[1].startsWith('.'))await visit(resolve(dirname(path),match[1]));
  };
  await visit(entry);
  await visit(fileURLToPath(new URL('../src/main.js',import.meta.url)));
});
