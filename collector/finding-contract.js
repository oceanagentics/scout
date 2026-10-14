import {normalizeDate} from '../src/finding.js';
import {sourceURL} from './octo-documents.js';

export const INTAKE_INSTRUCTION=`Read this page: **[URL]**

Identify the distinct developments described on the page: events,
announcements, and official treaty developments.

For each development, provide:

- description: A short, specific description naming the development.
- type: event, announcement, or treaty_status.
- priority: high, normal, or low, using the rubric below.
- organizations: Associated organization names, most directly associated
  first. List each organization once; do not include individual people.
- date: (events only) The event’s start date.
- starttime: (events only) The time that event starts.
- timezone: (events only) The timezone the event takes place in.
- deadline: The date submissions are required by.

For events, look carefully for the scheduled date, time, and timezone.
Use the schedule for that specific event, not its parent conference.
Do not substitute the page’s publication date for an event date.
Use YYYY-MM-DD for date and deadline, or YYYY-MM / YYYY for partial dates.
Use HH:MM for starttime, and UTC, a numeric offset, or an IANA timezone.
Use null for unsupported values; do not guess. Use [] for unknown organizations.
For announcements and treaty developments, date, starttime and timezone are null.

**High:** technical BBNJ Clearing-House Mechanism (ChM) developments, including architecture, data standards, interoperability and implementation workshops/consultations; officially verified BBNJ ratifications and important official treaty changes; substantive ocean-related funder information, including funding calls, grants and funder announcements.

**Normal:** other substantive BBNJ webinars, conferences, side events, papers, publications and announcements.

**Low:** general advocacy, repeated commentary, promotion or incidental high-seas/ocean mentions without a substantive BBNJ/ChM or funder update.

Judge priority by the development’s substance. Missing scheduling
details do not lower priority. Use null when relevance is unclear.

Return a JSON array containing one object per development, with
description, type, priority, organizations, date, starttime, timezone and deadline.
Return [] when the page contains no developments.`;
export const RESPONSE_SCHEMA={
  type:'array',
  maxItems:8,
  items:{
    type:'object',
    properties:{
      description:{type:'string'},
      type:{type:['string','null'],enum:['event','announcement','treaty_status',null]},
      priority:{type:['string','null'],enum:['high','normal','low',null]},
      organizations:{type:'array',items:{type:'string'}},
      date:{type:['string','null']},
      starttime:{type:['string','null']},
      timezone:{type:['string','null']},
      deadline:{type:['string','null']}
    },
    required:['description','type','priority','organizations','date','starttime','timezone'],
    additionalProperties:false
  }
};
export const sameClaim=(a,b)=>JSON.stringify(a,sort)===JSON.stringify(b,sort);
function sort(_k,v){return v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v;}
export const text=(v,n)=>typeof v==='string'?v.toWellFormed().replace(/\s+/g,' ').trim().slice(0,n).toWellFormed():null;
export function publicURL(v){try{return typeof v==='string'&&v.length<=2048?sourceURL(v):null;}catch{return null;}}

// Keep the model's flat response separate from Scout's stored record shape.
export function normalizeFinding(raw,url){
  const description=text(raw?.description,280);
  if(!description)return null;
  const kind=['event','announcement','treaty_status'].includes(raw?.type)?raw.type:'announcement';
  const unknowns={},details={};
  if(!['event','announcement','treaty_status'].includes(raw?.type))unknowns.kind={reason:'uncertain'};
  if(kind==='event'&&typeof raw.date==='string'){
    const precision={4:'year',7:'month',10:'day'}[raw.date.length],value={value:raw.date,precision};
    try{
      details.start=normalizeDate(value);
      if(raw.starttime)try{details.start=normalizeDate({...value,time:raw.starttime});}
        catch{unknowns['details.start.time']={reason:'invalid_clock'};}
      if(raw.timezone&&details.start.time)try{details.start=normalizeDate({...value,time:raw.starttime,zone:raw.timezone});}
        catch{unknowns['details.start.zone']={reason:'invalid_timezone'};}
    }catch{unknowns['details.start']={reason:'invalid_date'};}
  }
  if(typeof raw.deadline==='string'){
    const precision={4:'year',7:'month',10:'day'}[raw.deadline.length];
    try{details.response_due=normalizeDate({value:raw.deadline,precision});}
    catch{unknowns['details.response_due']={reason:'invalid_date'};}
  }
  const organizations=[...new Map((Array.isArray(raw.organizations)?raw.organizations:[]).slice(0,12).flatMap(o=>{
    const name=text(o,200);return name?[[name.toLowerCase(),{name}]]:[];
  })).values()];
  if(!organizations.length)unknowns.organizations={reason:'not_established'};
  if(kind==='event'&&!details.start&&!unknowns['details.start'])unknowns['details.start']={reason:'not_established'};
  const priority=['high','normal','low'].includes(raw.priority)?raw.priority:null;
  return {kind,title:description,description,canonical_url:url,organizations,details,
    completeness:{state:Object.keys(unknowns).length?'provisional':'complete',unknowns},
    priority,relevance:{state:priority?'assessed':'uncertain',reason:null,fields:[]}};
}
