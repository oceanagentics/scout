import { Buffer } from 'node:buffer';
import { isDeepStrictEqual } from 'node:util';
import { prepareDocument } from './octo-documents.js';

export const HUB_CALENDAR='https://www.hubocean.earth/events-calendar';
export const PREPARATION_VERSION='hub-documents-v1';
const escaped=text=>text.replaceAll('&','&amp;').replaceAll('<','&lt;');

// Readable bodies precede literal metadata; full raw responses remain separate.
// Schedules and ICS UIDs are source fields, never eligibility or record identity.
export function prepareHubDocument({url,raw,items=[],title=''}){
  const html=items.flatMap(item=>[item.body,item.excerpt]).filter(v=>typeof v==='string').join('\n');
  const prepared=prepareDocument({url,title,html:(html||'<p>Calendar source</p>')+'<pre>'+escaped(raw)+'</pre>'});
  prepared.version=PREPARATION_VERSION;prepared.input='whole-calendar-source';return prepared;
}

export async function retrieveHubDocuments({tracker,read,sourceURL,budget,known=[],pending=[],progress={},
  limits={requests:8,documents:5,pages:1,bytes:2_000_000},now=Date.now}){
  if(tracker.collector!=='web'||tracker.url!==HUB_CALENDAR)throw new Error('Unsupported HUB calendar tracker');
  if(['requests','documents','pages','bytes'].some(k=>!Number.isSafeInteger(limits[k])||limits[k]<1))throw new Error('Invalid HUB retrieval bounds');
  const publisherURL=value=>{
    if(typeof value!=='string'||!value.trim())throw new Error('Missing HUB source URL');
    const url=sourceURL(new URL(value,HUB_CALENDAR).href);
    if(new URL(url).origin!==new URL(HUB_CALENDAR).origin)throw new Error('HUB publisher identity conflict');return url;
  };
  const formatted=(url,format)=>{const u=new URL(publisherURL(url));u.searchParams.set('format',format);return sourceURL(u.href);};
  const documents=[],responses=[],coverage=[],inventory=[],queue=[],seen=new Set();let requests=0,pages=0,selected=0,blocked;
  const next={after_id:progress.after_id??null,after_key:progress.after_key??null};
  if([next.after_id,next.after_key].some(value=>value!==null&&typeof value!=='string'))throw new Error('Invalid HUB progress');
  const add=doc=>{
    const prior=documents.find(d=>d.id===doc.id&&d.raw===doc.raw&&d.url===doc.url);
    if(prior){prior.provenance.push(...doc.provenance);return;}
    const versions=documents.filter(d=>d.id===doc.id);
    if(versions.length){for(const d of versions)d.state='conflict';doc.state='conflict';coverage.push({id:doc.id,state:'conflict',reason:'Differing payloads/URLs for one source ID; all versions retained'});}
    documents.push(doc);
  };
  const enqueue=(task,via)=>{
    try{
      // Shared capture history retains source IDs/URLs, not adapter task objects.
      if(!task.kind)task=task.id?.startsWith('hub:calendar:')?{kind:'calendar',url:task.url}:
        task.id?.startsWith('hub:ical:')?{kind:'ical',url:task.url}:
        {kind:'item',url:task.url,id:task.id?.replace(/^hub:item:/,'')};
      if(!['calendar','item','ical'].includes(task.kind))throw new Error('Unsupported HUB source task');
      const url=formatted(task.url,task.kind==='ical'?'ical':'json'),key=task.kind+':'+url;
      const prior=queue.find(i=>i.key===key);
      if(prior){if(!prior.via.some(v=>isDeepStrictEqual(v,via)))prior.via.push(via);return prior;}
      const entry={key,task:{...task,url:publisherURL(task.url)},url,via:[via],state:'pending'};queue.push(entry);return entry;
    }catch(error){coverage.push({task,via,state:'unsupported',reason:error.message});}
  };
  // Carry source relationships once; prior attempts remain in their run artifacts.
  for(const item of pending){
    const entry=enqueue(item.task??item,{relationship:'pending',previous_state:item.state,reason:item.reason});
    for(const via of item.via??[])if(via.relationship!=='pending')enqueue(item.task??item,via);
    if(entry&&item.last_failure)entry.last_failure=item.last_failure;
  }
  enqueue({kind:'calendar',url:HUB_CALENDAR},{relationship:'configured'});
  for(const item of known)enqueue(item.task??item,{relationship:'known'});
  // Rotate stable task keys after actual reads, including failures. Unread work
  // keeps its place; failed detail routes cannot monopolize calendar refresh.
  queue.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
  if(next.after_key)queue.push(...queue.splice(0,queue.filter(item=>item.key<=next.after_key).length));
  const retainItem=(item,via)=>{
    const entry={item,via,state:'listed'};inventory.push(entry);
    try{
      if(!item||typeof item!=='object'||Array.isArray(item)||typeof item.id!=='string'||!item.id.trim())throw new Error('Calendar item source ID unavailable');
      entry.id='hub:item:'+item.id;entry.url=publisherURL(item.fullUrl);
      if(typeof item.body!=='string')throw new Error('Calendar whole item body unavailable');
    }catch(error){entry.state='failed';entry.reason=error.message;coverage.push({...entry});}
    return entry;
  };
  for(let index=0;index<queue.length;index++){
    const entry=queue[index],task=entry.task;
    if(task.kind==='calendar'&&selected>=limits.documents){entry.state='deferred';entry.reason='Item document bound';blocked??=entry.reason;continue;}
    if(task.kind==='item'&&selected>=limits.documents){entry.state='deferred';entry.reason='Item document bound';continue;}
    if(task.kind==='calendar'&&pages>=limits.pages){entry.state='deferred';entry.reason='Calendar page bound';continue;}
    if(blocked||requests>=limits.requests||budget.requests>=limits.requests||now()>=budget.deadline){blocked??='Request/time bound';entry.state='deferred';entry.reason=blocked;continue;}
    const before=budget.requests;requests++;next.after_key=entry.key;if(task.kind==='calendar')pages++;
    try{
      const response=await read(entry.url,budget);responses.push({requested_url:entry.url,response});
      if(sourceURL(response.url)!==entry.url||response.status!==200||typeof response.body!=='string'||Buffer.byteLength(response.body)>limits.bytes)throw new Error('HUB response identity/status/byte bound');
      const mime=response.headers?.['content-type']??'';
      if(task.kind==='ical'){
        if(!/^(?:text\/calendar|text\/plain)\b/i.test(mime))throw new Error('Unsupported ICS response format');
        const lines=response.body.replace(/\r\n[ \t]/g,'').split(/\r?\n/).filter(Boolean),stack=[];
        for(const line of lines){if(line.startsWith('BEGIN:'))stack.push(line.slice(6));else if(line.startsWith('END:')&&stack.pop()!==line.slice(4))throw new Error('ICS component boundary conflict');}
        if(lines[0]!=='BEGIN:VCALENDAR'||lines.at(-1)!=='END:VCALENDAR'||stack.length)throw new Error('Incomplete ICS document');
        const fields=lines.filter(l=>!l.startsWith('BEGIN:')&&!l.startsWith('END:'));
        add({id:'hub:ical:'+entry.url,url:entry.url,raw:response.body,response,fields,task,provenance:entry.via,
          prepared:prepareHubDocument({url:entry.url,raw:response.body})});
        coverage.push({url:entry.url,parent_id:task.parent_id,state:'retained',relationship:'calendar-export',reason:'Whole ICS retained; UID/schedule conflicts and multiple sessions require downstream interpretation'});
      }else{
        if(!/json/i.test(mime))throw new Error('Unsupported calendar JSON format');
        const feed=JSON.parse(response.body);
        if(!feed||typeof feed!=='object'||Array.isArray(feed))throw new Error('Invalid calendar JSON envelope');
        let entries;
        if(task.kind==='calendar'){
          if(!Array.isArray(feed.upcoming)||!Array.isArray(feed.past))throw new Error('Calendar item arrays unavailable');
          const rows=[...feed.upcoming,...feed.past];
          add({id:'hub:calendar:'+entry.url,url:entry.url,raw:response.body,response,task,metadata:feed,provenance:entry.via,
            prepared:prepareHubDocument({url:entry.url,raw:response.body,items:rows.filter(r=>r&&typeof r==='object')})});
          entries=[...feed.upcoming.map((item,position)=>retainItem(item,{source_url:entry.url,group:'upcoming',position})),
            ...feed.past.map((item,position)=>retainItem(item,{source_url:entry.url,group:'past',position}))];
          coverage.push({url:entry.url,state:'partial',pagination:feed.pagination??null,reason:'Returned upcoming/past arrays retained; no exhaustive calendar history claimed'});
          // Follow only a literal observed next-page URL, never construct dates/cursors.
          if(typeof feed.pagination?.nextPageUrl==='string')enqueue({kind:'calendar',url:feed.pagination.nextPageUrl},{relationship:'pagination',from:entry.url});
        }else{
          const item=feed.item??feed;
          if(task.id&&item.id!==task.id)throw new Error('Known calendar source ID conflict');
          entries=[retainItem(item,{source_url:entry.url,relationship:'known-detail'})];
          if(entries[0].url!==publisherURL(task.url))throw new Error('Known calendar source URL conflict');
        }
        for(const item of entries.filter(i=>i.state==='listed')){
          item.conflicted=entries.some(other=>other.state==='listed'&&other.id===item.id&&(other.url!==item.url||JSON.stringify(other.item)!==JSON.stringify(item.item)));
          if(item.conflicted)coverage.push({id:item.id,url:item.url,state:'conflict',reason:'Calendar returned contradictory source-ID versions; retained even beyond item bound'});
        }
        const ordered=entries.filter(i=>i.state==='listed').sort((a,b)=>a.id.localeCompare(b.id)||a.url.localeCompare(b.url));
        const rotated=next.after_id?[...ordered.filter(i=>i.id>next.after_id),...ordered.filter(i=>i.id<=next.after_id)]:ordered;
        for(const item of rotated){
          const raw=JSON.stringify(item.item),key=item.id+'\n'+item.url+'\n'+raw;
          if(seen.has(key)){documents.find(d=>d.id===item.id&&d.raw===raw&&d.url===item.url)?.provenance.push(item.via);item.state='duplicate';continue;}
          if(selected>=limits.documents){item.state='deferred';item.reason='Item document bound';enqueue({kind:'item',url:item.url,id:item.item.id},{relationship:'deferred-item',from:entry.url});continue;}
          selected++;seen.add(key);if(task.kind==='calendar')next.after_id=item.id;
          const prepared=prepareHubDocument({url:item.url,raw,items:[item.item],title:typeof item.item.title==='string'?item.item.title:''});
          const ical=formatted(item.url,'ical');prepared.links.push({target:ical,label:'Publisher calendar export',tag:'api',relationship:'calendar-export',context:item.id,state:'unfetched'});
          add({id:item.id,url:item.url,raw,item:item.item,...(item.conflicted?{state:'conflict'}:{}),task:{kind:'item',url:item.url,id:item.item.id},provenance:[item.via],prepared});item.state='prepared';
          enqueue({kind:'ical',url:item.url,parent_id:item.id},{relationship:'calendar-export',parent_id:item.id});
        }
      }
      entry.state='retained';delete entry.last_failure;
    }catch(error){entry.state=error.quota?'deferred':'failed';entry.reason=error.message;entry.last_failure={state:entry.state,reason:entry.reason};if(error.quota)blocked=error.message;}
    finally{if(budget.requests===before)budget.requests++;}
  }
  for(const doc of documents)for(const link of doc.prepared.links)coverage.push({parent_id:doc.id,...link,reason:'Support/media retained as observed; further retrieval requires shared support stage'});
  coverage.push(...inventory.map(({item,...entry})=>entry),...queue);
  return {documents,responses,inventory,coverage,pending:queue.filter(e=>e.state!=='retained'),progress:next,requests,limits,complete:false};
}
