import {discoverSource,isBluesky} from './sources/index.js';
import {investigate} from './investigate.js';
import {applyDecisions,proposedFindings} from './findings.js';
import {verifyLease,pendingItems,registerItems,consumeItem,completeSource} from './progress.js';
import {cbdRequest,prepareCBD} from './sources/cbd.js';
import {scoutDay} from '../shared/finding-dates.js';
import {modelErrorReason} from './models/contract.js';
export async function ingestSource(db,tracker,{modelFor,readUrl,sourceFetch,search,deadline,through}){
 const commitDeadline=Date.parse(through)+110000;
 const result={created:0,changed:0,saved:0,ambiguous:0,processed:0,skipped:0,createdIds:[],calendarIds:[],diagnostics:[]};
 const add=counts=>{for(const key of ['created','changed','saved','ambiguous'])result[key]+=counts[key];result.createdIds.push(...counts.createdIds);result.calendarIds.push(...counts.calendarIds);};
 try{
 let pending=isBluesky(tracker.url)?[]:await pendingItems(db,tracker),discovery,available=new Map();
 if(!pending.length){
  discovery=await discoverSource(tracker,{through,readUrl,modelFor,search,deadline,fetch:sourceFetch,signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))});
  discovery.items=discovery.items.filter(item=>item.source_kind!=='post'||scoutDay(new Date(item.published_at))>=tracker.oldest_date);
  if(!discovery.native){
   discovery.items=[...new Map(discovery.items.map(i=>[i.key,i])).values()];
   if(discovery.excluded)result.diagnostics.push({excluded_items:discovery.excluded});
   await registerItems(db,tracker,discovery,commitDeadline);
   available=new Map(discovery.items.map(i=>[i.key,i]));pending=await pendingItems(db,tracker);
  }
 }
 if(discovery?.native){
  const items=discovery.items;
  for(let start=0;start<items.length;){
   let end=start+1;while(end<items.length&&items[end].at===items[start].at)end++;
   const entries=[],evidence=new Map();
   for(const item of items.slice(start,end)){
    const investigation=await investigate(db,item,{modelFor,deadline,readUrl,oldestDate:tracker.oldest_date,through,proposed:proposedFindings(entries),evidence});
    result.diagnostics.push({...investigation.diagnostics,invalid_fields:investigation.invalid_fields});
    if(!investigation.decisions.some(d=>['create','update'].includes(d.action)&&d.fields.score>0)){entries.push({item,investigation});continue;}
    const retained=investigation.decisions.filter(d=>!['create','update'].includes(d.action)||d.fields.score===0||d.fields.score===null);
    if(retained.length)entries.push({item,investigation:{...investigation,decisions:retained,
     lookups:retained.some(d=>d.action!=='skip')?investigation.lookups:[]}});
    try{
     const terra=await investigate(db,item,{modelFor,model:'gpt-6.1-terra',deadline,readUrl,oldestDate:tracker.oldest_date,through,proposed:proposedFindings(entries),evidence,previous:investigation});
     if(terra.diagnostics?.attempts?.some(attempt=>attempt.diagnostics?.retrieval?.some(r=>r.status==='NATIVE_INPUT_FAILED')))
      throw Object.assign(new Error('url_retrieval_failed'),{reason:'url_retrieval_failed',diagnostics:terra.diagnostics});
     entries.push({item,investigation:terra});result.diagnostics.push({...terra.diagnostics,invalid_fields:terra.invalid_fields});
    }catch(error){throw Object.assign(new Error('terra_failed'),{reason:'terra_failed',diagnostics:{...error.diagnostics,cause:modelErrorReason(error)}});}
   }
   const counts=await db.transaction(async tx=>{
    await verifyLease(tx,tracker);const counts=await applyDecisions(tx,entries);
    await tx.query('update scout.trackers set last_successful_check=$2,last_error=null,failure_count=0 where id=$1',[tracker.id,items[end-1].at]);return counts;
   },{deadline:commitDeadline});
   add(counts);result.processed+=end-start;start=end;
  }
 }else for(const row of pending){
  if(Date.now()>=deadline)throw Object.assign(new Error('runtime_bound'),{reason:'runtime_bound'});
  let item=available.get(row.item_key);
  const request=cbdRequest(row.url)??row.url;
  let content=item?.content?.request_url===request?item.content:null,investigation,lastError=null,errorDiagnostics;
  const entries=[],evidence=new Map();
  try{
   if(!content)try{
    content=await readUrl(request,{lastSuccessfulCheck:row.request_checked_at,previousRequestURL:row.request_url,previousFingerprint:row.request_fingerprint});
    if(!content.unchanged&&cbdRequest(row.url))content=prepareCBD(content,row.url);
   }catch(error){
    const supplied=item?.content?.content;
    if(!['source_unavailable','source_invalid'].includes(error.reason)||!(typeof supplied==='string'?supplied.trim():supplied&&Object.values(supplied).some(value=>typeof value==='string'&&value.trim())))throw error;
    content=item.content;lastError=error.reason;errorDiagnostics=error.diagnostics;
   }
   if(!content.unchanged){
    item={...item,key:row.item_key,url:row.url,version:row.observed_version,source_kind:'web',content};
    investigation=await investigate(db,item,{modelFor,deadline,readUrl,oldestDate:tracker.oldest_date,through,evidence});
    if(investigation.decisions.some(d=>['create','update'].includes(d.action)&&d.fields.score>0)){
     result.diagnostics.push({...investigation.diagnostics,invalid_fields:investigation.invalid_fields});
     const retained=investigation.decisions.filter(d=>!['create','update'].includes(d.action)||d.fields.score===0||d.fields.score===null);
     if(retained.length)entries.push({item,investigation:{...investigation,decisions:retained,
      lookups:retained.some(d=>d.action!=='skip')?investigation.lookups:[]}});
     try{
      const terra=await investigate(db,item,{modelFor,model:'gpt-6.1-terra',deadline,readUrl,oldestDate:tracker.oldest_date,through,proposed:proposedFindings(entries),evidence,previous:investigation});
      if(terra.diagnostics?.attempts?.some(attempt=>attempt.diagnostics?.retrieval?.some(r=>r.status==='NATIVE_INPUT_FAILED')))
       throw Object.assign(new Error('url_retrieval_failed'),{reason:'url_retrieval_failed',diagnostics:terra.diagnostics});
      terra.resource??=investigation.resource;investigation=terra;
     }catch(error){throw Object.assign(new Error('terra_failed'),{reason:'terra_failed',diagnostics:{...error.diagnostics,cause:modelErrorReason(error)}});}
    }
    entries.push({item,investigation});
   }
  }catch(error){
   if(!['source_unavailable','source_invalid','runtime_bound','model_unreadable','output_incomplete','invalid_output','invalid_json','output_truncated','url_retrieval_failed','retrieval_metadata_missing'].includes(error.reason))throw error;
   lastError=error.reason;errorDiagnostics=error.diagnostics;content=null;
  }
  if(!investigation){
   await db.transaction(async tx=>{await verifyLease(tx,tracker);await consumeItem(tx,tracker,row,content,lastError);},{deadline:commitDeadline});
   result.processed++;
   if(lastError){result.skipped++;result.diagnostics.push({...errorDiagnostics,url:row.url,reason:lastError});}
   continue;
  }
  result.diagnostics.push({...investigation.diagnostics,invalid_fields:investigation.invalid_fields});
  const counts=await db.transaction(async tx=>{
   await verifyLease(tx,tracker);
   const counts=await applyDecisions(tx,entries);
   const resource=investigation.resource??(item.content?.request_url?item.content:null);
   await consumeItem(tx,tracker,row,resource,lastError);return counts;
  },{deadline:commitDeadline});
  add(counts);result.processed++;
  if(lastError)result.diagnostics.push({...errorDiagnostics,url:row.url,reason:lastError});
 }
 if(discovery?.excluded)throw Object.assign(new Error('invalid_output'),{reason:'invalid_output'});
 await completeSource(db,tracker,through,commitDeadline);
 return {...result,state:result.saved?'saved':'no_findings'};
 }catch(error){
  if(error.diagnostics)result.diagnostics.push({...error.diagnostics,reason:error.reason??'reader_failed'});
  return {...result,state:'deferred',reason:error.reason??'reader_failed'};
 }
}
