import {INTAKE_INSTRUCTION,RESPONSE_SCHEMA} from './instructions.js';
import {searchFindings,normalizeFinding} from './findings.js';
import {findingInterval,scoutDay} from '../shared/finding-dates.js';
const fail=reason=>Object.assign(new Error(reason),{reason});
export async function investigate(db,item,{modelFor,deadline,readUrl,oldestDate,through,proposed=[]}){
 const lookups=[],readURLs=new Set([item.url]),invalid_fields={};let resource=null;
 const read=async(url,options={})=>{const source=await readUrl(url,options);readURLs.add(source.url);if(new URL(url).href.split('#')[0]===item.url.split('#')[0])resource=source;return source;};
 const functions=[{name:'search_findings',description:'Search saved Scout findings. Text queries are ORed; each phrase uses all words. Include a responsible organization name ALONE alongside specific topic phrases. Broaden empty searches. Return complete finding candidates.',
  parameters:{type:'object',properties:{queries:{type:'array',items:{type:'string'}},urls:{type:'array',items:{type:'string'}}},required:['queries','urls'],additionalProperties:false},
  run:async args=>{const result=await searchFindings(db,args);lookups.push({args,records:result.records});const records=[...new Map([...result.records,...proposed].map(r=>[r.id,r])).values()].map(({revision,modified,pending,...record})=>record);return {records,count:records.length};}}];
 const validate=answer=>{
  if(answer.status==='unreadable')throw fail('model_unreadable');
  if(answer.status!=='complete'||!Array.isArray(answer.decisions))throw fail('invalid_output');
  const candidates=[...lookups.flatMap(l=>l.records),...proposed];
  for(const d of answer.decisions){
   if(!['create','update','skip'].includes(d?.action))throw fail('invalid_output');
   if(d.action==='skip'&&!(typeof d.reason==='string'&&d.reason.trim()))throw fail('invalid_output');
   if(['create','update'].includes(d.action)&&(!Array.isArray(d.fields?.organizations)||!Array.isArray(d.fields.supporting_urls)||!normalizeFinding(d.fields,item.url)))throw fail('invalid_output');
   const target=candidates.find(r=>r.id===d.id);
   if(d.action==='update'&&(!lookups.length||!target))throw fail('invalid_output');
   if(d.action==='create'&&!lookups.length)throw fail('invalid_output');
  }
 };
 const answer=await modelFor(item,{deadline,readUrl:read,functions,validate})(INTAKE_INSTRUCTION,{url:item.url,source_kind:item.source_kind,
  current_date:scoutDay(new Date(through)),content:item.content},RESPONSE_SCHEMA);
 validate(answer);
 const decisions=answer.decisions.filter(d=>{
  if(!['create','update'].includes(d.action))return true;
  d.fields.supporting_urls=d.fields.supporting_urls.filter(url=>readURLs.has(url));
  const [,latest]=findingInterval(normalizeFinding(d.fields,item.url));return !latest||latest>=oldestDate;
 });
 return {decisions,lookups,invalid_fields,resource,diagnostics:answer._diagnostics};
}
