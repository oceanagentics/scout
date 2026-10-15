import { isDeepStrictEqual } from 'node:util';
import { Buffer } from 'node:buffer';
import { parseDocument, DomUtils } from 'htmlparser2';
import { prepareDocument, prepareCbdPayload } from './octo-documents.js';
export { prepareCbdPayload } from './octo-documents.js';

export const CBD_REGISTRY='https://www.cbd.int/side-events/';
export const PREPARATION_VERSION='cbd-documents-v2';
const base='https://api.cbd.int/api/';
const hex=id=>typeof id==='string'&&/^[a-f0-9]{24}$/.test(id);
const sorted=ids=>[...new Set(ids)].sort();

function queryURL(task,limits,sourceURL){
  let path,params;
  if(task.kind==='meeting-page'&&Number.isSafeInteger(task.offset)&&task.offset>=0){path='v2016/conferences';params={q:{},s:{_id:1},sk:task.offset,l:limits.meetingsPerPage};}
  else if(task.kind==='reservations-page'&&task.meetings?.length&&task.meetings.every(hex)&&Number.isSafeInteger(task.offset)&&task.offset>=0){
    path='v2016/reservations';params={q:{'location.conference':{$in:sorted(task.meetings)}},s:{_id:1},sk:task.offset,l:limits.reservationsPerPage};
  }else if(task.kind==='reservation'&&hex(task.id)){path='v2016/reservations';params={q:{_id:{$oid:task.id}}};}
  else throw new Error('Unsupported CBD structural source task');
  return sourceURL(base+path+(Object.keys(params).length?'?'+new URLSearchParams(Object.entries(params).map(([k,v])=>[k,typeof v==='object'?JSON.stringify(v):String(v)])):''));
}

