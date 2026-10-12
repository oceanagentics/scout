import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calendarEvent,sameEvent,syncCalendar,googleAccessToken} from '../calendar/google.js';
import {calendarFeed} from '../calendar/feed.js';

const id='89a76621-0fac-447f-9429-62e1e8f985d1';
const record={id,version:1,updated_at:'2026-10-12T10:00:00Z',kind:'event',priority:'low',title:'Ocean data',description:'A & B <demo>',
  organizations:[{name:'HUB Ocean'}],canonical_url:'https://example.org/event',
  details:{start:{value:'2026-10-22',precision:'day',time:'15:30',zone:'+02:00'},
    end:{value:'2026-10-22',precision:'day',time:'16:15',zone:'+02:00'},location:'Online'}};
const response=(data,status=200)=>new Response(status===204?null:JSON.stringify(data),{status});
const owned=()=>({...calendarEvent(record),id:'scout'+id.replaceAll('-',''),etag:'"1"',extendedProperties:{private:{scout:'events-v1',record_id:id}}});
const options={calendarId:'danny@oceanagentics.com',accessToken:'test'};

test('all priorities, exact instants, source links and informational defaults',()=>{
  const event=calendarEvent(record);
  assert.deepEqual(event.start,{dateTime:'2026-10-22T13:30:00.000Z'});
  assert.deepEqual(event.end,{dateTime:'2026-10-22T14:15:00.000Z'});
  assert.equal(event.transparency,'transparent');assert.equal(event.visibility,'default');
  assert.deepEqual(event.reminders,{useDefault:false,overrides:[]});assert.equal(event.attendees,undefined);
  assert.match(event.description,/A &amp; B &lt;demo&gt;/);
  assert.equal(calendarEvent({...record,kind:'announcement'}),null);
  assert.equal(calendarEvent({...record,details:{...record.details,status:'cancelled'}}),null);
});

test('date-only ranges have exclusive end; missing clocks never invent a duration',()=>{
  for(const details of [{start:{value:'2026-10-22',precision:'day'}},{start:record.details.start},
    {start:{value:'2026-10-22',precision:'day',time:'15:30'},end:{value:'2026-10-24',precision:'day'}}]){
    const event=calendarEvent({...record,details});
    assert.deepEqual(event.start,{date:'2026-10-22'});assert.equal(event.end.date,details.end?'2026-10-25':'2026-10-23');
    assert.match(event.description,/Calendar date entry/);
  }
  for(const start of [undefined,{value:'2026-10',precision:'month'},{value:'2026',precision:'year'}])
    assert.equal(calendarEvent({...record,details:{start}}),null);
  assert.equal(calendarEvent({...record,details:{...record.details,end:record.details.start}}).start.date,'2026-10-22');
  assert.equal(calendarEvent({...record,details:{start:record.details.start,end:{value:'2026-10',precision:'month'}}}).start.date,'2026-10-22');
  assert.throws(()=>calendarEvent({...record,details:{...record.details,end:{value:'2026-10-21',precision:'day'}}}),/range/);
});

test('DST ambiguity stays a date entry, and derived UTC is rechecked',()=>{
  const event=calendarEvent({...record,details:{start:{value:'2026-11-01',precision:'day',time:'01:30',zone:'America/New_York'},
    end:{value:'2026-11-01',precision:'day',time:'03:00',zone:'America/New_York'}}});
  assert.equal(event.start.date,'2026-11-01');
  assert.equal(calendarEvent({...record,details:{...record.details,start:{...record.details.start,utc:'1999-01-01T00:00:00Z'}}}).start.dateTime,'2026-10-22T13:30:00.000Z');
});

test('complete batch creates 37 past and future events; repeat makes one read and no writes',async()=>{
  let saved=[],calls=[];
  const send=async(url,request)=>{
    calls.push({url,request});assert.ok(url.startsWith('https://www.googleapis.com/calendar/v3/calendars/danny%40oceanagentics.com/events'));
    if(request.method==='GET'){
      assert.equal(new URL(url).searchParams.get('privateExtendedProperty'),'scout=events-v1');return response({items:saved});
    }
    assert.equal(new URL(url).searchParams.get('sendUpdates'),'none');
    const event={...JSON.parse(request.body),etag:'"1"'};saved.push(event);return response(event);
  };
  const records=Array.from({length:37},(_,i)=>({...record,id:'aaaaaaaa-aaaa-4aaa-aaaa-'+String(i).padStart(12,'0'),
    details:{start:{value:i<22?'2001-09-01':'2099-10-22',precision:'day'}}}));
  assert.equal((await syncCalendar(records,{...options,send})).created,37);
  assert.equal(saved.length,37);assert.equal(new Set(saved.map(event=>event.id)).size,37);
  calls=[];
  assert.equal((await syncCalendar(records,{...options,send})).unchanged,37);assert.equal(calls.length,1);
});

test('correction clears old date form, matches revision, and cancellation removes its entry',async()=>{
  const calls=[];
  const send=async(url,request)=>{calls.push({url,request});return response(request.method==='GET'?{items:[owned()]}:owned());};
  const changed={...record,details:{start:{value:'2026-10-24',precision:'day'}}};
  assert.equal((await syncCalendar([changed],{...options,send})).updated,1);
  assert.equal(calls[1].request.method,'PATCH');assert.equal(calls[1].request.headers['If-Match'],'"1"');
  assert.deepEqual(JSON.parse(calls[1].request.body).start,{date:'2026-10-24',dateTime:null,timeZone:null});
  calls.length=0;
  assert.equal((await syncCalendar([{...record,details:{...record.details,status:'cancelled'}}],{...options,send})).removed,1);
  assert.equal(calls[1].request.method,'DELETE');
});

