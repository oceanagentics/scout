// Shared typed values. Calendar dates never pass through the viewer's timezone.
export const DATE_FIELDS={event:['start','end'],announcement:['published','effective','response_due'],treaty_status:['action_date','effective']};
export const ORGANIZATION_ROLES={event:['organizer','host','partner','funder','participant'],announcement:['issuer','publisher','subject','funder'],treaty_status:['authority']};
export function dateInterval(date){
  if(!date||typeof date.value!=='string')return null;
  const {value,precision}=date;
  if(!({year:/^\d{4}$/,month:/^\d{4}-\d{2}$/,day:/^\d{4}-\d{2}-\d{2}$/}[precision]?.test(value)))return null;
  const start=value+(precision==='year'?'-01-01':precision==='month'?'-01':'');
  const parsed=new Date(start+'T00:00:00Z');
  if(!Number.isFinite(+parsed)||parsed.toISOString().slice(0,10)!==start||+value.slice(0,4)<1)return null;
  const last=new Date(parsed);last.setUTCMonth(last.getUTCMonth()+1,0);
  const end=precision==='year'?value+'-12-31':precision==='month'?last.toISOString().slice(0,10):start;
  return [start,end];
}
export function normalizeDate(date){
  if(!dateInterval(date))throw new Error('Date requires a real calendar value with matching precision');
  if(Object.keys(date).some(k=>!['value','precision','time','zone'].includes(k)))throw new Error('Unexpected date field; UTC is derived, never supplied');
  const {time,zone}=date;
  if(time!=null&&(date.precision!=='day'||!/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time)))throw new Error('Clock requires an exact day and valid local time');
  if(zone!=null&&(!time||typeof zone!=='string'))throw new Error('Timezone requires a local clock');
  const result={value:date.value,precision:date.precision,...time?{time}:{},...zone?{zone}:{}};
  if(!zone)return result;
  const local=date.value+'T'+time+(time.length===5?':00':'');
  if(/^(?:Z|UTC|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/.test(zone)){
    const instant=new Date(local+(zone==='UTC'?'Z':zone));
    if(!Number.isFinite(+instant))throw new Error('Invalid fixed timezone');
    result.utc=instant.toISOString();return result;
  }
  let format;
  try{format=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});}
  catch{throw new Error('Explicit IANA timezone or numeric offset required');}
  const target=Date.parse(local+'Z'),matches=[];
  // Distinct nearby offsets catch DST folds/gaps; ambiguous local clocks stay local.
  const offsets=new Set([-36,0,36].map(hours=>{
    const at=target+hours*3600000,p=Object.fromEntries(format.formatToParts(at).map(x=>[x.type,x.value]));
    return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`)-at;
  }));
  for(const offset of offsets){const at=target-offset,p=Object.fromEntries(format.formatToParts(at).map(x=>[x.type,x.value]));
    if(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`===local)matches.push(at);}
  if(matches.length===1)result.utc=new Date(matches[0]).toISOString();
  return result;
}
// Shared by standalone calendars and calendar components embedded in documents.
export function readCalendar(text){
  return [...text.matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)\r?\nEND:VEVENT/g)].map(event=>{
    const fields=event[1].replace(/\r?\n[ \t]/g,'').split(/\r?\n/).map(line=>line.match(/^([A-Z-]+)((?:;[^:]*)?):(.*)$/)).filter(Boolean);
    const one=name=>{const matches=fields.filter(f=>f[1]===name);if(matches.length>1)throw new Error('Ambiguous calendar '+name);return matches[0];};
    const dates={},properties={};
    for(const [field,name]of [['start','DTSTART'],['end','DTEND']]){
      const entry=one(name);if(!entry)continue;
      const [, ,params,value]=entry,match=value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
      if(!match)throw new Error('Unsupported calendar date value');
      const allDay=!match[4];if(/;VALUE=DATE(?:;|$)/.test(params)!==allDay)throw new Error('Calendar VALUE/date shape conflict');
      const date={value:match.slice(1,4).join('-'),precision:'day'};
      if(!allDay){date.time=match.slice(4,7).join(':');const zone=match[7]?'UTC':params.match(/;TZID="?([^";]+)"?/)?.[1];if(zone)date.zone=zone;}
      normalizeDate(date);
      if(field==='end'&&allDay)date.value=new Date(Date.parse(date.value+'T00:00:00Z')-86400000).toISOString().slice(0,10);
      dates[field]=date;properties[field]=entry[0];
    }
    return {uid:one('UID')?.[3],recurrence:one('RECURRENCE-ID')?.[3]??one('RRULE')?.[3]??one('RDATE')?.[3],summary:one('SUMMARY')?.[3],dates,properties};
  });
}
export function findingInterval(record,meaning){
  const fields=DATE_FIELDS[record.kind];if(!fields)return [null,null];
  const start=dateInterval(record.details?.[meaning??fields[0]]);
  if(!start)return [null,null];
  const end=!meaning&&record.kind==='event'?dateInterval(record.details?.end):null;
  return [start[0],end?.[1]??start[1]];
}
export function dateLabel(date){
  if(!dateInterval(date))return 'Unknown';
  return date.value+(date.precision==='day'?(date.time?` · ${date.time} ${date.zone??'(timezone unknown)'}`:' · Time unknown'):` · ${date.precision} precision`);
}
