import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calendarFeed} from '../calendar/feed.js';
import {googleEvent,syncCalendar} from '../calendar/google.js';

const id='89a76621-0fac-447f-9429-62e1e8f985d1';
const record={id,modified:['2026-10-12T10:00:00Z'],type:'event',priority:'high',description:'A & B <demo>',
  organizations:['HUB Ocean'],sources:[{url:'https://example.org/event',role:'finding'}],date:'2026-10-22',starttime:'15:30',timezone:'+02:00'};
test('feed has stable identity/revisions, UTC dates, safe text and byte-correct folding',()=>{
  const unsafe={...record,description:'🌊'.repeat(30)+'one,two;three\\four\r\nfive'};
  const feed=calendarFeed([unsafe]),unfolded=feed.replaceAll('\r\n ','');
  assert.equal((feed.match(/\r\nBEGIN:VEVENT\r\n/g)??[]).length,1);
  for(const line of feed.split('\r\n'))assert.ok(Buffer.byteLength(line)<=75);
  assert.match(unfolded,/UID:89a76621-0fac-447f-9429-62e1e8f985d1@scout.oceanagentics.com/);
  assert.match(unfolded,/DTSTART:20261022T133000Z/);assert.doesNotMatch(unfolded,/DTEND|DURATION/);
  assert.match(unfolded,/DTSTAMP:20261012T100000Z/);assert.ok(unfolded.includes('SEQUENCE:'+(Math.floor(Date.parse(record.modified[0])/1000)+3)));
  assert.match(unfolded,/\r\nSUMMARY:⭐ 🐧 🌊/);
  assert.ok(unfolded.includes('one\\,two\\;three\\\\four\\nfive'));
});

