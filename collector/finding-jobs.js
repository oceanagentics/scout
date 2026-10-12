import {createHash,randomUUID} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {INTAKE_INSTRUCTION,RESPONSE_SCHEMA,normalizeFinding,sameClaim,publicURL,text} from './finding-contract.js';
import {normalizeDate,dateInterval} from '../src/finding.js';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalize=value=>value.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu,' ').trim().toLowerCase();
const fail=reason=>Object.assign(new Error(reason),{reason});
const REVISION='url-intake-v1';

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


function merge(f,target){
  const values=structuredClone(f),provenance={...target?.provenance};
  for(const key of ['title','description','canonical_url','organizations',...Object.keys({...target?.details,...f.details}).map(k=>'details.'+k)]){
    const detail=key.startsWith('details.'),name=detail?key.slice(8):key,old=detail?target?.details[name]:target?.[name];
    let value=detail?values.details[name]:values[name];
    if(old?.precision&&value?.precision&&old.value===value.value){
      const {utc,...date}={...old,...value};
      try{value=normalizeDate(date);}catch{}
    }
    if(target?.overrides?.[key]||value==null||Array.isArray(value)&&!value.length)value=old??value;
    if(detail){if(value!=null)values.details[name]=value;}else values[name]=value;
    if(value!=null&&(!Array.isArray(value)||value.length))delete values.completeness.unknowns[key];
  }
  if(values.details.start&&values.details.end&&dateInterval(values.details.end)[1]<dateInterval(values.details.start)[0]){
    if(target?.overrides?.['details.end'])values.details.start=target.details.start;
    else delete values.details.end;
    values.completeness.unknowns['details.end']={reason:'conflicting_dates'};
  }
  // Missing optional fields never erase established facts; protected human fields never change.
  values.completeness.state=Object.keys(values.completeness.unknowns).length?'provisional':'complete';
  if(!values.priority&&target){values.priority=target.priority;values.relevance=target.relevance;}
  return {...values,provenance};
}
async function saveFindings(db,source,findings,urls){
  return db.transaction(async tx=>{
    if(!(await tx.query("select id from scout.source_state where id=$1 and lease_id=$2 and lease_until>clock_timestamp() for update",[source.id,source.lease_id])).rows.length)throw fail('stale_lease');
    await tx.query("select pg_advisory_xact_lock(hashtextextended('scout:findings',0))");
    const counts={created:0,changed:0,saved:0,ambiguous:0},used=new Set();
    for(const f of findings){
      const identity='source:'+hash([source.tracker_id,source.identity,f.kind,normalize(f.title)]);
      // Match stable identities first, then the same source/title. A single development of a kind
      // can enrich its existing source record even when the model rephrases its title.
      const candidates=(await tx.query(`select distinct r.* from scout.records r left join scout.record_identities i on i.record_id=r.id
        where r.kind=$1 and (i.identity=$2 or (lower(r.title)=lower($3) and ($5::text is null or r.details#>>'{start,value}' is null or r.details#>>'{start,value}'=$5)) or r.canonical_url=$4 or exists(
          select 1 from scout.record_sources s where s.record_id=r.id and s.url=$4)) order by r.discovered_at,r.id limit 20`,
        [f.kind,identity,f.title,source.url,f.details.start?.value??null])).rows.filter(r=>!used.has(r.id));
      const exact=candidates.filter(r=>normalize(r.title)===normalize(f.title));
      const words=new Set(normalize(f.title).split(' '));
      const similar=candidates.filter(r=>{
        const other=new Set(normalize(r.title).split(' ')),common=[...words].filter(w=>other.has(w)).length;
        return common/Math.max(words.size,other.size)>=0.8;
      });
      const sole=findings.filter(r=>r.kind===f.kind).length===1;
      const target=exact.length?exact[0]:similar.length===1?similar[0]:sole&&candidates.length===1?candidates[0]:null;
      if(!target&&candidates.length&&sole){counts.ambiguous++;continue;}
      const values=merge(f,target),keys=['kind','title','description','canonical_url','organizations','details','provenance','completeness','priority','relevance'];
      let record=target;
      if(!target||keys.filter(k=>k!=='provenance').some(k=>!sameClaim(target[k],values[k]))){
        const params=keys.map(k=>values[k]);
        if(Buffer.byteLength(JSON.stringify(params))>12288){counts.ambiguous++;continue;}
        record=target?(await tx.query(`update scout.records set kind=$3,title=$4,description=$5,canonical_url=$6,organizations=$7,details=$8,provenance=$9,
          completeness=$10,priority=$11,relevance=$12,version=version+1,accepted_version=case when $11::text is null then null else version+1 end,
          updated_at=clock_timestamp() where id=$1 and version=$2 returning *`,[target.id,target.version,...params])).rows[0]
          :(await tx.query(`insert into scout.records(${keys.join(',')},accepted_version) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,case when $9::text is null then null else 1 end) returning *`,params)).rows[0];
        if(!record)throw fail('stale_record');
        counts[target?'changed':'created']++;
      }
      used.add(record.id);counts.saved++;
      await tx.query('insert into scout.record_identities(identity,record_id) values($1,$2) on conflict do nothing',[identity,record.id]);
      await tx.query(`insert into scout.record_sources(record_id,url,tracker_id,relationship)
        select $1,u,$2,case when u=$3 then 'primary' else 'support' end from unnest($4::text[]) u on conflict do nothing`,
        [record.id,source.tracker_id,source.url,urls]);
    }
    return counts;
  });
}

