import {discoverSource,isBluesky} from './sources/index.js';
import {investigate} from './investigate.js';
import {applyDecisions,proposedFindings} from './findings.js';
import {verifyLease,pendingItems,registerItems,consumeItem,completeSource} from './progress.js';
import {cbdRequest,prepareCBD} from './sources/cbd.js';
export async function ingestSource(db,tracker,{modelFor,readUrl,sourceFetch,deadline,through}){
 const commitDeadline=Date.parse(through)+110000;
 const result={created:0,changed:0,saved:0,ambiguous:0,processed:0,createdIds:[],calendarIds:[],diagnostics:[]};
 const add=counts=>{for(const key of ['created','changed','saved','ambiguous'])result[key]+=counts[key];result.createdIds.push(...counts.createdIds);result.calendarIds.push(...counts.calendarIds);};
 try{
 let pending=isBluesky(tracker.url)?[]:await pendingItems(db,tracker),discovery,available=new Map();
 if(!pending.length){
  discovery=await discoverSource(tracker,{through,readUrl,modelFor,deadline,fetch:sourceFetch,signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))});
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
   const entries=[];
   for(const item of items.slice(start,end)){
    const investigation=await investigate(db,item,{modelFor,deadline,readUrl,oldestDate:tracker.oldest_date,through,proposed:proposedFindings(entries)});
    entries.push({item,investigation});result.diagnostics.push({...investigation.diagnostics,invalid_fields:investigation.invalid_fields});
   }
   const counts=await db.transaction(async tx=>{
    await verifyLease(tx,tracker);const counts=await applyDecisions(tx,entries);
    await tx.query('update scout.trackers set last_successful_check=$2,last_error=null,failure_count=0 where id=$1',[tracker.id,items[end-1].at]);return counts;
   },{deadline:commitDeadline});
   add(counts);result.processed+=end-start;start=end;
  }
 }else for(const row of pending){
  let item=available.get(row.item_key);
  const request=cbdRequest(row.url)??row.url;
  let content=item?.content?.request_url===request?item.content:null;
  if(!content)try{
   content=await readUrl(request,{lastSuccessfulCheck:row.request_checked_at,previousRequestURL:row.request_url});
   if(!content.unchanged&&cbdRequest(row.url))content=prepareCBD(content,row.url);
  }
  catch(error){
   if(error.reason!=='source_unavailable')throw error;
   content=item?.content??{url:row.url,error:'source_unavailable'};
  }
  if(content.unchanged){
   await db.transaction(async tx=>{await verifyLease(tx,tracker);await consumeItem(tx,tracker,row,content);},{deadline:commitDeadline});
   result.processed++;continue;
  }
  item={...item,key:row.item_key,url:row.url,version:row.observed_version,source_kind:'web',content};
  const investigation=await investigate(db,item,{modelFor,deadline,readUrl,oldestDate:tracker.oldest_date,through});
  result.diagnostics.push({...investigation.diagnostics,invalid_fields:investigation.invalid_fields});
  const counts=await db.transaction(async tx=>{
   await verifyLease(tx,tracker);
   const counts=await applyDecisions(tx,[{item,investigation}]);
   const resource=investigation.resource??(item.content?.request_url?item.content:null);
   await consumeItem(tx,tracker,row,resource);return counts;
  },{deadline:commitDeadline});
  add(counts);result.processed++;
 }
 if(discovery?.excluded)throw Object.assign(new Error('invalid_output'),{reason:'invalid_output'});
 await completeSource(db,tracker,through,commitDeadline);
 return {...result,state:result.saved?'saved':'no_findings'};
 }catch(error){return {...result,state:'deferred',reason:error.reason??'reader_failed'};}
}
