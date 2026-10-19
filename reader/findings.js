import {createHash} from 'node:crypto';
import {DATE_FIELDS,normalizeDate,dateInterval} from '../shared/finding-dates.js';

const sameClaim=(a,b)=>JSON.stringify(a,sort)===JSON.stringify(b,sort);
function sort(_k,v){return v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v;}
const text=v=>typeof v==='string'?v.toWellFormed().replace(/\s+/g,' ').trim():null;

// Keep the model's flat response separate from Scout's stored record shape.
export function normalizeFinding(raw,url){
  const description=text(raw?.description);
  if(!description)return null;
  const kind=['event','announcement','treaty_status'].includes(raw?.type)?raw.type:'announcement';
  const unknowns={},details={};
  if(!['event','announcement','treaty_status'].includes(raw?.type))unknowns.kind={reason:'uncertain'};
  const dateField=DATE_FIELDS[kind][0];
  if(typeof raw.date==='string'){
    const precision={4:'year',7:'month',10:'day'}[raw.date.length],value={value:raw.date,precision};
    try{
      details[dateField]=normalizeDate(value);
      if(raw.starttime)try{details[dateField]=normalizeDate({...value,time:raw.starttime});}
        catch{unknowns[`details.${dateField}.time`]={reason:'invalid_clock'};}
      if(raw.timezone&&details[dateField].time)try{details[dateField]=normalizeDate({...value,time:raw.starttime,zone:raw.timezone});}
        catch{unknowns[`details.${dateField}.zone`]={reason:'invalid_timezone'};}
    }catch{unknowns[`details.${dateField}`]={reason:'invalid_date'};}
  }
  if(typeof raw.deadline==='string'){
    const precision={4:'year',7:'month',10:'day'}[raw.deadline.length];
    try{details.response_due=normalizeDate({value:raw.deadline,precision});}
    catch{unknowns['details.response_due']={reason:'invalid_date'};}
  }
  const organizations=[...new Map((Array.isArray(raw.organizations)?raw.organizations:[]).flatMap(o=>{
    const name=text(o);return name?[[name.toLowerCase(),{name}]]:[];
  })).values()];
  if(!organizations.length)unknowns.organizations={reason:'not_established'};
  if(kind==='event'&&!details.start&&!unknowns['details.start'])unknowns['details.start']={reason:'not_established'};
  const priority=['high','normal','low'].includes(raw.priority)?raw.priority:null;
  return {kind,description,canonical_url:url,organizations,details,
    completeness:{state:Object.keys(unknowns).length?'provisional':'complete',unknowns},
    priority,relevance:{state:priority?'assessed':'uncertain',reason:null,fields:[]}};
}


const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalize=value=>value.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu,' ').trim().toLowerCase();
const fail=reason=>Object.assign(new Error(reason),{reason});

function merge(f,target){
  const values=structuredClone(f);
  for(const key of ['description','canonical_url','organizations',...Object.keys({...target?.details,...f.details}).map(k=>'details.'+k)]){
    const detail=key.startsWith('details.'),name=detail?key.slice(8):key,old=detail?target?.details[name]:target?.[name];
    let value=detail?values.details[name]:values[name];
    if(old?.precision&&value?.precision&&old.value===value.value){
      const {utc,...date}={...old,...value};
      try{value=normalizeDate(date);}catch{}
    }
    if(value==null||Array.isArray(value)&&!value.length)value=old??value;
    if(detail){if(value!=null)values.details[name]=value;}else values[name]=value;
    if(value!=null&&(!Array.isArray(value)||value.length))delete values.completeness.unknowns[key];
  }
  if(values.details.start&&values.details.end&&dateInterval(values.details.end)[1]<dateInterval(values.details.start)[0]){
    delete values.details.end;
    values.completeness.unknowns['details.end']={reason:'conflicting_dates'};
  }
  // Missing optional fields do not erase established facts.
  values.completeness.state=Object.keys(values.completeness.unknowns).length?'provisional':'complete';
  if(!values.priority&&target){values.priority=target.priority;values.relevance=target.relevance;}
  return values;
}
export async function saveFindings(tx,tracker,findings){
  await tx.query("select pg_advisory_xact_lock(hashtextextended('scout:findings',0))");
  const counts={created:0,changed:0,saved:0,ambiguous:0},used=new Set(),seen=new Set();
  for(const f of findings){
    const identity='source:'+hash([tracker.id,'tracker',f.kind,normalize(f.description)]);
    if(seen.has(identity))continue;
    // Match stable identities first, then the same source/description. A single development of a kind
    // can enrich its existing source record even when the model rephrases its description.
    const candidates=(await tx.query(`select r.* from scout.records r
      where r.kind=$1 and (r.identities @> array[$2::text] or (lower(r.description)=lower($3) and ($5::text is null or r.details#>>'{start,value}' is null or r.details#>>'{start,value}'=$5))
        or r.canonical_url=$4 or r.sources @> jsonb_build_array(jsonb_build_object('url',$4::text)))
      order by (r.identities @> array[$2::text]) desc,r.discovered_at,r.id limit 20`,
      [f.kind,identity,f.description,tracker.url,f.details.start?.value??null])).rows.filter(r=>!used.has(r.id));
    const exact=candidates.filter(r=>normalize(r.description)===normalize(f.description));
    const words=new Set(normalize(f.description).split(' '));
    const similar=candidates.filter(r=>{
      const other=new Set(normalize(r.description).split(' ')),common=[...words].filter(w=>other.has(w)).length;
      return common/Math.max(words.size,other.size)>=0.8;
    });
    const sole=findings.filter(r=>r.kind===f.kind).length===1;
    const target=candidates.find(r=>r.identities.includes(identity))??(exact.length?exact[0]:similar.length===1?similar[0]:sole&&candidates.length===1?candidates[0]:null);
    if(!target&&candidates.length&&sole){counts.ambiguous++;continue;}
    const values=merge(f,target),keys=['kind','description','canonical_url','organizations','details','completeness','priority','relevance'];
    const sources=new Map((target?.sources??[]).map(s=>[s.url,s]));
    if(!sources.has(tracker.url))sources.set(tracker.url,{url:tracker.url,tracker_id:tracker.id,relationship:'primary'});
    values.sources=[...sources.values()];
    values.identities=[...new Set([...(target?.identities??[]),identity])];
    const changed=!target||keys.some(k=>!sameClaim(target[k],values[k]));
    keys.push('sources','identities');
    let record=target;
    if(changed||!sameClaim(target.sources,values.sources)||!sameClaim(target.identities,values.identities)){
      const params=keys.map(k=>values[k]);
      record=target?(await tx.query(`update scout.records set kind=$3,description=$4,canonical_url=$5,organizations=$6,details=$7,
        completeness=$8,priority=$9,relevance=$10,sources=$11,identities=array(select jsonb_array_elements_text($12::jsonb)),
        version=version+$13,accepted_version=case when $13=0 then accepted_version when $9::text is null then null else version+1 end,
        updated_at=case when $13=0 then updated_at else clock_timestamp() end where id=$1 and version=$2 returning *`,[target.id,target.version,...params,Number(changed)])).rows[0]
        :(await tx.query(`insert into scout.records(${keys.join(',')},accepted_version)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,array(select jsonb_array_elements_text($10::jsonb)),case when $7::text is null then null else 1 end) returning *`,params)).rows[0];
      if(!record)throw fail('stale_record');
      if(changed)counts[target?'changed':'created']++;
    }
    used.add(record.id);seen.add(identity);counts.saved++;
  }
  return counts;
}