// A fingerprint permits zero-model unchanged checks; bodies are never supplied to Gemini or stored.
export async function processDocument(db,{source,prepared,read,model,deadline=Date.now()+100000}){
  const leased=await claimSource(db,source);
  if(!leased)return {state:'idle',created:0,changed:0};
  const counts={created:0,changed:0,captured:0,ambiguous:0},usage={generations:0,input_tokens:0,output_tokens:0};
  let observed,research={revision:REVISION},attempts=leased.attempts,captured=false,improvement='not_requested';
  const fingerprint=async(url,value)=>{
    try{const page=value??await read?.(url);return page&&(!page.status||page.status===200)?hash(page.text??page.body??page):null;}catch{return null;}
  };
  try{
    research.main=await fingerprint(source.url,prepared);
    research.supports=await Promise.all((leased.research?.supports??[]).slice(0,3).map(async s=>({url:s.url,hash:await fingerprint(s.url)})));
    observed=hash(research);
    const changed=leased.research?.revision!==REVISION||observed!==leased.observed_hash;
    if(changed)attempts=1;
    if(research.main&&observed===leased.processed_hash){
      await finishSource(db,leased,{observed,processed:observed,research});return {state:'unchanged',created:0,changed:0};
    }
    if(!changed&&leased.state==='parked'){
      await finishSource(db,leased,{observed,research,state:'parked',reason:leased.reason,attempts,retryAt:new Date(Date.now()+86400000).toISOString()});
      return {state:'parked',reason:leased.reason,...counts};
    }
    const call=async(prompt,input=[])=>{
      if(Date.now()+10000>=deadline)throw fail('runtime_bound');
      let answer;
      try{answer=await model(prompt,input,RESPONSE_SCHEMA);usage.generations++;}
      catch(error){if(error.dispatched){usage.generations++;usage.input_tokens+=error.usage?.input_tokens??0;usage.output_tokens+=error.usage?.output_tokens??0;}throw error;}
      usage.input_tokens+=answer._usage?.input_tokens??0;usage.output_tokens+=answer._usage?.output_tokens??0;
      if(!['found','none','unreadable'].includes(answer.status)||!Array.isArray(answer.records))throw fail('invalid_output');
      if(answer.status==='unreadable')throw fail('url_unreadable');
      return answer;
    };
    const prompt=INTAKE_INSTRUCTION.replace('[URL]',source.url),answer=await call(prompt);
    const findings=answer.records.slice(0,8).map(r=>normalizeFinding(r,source.url)).filter(Boolean);
    const saved=await saveFindings(db,leased,findings,[source.url]);
    counts.created+=saved.created;counts.changed+=saved.changed;counts.captured=saved.saved;counts.ambiguous+=saved.ambiguous;
    captured=saved.saved>0;
    if(answer.status==='found'&&!findings.length)throw fail('empty_findings');
    const wanted=[...new Map((answer.follow_up_requests??[]).slice(0,3).flatMap(r=>{
      const url=publicURL(r?.url),question=text(r?.question,280);return url&&url!==source.url&&question?[[url,{url,question}]]:[];
    })).values()];
    research.supports=wanted.map(({url})=>({url,hash:null}));
    if(wanted.length){
      improvement='pending';
      if(answer._usage?.overrun)throw fail('token_reservation_overrun');
      if(db.metrics?.statements>40)throw fail('sql_bound');
      const improved=await call(prompt+'\n\nImprove the findings below by reading only the requested links. Return the same developments with the same titles, keeping previously established facts and correcting mistakes. Answer the specific questions; leave unresolved fields partial. Do not add unrelated developments.',
        {records:findings,requested_links:wanted});
      const next=improved.records.slice(0,8).map(r=>normalizeFinding(r,source.url)).filter(Boolean);
      const matched=next.filter(f=>findings.some(old=>old.kind===f.kind&&normalize(old.title)===normalize(f.title)));
      const urls=[source.url,...(improved._retrieval??[]).filter(r=>r.status==='URL_RETRIEVAL_STATUS_SUCCESS'&&wanted.some(w=>w.url===publicURL(r.url))).map(r=>publicURL(r.url))];
      const enriched=await saveFindings(db,leased,matched,[...new Set(urls)]);
      counts.created+=enriched.created;counts.changed+=enriched.changed;counts.ambiguous+=enriched.ambiguous;
      improvement=enriched.changed?'improved':'no_change';
      research.supports=await Promise.all(wanted.map(async({url})=>({url,hash:await fingerprint(url)})));
    }
    observed=hash(research);
    if(!await finishSource(db,leased,{observed,processed:observed,research}))throw fail('stale_lease');
    return {state:captured?'captured':counts.ambiguous?'ambiguous':'no_findings',...counts,improvement,usage};
  }catch(error){
    const reason=/^[a-z_]{1,48}$/.test(error.reason??error.message??'')?error.reason??error.message:'invalid_output';
    if(reason==='quota'&&!usage.generations&&!error.dispatched)attempts=Math.max(0,attempts-1);
    const parked=attempts>=3;
    await finishSource(db,leased,{observed,research,state:parked?'parked':'deferred',reason,attempts,
      retryAt:new Date(Math.max(Date.parse(error.deferred?.retry_at)||0,Date.now()+(parked?86400000:3600000))).toISOString()});
    return {state:captured?'captured':parked?'parked':'deferred',reason,...counts,improvement:captured?'pending':improvement,usage};
  }
}
