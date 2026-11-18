import {Buffer} from 'node:buffer';
import {randomUUID} from 'node:crypto';
import {sourceLink} from '../shared/records.js';
import {normalizeDate,dateInterval,recordEnd} from '../shared/finding-dates.js';

const text=v=>typeof v==='string'?v.toWellFormed().replace(/\s+/g,' ').trim():null;
const fields=['description','type','priority','organizations','deadline','date','starttime','timezone','enddate','endtime','sources','details'];

export function normalizeFinding(raw,url,invalidFields){
  const description=text(raw?.description);
  if(!description)return null;
  const date=value=>dateInterval({value,precision:{4:'year',7:'month',10:'day'}[value?.length]})?value:null;
  const starttime=/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(raw.starttime??'')?raw.starttime:null;
  let timezone=text(raw.timezone)||null;
  if(timezone)try{normalizeDate({value:'2026-01-01',precision:'day',time:'12:00',zone:timezone});}catch{timezone=null;}
  const finding={description,type:['event','announcement','treaty_status'].includes(raw.type)?raw.type:null,
    priority:['high','normal','low'].includes(raw.priority)?raw.priority:null,
    organizations:[...new Map((Array.isArray(raw.organizations)?raw.organizations:[]).flatMap(o=>{
      const name=text(o);return name?[[name.toLowerCase(),name]]:[];
    })).values()],deadline:date(raw.deadline),date:date(raw.date),starttime,timezone,enddate:date(raw.enddate),endtime:raw.endtime,sources:[{url,role:'finding'},...(raw.supporting_urls??[]).filter(sourceLink).map(url=>({url,role:'supporting'}))],details:typeof raw.details==='string'&&Buffer.byteLength(raw.details,'utf8')<=4096?raw.details.trim()||null:null};
  const end=recordEnd(finding);finding.enddate=end?.value??null;finding.endtime=end?.time??null;
  if(invalidFields&&raw.details!=null&&finding.details===null)invalidFields.details=(invalidFields.details??0)+1;
  if(invalidFields)for(const key of ['date','deadline','starttime','timezone','enddate','endtime']){
    if(raw[key]!=null&&finding[key]===null)invalidFields[key]=(invalidFields[key]??0)+1;
  }
  return finding;
}

const fail=reason=>Object.assign(new Error(reason),{reason});

export function mergeFinding(f,target){
  const values={...f};
  for(const key of fields){
    if(values[key]==null||Array.isArray(values[key])&&!values[key].length)values[key]=target?.[key]??values[key];
  }
  for(const key of ['date','deadline','enddate']){
    if(target?.[key]&&values[key]&&values[key].length<target[key].length){
      values[key]=target[key];
      if(key==='date'){
        values.starttime=target.starttime;values.timezone=target.timezone;
        if(f.endtime&&f.timezone&&f.timezone!==values.timezone){values.enddate=target.enddate;values.endtime=target.endtime;}
      }
      if(key==='enddate')values.endtime=target.endtime;
    }
  }
  if(target?.timezone&&target.timezone!==values.timezone&&target.endtime&&!f.endtime){
    const saved=recordEnd(target),reinterpreted=recordEnd({...target,timezone:values.timezone});
    if(!saved?.utc||saved.utc!==reinterpreted?.utc){
      if(!f.enddate)values.enddate=null;
      values.endtime=null;
    }
  }
  if(target?.enddate&&values.enddate!==target.enddate&&!f.endtime)values.endtime=null;
  const end=recordEnd(values);values.enddate=end?.value??null;values.endtime=end?.time??null;
  const sources=new Map((target?.sources??[]).map(s=>[sourceLink(s.url)??s.url,s]));
  for(const s of f.sources){const key=sourceLink(s.url),old=sources.get(key);if(key)sources.set(key,{url:key,role:old?.role==='finding'||s.role==='finding'?'finding':s.role});}
  values.sources=[...sources.values()];
  return values;
}
export async function searchFindings(db,{queries,urls}){
 if(!Array.isArray(queries)||!Array.isArray(urls)||queries.some(q=>typeof q!=='string')||urls.some(u=>!sourceLink(u))||!queries.some(q=>q.trim())&&!urls.length)throw fail('invalid_output');
 const records=(await db.query(`select r.*,r.modified::text[] as modified,r.modified[cardinality(r.modified)]::text as revision from scout.records r
 where exists(select 1 from unnest($1::text[]) q where length(trim(q))>0 and
  to_tsvector('simple',r.description||' '||array_to_string(r.organizations,' ')||' '||coalesce(r.details,'')) @@ plainto_tsquery('simple',q))
 or exists(select 1 from jsonb_array_elements(r.sources) s where s->>'url'=any($2::text[])) order by r.id`,[queries,urls])).rows;
 return {records,count:records.length};
}

