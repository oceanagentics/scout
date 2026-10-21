import {normalizeDate,dateInterval} from '../shared/finding-dates.js';

const text=v=>typeof v==='string'?v.toWellFormed().replace(/\s+/g,' ').trim():null;
const fields=['description','type','priority','organizations','deadline','date','starttime','timezone','sources'];

export function normalizeFinding(raw,url){
  const description=text(raw?.description);
  if(!description)return null;
  const date=value=>dateInterval({value,precision:{4:'year',7:'month',10:'day'}[value?.length]})?value:null;
  const starttime=/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(raw.starttime??'')?raw.starttime:null;
  let timezone=text(raw.timezone)||null;
  if(timezone)try{normalizeDate({value:'2026-01-01',precision:'day',time:'12:00',zone:timezone});}catch{timezone=null;}
  return {description,type:['event','announcement','treaty_status'].includes(raw.type)?raw.type:null,
    priority:['high','normal','low'].includes(raw.priority)?raw.priority:null,
    organizations:[...new Map((Array.isArray(raw.organizations)?raw.organizations:[]).flatMap(o=>{
      const name=text(o);return name?[[name.toLowerCase(),name]]:[];
    })).values()],deadline:date(raw.deadline),date:date(raw.date),starttime,timezone,sources:[url]};
}

const normalize=value=>value.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu,' ').trim().toLowerCase();
const fail=reason=>Object.assign(new Error(reason),{reason});

function merge(f,target){
  const values={...f};
  for(const key of fields){
    if(values[key]==null||Array.isArray(values[key])&&!values[key].length)values[key]=target?.[key]??values[key];
  }
  values.sources=[...new Set([...(target?.sources??[]),...f.sources])];
  return values;
}
export async function saveFindings(tx,tracker,findings){
  await tx.query("select pg_advisory_xact_lock(hashtextextended('scout:findings',0))");
  const counts={created:0,changed:0,saved:0,ambiguous:0},used=new Set(),seen=new Set();
  for(const f of findings){
    const key=JSON.stringify([f.type,normalize(f.description),f.date]);
    if(seen.has(key))continue;
    // Retain the existing description/source matching while matching is deferred.
    const candidates=(await tx.query(`select * from scout.records
      where type is not distinct from $1 and ((lower(description)=lower($2) and ($4::text is null or date is null or date=$4))
        or $3=any(sources)) order by modified[1],id limit 20`,
      [f.type,f.description,tracker.url,f.date])).rows.filter(r=>!used.has(r.id));
    const exact=candidates.filter(r=>normalize(r.description)===normalize(f.description));
    const words=new Set(normalize(f.description).split(' '));
    const similar=candidates.filter(r=>{
      const other=new Set(normalize(r.description).split(' ')),common=[...words].filter(w=>other.has(w)).length;
      return common/Math.max(words.size,other.size)>=0.8;
    });
    const sole=findings.filter(r=>r.type===f.type).length===1;
    const target=exact.length?exact[0]:similar.length===1?similar[0]:sole&&candidates.length===1?candidates[0]:null;
    if(!target&&candidates.length&&sole){counts.ambiguous++;continue;}
    const values=merge(f,target),changed=!target||fields.some(k=>JSON.stringify(target[k])!==JSON.stringify(values[k]));
    let record=target;
    if(changed){
      const params=fields.map(k=>values[k]);
      const columns=`description=$1,type=$2,priority=$3,organizations=array(select jsonb_array_elements_text($4::jsonb)),
        deadline=$5,date=$6,starttime=$7,timezone=$8,sources=array(select jsonb_array_elements_text($9::jsonb))`;
      record=target?(await tx.query(`update scout.records set ${columns},
        modified=array_append(modified,greatest(date_trunc('milliseconds',clock_timestamp()),modified[cardinality(modified)]+interval '1 millisecond'))
        where id=$10 returning *`,[...params,target.id])).rows[0]
        :(await tx.query(`insert into scout.records(${fields.join(',')})
          values($1,$2,$3,array(select jsonb_array_elements_text($4::jsonb)),$5,$6,$7,$8,array(select jsonb_array_elements_text($9::jsonb))) returning *`,params)).rows[0];
      if(!record)throw fail('stale_record');
      counts[target?'changed':'created']++;
    }
    used.add(record.id);seen.add(key);counts.saved++;
  }
  return counts;
}
