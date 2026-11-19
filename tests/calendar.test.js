import {test} from 'node:test';
import assert from 'node:assert/strict';
import {googleEvent,syncCalendar} from '../calendar/google.js';

const id='89a76621-0fac-447f-9429-62e1e8f985d1';
const sharedCalendar='c_c4eba5697d3a3e33c4590daa7c20c8791d7d608b787ff959bf3117f3a7d02df5@group.calendar.google.com';
const reviewCalendar='c_d6d8bace0ef22918c156fc9878f310a210a4feb47a7f078744a99cceef293633@group.calendar.google.com';
const record={id,modified:['2026-10-12T10:00:00Z'],type:'event',priority:'high',description:'A & B <demo>',
  organizations:['HUB Ocean'],sources:[{url:'https://example.org/event',role:'finding'}],date:'2026-10-22',starttime:'15:30',timezone:'+02:00'};
test('Google events include all priorities with exact dates',()=>{
  assert.ok(googleEvent(record));
  for(const priority of ['normal','low',null,undefined])assert.ok(googleEvent({...record,priority}));
  for(const change of [{type:'announcement'},{date:null},{date:'2026-10'},{date:'2026'}])
    assert.equal(googleEvent({...record,...change}),null);
  assert.throws(()=>googleEvent({...record,id:'invalid'}),/Invalid Scout record ID/);
  const past=googleEvent({...record,date:'2001-09-01',starttime:null,timezone:null});
  assert.deepEqual(past.start,{date:'2001-09-01'});assert.deepEqual(past.end,{date:'2001-09-02'});
});

test('Google entries retain stable IDs, titles, source clocks and timezones',()=>{
  const event=googleEvent(record);
  assert.equal(event.id,'scout89a766210fac447f942962e1e8f985d1');
  assert.equal(event.summary,'⭐ 🐧 A & B <demo>');assert.equal(event.transparency,'transparent');
  assert.deepEqual(event.extendedProperties.private,{scout:'1',scout_modified:'2026-10-12T10:00:00.000Z'});
  assert.match(event.description,/Source start: 2026-10-22 · 15:30 \+02:00/);
  const eastern=googleEvent({...record,date:'2026-11-04',starttime:'10:00',timezone:'-05:00'});
  assert.match(eastern.description,/Source start: 2026-11-04 · 10:00 -05:00/);
  assert.equal(eastern.start.dateTime,'2026-11-04T15:00:00.000Z');
  for(const [date,utc] of [['2027-01-11','2027-01-11T15:00:00.000Z'],['2027-07-11','2027-07-11T14:00:00.000Z']])
    assert.equal(googleEvent({...record,date,starttime:'10:00',timezone:'America/New_York'}).start.dateTime,utc);
});

test('Google entries label registration links and state registration is required only when one exists',()=>{
  const registration='https://us06web.zoom.us/meeting/register/X7ub2wxiR2-eFKqk8Taqvg#/registration';
  const withLink=googleEvent({...record,sources:[{url:'https://example.org/event',role:'finding'},{url:registration,role:'supporting'}]}).description;
  assert.match(withLink,/Source: https:\/\/example.org\/event/);
  assert.ok(withLink.includes('Registration link: '+registration));assert.doesNotMatch(withLink,/Source: https:\/\/us06web/);
  assert.match(withLink,/Registration is required\./);assert.doesNotMatch(withLink,/Informational event/);
  assert.match(googleEvent(record).description,/Informational event from Scout; registration may be required\./);
});

test('Google entries label placeholder ends and retain unresolved source clocks as date entries',()=>{
  const timed=googleEvent(record);
  assert.equal(timed.start.dateTime,'2026-10-22T13:30:00.000Z');
  assert.equal(timed.end.dateTime,'2026-10-22T14:00:00.000Z');
  assert.match(timed.description,/End time unknown; displayed end is a 30-minute placeholder/);
  const unknown=googleEvent({...record,timezone:null});
  assert.deepEqual(unknown.start,{date:'2026-10-22'});assert.deepEqual(unknown.end,{date:'2026-10-23'});
  assert.match(unknown.description,/15:30 \(timezone unknown\)/);
});