// A tied native timestamp group is one transaction. Later posts must see earlier
// proposed facts and URLs without holding a database transaction during model calls.
export function proposedFindings(entries){
 const records=new Map();
 for(const {item,investigation} of entries){
  for(const lookup of investigation.lookups)for(const r of lookup.records)if(!records.has(r.id))records.set(r.id,r);
  for(const d of investigation.decisions){
   if(!['create','update'].includes(d.action))continue;
   const old=d.action==='update'?records.get(d.id):null;
   if(d.action==='update'&&!old)continue;
   const f=normalizeFinding(d.fields,item.url);if(!f)continue;
   if(d.action==='create')d.created_id??=randomUUID();
   const id=old?.id??d.created_id;
   records.set(id,{...mergeFinding(f,old),id,revision:old?.revision??null,pending:true});
  }
 }
 return [...records.values()].filter(r=>r.pending);
}

export async function applyDecisions(tx,entries){
 const counts={created:0,changed:0,saved:0,ambiguous:0,createdIds:[],calendarIds:[]};
 const operations=entries.flatMap(e=>e.investigation.decisions).filter(d=>d.action!=='skip');
 if(operations.length)await tx.query("select pg_advisory_xact_lock(hashtextextended('scout:findings',0))");
 const snapshots=new Map();
 const signature=records=>JSON.stringify(records.map(r=>[r.id,r.revision]).sort((a,b)=>a[0].localeCompare(b[0])));
 for(const {investigation} of entries){
 const candidates=new Map();
 for(const lookup of investigation.lookups){
  const current=await searchFindings(tx,lookup.args);
  if(operations.length&&signature(current.records)!==signature(lookup.records))throw fail('stale_record');
  for(const r of current.records)candidates.set(r.id,r);
 }
 snapshots.set(investigation,candidates);
 }
 const working=new Map(),created=new Set(),createSources=new Map();
 const createKey=f=>JSON.stringify(fields.filter(k=>k!=='sources').map(k=>f[k]));
 for(const {item,investigation} of entries)for(const d of investigation.decisions)if(d.action==='create'){
  const f=normalizeFinding(d.fields,item.url);if(!f)throw fail('invalid_output');
  const key=createKey(f);createSources.set(key,[...(createSources.get(key)??[]),...f.sources]);
 }
 for(const {item,investigation} of entries){
 const candidates=snapshots.get(investigation),used=new Set();
 for(const d of investigation.decisions){
  if(d.action==='skip'){counts.ambiguous++;continue;}
  if(d.action==='create'&&!investigation.lookups.length)throw fail('invalid_output');
  const target=d.action==='create'?null:working.get(d.id)??candidates.get(d.id);
  if(d.action!=='create'&&(!target||target.revision!==d.expected_revision||used.has(d.id)))throw fail('stale_record');
  if(target)used.add(target.id);
  if(d.action==='no_change'){
   if(!target.sources.some(s=>s.role==='finding'&&s.url===item.url))throw fail('invalid_output');
   counts.saved++;continue;
  }
  const f=normalizeFinding(d.fields,item.url,investigation.invalid_fields);
  if(!f)throw fail('invalid_output');
  if(target&&['date','deadline'].some(k=>f[k]&&target[k]&&!f[k].startsWith(target[k])&&!target[k].startsWith(f[k]))){counts.ambiguous++;continue;}
  const identity=createKey(f);
  if(!target)f.sources=createSources.get(identity);
  const values=mergeFinding(f,target);
  if(!target&&created.has(identity))continue;
  if(!target)created.add(identity);
  if(target&&!fields.some(k=>JSON.stringify(target[k])!==JSON.stringify(values[k]))){counts.saved++;continue;}
  const params=fields.map(k=>['sources','organizations'].includes(k)?JSON.stringify(values[k]):values[k]);
  const createdID=d.created_id??randomUUID();
  const expressions=fields.map((k,i)=>k==='organizations'?`array(select jsonb_array_elements_text($${i+1}::jsonb))`:k==='sources'?`$${i+1}::jsonb`:`$${i+1}`);
  const record=target?(await tx.query(`update scout.records set ${fields.map((k,i)=>k+'='+expressions[i]).join(',')},
   modified=array_append(modified,greatest(date_trunc('milliseconds',clock_timestamp()),modified[cardinality(modified)]+interval '1 millisecond'))
   where id=$${params.length+1} returning id`,[...params,target.id])).rows[0]
   :(await tx.query(`insert into scout.records(${fields.join(',')},id) values(${expressions.join(',')},$${params.length+1}) returning id`,[...params,createdID])).rows[0];
  if(!record)throw fail('stale_record');
  working.set(record.id,{...values,id:record.id,revision:target?.revision??null});
  counts[target?'changed':'created']++;counts.saved++;
  if(!target)counts.createdIds.push(record.id);
  if(values.type==='event'||target?.type==='event')counts.calendarIds.push(record.id);
 }
 }
 return counts;
}
