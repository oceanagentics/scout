import {createHash,randomUUID} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {EXTRACTION_INSTRUCTION,validateFinding,REVIEW_INSTRUCTION,proposalClaims,reviewFinding,claimValue,sameClaim} from './finding-contract.js';
import {PRIORITY_INSTRUCTION} from './assessment.js';
import {normalizeDate} from '../src/finding.js';

const canonical=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const normalize=value=>value.normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
const fail=reason=>Object.assign(new Error(reason),{reason});
export function packDocument(source,prepared){
  return {stage:'extract',documents:(prepared.documents??[{id:'P',url:source.url,relationship:'primary',prepared}]).map(d=>({
    id:d.id,url:d.url,relationship:d.relationship,title:d.prepared.title,
    ...(d.prepared.visual?{visual:true,pages:d.prepared.pages,visual_pages:d.prepared.visual_pages}:{}),
    blocks:(d.prepared.blocks?.length?d.prepared.blocks:[{id:0,start:0,end:d.prepared.text?.length??0}]).map(b=>({...b,text:d.prepared.text?.slice(b.start,b.end)??''})),
    ...(d.prepared.inline_data?{inline_data:d.prepared.inline_data}:{})
  }))};
}
export async function claimSource(db,source){
  return (await db.query(`insert into scout.source_state(tracker_id,identity,url,state,attempts,lease_id,lease_until,native_id,native_ref)
    select $1,$2,$3,'running',1,$4,clock_timestamp()+interval '120 seconds',$5,$6
    where exists(select 1 from scout.source_state where tracker_id=$1 and identity=$2)
      or (select count(*) from scout.source_state where tracker_id=$1)<201
    on conflict(tracker_id,identity) do update set state=case when scout.source_state.attempts>=3 then 'parked' else 'running' end,attempts=least(3,scout.source_state.attempts+1),
      reason=case when scout.source_state.attempts>=3 then 'attempt_bound' else scout.source_state.reason end,
      lease_id=excluded.lease_id,lease_until=excluded.lease_until
    where scout.source_state.state<>'parked' and scout.source_state.due_at<=clock_timestamp() and
      (scout.source_state.lease_until is null or scout.source_state.lease_until<clock_timestamp())
    returning *`,[source.tracker_id,source.identity??source.url,source.url,randomUUID(),source.native_id??null,source.native_ref??{}])).rows[0];
}
export async function finishSource(db,source,{observed,processed,state='complete',reason=null,retryAt,attempts=0,cursor=null}={}){
  return (await db.query(`update scout.source_state set observed_hash=coalesce($3,observed_hash),processed_hash=coalesce($4,processed_hash),
    state=$5,reason=$6,attempts=$7,due_at=greatest(clock_timestamp()+interval '1 minute',$8::timestamptz),
    checked_at=clock_timestamp(),lease_id=null,lease_until=null,cursor=$9
    where id=$1 and lease_id=$2 and lease_until>clock_timestamp() returning id`,
    [source.id,source.lease_id,observed??null,processed??null,state,reason,attempts,retryAt??new Date(Date.now()+6*3600000).toISOString(),cursor])).rows.length>0;
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
    const counts={created:0,changed:0},createdIds=[];
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
// Read only after claiming. Re-fetch on every retry; successful fingerprints never hide failures.
export async function processDocument(db,{source,prepared,read,model,deadline=Date.now()+100000}){
  const leased=await claimSource(db,source);
  if(!leased||leased.state==='parked')return {state:leased?.state??'idle',created:0,changed:0};
  let observed,attempts=leased.attempts,completedCalls=0;
  try{
    if(Date.now()+5000>=deadline)throw fail('runtime_bound');
    prepared??=await read();
    const packet=packDocument(source,prepared);observed=hash(packet);
    if(observed===leased.processed_hash){
      await finishSource(db,leased,{observed,processed:observed});return {state:'unchanged',created:0,changed:0};
    }
    if(leased.attempts===3&&leased.reason==='attempt_bound'&&observed===leased.observed_hash)throw fail('attempt_bound');
    if(observed!==leased.observed_hash&&leased.observed_hash)attempts=1;
    if(!model)throw fail('configuration');
    const instruction=EXTRACTION_INSTRUCTION.replace('do not assess relevance yet','assess relevance only from supported facts')+
      ' Also return relevance: an array aligned with findings, each {priority:high|normal|low|null,reason:string,fields:array of finding field paths}. '+PRIORITY_INSTRUCTION;
    const response=await model(instruction,[packet]);completedCalls++;
    if(response?.complete!==true||!Array.isArray(response.findings)||response.findings.length>8)throw fail('invalid_output');
    let findings=response.findings.map(f=>validateFinding(f,packet)),verdicts=response.relevance??[];
    // Dates, organization roles and official treaty changes justify independent semantic review.
    const reviewIndices=findings.flatMap((f,i)=>f.organizations.length||Object.values(f.details).some(v=>v?.precision)||f.kind==='treaty_status'?[i]:[]);
    const reviews=[];
    for(const i of reviewIndices){
      const finding=findings[i],claims=proposalClaims(finding.proposal),input={...packet,stage:'review',finding,claims,
        basis:claims.filter(c=>!c.field.startsWith('unknowns.')).map(c=>({key:'proposed.'+c.field,field:c.field,value:c.value}))},input_hash=hash(input);
      reviews.push({index:i,input:{...input,input_hash}});
    }
    if(reviews.length){
      const inputs=reviews.map(r=>r.input),shared=reviews.length===1?inputs:[{...packet,stage:'review_batch',reviews:inputs.map(({documents,...input})=>input)}];
      const answer=await model(REVIEW_INSTRUCTION+' Relevance rubric: '+PRIORITY_INSTRUCTION+
        (reviews.length>1?' Review each item in reviews independently against shared documents. Return {reviews:[one complete review per item, in input order]}.':''),shared);completedCalls++;
      const decisions=reviews.length===1?[answer]:answer?.reviews;
      if(!Array.isArray(decisions)||decisions.length!==reviews.length)throw fail('invalid_output');
      reviews.forEach(({index,input},n)=>{findings[index]=reviewFinding(findings[index],decisions[n],packet,{input_hash:input.input_hash});verdicts[index]=decisions[n].relevance;});
    }
    const counts=await saveFindings(db,leased,findings,verdicts,packet);
    if(!await finishSource(db,leased,{observed,processed:observed}))throw fail('stale_lease');
    return {state:'complete',...counts};
  }catch(error){
    const reason=['quota','configuration','runtime_bound','provider_unavailable','provider_unknown','stale_lease','stale_record','ambiguous_identity','input_bound','output_bound','review_bound','finding_bound','attempt_bound'].includes(error.reason??error.message)?error.reason??error.message:'invalid_output';
    if(reason==='quota'&&!completedCalls&&!error.dispatched)attempts=Math.max(0,attempts-1);
    const parked=attempts>=3||['ambiguous_identity','input_bound','review_bound','finding_bound','attempt_bound'].includes(reason);
    await finishSource(db,leased,{observed,state:parked?'parked':'deferred',reason:attempts>=3?'attempt_bound':reason,attempts,
      retryAt:new Date(Math.max(Date.parse(error.deferred?.retry_at)||0,Date.now()+(parked?86400000:60000*2**attempts))).toISOString()});
    return {state:parked?'parked':'deferred',reason,created:0,changed:0};
  }
}
