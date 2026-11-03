import {recordDate,dateLabel} from '../shared/finding-dates.js';
import {sourceLink} from '../shared/records.js';

const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const text=value=>String(value??'').replaceAll('\\','\\\\').replace(/\r\n|\r|\n/g,'\\n').replaceAll(';','\\;').replaceAll(',','\\,');
const stamp=value=>new Date(value).toISOString().replaceAll('-','').replaceAll(':','').replace(/\.\d{3}/,'');

export function calendarFeed(records){
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Ocean Agentics//Scout//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH','X-WR-CALNAME:Scout Events'];
  for(const record of records){
    if(!uuid.test(record.id))throw new Error('Invalid Scout record ID');
    if(record.type!=='event')continue;
    const start=recordDate(record);
    if(start?.precision!=='day')continue;
    const end=new Date(Date.parse(start.value+'T00:00:00Z')+86400000).toISOString().slice(0,10);
    const registration=sourceLink(record.registration);
    const description=[record.description,record.organizations.join('; '),
      'Source start: '+(start.utc?`${start.utc.slice(0,10)} · ${start.utc.slice(11,16)} UTC`:dateLabel(start)),
      ...record.sources.filter(url=>sourceLink(url)&&url!==registration).map(url=>'Source: '+url),
      ...registration?['Registration link: '+registration,'Registration is required.']
        :['Informational event from Scout; registration may be required.'],
      'Scout record: https://bbnj-scout.web.app/?record='+record.id].filter(Boolean).join('\n\n');
    lines.push('BEGIN:VEVENT','UID:'+record.id+'@scout.oceanagentics.com',
      'DTSTAMP:'+stamp(record.modified.at(-1)),'LAST-MODIFIED:'+stamp(record.modified.at(-1)),
      'SEQUENCE:'+Math.floor(Date.parse(record.modified.at(-1))/1000),'SUMMARY:'+text('🐧 '+record.description),
      'DESCRIPTION:'+text(description),'LOCATION:','TRANSP:TRANSPARENT','STATUS:CONFIRMED',
      'DTSTART;VALUE=DATE:'+start.value.replaceAll('-',''),'DTEND;VALUE=DATE:'+end.replaceAll('-',''));
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
