import {normalizeDate,DATE_FIELDS} from '../src/finding.js';
import {sourceURL} from './octo-documents.js';

export const INTAKE_INSTRUCTION=`Read this page: **[URL]**

Look for developments (events and their dates or announcements) on this page and return a list of all the developments found.

For each development, provide:

- A concise explanation of the development.
- Whether it is an event, announcement, or official treaty development.
- For events find dates and times relevant to the events, follow linked registration pages or program pages if necessary to find the date.
- Associated organization names, ranked with the most directly associated first. Do not assign role labels or numeric scores.
- Relevant dates and times, explaining what each refers to.
- Its priority under the rubric and the source-supported reason.
- Any registration URLs
- Important information still missing or uncertain.

**High:** technical BBNJ Clearing-House Mechanism (ChM) developments, including architecture, data standards, interoperability and implementation workshops/consultations; officially verified BBNJ ratifications and important official treaty changes; substantive ocean-related funder information, including funding calls, grants and funder announcements.

**Normal:** other substantive BBNJ webinars, conferences, side events, papers, publications and announcements.

**Low:** general advocacy, repeated commentary, promotion or incidental high-seas/ocean mentions without a substantive BBNJ/ChM or funder update.

Request further research in follow_up_requests if necessary.`;
export const RESPONSE_SCHEMA={
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "enum": [
        "found",
        "none",
        "unreadable"
      ]
    },
    "records": {
      "type": "array",
      "maxItems": 8,
      "items": {
        "type": "object",
        "properties": {
          "description": {
            "type": "string"
          },
          "type": {
            "type": [
              "string",
              "null"
            ],
            "enum": [
              "event",
              "announcement",
              "treaty_status",
              null
            ]
          },
          "priority": {
            "type": [
              "string",
              "null"
            ],
            "enum": [
              "high",
              "normal",
              "low",
              null
            ]
          },
          "organizations": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "date": {
            "type": [
              "string",
              "null"
            ],
            "description": "Event start, announcement publication, or official treaty action date: YYYY-MM-DD, YYYY-MM or YYYY; null if unknown."
          },
          "time": {
            "type": [
              "string",
              "null"
            ],
            "description": "Time for that date in HH:MM; null if unknown."
          },
          "timezone": {
            "type": [
              "string",
              "null"
            ],
            "description": "Stated UTC, numeric offset or IANA timezone; null if unknown."
          }
        },
        "required": [
          "description",
          "type",
          "priority",
          "organizations",
          "date",
          "time",
          "timezone"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "status",
    "records"
  ],
  "additionalProperties": false
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
  const unknowns={},details={},key=DATE_FIELDS[kind][0];
  if(!['event','announcement','treaty_status'].includes(raw?.type))unknowns.kind={reason:'uncertain'};
  if(typeof raw.date==='string'){
    const precision={4:'year',7:'month',10:'day'}[raw.date.length],value={value:raw.date,precision};
    try{
      details[key]=normalizeDate(value);
      if(raw.time)try{details[key]=normalizeDate({...value,time:raw.time});}
        catch{unknowns['details.'+key+'.time']={reason:'invalid_clock'};}
      if(raw.timezone&&details[key].time)try{details[key]=normalizeDate({...value,time:raw.time,zone:raw.timezone});}
        catch{unknowns['details.'+key+'.zone']={reason:'invalid_timezone'};}
    }catch{unknowns['details.'+key]={reason:'invalid_date'};}
  }
  const organizations=[...new Map((Array.isArray(raw.organizations)?raw.organizations:[]).slice(0,12).flatMap(o=>{
    const name=text(o,200);return name?[[name.toLowerCase(),{name}]]:[];
  })).values()];
  if(!organizations.length)unknowns.organizations={reason:'not_established'};
  if(!details[key]&&!unknowns['details.'+key])unknowns['details.'+key]={reason:'not_established'};
  const priority=['high','normal','low'].includes(raw.priority)?raw.priority:null;
  return {kind,title:description,description,canonical_url:url,organizations,details,
    completeness:{state:Object.keys(unknowns).length?'provisional':'complete',unknowns},
    priority,relevance:{state:priority?'assessed':'uncertain',reason:null,fields:[]}};
}
