import {INTAKE_INSTRUCTION,RESPONSE_SCHEMA} from './instructions.js';
import {searchFindings,normalizeFinding} from './findings.js';
import {findingInterval,scoutDay} from '../shared/finding-dates.js';
const fail=reason=>Object.assign(new Error(reason),{reason});
export async function investigate(db,item,{modelFor,deadline,readUrl,oldestDate,through,proposed=[],model='gpt-6-luna',evidence=new Map(),previous=null}){
 const original=item.content?.url?item.content:{url:item.url,content:item.content};
 evidence.set(original.url,original);
 const supplied=[...evidence.values()].filter(source=>source!==original);
 const updates=previous?.decisions.filter(d=>d.action==='update'&&d.fields.score>0)??[];
 const lookups=updates.length?[...previous.lookups]:[],readURLs=new Set([item.url,...supplied.filter(source=>Object.hasOwn(source,'content')||source.media_type).map(source=>source.url)]),invalid_fields={};let resource=null;
 const suggestedUpdates=updates.map(({id,fields})=>{
  const {revision,modified,pending,slack_channel_post,...current_record}=proposed.find(r=>r.id===id)??lookups.flatMap(l=>l.records).find(r=>r.id===id);
  return {id,fields,current_record};
 });
 const read=async(url,options={})=>{const source=await readUrl(url,options);evidence.set(source.url,source);readURLs.add(source.url);if(new URL(url).href.split('#')[0]===item.url.split('#')[0])resource=source;return source;};
 const functions=[{name:'search_findings',description:'Search saved Scout findings. Text queries are ORed; each phrase uses all words. Include a responsible organization name ALONE alongside specific topic phrases. Broaden empty searches. Return complete finding candidates.',
  parameters:{type:'object',properties:{queries:{type:'array',items:{type:'string'}},urls:{type:'array',items:{type:'string'}}},required:['queries','urls'],additionalProperties:false},
  run:async args=>{const result=await searchFindings(db,args);lookups.push({args,records:result.records});const records=[...new Map([...result.records,...proposed].map(r=>[r.id,r])).values()].map(({revision,modified,pending,slack_channel_post,...record})=>record);return {records,count:records.length};}}];
 const validate=answer=>{
  if(answer.status==='unreadable')throw fail('model_unreadable');
  if(answer.status!=='complete'||!Array.isArray(answer.decisions))throw fail('invalid_output');
  const candidates=[...lookups.flatMap(l=>l.records),...proposed];
  for(const d of answer.decisions){
   if(!['create','update','skip'].includes(d?.action))throw fail('invalid_output');
   if(d.action==='skip'&&!(typeof d.reason==='string'&&d.reason.trim()))throw fail('invalid_output');
   if(['create','update'].includes(d.action)&&(!Array.isArray(d.fields?.organizations)||!Array.isArray(d.fields.supporting_urls)||!normalizeFinding(d.fields,item.url)))throw fail('invalid_output');
   if(['create','update'].includes(d.action)&&d.fields.score!==null&&(!Number.isInteger(d.fields.score)||d.fields.score<0||d.fields.score>100))throw fail('invalid_output');
   const target=candidates.find(r=>r.id===d.id);
   if(d.action==='update'&&(!lookups.length||!target))throw fail('invalid_output');
   if(d.action==='create'&&!lookups.length)throw fail('invalid_output');
  }
 };
 const answer=await modelFor(item,{model,deadline,readUrl:read,functions,validate})(INTAKE_INSTRUCTION,{url:item.url,source_kind:item.source_kind,
  current_date:scoutDay(new Date(through)),oldest_date:oldestDate,content:item.content,...(supplied.length?{evidence:supplied}:{}),
  ...(suggestedUpdates.length?{suggested_updates:suggestedUpdates}:{})},RESPONSE_SCHEMA);
 validate(answer);
 for(const reference of answer._diagnostics?.attempts?.flatMap(attempt=>attempt.diagnostics?.retrieval??[])??[])
  if(reference.status==='PROVIDER_WEB_REFERENCE'&&!evidence.has(reference.url))evidence.set(reference.url,reference);
 const decisions=answer.decisions.filter(d=>{
  if(!['create','update'].includes(d.action))return true;
  d.fields.supporting_urls=d.fields.supporting_urls.filter(url=>readURLs.has(url));
  const [,latest]=findingInterval(normalizeFinding(d.fields,item.url));return !latest||latest>=oldestDate;
 });
 return {decisions,lookups,invalid_fields,resource,diagnostics:answer._diagnostics};
}