test('past records are added and corrected; manually deleted entries remain deleted',async()=>{
  let writes=0,current=[];
  const send=async(_,request)=>request.method==='GET'?response({items:current}):(writes++,response(owned()));
  const past={...record,details:{start:{value:'2026-09-01',precision:'day'}}};
  assert.equal((await syncCalendar([past],{...options,send})).created,1);assert.equal(writes,1);
  current=[owned()];assert.equal((await syncCalendar([past],{...options,send})).updated,1);
  current=[{id:owned().id,status:'cancelled'}];
  assert.equal((await syncCalendar([record],{...options,send})).skipped,1);assert.equal(writes,2);
});

test('foreign entries, guest changes, recurrence and missing revisions fail before writes',async()=>{
  for(const extra of [{description:'Personal event'},{attendees:[{email:'guest@example.org'}]},
    {recurrence:['RRULE:FREQ=WEEKLY']},{recurringEventId:'parent'},{etag:null}]){
    let writes=0;
    await assert.rejects(syncCalendar([{...record,title:'Changed'}],{...options,send:async(_,request)=>{
      if(request.method!=='GET')writes++;return response({items:[{...owned(),...extra}]});
    }}));assert.equal(writes,0);
  }
});

test('bounded batch refuses truncated results and excessive changes; uncertain writes are not retried',async()=>{
  await assert.rejects(syncCalendar([record],{...options,send:async()=>response({items:[],nextPageToken:'more'})}),/limit/);
  const many=Array.from({length:51},(_,i)=>({...record,id:'aaaaaaaa-aaaa-4aaa-aaaa-'+String(i).padStart(12,'0')}));
  let calls=0;await assert.rejects(syncCalendar(many,{...options,send:async()=>{calls++;return response({items:[]});}}),/50 changes/);assert.equal(calls,1);
  const metrics={requests:0,writes:0};
  await assert.rejects(syncCalendar([record],{...options,metrics,send:async(_,request)=>{
    if(request.method==='GET')return response({items:[]});throw new Error('network with private details');
  }}),/outcome unknown/);assert.deepEqual(metrics,{requests:2,writes:1});
});

test('Google localizes timestamps without making unchanged events dirty',()=>{
  const event=owned();assert.equal(sameEvent({...event,start:{dateTime:'2026-10-22T09:30:00-04:00'}},event),true);
  assert.equal(sameEvent({...event,reminders:{useDefault:true}},event),false);
});

test('OAuth requires credentials and does not echo provider errors',async()=>{
  await assert.rejects(googleAccessToken({}),/required/);
  assert.equal(await googleAccessToken({clientId:'id',clientSecret:'secret',refreshToken:'refresh'},async(url,request)=>{
    assert.equal(url,'https://oauth2.googleapis.com/token');assert.equal(request.body.get('grant_type'),'refresh_token');return response({access_token:'short-lived'});
  }),'short-lived');
  await assert.rejects(googleAccessToken({clientId:'id',clientSecret:'secret',refreshToken:'refresh'},async()=>response({error:'sensitive'},403)),/^Error: Google authorization HTTP 403$/);
});

test('feed has stable identity/revisions, UTC dates, safe text and byte-correct folding',()=>{
  const unsafe={...record,title:'🌊'.repeat(30)+'\r\nBEGIN:VEVENT',description:'one,two;three\\four\r\nfive'};
  const feed=calendarFeed([unsafe]),unfolded=feed.replaceAll('\r\n ','');
  assert.equal((feed.match(/\r\nBEGIN:VEVENT\r\n/g)??[]).length,1);
  for(const line of feed.split('\r\n'))assert.ok(Buffer.byteLength(line)<=75);
  assert.match(unfolded,/UID:89a76621-0fac-447f-9429-62e1e8f985d1@scout.oceanagentics.com/);
  assert.match(unfolded,/DTSTART:20261022T133000Z/);assert.match(unfolded,/DTEND:20261022T141500Z/);
  assert.match(unfolded,/DTSTAMP:20261012T100000Z/);assert.match(unfolded,/SEQUENCE:1/);
  assert.ok(unfolded.includes('one\\,two\\;three\\\\four\\nfive'));
});

test('feed includes past events and cancellation, excluding undated records',()=>{
  const dated={...record,details:{start:{value:'2026-10-22',precision:'day'},status:'cancelled'}};
  const past={...record,id:'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',details:{start:{value:'2001-09-01',precision:'day'}}};
  const feed=calendarFeed([dated,past,{...record,id:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',details:{}}]);
  assert.match(feed,/DTSTART;VALUE=DATE:20261022/);assert.match(feed,/DTEND;VALUE=DATE:20261023/);
  assert.match(feed,/STATUS:CANCELLED/);assert.equal((feed.match(/BEGIN:VEVENT/g)??[]).length,2);
  assert.match(feed,/DTSTART;VALUE=DATE:20010901/);assert.match(feed,/DTEND;VALUE=DATE:20010902/);
});