test('published ends become timed ranges and inclusive multi-day dates become full date entries',()=>{
  const timed={...record,enddate:record.date,endtime:'16:15'},google=googleEvent(timed);
  assert.deepEqual(google.end,{dateTime:'2026-10-22T14:15:00.000Z'});assert.doesNotMatch(google.description,/placeholder/);
  const floating=googleEvent({...timed,timezone:null});
  assert.deepEqual(floating.start,{date:'2026-10-22'});assert.deepEqual(floating.end,{date:'2026-10-23'});
  assert.match(floating.description,/Source end: 2026-10-22 · 16:15 \(timezone unknown\)/);
  const overnight={...record,starttime:'23:30',enddate:'2026-10-23',endtime:'01:00'};
  assert.deepEqual(googleEvent(overnight).end,{dateTime:'2026-10-22T23:00:00.000Z'});
  for(const starttime of [null,'15:30']){
    const span={...record,starttime,enddate:'2026-10-24',endtime:null},event=googleEvent(span);
    assert.deepEqual(event.start,{date:'2026-10-22'});assert.deepEqual(event.end,{date:'2026-10-25'});
    if(starttime)assert.match(event.description,/Source start: 2026-10-22 · 15:30/);
  }
  const invalid=googleEvent({...timed,endtime:'14:00'});
  assert.match(invalid.description,/30-minute placeholder/);
  const fold={...record,date:'2026-11-01',starttime:'01:30',timezone:'America/New_York',enddate:'2026-11-01',endtime:'02:30'};
  assert.deepEqual(googleEvent(fold).start,{date:'2026-11-01'});
  assert.match(googleEvent(fold).description,/Calendar date entry/);
});

test('reconciliation creates, updates and removes managed entries, then repeats without writes',async()=>{
  const second={...record,id:'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'};
  const old=googleEvent({...record,description:'Old title',modified:['2026-10-01T00:00:00Z']});old.etag='revision';old.status='cancelled';
  const orphan={...googleEvent({...record,id:'cccccccc-cccc-4ccc-cccc-cccccccccccc'}),etag:'orphan-revision'};
  const deleted={...orphan,id:'deleted',status:'cancelled'};
  const events=new Map([[old.id,old],[orphan.id,orphan],[deleted.id,deleted],['manual',{id:'manual'}]]),writes=[],queries=[];
  const reviewEvents=new Map(),calendars=new Map([[sharedCalendar,events],[reviewCalendar,reviewEvents]]);
  let paginated=true,records=[record,second];
  const db={query:async(sql,params)=>{
    queries.push({sql,params});return {rows:sql.includes('vault.')?[{decrypted_secret:JSON.stringify({client_id:'client',client_secret:'secret',refresh_token:'refresh'})}]:records};
  }};
  const send=async(url,options)=>{
    if(url.includes('oauth2'))return Response.json({access_token:'access',scope:'https://www.googleapis.com/auth/calendar.events.owned'});
    const parsed=new URL(url),method=options.method,id=parsed.pathname.split('/').at(-1);
    const calendar=decodeURIComponent(parsed.pathname.split('/')[4]),calendarEvents=calendars.get(calendar);assert.ok(calendarEvents);
    if(method==='GET'&&id==='events'){
      assert.equal(parsed.searchParams.get('privateExtendedProperty'),'scout=1');
      assert.equal(parsed.searchParams.get('showDeleted'),'true');
      if(calendar===sharedCalendar&&paginated&&!parsed.searchParams.has('pageToken'))return Response.json({items:[old],nextPageToken:'next'});
      const items=calendar===sharedCalendar&&paginated?[orphan,deleted,{id:'manual'}]:[...calendarEvents.values()];paginated=false;return Response.json({items});
    }
    if(method==='GET')return calendarEvents.has(id)?Response.json(calendarEvents.get(id)):Response.json({}, {status:404});
    assert.equal(parsed.searchParams.get('sendUpdates'),'none');writes.push([calendar,method]);
    if(method==='DELETE'){
      assert.equal(options.headers['If-Match'],calendarEvents.get(id).etag);calendarEvents.delete(id);return new Response(null,{status:204});
    }
    const event=JSON.parse(options.body);
    if(method==='PUT')assert.equal(options.headers['If-Match'],calendarEvents.get(id).etag);
    calendarEvents.set(event.id,{...event,etag:'new-revision'});return Response.json(calendarEvents.get(event.id));
  };
  assert.deepEqual(await syncCalendar(db,{fetch:send}),{status:'ok',created:3,updated:1,removed:1,unchanged:0,google_requests:9});
  assert.deepEqual(writes,[[sharedCalendar,'PUT'],[sharedCalendar,'POST'],[sharedCalendar,'DELETE'],[reviewCalendar,'POST'],[reviewCalendar,'POST']]);assert.ok(events.has('manual'));
  writes.length=0;
  assert.deepEqual(await syncCalendar(db,{fetch:send}),{status:'ok',created:0,updated:0,removed:0,unchanged:4,google_requests:3});
  assert.deepEqual(writes,[]);assert.equal(queries.length,4);
  records=[record,{...second,priority:'normal'}];
  const removal=await syncCalendar(db,{ids:[second.id],fetch:send});assert.equal(removal.removed,1);
  assert.equal(events.has(googleEvent(second).id),false);assert.ok(events.has(old.id));assert.ok(reviewEvents.has(googleEvent(second).id));
  records=[{...record,priority:'low'}];
  const reconciliation=await syncCalendar(db,{fetch:send});assert.equal(reconciliation.removed,2);
  assert.equal(events.has(old.id),false);assert.ok(events.has('manual'));assert.deepEqual([...reviewEvents.keys()],[old.id]);
});
