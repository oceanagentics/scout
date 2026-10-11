import {DATE_FIELDS,ORGANIZATION_ROLES,normalizeDate,dateInterval} from '../src/finding.js';
import {sameClaim} from './finding-contract.js';
import {sourceURL} from './hsa.js';

export async function correctFinding(db,{record_id,version,field,value,url}){
  const invalid=()=>Object.assign(new Error('Current record version, supported value and public source URL required'),{status:400});
  if(!/^[a-f0-9-]{36}$/i.test(record_id??'')||!Number.isInteger(version)||version<1||typeof field!=='string')throw invalid();
  try{if(sourceURL(url)!==url)throw invalid();}catch{throw invalid();}
  return db.transaction(async tx=>{
    const record=(await tx.query('select * from scout.records where id=$1 and version=$2 for update',[record_id,version])).rows[0];
    if(!record)throw Object.assign(new Error('Record changed; refresh before correction'),{status:409});
    const details={...record.details},values={title:record.title,description:record.description,organizations:record.organizations};
    if(['title','description'].includes(field)){
      if(typeof value!=='string'||!value.trim()||value.length>280)throw invalid();
      values[field]=value;
    }else if(field==='organizations'){
      if(!Array.isArray(value)||value.length>12||value.some(o=>Object.keys(o).sort().join(',')!=='name,role'||typeof o.name!=='string'||!o.name.trim()||o.name.length>160||!ORGANIZATION_ROLES[record.kind].includes(o.role)))throw invalid();
      values.organizations=value;
    }else if(DATE_FIELDS[record.kind].some(k=>'details.'+k===field)){
      try{details[field.slice(8)]=normalizeDate(value);}catch{throw invalid();}
    }else throw invalid();
    if(details.end&&(!details.start||dateInterval(details.end)[1]<dateInterval(details.start)[0]||details.start.utc&&details.end.utc&&details.end.utc<details.start.utc))throw invalid();
    const prior=field.startsWith('details.')?record.details[field.slice(8)]:record[field];
    if(sameClaim(prior,value)&&record.overrides[field]?.url===url)return {id:record.id,version:record.version};
    const overrides={...record.overrides,[field]:{url}},provenance={...record.provenance,[field]:[url]},unknowns={...record.completeness.unknowns};
    delete unknowns[field];
    const saved=(await tx.query(`update scout.records set title=$3,description=$4,organizations=$5,details=$6,overrides=$7,provenance=$8,
      completeness=$9,version=version+1,accepted_version=null,relevance='{"state":"pending"}',updated_at=clock_timestamp()
      where id=$1 and version=$2 returning id,version`,[record.id,version,values.title,values.description,values.organizations,details,overrides,provenance,
      {state:Object.keys(unknowns).length?'provisional':'complete',unknowns}])).rows[0];
    await tx.query("insert into scout.record_sources(record_id,url,relationship) values($1,$2,'human_review') on conflict do nothing returning record_id",[record.id,url]);
    await tx.query("update scout.source_state s set processed_hash=null,due_at=clock_timestamp(),attempts=0,state='due' where s.url in (select url from scout.record_sources where record_id=$1) and s.state<>'running' returning id",[record.id]);
    return saved;
  });
}
