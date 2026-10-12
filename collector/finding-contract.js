import {normalizeDate,DATE_FIELDS,dateInterval} from '../src/finding.js';
import {sourceURL} from './octo-documents.js';

export const INTAKE_INSTRUCTION=`Read this page: **[URL]**

Look for events or announcements and rate them under the following categories:

**High:** technical BBNJ Clearing-House Mechanism (ChM) developments, including architecture, data standards, interoperability and implementation workshops/consultations; officially verified BBNJ ratifications and important official treaty changes; substantive ocean-related funder information, including funding calls, grants and funder announcements.

**Normal:** other substantive BBNJ webinars, conferences, side events, papers, publications and announcements.

**Low:** general advocacy, repeated commentary, promotion or incidental high-seas/ocean mentions without a substantive BBNJ/ChM or funder update.

Technical ocean activity or a tracked organization alone does not establish High. Keep source authority separate from relevance. Missing dates, times, organizers or other details never lower priority. Explain the substantive subject and why it meets the assigned rubric, not missing details; every reason clause needs cited evidence. Insufficient relevance evidence remains uncertain, never substitute Low.

For each development, provide:

- Its name and a concise explanation of what is happening.
- Whether it is an event, announcement, or official treaty development.
- Associated organization names, ranked with the most directly associated first. Do not assign role labels or numeric scores.
- Relevant dates and times, explaining what each refers to.
- Its priority under the rubric and the source-supported reason.
- Any registration URLs
- Important information still missing or uncertain.

Request further research in follow_up_requests only when you think it is necessary to understand the event or announcement. Give the specific questions and identify a useful linked page for each if available; omit the URL or use null when unknown. Research fields are optional; no decision or explanation is required when no research is requested. Missing optional fields alone do not require research.

Include useful partial findings. Do not invent missing information, confuse publication dates with event dates, or treat individual people as organizations. A publication date does not establish an event's year.

If the page contains no relevant development, explain why. If you cannot access the page, report that explicitly.`;
export const RESPONSE_SCHEMA={
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "enum": [
        "found",
        "none",
        "unreadable"
      ],
      "description": "Whether the page yielded records, no relevant development, or could not be read."
    },
    "records": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
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
            ],
            "description": "Nature of the development; null when unclear."
          },
          "title": {
            "type": "string",
            "description": "Name of this specific development."
          },
          "summary": {
            "type": "string",
            "description": "Concise description of what is happening."
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
            ],
            "description": "Apply the full supplied rubric; null when relevance is uncertain."
          },
          "relevance_reason": {
            "type": [
              "string",
              "null"
            ],
            "description": "Source-supported explanation of the priority; cite the source URL when giving evidence."
          },
          "organizations": {
            "type": "array",
            "description": "Associated organizations in ranked order, most directly associated first. Names only; no role labels.",
            "items": {
              "type": "object",
              "properties": {
                "name": {
                  "type": "string",
                  "description": "Organization name, not a person or product."
                }
              },
              "required": [
                "name"
              ],
              "additionalProperties": false
            }
          },
          "dates": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "meaning": {
                  "type": "string",
                  "enum": [
                    "event_start",
                    "event_end",
                    "publication",
                    "effective_date",
                    "response_deadline",
                    "treaty_action",
                    "other"
                  ],
                  "description": "Meaning of this date for this record, not a different development mentioned on the page."
                },
                "date": {
                  "type": [
                    "string",
                    "null"
                  ],
                  "description": "Date at supported precision: YYYY, YYYY-MM, or YYYY-MM-DD; null if unclear. Do not invent precision."
                },
                "time": {
                  "type": [
                    "string",
                    "null"
                  ],
                  "description": "Explicit clock in HH:MM, otherwise null."
                },
                "timezone": {
                  "type": [
                    "string",
                    "null"
                  ],
                  "description": "Explicit IANA timezone or numeric offset (+02:00, -05:00), or UTC. Do not infer a zone."
                }
              },
              "required": [
                "meaning",
                "date"
              ],
              "additionalProperties": false
            }
          },
          "location": {
            "type": [
              "string",
              "null"
            ],
            "description": "Location or online format, if established."
          },
          "registration_urls": {
            "type": "array",
            "items": {
              "type": "string",
              "description": "Explicit registration URL for this record, if any."
            }
          },
          "missing_information": {
            "type": "array",
            "items": {
              "type": "string",
              "description": "Important missing or uncertain information."
            }
          }
        },
        "required": [
          "type",
          "title",
          "summary"
        ],
        "additionalProperties": false
      },
      "maxItems": 8
    },
    "further_research": {
      "type": "boolean",
      "description": "Optional indication that further research is necessary to understand the development. Follow-up questions can request research without this flag."
    },
    "follow_up_requests": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "url": {
            "type": ["string", "null"],
            "description": "Useful linked page for this question, or null when no source is known. Never invent a URL."
          },
          "question": {
            "type": "string",
            "description": "Specific uncertainty that page could resolve."
          }
        },
        "required": [
          "question"
        ],
        "additionalProperties": false
      },
      "maxItems": 3
    },
    "note": {
      "type": [
        "string",
        "null"
      ],
      "description": "Optional explanation when no record can be returned, or a material qualification."
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

// Optional malformed fields stay local; prose is clipped instead of rejecting the finding.
export function normalizeFinding(raw,url){
  const title=text(raw?.title,300),description=text(raw?.summary,280);
  if(!title&&!description)return null;
  const kind=['event','announcement','treaty_status'].includes(raw?.type)?raw.type:'announcement';
  const unknowns={},details={};
  if(!raw?.type)unknowns.kind={reason:'uncertain'};
  for(const d of Array.isArray(raw?.dates)?raw.dates.slice(0,12):[]){
    const key={event_start:'start',event_end:'end',publication:'published',effective_date:'effective',response_deadline:'response_due',treaty_action:'action_date'}[d?.meaning];
    if(!key||!DATE_FIELDS[kind].includes(key)||typeof d.date!=='string')continue;
    const precision={4:'year',7:'month',10:'day'}[d.date.length],value={value:d.date,precision};
    try{
      details[key]=normalizeDate(value);
      if(d.time)try{details[key]=normalizeDate({...value,time:d.time,...d.timezone?{zone:d.timezone}:{}});}
        catch{unknowns['details.'+key+'.time']={reason:'invalid_clock'};}
    }catch{unknowns['details.'+key]={reason:'invalid_date'};}
  }
  if(details.start&&details.end&&dateInterval(details.end)[1]<dateInterval(details.start)[0]){delete details.end;unknowns["details.end"]={reason:"conflicting_dates"};}
  const location=text(raw?.location,240);if(location)details.location=location;
  const registration=(Array.isArray(raw?.registration_urls)?raw.registration_urls:[]).map(publicURL).find(Boolean);
  if(registration)details.registration_url=registration;
  const organizations=[...new Map((Array.isArray(raw?.organizations)?raw.organizations:[]).slice(0,12).flatMap(o=>{
    const name=text(o?.name,200);return name?[[name.toLowerCase(),{name}]]:[];
  })).values()];
  if(!organizations.length)unknowns.organizations={reason:'not_established'};
  for(const key of DATE_FIELDS[kind])if(!details[key])unknowns['details.'+key]={reason:'not_established'};
  const missing=(Array.isArray(raw?.missing_information)?raw.missing_information:[]).map(s=>text(s,180)).filter(Boolean).slice(0,6);
  if(missing.length)unknowns.research={reason:'not_established',explanation:missing.join('; ').slice(0,480)};
  const priority=['high','normal','low'].includes(raw?.priority)?raw.priority:null,reason=text(raw?.relevance_reason,600);
  return {kind,title:title||description.slice(0,300),description,canonical_url:url,organizations,details,
    completeness:{state:Object.keys(unknowns).length?'provisional':'complete',unknowns},
    priority:reason?priority:null,relevance:{state:priority&&reason?'assessed':'uncertain',reason:reason||'Relevance remains uncertain.',fields:[]}};
}
