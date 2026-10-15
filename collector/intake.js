import {INTAKE_INSTRUCTION,RESPONSE_SCHEMA,SCHEDULE_QUESTION,SCHEDULE_INSTRUCTION,SCHEDULE_SCHEMA,normalizeFinding} from './finding-contract.js';
import {claimSource,finishSource} from './source-state.js';
import {saveFindings} from './finding-store.js';
import {sourceURL} from './source-url.js';

const fail=reason=>Object.assign(new Error(reason),{reason});
const REVISION='url-intake-only-v1';
function publicURL(v){try{return typeof v==='string'&&v.length<=2048?sourceURL(v):null;}catch{return null;}}

// The model reads URLs. Completed/parked work requires an explicit state reset;
// local fetching, preparation and content-change detection are disabled.
export async function processDocument(db,{source,model}){
  const leased=await claimSource(db,source);
  if(!leased)return {state:'idle',created:0,changed:0};
  const counts={created:0,changed:0,captured:0,ambiguous:0},usage={generations:0,input_tokens:0,output_tokens:0},diagnostics=[];
  let research={...leased.research},attempts=leased.attempts,captured=false,improvement='not_requested',improvementStart;
  try{
    if(leased.state==='complete'){
      await finishSource(db,leased);return {state:'complete',created:0,changed:0};
    }
    if(leased.state==='parked'){
      await finishSource(db,leased,{research,state:'parked',reason:leased.reason,attempts,retryAt:new Date(Date.now()+86400000).toISOString()});
      return {state:'parked',reason:leased.reason,...counts,improvement:research.improvement,research};
    }
    research={revision:REVISION,supports:[]};
    const call=async(prompt,input=[],schema=RESPONSE_SCHEMA)=>{
      let answer;
      try{answer=await model(prompt,input,schema);usage.generations+=answer._usage?.generations??1;}
      catch(error){if(error.diagnostics)diagnostics.push(error.diagnostics);if(error.dispatched){usage.generations+=error.usage?.generations??1;usage.input_tokens+=error.usage?.input_tokens??0;usage.output_tokens+=error.usage?.output_tokens??0;}throw error;}
      if(answer._diagnostics)diagnostics.push(answer._diagnostics);
      usage.input_tokens+=answer._usage?.input_tokens??0;usage.output_tokens+=answer._usage?.output_tokens??0;
      if(!['found','none','unreadable'].includes(answer.status)||!Array.isArray(answer.records))throw fail('invalid_output');
      if(answer.status==='unreadable')throw fail('model_unreadable');
      return answer;
    };
    const answer=await call(INTAKE_INSTRUCTION,{url:source.url,current_date:new Date().toISOString().slice(0,10)});
    const findings=answer.records.slice(0,8).map(r=>normalizeFinding(r,source.url)).filter(Boolean);
    const saved=await saveFindings(db,leased,findings,[source.url]);
    counts.created+=saved.created;counts.changed+=saved.changed;counts.captured=saved.saved;counts.ambiguous+=saved.ambiguous;
    captured=saved.saved>0;
    const undated=saved.newRecords.filter(r=>r.kind==='event'&&(!r.details.start?.value||!r.details.start.time||!r.details.start.zone));
    if(answer.status==='found'&&!findings.length)throw fail('empty_findings');
    research.decision=undated.length>0;
    if(undated.length)research.supports=[{url:source.url,question:SCHEDULE_QUESTION}];
    improvement=research.decision?'pending':'not_requested';
    if(research.decision){
      improvement='pending';
      if(db.metrics?.statements>40)throw fail('sql_bound');
      improvementStart=usage.generations;
      const improved=await call(SCHEDULE_INSTRUCTION,
        {research:'event_schedule',records:undated.map(r=>({record_id:r.id,title:r.title,source_url:source.url,details:r.details})),requested_links:research.supports},SCHEDULE_SCHEMA);
      const retrieved=(improved._retrieval??[]).filter(r=>r.status==='URL_RETRIEVAL_STATUS_SUCCESS').map(r=>publicURL(r.url)).filter(Boolean);
      const matched=improved.records.slice(0,8).flatMap(r=>{
        const old=undated.find(f=>f.id===r?.record_id),url=publicURL(r?.date_source_url);
        if(!old||!url||!retrieved.includes(url))return [];
        const f=normalizeFinding({...r,type:'event',description:old.description},source.url);
        if(!f?.details.start)return [];
        return [{id:old.id,kind:old.kind,title:old.title,details:{start:f.details.start},urls:[url]}];
      });
      if(!matched.length)throw fail('research_exhausted');
      const enriched=await saveFindings(db,leased,matched,[]);
      counts.created+=enriched.created;counts.changed+=enriched.changed;counts.ambiguous+=enriched.ambiguous;
      improvement=enriched.changed?'improved':'no_change';
      if(enriched.saved<undated.length)throw fail('research_exhausted');
    }
    research.improvement=improvement;
    if(!await finishSource(db,leased,{processed:null,research}))throw fail('stale_lease');
    return {state:captured?'captured':counts.ambiguous?'ambiguous':'no_findings',...counts,improvement,research,usage,diagnostics};
  }catch(error){
    const reason=/^[a-z_]{1,48}$/.test(error.reason??error.message??'')?error.reason??error.message:'invalid_output';
    if(reason==='quota'&&!usage.generations&&!error.dispatched)attempts=Math.max(0,attempts-1);
    if(improvementStart!==undefined&&usage.generations>improvementStart)improvement='exhausted';
    research.improvement=improvement;
    const parked=captured||attempts>=3;
    await finishSource(db,leased,{research,state:parked?'parked':'deferred',reason,attempts,
      retryAt:new Date(Math.max(Date.parse(error.deferred?.retry_at)||0,Date.now()+(parked?86400000:3600000))).toISOString()});
    return {state:captured?'captured':parked?'parked':'deferred',reason,...counts,improvement,research,usage,diagnostics};
  }
}
