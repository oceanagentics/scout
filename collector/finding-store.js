import {createHash} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {sameClaim} from './finding-contract.js';
import {normalizeDate,dateInterval} from '../shared/finding-dates.js';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalize=value=>value.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu,' ').trim().toLowerCase();
const fail=reason=>Object.assign(new Error(reason),{reason});

function merge(f,target){
  const values=structuredClone(f),provenance={...target?.provenance};
  for(const key of ['description','canonical_url','organizations',...Object.keys({...target?.details,...f.details}).map(k=>'details.'+k)]){
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
export async function saveFindings(db,source,findings,urls){
  return db.transaction(async tx=>{
    if(!(await tx.query("select id from scout.source_state where id=$1 and lease_id=$2 and lease_until>clock_timestamp() for update",[source.id,source.lease_id])).rows.length)throw fail('stale_lease');
    await tx.query("select pg_advisory_xact_lock(hashtextextended('scout:findings',0))");
    const counts={created:0,changed:0,saved:0,ambiguous:0,newRecords:[]},used=new Set(),seen=new Set();
    for(const f of findings){
      const identity='source:'+hash([source.tracker_id,source.identity,f.kind,normalize(f.description)]);
      if(seen.has(identity))continue;
      // Match stable identities first, then the same source/description. A single development of a kind
      // can enrich its existing source record even when the model rephrases its description.
      const candidates=(f.id?await tx.query('select * from scout.records where id=$1 for update',[f.id]):await tx.query(`select r.* from scout.records r
        where r.kind=$1 and (r.identities @> array[$2::text] or (lower(r.description)=lower($3) and ($5::text is null or r.details#>>'{start,value}' is null or r.details#>>'{start,value}'=$5))
          or r.canonical_url=$4 or r.sources @> jsonb_build_array(jsonb_build_object('url',$4::text)))
        order by (r.identities @> array[$2::text]) desc,r.discovered_at,r.id limit 20`,
        [f.kind,identity,f.description,source.url,f.details.start?.value??null])).rows.filter(r=>!used.has(r.id));
      const exact=candidates.filter(r=>normalize(r.description)===normalize(f.description));
      const words=new Set(normalize(f.description).split(' '));
      const similar=candidates.filter(r=>{
        const other=new Set(normalize(r.description).split(' ')),common=[...words].filter(w=>other.has(w)).length;
        return common/Math.max(words.size,other.size)>=0.8;
      });
      const sole=findings.filter(r=>r.kind===f.kind).length===1;
      const target=f.id?candidates[0]:candidates.find(r=>r.identities.includes(identity))??(exact.length?exact[0]:similar.length===1?similar[0]:sole&&candidates.length===1?candidates[0]:null);
      if(f.id&&!target)continue; // Scheduling research can only update its saved record.
      if(!target&&candidates.length&&sole){counts.ambiguous++;continue;}
      const values=merge(f.id?{...target,details:{...target.details,...f.details},completeness:structuredClone(target.completeness)}:f,target),keys=['kind','description','canonical_url','organizations','details','provenance','completeness','priority','relevance'];
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
        record=target?(await tx.query(`update scout.records set kind=$3,description=$4,canonical_url=$5,organizations=$6,details=$7,provenance=$8,
          completeness=$9,priority=$10,relevance=$11,sources=$12,identities=array(select jsonb_array_elements_text($13::jsonb)),
          version=version+$14,accepted_version=case when $14=0 then accepted_version when $10::text is null then null else version+1 end,
          updated_at=case when $14=0 then updated_at else clock_timestamp() end where id=$1 and version=$2 returning *`,[target.id,target.version,...params,Number(changed)])).rows[0]
          :(await tx.query(`insert into scout.records(${keys.join(',')},accepted_version)
            values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,array(select jsonb_array_elements_text($11::jsonb)),case when $8::text is null then null else 1 end) returning *`,params)).rows[0];
        if(!record)throw fail('stale_record');
        if(changed)counts[target?'changed':'created']++;
      }
      used.add(record.id);seen.add(identity);counts.saved++;
      if(!target)counts.newRecords.push(record);
    }
    return counts;
  });
}
