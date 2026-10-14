import {createHash,randomUUID} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {INTAKE_INSTRUCTION,RESPONSE_SCHEMA,normalizeFinding,sameClaim,publicURL} from './finding-contract.js';
import {normalizeDate,dateInterval} from '../src/finding.js';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalize=value=>value.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu,' ').trim().toLowerCase();
const fail=reason=>Object.assign(new Error(reason),{reason});
const REVISION='url-intake-only-v1';
const SCHEDULE_QUESTION='When is this event scheduled? Check the event’s registration or programme page and identify the source supporting the date. Follow links or search the internet if necessary to find the scheduling.';

export async function claimSource(db,source){
  return (await db.query(`insert into scout.source_state(tracker_id,identity,url,state,attempts,lease_id,lease_until,native_id,native_ref)
    select $1,$2,$3,'running',1,$4,clock_timestamp()+interval '120 seconds',$5,$6
    where exists(select 1 from scout.source_state where tracker_id=$1 and identity=$2)
      or (select count(*) from scout.source_state where tracker_id=$1)<201
    on conflict(tracker_id,identity) do update set state=case when scout.source_state.state in ('complete','parked') then scout.source_state.state when scout.source_state.attempts>=3 then 'parked' else 'running' end,
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
    const counts={created:0,changed:0,saved:0,ambiguous:0,newRecords:[]},used=new Set(),seen=new Set();
    for(const f of findings){
      const identity='source:'+hash([source.tracker_id,source.identity,f.kind,normalize(f.title)]);
      if(seen.has(identity))continue;
      // Match stable identities first, then the same source/title. A single development of a kind
      // can enrich its existing source record even when the model rephrases its title.
      const candidates=(f.id?await tx.query('select * from scout.records where id=$1 for update',[f.id]):await tx.query(`select r.* from scout.records r
        where r.kind=$1 and (r.identities @> array[$2::text] or (lower(r.title)=lower($3) and ($5::text is null or r.details#>>'{start,value}' is null or r.details#>>'{start,value}'=$5))
          or r.canonical_url=$4 or r.sources @> jsonb_build_array(jsonb_build_object('url',$4::text)))
        order by (r.identities @> array[$2::text]) desc,r.discovered_at,r.id limit 20`,
        [f.kind,identity,f.title,source.url,f.details.start?.value??null])).rows.filter(r=>!used.has(r.id));
      const exact=candidates.filter(r=>normalize(r.title)===normalize(f.title));
      const words=new Set(normalize(f.title).split(' '));
      const similar=candidates.filter(r=>{
        const other=new Set(normalize(r.title).split(' ')),common=[...words].filter(w=>other.has(w)).length;
        return common/Math.max(words.size,other.size)>=0.8;
      });
      const sole=findings.filter(r=>r.kind===f.kind).length===1;
      const target=f.id?candidates[0]:candidates.find(r=>r.identities.includes(identity))??(exact.length?exact[0]:similar.length===1?similar[0]:sole&&candidates.length===1?candidates[0]:null);
      if(f.id&&!target)continue; // Scheduling research can only update its saved record.
      if(!target&&candidates.length&&sole){counts.ambiguous++;continue;}
      const values=merge(f.id?{...target,details:{...target.details,...f.details},completeness:structuredClone(target.completeness)}:f,target),keys=['kind','title','description','canonical_url','organizations','details','provenance','completeness','priority','relevance'];
      const sources=new Map((target?.sources??[]).map(s=>[s.url,s]));
      for(const url of f.id?f.urls:urls)if(!sources.has(url))sources.set(url,{url,tracker_id:source.tracker_id,relationship:url===source.url?'primary':'support'});
      values.sources=[...sources.values()];
      values.identities=[...new Set([...(target?.identities??[]),identity])];
      const changed=!target||keys.filter(k=>k!=='provenance').some(k=>!sameClaim(target[k],values[k]));
      keys.push('sources','identities');
      let record=target;
      if(changed||!sameClaim(target.sources,values.sources)||!sameClaim(target.identities,values.identities)){
        const params=keys.map(k=>values[k]);
        if(Buffer.byteLength(JSON.stringify(params))>12288){counts.ambiguous++;continue;}
        record=target?(await tx.query(`update scout.records set kind=$3,title=$4,description=$5,canonical_url=$6,organizations=$7,details=$8,provenance=$9,
          completeness=$10,priority=$11,relevance=$12,sources=$13,identities=array(select jsonb_array_elements_text($14::jsonb)),
          version=version+$15,accepted_version=case when $15=0 then accepted_version when $11::text is null then null else version+1 end,
          updated_at=case when $15=0 then updated_at else clock_timestamp() end where id=$1 and version=$2 returning *`,[target.id,target.version,...params,Number(changed)])).rows[0]
          :(await tx.query(`insert into scout.records(${keys.join(',')},accepted_version)
            values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,array(select jsonb_array_elements_text($12::jsonb)),case when $9::text is null then null else 1 end) returning *`,params)).rows[0];
        if(!record)throw fail('stale_record');
        if(changed)counts[target?'changed':'created']++;
      }
      used.add(record.id);seen.add(identity);counts.saved++;
      if(!target)counts.newRecords.push(record);
    }
    return counts;
  });
}

// The model reads URLs. Completed/parked work requires an explicit state reset;
// local fetching, preparation and content-change detection are disabled.
export async function processDocument(db,{source,model,deadline=Date.now()+100000}){
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
      if(usage.generations>=2)throw fail('generation_bound');
      if(Date.now()+10000>=deadline)throw fail('runtime_bound');
      let answer;
      try{answer=await model(prompt,input,schema);usage.generations+=answer._usage?.generations??1;}
      catch(error){if(error.diagnostics)diagnostics.push(error.diagnostics);if(error.dispatched){usage.generations+=error.usage?.generations??1;usage.input_tokens+=error.usage?.input_tokens??0;usage.output_tokens+=error.usage?.output_tokens??0;}throw error;}
      if(answer._diagnostics)diagnostics.push(answer._diagnostics);
      usage.input_tokens+=answer._usage?.input_tokens??0;usage.output_tokens+=answer._usage?.output_tokens??0;
      if(!['found','none','unreadable'].includes(answer.status)||!Array.isArray(answer.records))throw fail('invalid_output');
      if(answer.status==='unreadable')throw fail('model_unreadable');
      return answer;
    };
    const prompt=INTAKE_INSTRUCTION.replace('[URL]',source.url),answer=await call(prompt);
    const findings=answer.records.slice(0,8).map(r=>normalizeFinding(r,source.url)).filter(Boolean);
    const saved=await saveFindings(db,leased,findings,[source.url]);
    counts.created+=saved.created;counts.changed+=saved.changed;counts.captured=saved.saved;counts.ambiguous+=saved.ambiguous;
    captured=saved.saved>0;
    const undated=saved.newRecords.filter(r=>r.kind==='event'&&!r.details.start);
    const scheduleSchema={...RESPONSE_SCHEMA,properties:{...RESPONSE_SCHEMA.properties,records:{type:'array',items:{...RESPONSE_SCHEMA.properties.records.items,
      properties:{...RESPONSE_SCHEMA.properties.records.items.properties,record_id:{type:'string'},date_source_url:{type:['string','null']}},
      required:[...RESPONSE_SCHEMA.properties.records.items.required,'record_id']}}}};
    if(answer.status==='found'&&!findings.length)throw fail('empty_findings');
    research.decision=undated.length>0;
    if(undated.length)research.supports=[{url:source.url,question:SCHEDULE_QUESTION}];
    improvement=research.decision?'pending':'not_requested';
    if(research.decision){
      improvement='pending';
      if(answer._usage?.overrun)throw fail('token_reservation_overrun');
      if(db.metrics?.statements>40)throw fail('sql_bound');
      improvementStart=usage.generations;
      const improved=await call(SCHEDULE_QUESTION+'\nResearch each supplied event. Return its record_id and the seven development fields: description, type, priority, organizations, date, time, timezone. Include only source-supported scheduling for that exact event. Use YYYY-MM-DD (or YYYY-MM or YYYY for partial dates), HH:MM and an explicit UTC, numeric offset or IANA timezone. A session or town hall must not inherit its parent conference dates. A publication date does not establish the event date or year. Set date_source_url to the retrieved page establishing the schedule. Use null for unresolved dates, times and timezones. Do not add other events.',
        {research:'event_schedule',records:undated.map(r=>({record_id:r.id,title:r.title,source_url:source.url,details:r.details})),requested_links:research.supports},scheduleSchema);
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