// Complete descriptions and exact structured metadata, with source identities
// independent of result position. No finding fields or record identities.
export async function retrieveCbdDocuments({tracker,read,sourceURL,budget,known=[],knownDocuments=[],pending=[],progress={},limits={},priorityMeetings=[],now=Date.now}){
  if(tracker.collector!=='web'||tracker.url!==CBD_REGISTRY)throw new Error('Unsupported CBD registry tracker');
  limits={requests:12,documents:5,bytes:524288,meetingPages:1,meetingsPerPage:2,reservationPages:2,reservationsPerPage:10,...limits};
  if(['requests','documents','bytes','meetingPages','meetingsPerPage','reservationPages','reservationsPerPage'].some(k=>!Number.isSafeInteger(limits[k])||limits[k]<1)||limits.meetingsPerPage>100||limits.reservationsPerPage>100||
    !Number.isSafeInteger(budget.requests)||budget.requests<0||!Number.isFinite(budget.deadline))
    throw new Error('Invalid CBD retrieval bounds');
  const next={...progress,meeting_offset:progress.meeting_offset??0,reservations:{...progress.reservations??{}}};
  if(!Number.isSafeInteger(next.meeting_offset)||next.meeting_offset<0||Object.values(next.reservations).some(v=>!Number.isSafeInteger(v)||v<0))throw new Error('Invalid CBD pagination progress');
  const documents=[],responses=[],coverage=[],pages=[],queue=[],inventory=new Map(),pageCounts={meetings:0,reservations:{}},knownURLs=new Set();let requests=0,blocked,home;
  const add=doc=>{
    const existing=documents.find(d=>d.id===doc.id&&d.raw===doc.raw);
    if(existing){for(const via of doc.provenance)if(!existing.provenance.some(v=>isDeepStrictEqual(v,via)))existing.provenance.push(via);return;}
    const versions=documents.filter(d=>d.id===doc.id);if(versions.length){for(const d of versions)d.state='conflict';doc.state='conflict';coverage.push({id:doc.id,state:'conflict',reason:'Differing source payloads for one stable ID; all versions retained'});}
    documents.push(doc);
  };
  const enqueue=(task,via,source={})=>{
    try{
      if(['meeting','hosts','rooms','types','countries'].includes(task?.kind)||/^cbd:(meeting|hosts|rooms|types|countries)(:|$)/.test(task?.id??'')){
        coverage.push({task,via,state:'unfetched',reason:'Optional conference/host/room/type/country support retained as metadata; not fetched'});return;
      }
      if(!task?.kind){
        if(task?.id==='cbd:registry-shell')return;
        const native=/^cbd:reservation:([a-f0-9]{24})$/.exec(task?.id??task?.identity??'');
        if(!native)throw new Error('Unsupported CBD native source identity');task={kind:'reservation',id:native[1]};
      }
      const url=queryURL(task,limits,sourceURL);let item=inventory.get(url);
      if(!item){item={task,url,via:[],state:'pending',source_urls:[]};inventory.set(url,item);queue.push(item);}
      if(!item.via.some(v=>isDeepStrictEqual(v,via)))item.via.push(via);
      const states=[item.pending_state,source.state,source.pending_state];
      item.pending_state=states.includes('model-repair')?'model-repair':states.includes('model-pending')?'model-pending':undefined;
      if(source.last_failure)item.last_failure=source.last_failure;
      if(source.response&&source.remaining){item.response=source.response;item.remaining=source.remaining;}
      if(source.conflict)item.conflict=source.conflict;
      if(task.kind==='reservation'){
        item.id='cbd:reservation:'+task.id;
        item.conflicting_ids=[...new Set([...item.conflicting_ids??[],...source.conflicting_ids??[],source.id,source.identity].filter(id=>id!=null&&id!==item.id))];
        if(item.conflicting_ids.length)item.conflict='Known/pending CBD native identity disagreement';
        for(const value of [source.url,...source.source_urls??[]].filter(Boolean)){
          try{const u=new URL(sourceURL(value)),q=JSON.parse(u.searchParams.get('q')??'{}');
            if(u.origin!=='https://api.cbd.int'||u.pathname!=='/api/v2016/reservations'||(q._id?q._id.$oid!==task.id:!q['location.conference']?.$in?.length||!q['location.conference'].$in.every(hex)))throw new Error('Stored source URL/identity conflict');
            if(!item.source_urls.includes(u.href))item.source_urls.push(u.href);
          }catch{item.conflict='Known/pending CBD source URL/identity disagreement';if(!item.source_urls.includes(value))item.source_urls.push(value);}
        }
      }
      return item;
    }catch(error){coverage.push({task,via,state:'unsupported',reason:error.message});}
  };
  // Carry source relationships once; prior attempts stay in their run artifacts.
  if(priorityMeetings.some(id=>!hex(id)))throw new Error('Invalid priority conference identity');
  for(const id of priorityMeetings)enqueue({kind:'reservations-page',meetings:[id],offset:next.reservations[id]??0},{relationship:'priority-conference'});
  for(const item of pending){
    enqueue(item.task??item,{relationship:'pending'},item);
    for(const via of item.via??[])if(via.relationship!=='pending')enqueue(item.task??item,via,item);
  }
  enqueue({kind:'meeting-page',offset:next.meeting_offset},{relationship:'registry-discovery'});
  for(const item of [...known,...knownDocuments]){
    const entry=enqueue(item.task??item,{relationship:'known'},item);if(entry)knownURLs.add(entry.url);
    for(const source of item.provenance??[]){
      if(source.source_url)enqueue(item.task??item,{relationship:'source-response',source_url:source.source_url},item);
      for(const via of source.via??[source])if(via.relationship!=='pending')enqueue(item.task??item,via,item);
    }
  }
  const fetch=async url=>{
    if(blocked)throw new Error(blocked);
    if(requests>=limits.requests||budget.requests>=limits.requests||now()>=budget.deadline){blocked=now()>=budget.deadline?'Collection time limit reached':'CBD request bound reached';throw new Error(blocked);}
    const before=budget.requests,receipt={requested_url:url,state:'failed'};requests++;responses.push(receipt);
    try{const response=await read(sourceURL(url),budget);receipt.response=response;
      if(typeof response.body!=='string'||Buffer.byteLength(response.body)>limits.bytes)throw new Error('CBD response byte bound');
      if(budget.requests>limits.requests||now()>=budget.deadline)throw Object.assign(new Error('CBD request/time bound reached after read'),{quota:true});
      receipt.state='fetched';
      if(sourceURL(response.url)!==sourceURL(url)||response.status!=null&&(response.status<200||response.status>=300))throw new Error('CBD response destination/status conflict');return response;
    }catch(error){if(error.quota||now()>=budget.deadline)blocked=error.message;Object.assign(receipt,{state:blocked?'deferred':'failed',reason:error.message});throw error;}
    finally{if(budget.requests===before)budget.requests++;}
  };
  try{
    const response=await fetch(CBD_REGISTRY);
    if(!/text\/html/i.test(response.headers?.['content-type']??'')||!/<\/html>(?:\s|<!--[\s\S]*?-->)*$/i.test(response.body))throw new Error('CBD registry shell format/integrity unavailable');
    const dom=parseDocument(response.body,{withStartIndices:true,withEndIndices:true}),bodies=DomUtils.getElementsByTagName('body',dom.children);
    if(bodies.length!==1)throw new Error('CBD registry body boundary ambiguous');
    const prepared=prepareDocument({title:'',url:CBD_REGISTRY,html:response.body.slice(bodies[0].startIndex,bodies[0].endIndex+1)});prepared.version=PREPARATION_VERSION;prepared.input='registry-shell';
    if(now()>=budget.deadline){blocked='Collection time limit reached during preparation';throw new Error(blocked);}
    prepared.omissions.push({reason:'Dynamic registry scripts are not executed; API traversal is explicit and bounded; full shell response retained'});
    home={id:'cbd:registry-shell',url:CBD_REGISTRY,raw:response.body,response,prepared,provenance:[{relationship:'configured'}]};
    coverage.push({url:CBD_REGISTRY,state:'discovery',reason:'Registry shell/navigation only; conference selector and complete reservation rows are read separately'});
  }catch(error){coverage.push({url:CBD_REGISTRY,state:blocked?'deferred':'failed',reason:error.message});}
  const priority=item=>item.pending_state==='model-repair'?0:item.pending_state==='model-pending'?1:item.task.kind==='reservations-page'&&item.task.meetings.some(id=>priorityMeetings.includes(id))?2:3;
  while(queue.length){
    queue.sort((a,b)=>priority(a)-priority(b)||Number(a.url<=progress.after_url)-Number(b.url<=progress.after_url)||(a.url<b.url?-1:a.url>b.url?1:0));
    const item=queue.shift();
    const task=item.task,group=task.meetings?.slice().sort().join(',');
    if(item.conflict){item.state='failed';item.reason=item.conflict;continue;}
    if(blocked&&!item.response||documents.length>=limits.documents||now()>=budget.deadline||!item.response&&(task.kind==='meeting-page'&&pageCounts.meetings>=limits.meetingPages||task.kind==='reservations-page'&&(pageCounts.reservations[group]??0)>=limits.reservationPages)){
      item.state='deferred';item.reason=blocked??(documents.length>=limits.documents?'CBD document bound reached':now()>=budget.deadline?'Collection time limit reached':'CBD source page bound reached');continue;
    }
    const before=requests;
    try{
      const carried=Boolean(item.response),response=item.response??await fetch(item.url);
      if(carried)responses.push({requested_url:item.url,response,state:'retained'});
      if(typeof response.body!=='string'||Buffer.byteLength(response.body)>limits.bytes||sourceURL(response.url)!==item.url||response.status!=null&&(response.status<200||response.status>=300))throw new Error('CBD carried response identity/status/byte bound');
      if(!/json/i.test(response.headers?.['content-type']??''))throw new Error('CBD API format unavailable');
      const rows=JSON.parse(response.body);if(!Array.isArray(rows)||new Set(rows.map(r=>r?._id)).size!==rows.length||rows.some(r=>!r||typeof r!=='object'||!r._id))throw new Error('Invalid/ambiguous CBD API rows');
      if(item.remaining&&(!Array.isArray(item.remaining)||item.remaining.some(id=>!rows.some(row=>row._id===id))))throw new Error('CBD retained row continuation conflict');
      const meeting=task.kind==='meeting-page',reservation=!meeting;
      if((meeting||reservation)&&rows.some(r=>!hex(r._id)))throw new Error('CBD source ID invalid');
      if(task.kind==='meeting-page'&&rows.length>limits.meetingsPerPage||task.kind==='reservations-page'&&rows.length>limits.reservationsPerPage)throw new Error('CBD API page bound exceeded');
      if(task.kind==='reservation'&&(rows.length!==1||rows[0]._id!==task.id||item.source_urls.some(value=>{const q=JSON.parse(new URL(value).searchParams.get('q'));return q['location.conference']&&!q['location.conference'].$in.includes(rows[0].location?.conference);})))throw new Error('CBD known source identity missing/conflicting');
      if(reservation&&rows.some(r=>r.location?.conference&&!hex(r.location.conference)||r.sideEvent&&(r.sideEvent.conference!==r.location?.conference||!hex(r.sideEvent.conference)||!Number.isSafeInteger(r.sideEvent.id)||r.sideEvent.id<1||typeof r.sideEvent.description!=='string')||task.meetings&&!task.meetings.includes(r.location?.conference)))throw new Error('CBD reservation/session/meeting structural join conflict');
      item.state='retained';delete item.last_failure;
      pages.push({task,url:item.url,raw:response.body,response,rows,via:item.via,carried});
      const remaining=item.remaining?rows.filter(row=>item.remaining.includes(row._id)):rows;delete item.response;delete item.remaining;
      if(reservation)for(const [index,row] of remaining.entries()){
        const sourceTask={kind:'reservation',id:row._id},id='cbd:reservation:'+row._id,raw=JSON.stringify(row),knownItem=inventory.get(queryURL(sourceTask,limits,sourceURL));
        if(!knownItem?.conflict&&knownItem?.source_urls.some(value=>{const q=JSON.parse(new URL(value).searchParams.get('q'));return q['location.conference']&&!q['location.conference'].$in.includes(row.location?.conference);}))
          knownItem.conflict='Known/pending CBD conference query/source ID disagreement';
        if(knownItem?.conflict){knownItem.state='failed';knownItem.reason=knownItem.conflict;for(const doc of documents)if(doc.id===id)doc.state='conflict';coverage.push({id,state:'failed',reason:knownItem.conflict});continue;}
        const provenance=[{source_url:item.url,via:item.via}],existing=documents.find(d=>d.id===id&&d.raw===raw);
        if(existing){add({...existing,provenance});continue;}
        if(documents.length>=limits.documents||now()>=budget.deadline){Object.assign(item,{state:'deferred',reason:'CBD document/time bound reached',response,remaining:remaining.slice(index).map(r=>r._id)});break;}
        const doc=prepareCbdPayload({id,url:item.url,raw,rows:[row],task:sourceTask,sourceURL,provenance});
        if(now()>=budget.deadline){Object.assign(item,{state:'deferred',reason:'Collection time limit reached during preparation',response,remaining:remaining.slice(index).map(r=>r._id)});break;}
        doc.known=knownURLs.has(queryURL(sourceTask,limits,sourceURL));add(doc);
        coverage.push({id,relationship:'source-references',state:'unfetched',reason:'Opaque conference/host/room/type/country references and all support links retained in the whole source; not resolved or fetched'});
        if(!row.sideEvent)coverage.push({id:row._id,state:'unsupported',reason:'No session reference returned; complete reservation metadata retained'});
      }
      if(meeting){
        const ids=rows.map(r=>r._id).sort(),key=ids.join(',');
        if(ids.length)enqueue({kind:'reservations-page',meetings:ids,offset:next.reservations[key]??0},{relationship:'meeting-IDs',parent_ids:ids.map(id=>'cbd:meeting:'+id)});
        if(!carried){next.meeting_offset=rows.length===limits.meetingsPerPage?task.offset+rows.length:0;
          if(rows.length===limits.meetingsPerPage)enqueue({kind:'meeting-page',offset:next.meeting_offset},{relationship:'pagination'});}
      }
      if(reservation&&!carried){
        if(task.kind==='reservations-page'){next.reservations[group]=rows.length===limits.reservationsPerPage?task.offset+rows.length:0;
          if(rows.length===limits.reservationsPerPage)enqueue({...task,offset:next.reservations[group]},{relationship:'pagination'});}
      }
    }catch(error){item.state=blocked?'deferred':'failed';item.reason=error.message;if(requests>before)item.last_failure={state:item.state,reason:item.reason};delete item.response;delete item.remaining;}
    finally{if(requests>before){next.after_url=item.url;if(task.kind==='meeting-page')pageCounts.meetings++;if(task.kind==='reservations-page')pageCounts.reservations[group]=(pageCounts.reservations[group]??0)+1;}}
  }
  for(const doc of documents)for(const link of doc.prepared.links)coverage.push({...link,parent_id:doc.id,state:'unfetched',reason:'Source/API support and media not fetched by this adapter'});
  const work=[...inventory.values()];coverage.push(...work,{relationship:'scope',state:'partial',reason:'Shell and bounded conference pages are discovery; whole associated reservation rows are primary documents. Offset pages can shift; known IDs recheck independently. Optional conference/host/room/type/country records, scripts, registration/programme/media/support links and full registry history remain unfetched; no completeness claimed.'});
  return {home,pages,documents,responses,coverage,inventory:work,pending:work.filter(i=>i.state!=='retained'),progress:next,requests,limits,complete:false};
}
