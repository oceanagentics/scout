import {recordDate,recordEnd,dateLabel} from '../shared/finding-dates.js';
import {sourceLink} from '../shared/records.js';

const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const text=value=>String(value??'').replaceAll('\\','\\\\').replace(/\r\n|\r|\n/g,'\\n').replaceAll(';','\\;').replaceAll(',','\\,');
const stamp=value=>new Date(value).toISOString().replaceAll('-','').replaceAll(':','').replace(/\.\d{3}/,'');

export function calendarEvent(record){
  if(!uuid.test(record.id))throw new Error('Invalid Scout record ID');
  if(record.type!=='event')return null;
  const start=recordDate(record);
  if(start?.precision!=='day')return null;
  const end=recordEnd(record),allDay=!start.time||end?.precision==='day'&&end.value>start.value&&!end.time;
  const links=record.sources.map(s=>sourceLink(s.url)).filter(Boolean),registrationLinks=links.filter(url=>/regist/i.test(url));
  return {start,end,allDay,summary:(record.priority==='high'?'⭐ ':'')+(record.priority==='low'?'':'🐧 ')+record.description,
    description:[record.description,record.organizations.join('; '),'Source start: '+dateLabel(start),
      ...(end?['Source end: '+dateLabel(end)]:[]),
      ...links.map(url=>(registrationLinks.includes(url)?'Registration link: ':'Source: ')+url),
      registrationLinks.length?'Registration is required.':'Informational event from Scout; registration may be required.',
      'Scout record: https://bbnj-scout.web.app/?record='+record.id].filter(Boolean).join('\n\n')};
}

export function calendarFeed(records){
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Ocean Agentics//Scout//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH',
    'NAME:Scout Events','X-WR-CALNAME;VALUE=TEXT:Scout Events'];
  for(const record of records){
    const event=calendarEvent(record);
    if(!event)continue;
    const {start,end,allDay,summary,description}=event;
    lines.push('BEGIN:VEVENT','UID:'+record.id+'@scout.oceanagentics.com',
      'DTSTAMP:'+stamp(record.modified.at(-1)),'LAST-MODIFIED:'+stamp(record.modified.at(-1)),
      // Advance existing subscription entries when supported end fields become visible.
      'SEQUENCE:'+(Math.floor(Date.parse(record.modified.at(-1))/1000)+(start.time?1:0)+(record.priority==='high'?2:record.priority==='low'?1:0)+(end?4:0)),
      'SUMMARY:'+text(summary),
      'DESCRIPTION:'+text(description),'LOCATION:','TRANSP:TRANSPARENT','STATUS:CONFIRMED');
    if(!allDay){
      const utc=start.utc&&(!end?.time||end.utc);
      lines.push('DTSTART:'+(utc?stamp(start.utc):start.value.replaceAll('-','')+'T'+start.time.replaceAll(':','').padEnd(6,'0')));
      if(end?.time)lines.push('DTEND:'+(utc?stamp(end.utc):end.value.replaceAll('-','')+'T'+end.time.replaceAll(':','').padEnd(6,'0')));
    }
    else{
      const through=end?.precision==='day'?end.value:start.value;
      const exclusive=new Date(Date.parse(through+'T00:00:00Z')+86400000).toISOString().slice(0,10);
      lines.push('DTSTART;VALUE=DATE:'+start.value.replaceAll('-',''),'DTEND;VALUE=DATE:'+exclusive.replaceAll('-',''));
    }
    lines.push('URL:https://bbnj-scout.web.app/?record='+record.id,'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  // RFC 5545 folds at 75 octets, without splitting UTF-8 code points.
  return lines.map(line=>{
    let folded='',bytes=0;
    for(const char of line){const size=new TextEncoder().encode(char).length;
      if(bytes+size>75){folded+='\r\n ';bytes=1;}folded+=char;bytes+=size;}
    return folded;
  }).join('\r\n')+'\r\n';
}
