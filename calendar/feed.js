import {calendarEvent} from './google.js';

const text=value=>String(value??'').replaceAll('\\','\\\\').replace(/\r\n|\r|\n/g,'\\n').replaceAll(';','\\;').replaceAll(',','\\,');
const stamp=value=>new Date(value).toISOString().replaceAll('-','').replaceAll(':','').replace(/\.\d{3}/,'');
const plain=value=>value.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');

export function calendarFeed(records,{now=new Date(),timeZone='America/Kralendijk'}={}){
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Ocean Agentics//Scout//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH','X-WR-CALNAME:Scout Events'];
  for(const record of records){
    const cancelled=record.details?.status==='cancelled';
    const event=calendarEvent(cancelled?{...record,details:{...record.details,status:null}}:record,now,timeZone);
    if(!event)continue;
    lines.push('BEGIN:VEVENT','UID:'+record.id+'@scout.oceanagentics.com',
      'DTSTAMP:'+stamp(record.updated_at),'LAST-MODIFIED:'+stamp(record.updated_at),
      'SEQUENCE:'+record.version,'SUMMARY:'+text(event.summary),
      'DESCRIPTION:'+text(plain(event.description)),'LOCATION:'+text(event.location),'TRANSP:TRANSPARENT',
      'STATUS:'+(cancelled?'CANCELLED':'CONFIRMED'));
    for(const [name,value]of [['DTSTART',event.start],['DTEND',event.end]])
      lines.push(value.date?name+';VALUE=DATE:'+value.date.replaceAll('-',''):name+':'+stamp(value.dateTime));
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