test('feed includes dated past events and excludes undated records',()=>{
  const past={...record,id:'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',date:'2001-09-01',starttime:null,timezone:null};
  const feed=calendarFeed([record,past,{...record,id:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',date:null}]);
  assert.match(feed,/DTSTART:20261022T133000Z/);
  assert.equal((feed.match(/BEGIN:VEVENT/g)??[]).length,2);
  assert.match(feed,/DTSTART;VALUE=DATE:20010901/);assert.match(feed,/DTEND;VALUE=DATE:20010902/);
  const dateEntry=feed.split('BEGIN:VEVENT')[2];
  assert.ok(dateEntry.includes('SEQUENCE:'+(Math.floor(Date.parse(record.modified[0])/1000)+2)));
});

test('feed and Google calendar include only high-priority events',()=>{
  const excluded=['normal','low',null,undefined].map(priority=>({...record,priority}));
  const feed=calendarFeed([record,...excluded]);
  assert.equal((feed.match(/BEGIN:VEVENT/g)??[]).length,1);
  assert.ok(googleEvent(record));
  for(const event of excluded)assert.equal(googleEvent(event),null);
});

test('feed uses stored timezones, preserves clocks without a timezone and skips partial dates',()=>{
  const unfolded=calendarFeed([record]).replaceAll('\r\n ','');
  assert.match(unfolded,/Source start: 2026-10-22 · 15:30 \+02:00/);assert.doesNotMatch(unfolded,/end time unknown|Calendar date entry/);
  const eastern=calendarFeed([{...record,date:'2026-11-04',starttime:'10:00',timezone:'-05:00'}]).replaceAll('\r\n ','');
  assert.match(eastern,/Source start: 2026-11-04 · 10:00 -05:00/);
  assert.match(eastern,/DTSTART:20261104T150000Z/);
  for(const [date,utc] of [['2027-01-11','20270111T150000Z'],['2027-07-11','20270711T140000Z']])
    assert.ok(calendarFeed([{...record,date,starttime:'10:00',timezone:'America/New_York'}]).includes('DTSTART:'+utc));
  const unknownZone=calendarFeed([{...record,timezone:null}]).replaceAll('\r\n ','');
  assert.match(unknownZone,/Source start: 2026-10-22 · 15:30 \(timezone unknown\)/);
  assert.match(unknownZone,/DTSTART:20261022T153000\r\n/);assert.doesNotMatch(unknownZone,/DTSTART;VALUE=DATE|DTEND/);
  assert.match(unfolded,/TRANSP:TRANSPARENT/);assert.ok(unfolded.includes('A & B <demo>'));
  for(const change of [{type:'announcement'},{date:null},{date:'2026-10'},{date:'2026'}])
    assert.doesNotMatch(calendarFeed([{...record,...change}]),/BEGIN:VEVENT/);
  assert.throws(()=>calendarFeed([{...record,id:'invalid'}]),/Invalid Scout record ID/);
});

test('feed labels registration links and states registration is required only when one exists',()=>{
  const registration='https://us06web.zoom.us/meeting/register/X7ub2wxiR2-eFKqk8Taqvg#/registration';
  const withLink=calendarFeed([{...record,sources:[{url:'https://example.org/event',role:'finding'},{url:registration,role:'supporting'}]}]).replaceAll('\r\n ','');
  assert.match(withLink,/Source: https:\/\/example.org\/event/);
  assert.ok(withLink.includes('Registration link: '+registration));assert.doesNotMatch(withLink,/Source: https:\/\/us06web/);
  assert.match(withLink,/Registration is required\./);assert.doesNotMatch(withLink,/Informational event/);
  assert.match(calendarFeed([record]).replaceAll('\r\n ',''),/Informational event from Scout\\; registration may be required\./);
});

test('Google entries label placeholder ends and retain unresolved source clocks as date entries',()=>{
  const timed=googleEvent(record);
  assert.equal(timed.start.dateTime,'2026-10-22T13:30:00.000Z');
  assert.equal(timed.end.dateTime,'2026-10-22T14:00:00.000Z');
  assert.match(timed.description,/End time unknown; displayed end is a 30-minute placeholder/);
  const unknown=googleEvent({...record,timezone:null});
  assert.deepEqual(unknown.start,{date:'2026-10-22'});assert.deepEqual(unknown.end,{date:'2026-10-23'});
  assert.match(unknown.description,/15:30 \(timezone unknown\)/);
  for(const change of [{date:'2026-10'},{date:null},{type:'announcement'}])assert.equal(googleEvent({...record,...change}),null);
});

test('published ends become timed ranges and inclusive multi-day dates become full date entries',()=>{
  const timed={...record,enddate:record.date,endtime:'16:15'},google=googleEvent(timed);
  assert.deepEqual(google.end,{dateTime:'2026-10-22T14:15:00.000Z'});assert.doesNotMatch(google.description,/placeholder/);
  assert.match(calendarFeed([timed]),/DTEND:20261022T141500Z/);
  const floating={...timed,timezone:null},feed=calendarFeed([floating]).replaceAll('\r\n ','');
  assert.match(feed,/DTSTART:20261022T153000\r\nDTEND:20261022T161500\r\n/);
  const overnight={...record,starttime:'23:30',enddate:'2026-10-23',endtime:'01:00'};
  assert.deepEqual(googleEvent(overnight).end,{dateTime:'2026-10-22T23:00:00.000Z'});
  for(const starttime of [null,'15:30']){
    const span={...record,starttime,enddate:'2026-10-24',endtime:null},event=googleEvent(span);
    assert.deepEqual(event.start,{date:'2026-10-22'});assert.deepEqual(event.end,{date:'2026-10-25'});
    assert.match(calendarFeed([span]),/DTSTART;VALUE=DATE:20261022\r\nDTEND;VALUE=DATE:20261025/);
    if(starttime)assert.match(event.description,/Source start: 2026-10-22 · 15:30/);
  }
  const invalid=googleEvent({...timed,endtime:'14:00'});
  assert.match(invalid.description,/30-minute placeholder/);
  const fold={...record,date:'2026-11-01',starttime:'01:30',timezone:'America/New_York',enddate:'2026-11-01',endtime:'02:30'};
  assert.match(calendarFeed([fold]),/DTSTART:20261101T013000\r\nDTEND:20261101T023000\r\n/);
});

test('reconciliation creates, updates and removes managed entries, then repeats without writes',async()=>{
  const second={...record,id:'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'};
  const old=googleEvent({...record,description:'Old title',modified:['2026-10-01T00:00:00Z']});old.etag='revision';old.status='cancelled';
  const orphan={...googleEvent({...record,id:'cccccccc-cccc-4ccc-cccc-cccccccccccc'}),etag:'orphan-revision'};
  const deleted={...orphan,id:'deleted',status:'cancelled'};
  const events=new Map([[old.id,old],[orphan.id,orphan],[deleted.id,deleted],['manual',{id:'manual'}]]),writes=[],queries=[];
  let paginated=true,records=[record,second];
  const db={query:async(sql,params)=>{
    queries.push({sql,params});return {rows:sql.includes('vault.')?[{decrypted_secret:JSON.stringify({client_id:'client',client_secret:'secret',refresh_token:'refresh'})}]:records};
  }};
  const send=async(url,options)=>{
    if(url.includes('oauth2'))return Response.json({access_token:'access',scope:'https://www.googleapis.com/auth/calendar.events.owned'});
    const parsed=new URL(url),method=options.method,id=parsed.pathname.split('/').at(-1);
    if(method==='GET'&&id==='events'){
      assert.equal(parsed.searchParams.get('privateExtendedProperty'),'scout=1');
      assert.equal(parsed.searchParams.get('showDeleted'),'true');
      if(paginated&&!parsed.searchParams.has('pageToken'))return Response.json({items:[old],nextPageToken:'next'});
      const items=paginated?[orphan,deleted,{id:'manual'}]:[...events.values()];paginated=false;return Response.json({items});
    }
    if(method==='GET')return events.has(id)?Response.json(events.get(id)):Response.json({}, {status:404});
    assert.equal(parsed.searchParams.get('sendUpdates'),'none');writes.push(method);
    if(method==='DELETE'){
      assert.equal(options.headers['If-Match'],events.get(id).etag);events.delete(id);return new Response(null,{status:204});
    }
    const event=JSON.parse(options.body);
    if(method==='PUT')assert.equal(options.headers['If-Match'],events.get(id).etag);
    events.set(event.id,{...event,etag:'new-revision'});return Response.json(events.get(event.id));
  };
  assert.deepEqual(await syncCalendar(db,{fetch:send}),{status:'ok',created:1,updated:1,removed:1,unchanged:0,google_requests:6});
  assert.deepEqual(writes,['PUT','POST','DELETE']);assert.ok(events.has('manual'));
  writes.length=0;
  assert.deepEqual(await syncCalendar(db,{fetch:send}),{status:'ok',created:0,updated:0,removed:0,unchanged:2,google_requests:2});
  assert.deepEqual(writes,[]);assert.equal(queries.length,4);
  records=[record,{...second,priority:'normal'}];
  const removal=await syncCalendar(db,{ids:[second.id],fetch:send});assert.equal(removal.removed,1);
  assert.equal(events.has(googleEvent(second).id),false);assert.ok(events.has(old.id));
  records=[{...record,priority:'low'}];
  const reconciliation=await syncCalendar(db,{fetch:send});assert.equal(reconciliation.removed,1);
  assert.equal(events.has(old.id),false);assert.ok(events.has('manual'));
});
