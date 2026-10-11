import {createHash,randomUUID} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {EXTRACTION_INSTRUCTION,validateFinding,REVIEW_INSTRUCTION,IMPORTANT_FIELDS,RESEARCH_FIELDS,claimValue,sameClaim} from './finding-contract.js';
import {PRIORITY_INSTRUCTION} from './assessment.js';
import {normalizeDate} from '../src/finding.js';
import {nativeLinks,sourceURL} from './octo-documents.js';

const canonical=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const normalize=value=>value.normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
const fail=reason=>Object.assign(new Error(reason),{reason});
export function packDocument(source,prepared){
  return {stage:'extract',documents:(prepared.documents??[{id:'P',url:prepared.url??source.url,relationship:'primary',prepared}]).map(d=>{
    const seen=new Set([d.url,source.url].filter(Boolean).map(sourceURL));
    return {
    id:d.id,url:d.url,relationship:d.relationship,title:d.prepared.title,
    links:[...d.prepared.links??[],...nativeLinks(d.prepared)].flatMap(l=>{try{
      const url=sourceURL(l.target);if(seen.has(url))return [];seen.add(url);
      const label=(l.label??'').replace(/\s+/g,' ').trim().slice(0,160).toWellFormed(),context=(l.context??'').replace(/\s+/g,' ').trim();
      const start=Math.max(0,context.indexOf(label||url)-80);
      return [{url,label,context:context.slice(start,start+320).toWellFormed(),relationship:l.relationship??'support'}];
    }catch{return [];}}),
    ...(d.prepared.pages?{pages:d.prepared.pages}:{}),
    ...(d.prepared.visual?{visual:true,visual_pages:d.prepared.visual_pages}:{}),
    blocks:(d.prepared.blocks?.length?d.prepared.blocks:[{id:0,start:0,end:d.prepared.text?.length??0}]).map(b=>({...b,text:d.prepared.text?.slice(b.start,b.end)??''})),
    ...(d.prepared.inline_data?{inline_data:d.prepared.inline_data}:{})
  };})};
}
export async function claimSource(db,source){
  return (await db.query(`insert into scout.source_state(tracker_id,identity,url,state,attempts,lease_id,lease_until,native_id,native_ref)
    select $1,$2,$3,'running',1,$4,clock_timestamp()+interval '120 seconds',$5,$6
    where exists(select 1 from scout.source_state where tracker_id=$1 and identity=$2)
      or (select count(*) from scout.source_state where tracker_id=$1)<201
    on conflict(tracker_id,identity) do update set state=case when scout.source_state.state='parked' or scout.source_state.attempts>=3 then 'parked' else 'running' end,
      attempts=case when scout.source_state.state='parked' then scout.source_state.attempts else least(3,scout.source_state.attempts+1) end,
      reason=case when scout.source_state.state<>'parked' and scout.source_state.attempts>=3 then 'attempt_bound' else scout.source_state.reason end,
      lease_id=excluded.lease_id,lease_until=excluded.lease_until
    where scout.source_state.due_at<=clock_timestamp() and
      (scout.source_state.lease_until is null or scout.source_state.lease_until<clock_timestamp())
    returning *`,[source.tracker_id,source.identity??source.url,source.url,randomUUID(),source.native_id??null,source.native_ref??{}])).rows[0];
}
export async function finishSource(db,source,{observed,processed,state='complete',reason=null,retryAt,attempts=0,cursor=null,research=null}={}){
  return (await db.query(`update scout.source_state set observed_hash=coalesce($3,observed_hash),processed_hash=case when $11 then $4 else processed_hash end,
    state=$5,reason=$6,attempts=$7,due_at=greatest(clock_timestamp()+interval '1 minute',$8::timestamptz),
    checked_at=clock_timestamp(),lease_id=null,lease_until=null,cursor=$9,research=coalesce($10,research)
    where id=$1 and lease_id=$2 and lease_until>clock_timestamp() returning id`,
    [source.id,source.lease_id,observed??null,processed??null,state,reason,attempts,retryAt??new Date(Date.now()+6*3600000).toISOString(),cursor,research,processed!==undefined])).rows.length>0;
}
function finalValues(f,target){
  const values=Object.fromEntries(['kind','title','description','canonical_url','organizations','details','completeness'].map(k=>[k,structuredClone(f[k])]));
  const provenance=Object.fromEntries(Object.entries(f.proofs).filter(([k])=>k!=='anchor').map(([k,p])=>[k,[...new Set(p.sources.map(s=>s.url))]]));
  const conflicts={...values.completeness.unknowns};
  if(target){
    if(target.kind!==f.kind)throw fail('ambiguous_identity');
    for(const field of ['title','description','canonical_url',...Object.keys(target.details).map(k=>'details.'+k)]){
      const section=field.startsWith('details.')?'details':null,key=section?field.slice(8):field,old=section?target.details[key]:target[key];
      let next=section?values.details[key]:values[key];
      if(old?.precision&&next?.precision&&old.value===next.value&&old.precision===next.precision){const {utc,...local}={...old,...next};next=values.details[key]=normalizeDate(local);}
      const correction=f.changes[field]?.some(s=>(target.provenance?.[field]??[]).includes(s.url));
      if(old!=null&&(target.overrides?.[field]||next==null||!sameClaim(old,next)&&!correction)){
        if(next!=null&&!sameClaim(old,next))conflicts[field]={reason:'conflicting_evidence',explanation:'Established value retained pending an explicit source correction.'};
        if(section)values.details[key]=old;else values[key]=old;
        provenance[field]=target.provenance?.[field]??[];
        if(conflicts[field]?.reason!=='conflicting_evidence')delete conflicts[field];
      }
    }
    values.organizations=target.overrides?.organizations?target.organizations:[...target.organizations,...values.organizations.filter(o=>!target.organizations.some(p=>sameClaim(o,p)))];
    if(values.organizations.length)delete conflicts.organizations;
    values.completeness={state:Object.values(conflicts).some(v=>v.reason==='conflicting_evidence')?'conflicting':Object.keys(conflicts).length?'provisional':'complete',unknowns:conflicts};
  }
  // A model limitation is saved as a short code, never its arbitrary source quotation.
  values.completeness.unknowns=Object.fromEntries(Object.entries(values.completeness.unknowns).map(([k,v])=>[k,{reason:v.reason}]));
  return {...values,provenance};
}
function relevanceFor(response,f,values){
  const fields=response?.fields?.map(k=>k.replace(/^proposed\./,''));
  const supported=fields?.length&&new Set(fields).size===fields.length&&fields.every(k=>f.proofs[k.replace(/\.(time|zone)$/,'')]&&claimValue(f,k)!=null&&sameClaim(claimValue(f,k),claimValue(values,k)));
  if(!supported||!['high','normal','low'].includes(response?.priority)||typeof response.reason!=='string'||!response.reason.trim()||response.reason.length>280)
    return {priority:null,relevance:{state:'uncertain',reason:'Insufficient supported relevance facts.',fields:[]}};
  return {priority:response.priority,relevance:{state:'assessed',reason:response.reason,fields}};
}
async function saveFindings(db,source,findings,verdicts,packet){
  return db.transaction(async tx=>{
    if(!(await tx.query("select id from scout.source_state where id=$1 and lease_id=$2 and lease_until>clock_timestamp() for update",[source.id,source.lease_id])).rows.length)throw fail('stale_lease');
    // One global finding lock serializes identity decisions, including overlapping sources.
    await tx.query("select pg_advisory_xact_lock(hashtextextended('scout:findings',0))");
    const counts={created:0,changed:0,unresolved:false},createdIds=[];
    for(let n=0;n<findings.length;n++){
      const f=findings[n],native=f.identities.some(i=>/:(native_id|calendar_uid):/.test(i.key)),localKey='source:'+hash([source.tracker_id,source.identity,f.kind,normalize(f.anchor)]),
        identities=[...new Set([...f.identities.map(i=>i.key),...native?[]:[localKey]])];
      if(identities.some(i=>i.length>1024))throw fail('identity_bound');
      const targets=(await tx.query(`select distinct r.* from scout.records r left join scout.record_identities i on i.record_id=r.id
        where i.identity=any($1::text[]) or (not $6 and r.kind=$3 and
          ($2::text is not null and r.canonical_url=$2 or lower(r.title)=lower($4) and exists(
            select 1 from scout.record_sources s where s.record_id=r.id and s.url=$5))) limit 2`,[identities,f.canonical_url,f.kind,f.title,source.url,native])).rows;
      if(targets.length>1)throw fail('ambiguous_identity');
      const target=targets[0];
      if(!target&&(await tx.query(`select r.id from scout.records r join scout.record_sources s on s.record_id=r.id
        where s.url=$1 and r.kind=$2 and not(r.id=any($3::uuid[])) and (not $4 or not exists(
          select 1 from scout.record_identities i where i.record_id=r.id and i.identity ~ ':(native_id|calendar_uid):')) limit 1`,[source.url,f.kind,createdIds,native])).rows.length)throw fail('ambiguous_identity');
      if(target){
        const prior=(await tx.query('select identity from scout.record_identities where record_id=$1',[target.id])).rows;
        const native=key=>key.includes(':calendar_uid:')?key.split(':calendar_uid:')[0]+':calendar_uid:':key.includes(':native_id:')?key.slice(0,key.lastIndexOf(':')+1):null;
        if(identities.some(k=>native(k)&&prior.some(p=>native(p.identity)===native(k)&&!identities.includes(p.identity))))throw fail('ambiguous_identity');
      }
      const values=finalValues(f,target),rating=relevanceFor(verdicts[n],f,values);
      if(Object.values(values.completeness.unknowns).some(u=>u.reason!=='not_announced'))counts.unresolved=true;
      if(target&&rating.priority===target.priority&&rating.relevance.state===target.relevance.state&&
        ['kind','title','description','canonical_url','organizations','details','completeness'].every(k=>sameClaim(target[k],values[k])))rating.relevance=target.relevance;
      Object.assign(values,rating);
      const changed=!target||['kind','title','description','canonical_url','organizations','details','completeness','priority','relevance'].some(k=>!sameClaim(target[k],values[k]));
      let record=target;
      if(changed){
        const keys=['kind','title','description','canonical_url','organizations','details','provenance','completeness','priority','relevance'],params=keys.map(k=>values[k]);
        if(Buffer.byteLength(JSON.stringify(params))>12288)throw fail('finding_bound');
        record=target?(await tx.query(`update scout.records set kind=$3,title=$4,description=$5,canonical_url=$6,organizations=$7,details=$8,provenance=$9,
          completeness=$10,priority=$11,relevance=$12,version=version+1,accepted_version=case when $11::text is null then null else version+1 end,
          updated_at=clock_timestamp() where id=$1 and version=$2 returning *`,[target.id,target.version,...params])).rows[0]
          :(await tx.query(`insert into scout.records(${keys.join(',')},accepted_version) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,case when $9::text is null then null else 1 end) returning *`,params)).rows[0];
        if(!record)throw fail('stale_record');
        if(!target)createdIds.push(record.id);
        counts[target?'changed':'created']++;
      }
      for(const identity of identities){
        const saved=(await tx.query('insert into scout.record_identities(identity,record_id) values($1,$2) on conflict do nothing returning record_id',[identity,record.id])).rows;
        if(!saved.length&&!(await tx.query('select 1 from scout.record_identities where identity=$1 and record_id=$2',[identity,record.id])).rows.length)throw fail('ambiguous_identity');
      }
      const used=new Set(Object.values(f.proofs).flatMap(p=>p.sources.map(s=>s.url)));
      for(const doc of packet.documents.filter(d=>used.has(d.url)))await tx.query('insert into scout.record_sources(record_id,url,tracker_id,relationship) values($1,$2,$3,$4) on conflict do nothing returning record_id',[record.id,doc.url,source.tracker_id,doc.relationship??'source']);
    }
    return counts;
  });
}
// Re-fetch after claiming; parked attempts still check for changed or recovered inputs.
export async function processDocument(db,{source,prepared,read,support,model,deadline=Date.now()+100000}){
  const leased=await claimSource(db,source);
  if(!leased)return {state:'idle',created:0,changed:0};
  let observed,research=leased.research,attempts=leased.attempts,completedCalls=0,retryAt,counts={created:0,changed:0};
  try{
    if(Date.now()+5000>=deadline)throw fail('runtime_bound');
    try{prepared??=await read();}catch(error){observed=hash({state:'inaccessible_source'});throw Object.assign(error,{reason:'inaccessible_source'});}
    const primary=packDocument(source,prepared),main=hash(primary);
    let fetched={documents:[],coverage:[]};
    if(research?.main===main&&research.supports?.length){
      fetched=support?await support(research.supports):{documents:[],coverage:research.supports.map(({url})=>({url,state:'unread'}))};
      retryAt=fetched.retryAt;
    }
    research={main,supports:fetched.coverage.map(({url,state})=>{
      const doc=fetched.documents.find(d=>d.requested_url===url);
      return {url,state,hash:doc?hash(packDocument({url:doc.url},doc.prepared)):state==='unread'?leased.research?.supports?.find(s=>s.url===url)?.hash??null:null};
    })};
    observed=hash(research);
    const changed=Boolean(leased.observed_hash&&(!leased.research?.main||leased.research.main!==main||
      leased.observed_hash===hash({state:'inaccessible_source'})||research.supports.some(s=>s.state==='fetched'&&s.hash!==leased.research.supports?.find(p=>p.url===s.url)?.hash)));
    if(leased.state==='parked'&&(!changed||!leased.observed_hash)){
      await finishSource(db,leased,{observed,research,state:'parked',reason:leased.reason,attempts,
        retryAt:new Date(Math.max(Date.parse(retryAt)||0,Date.now()+86400000)).toISOString()});
      return {state:'parked',reason:leased.reason,...counts};
    }
    if(observed===leased.processed_hash){
      await finishSource(db,leased,{observed,processed:observed,research});return {state:'unchanged',...counts};
    }
    if(changed)attempts=1;
    if(Date.now()+5000>=deadline)throw fail('runtime_bound');
    if(!model)throw fail('configuration');
    const response=await model(EXTRACTION_INSTRUCTION,[primary]);completedCalls++;
    if(!response||Object.keys(response).some(k=>!['understanding','research'].includes(k))||typeof response.understanding!=='string'||
      !response.understanding.isWellFormed()||response.understanding.length>6000)throw fail('invalid_output');
    if(!response.research||!Array.isArray(response.research.requests)||Object.keys(response.research).some(k=>k!=='requests'))throw fail('invalid_research');
    const requests=response.research.requests;
    if(requests.length>3||requests.some(r=>!r||Object.keys(r).some(k=>!['url','needed_for','reason'].includes(k))||
      typeof r.url!=='string'||r.url.length>2048||typeof r.reason!=='string'||!r.reason.trim()||r.reason.length>280||
      !Array.isArray(r.needed_for)||!r.needed_for.length||r.needed_for.some(k=>!RESEARCH_FIELDS.includes(k))||
      !primary.documents.some(d=>d.links.some(l=>l.url===sourceURL(r.url)))))throw fail('invalid_research');
    const wanted=[...new Map(requests.map(r=>[sourceURL(r.url),{...r,url:sourceURL(r.url)}])).values()].sort((a,b)=>a.url.localeCompare(b.url));
    const missing=wanted.filter(r=>!fetched.coverage.some(c=>c.url===r.url));
    if(missing.length){
      const extra=support?await support(missing):{documents:[],coverage:missing.map(({url})=>({url,state:'unread'}))};
      fetched={documents:[...fetched.documents,...extra.documents.filter(d=>d.id!=='P')],coverage:[...fetched.coverage,...extra.coverage]};
      if(Date.parse(extra.retryAt)>(Date.parse(retryAt)||0))retryAt=extra.retryAt;
    }
    const documents=[{id:'P',url:prepared.url??source.url,relationship:'primary',prepared}];
    const statuses=wanted.map(({url})=>{
      const doc=fetched.documents.find(d=>d.requested_url===url),state=fetched.coverage.find(c=>c.url===url)?.state??'unread';
      if(doc)documents.push({...doc,id:'S'+documents.length});
      return {url,state,hash:doc?hash(packDocument({url:doc.url},doc.prepared)):null};
    });
    research={main,supports:statuses};observed=hash(research);
    if(Date.now()+5000>=deadline)throw fail('runtime_bound');
    const packet=packDocument(source,{documents}),input={...packet,stage:'complete',understanding:response.understanding,
      requested_sources:statuses.map(({url,state})=>({url,state})),important_fields:IMPORTANT_FIELDS};
    input.input_hash=hash(input);
    const answer=await model(REVIEW_INSTRUCTION+'\n\nRelevance rubric:\n'+PRIORITY_INSTRUCTION,[input]);completedCalls++;
    if(answer?.input_hash!==input.input_hash||!Array.isArray(answer.findings)||answer.findings.length>8||
      !Array.isArray(answer.checks)||answer.checks.length!==answer.findings.length||answer.research)throw fail('invalid_output');
    const verdicts=answer.relevance??[],findings=answer.findings.map((proposal,i)=>{
      const check=answer.checks[i],occurrence=check?.occurrence;
      if(!check||Object.keys(check).some(k=>!['checked_fields','occurrence'].includes(k))||!occurrence||Object.keys(occurrence).some(k=>!['status','reason'].includes(k))||
        !['supported','unsupported','uncertain'].includes(occurrence.status)||typeof occurrence.reason!=='string'||!occurrence.reason.trim()||!occurrence.reason.isWellFormed()||occurrence.reason.length>280)throw fail('invalid_output');
      if(occurrence.status!=='supported')throw fail('ambiguous_identity');
      return validateFinding(proposal,packet);
    });
    let adequate=answer.complete===true&&Array.isArray(answer.checked_documents)&&
      sameClaim([...answer.checked_documents].sort(),packet.documents.map(d=>d.id).sort())&&statuses.every(s=>s.state==='fetched');
    for(const [i,f]of findings.entries()){
      const fields=IMPORTANT_FIELDS[f.kind],checked=answer.checks[i].checked_fields;
      if(!Array.isArray(checked)||!sameClaim([...checked].sort(),[...fields].sort()))adequate=false;
      for(const field of fields){
        const value=claimValue(f,field),present=Array.isArray(value)?value.length>0:value!=null;
        if(!present&&!f.unknowns[field])f.unknowns[field]={reason:'unverified_evidence',explanation:'Important field not established by completion check.'};
      }
      if(statuses.some(s=>s.state!=='fetched'))f.unknowns.research={reason:'inaccessible_source',explanation:'Requested source remains unavailable or unread.'};
      if(Object.values(f.unknowns).some(u=>u.reason!=='not_announced'))adequate=false;
      f.completeness={state:Object.values(f.unknowns).some(u=>u.reason==='conflicting_evidence')?'conflicting':Object.keys(f.unknowns).length?'provisional':'complete',unknowns:f.unknowns};
    }
    const saved=await saveFindings(db,leased,findings,verdicts,packet);
    counts={created:saved.created,changed:saved.changed};
    if(!adequate||saved.unresolved)throw fail('research_unresolved');
    if(!await finishSource(db,leased,{observed,processed:observed,research}))throw fail('stale_lease');
    return {state:'complete',...counts};
  }catch(error){
    const reason=['quota','configuration','runtime_bound','provider_unavailable','provider_unknown','stale_lease','stale_record','ambiguous_identity','input_bound','output_bound','review_bound','finding_bound','attempt_bound','invalid_research','research_unresolved','inaccessible_source'].includes(error.reason??error.message)?error.reason??error.message:'invalid_output';
    if(reason==='quota'&&!completedCalls&&!error.dispatched&&(leased.state!=='parked'||observed!==leased.observed_hash))attempts=Math.max(0,attempts-1);
    const parked=leased.state==='parked'&&observed===leased.observed_hash||attempts>=3||['ambiguous_identity','input_bound','review_bound','finding_bound','attempt_bound'].includes(reason);
    await finishSource(db,leased,{observed,research,processed:counts.created||counts.changed?null:undefined,state:parked?'parked':'deferred',reason:attempts>=3?'attempt_bound':reason,attempts,
      retryAt:new Date(Math.max(Date.parse(error.deferred?.retry_at)||0,Date.parse(retryAt)||0,Date.now()+(parked?86400000:60000*2**attempts))).toISOString()});
    return {state:parked?'parked':'deferred',reason,...counts};
  }
}
