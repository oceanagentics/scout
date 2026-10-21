import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureTraffic,diagnoseTracker} from '../diagnostics/diagnose-tracker.js';

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

test('local tracker diagnostic captures one model investigation with only a tracker read shared remotely',async t=>{
  const path=await output(t),tracker='11111111-1111-4111-8111-111111111111',source='https://example.org/event';
  let generations=0;const sql=[];
  const ledger={query:async(q,p)=>{
    sql.push(q);
    if(q.startsWith('select id,name'))return {rows:[{id:tracker,name:'Diagnostic tracker',url:source,collector:'web',cadence:'6 hours'}]};
    assert.fail('Unexpected shared SQL: '+q);
  }};
  const result=await diagnoseTracker({tracker,output:path,env:{GEMINI_API_KEY:'gemini-key'},ledger,fetch:async(url,request)=>{
    assert.ok(url.endsWith(':generateContent'));generations++;const body=JSON.parse(request.body),event={description:'BBNJ data workshop',type:'event',priority:'high',organizations:['Organizer'],date:'2026-10-22',starttime:'13:30',timezone:'UTC'};
    return Response.json({responseId:'response-'+generations,usageMetadata:{promptTokenCount:400,toolUsePromptTokenCount:100,candidatesTokenCount:200,totalTokenCount:700},
      candidates:[{finishReason:'STOP',urlContextMetadata:{urlMetadata:[{retrievedUrl:source,urlRetrievalStatus:'URL_RETRIEVAL_STATUS_SUCCESS'}]},
        content:{parts:[{text:JSON.stringify([event])}]}}]});
  }});
  assert.equal(generations,1);assert.equal(result.result.state,'saved');
  assert.equal(result.records.length,1);assert.equal(result.records[0].date,'2026-10-22');assert.equal(result.records[0].starttime,'13:30');
  const entries=await lines(path),requests=entries.filter(e=>e.direction==='request'),responses=entries.filter(e=>e.direction==='response');
  assert.equal(requests.length,1);assert.equal(responses.length,1);
  assert.match(requests[0].body,/responseJsonSchema/);
  assert.match(responses[0].body,/urlContextMetadata/);
  assert.equal(sql.length,1);assert.ok(sql[0].startsWith('select id,name'));
});
