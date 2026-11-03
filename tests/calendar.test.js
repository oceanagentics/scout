import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calendarFeed} from '../calendar/feed.js';

const id='89a76621-0fac-447f-9429-62e1e8f985d1';
const record={id,modified:['2026-10-12T10:00:00Z'],type:'event',priority:'low',description:'A & B <demo>',
  organizations:['HUB Ocean'],sources:['https://example.org/event'],date:'2026-10-22',starttime:'15:30',timezone:'+02:00'};
test('feed has stable identity/revisions, UTC dates, safe text and byte-correct folding',()=>{
  const unsafe={...record,description:'🌊'.repeat(30)+'one,two;three\\four\r\nfive'};
  const feed=calendarFeed([unsafe]),unfolded=feed.replaceAll('\r\n ','');
  assert.equal((feed.match(/\r\nBEGIN:VEVENT\r\n/g)??[]).length,1);
  for(const line of feed.split('\r\n'))assert.ok(Buffer.byteLength(line)<=75);
  assert.match(unfolded,/UID:89a76621-0fac-447f-9429-62e1e8f985d1@scout.oceanagentics.com/);
  assert.match(unfolded,/DTSTART;VALUE=DATE:20261022/);assert.match(unfolded,/DTEND;VALUE=DATE:20261023/);
  assert.match(unfolded,/DTSTAMP:20261012T100000Z/);assert.ok(unfolded.includes('SEQUENCE:'+Math.floor(Date.parse(record.modified[0])/1000)));
  assert.ok(unfolded.includes('one\\,two\\;three\\\\four\\nfive'));
});

test('feed includes dated past events and excludes undated records',()=>{
  const past={...record,id:'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',date:'2001-09-01'};
  const feed=calendarFeed([record,past,{...record,id:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',date:null}]);
  assert.match(feed,/DTSTART;VALUE=DATE:20261022/);assert.match(feed,/DTEND;VALUE=DATE:20261023/);
  assert.equal((feed.match(/BEGIN:VEVENT/g)??[]).length,2);
  assert.match(feed,/DTSTART;VALUE=DATE:20010901/);assert.match(feed,/DTEND;VALUE=DATE:20010902/);
});

test('feed date entries preserve supported start times and skip non-events or partial dates',()=>{
  const unfolded=calendarFeed([record]).replaceAll('\r\n ','');
  assert.match(unfolded,/15:30 \+02:00/);assert.doesNotMatch(unfolded,/end time unknown|Calendar date entry/);
  assert.match(unfolded,/TRANSP:TRANSPARENT/);assert.ok(unfolded.includes('A & B <demo>'));
  for(const change of [{type:'announcement'},{date:null},{date:'2026-10'},{date:'2026'}])
    assert.doesNotMatch(calendarFeed([{...record,...change}]),/BEGIN:VEVENT/);
  assert.throws(()=>calendarFeed([{...record,id:'invalid'}]),/Invalid Scout record ID/);
});

test('feed labels registration links and states registration is required only when one exists',()=>{
  const registration='https://us06web.zoom.us/meeting/register/X7ub2wxiR2-eFKqk8Taqvg#/registration';
  const withLink=calendarFeed([{...record,sources:['https://example.org/event',registration]}]).replaceAll('\r\n ','');
  assert.match(withLink,/Source: https:\/\/example.org\/event/);
  assert.ok(withLink.includes('Registration link: '+registration));assert.doesNotMatch(withLink,/Source: https:\/\/us06web/);
  assert.match(withLink,/Registration is required\./);assert.doesNotMatch(withLink,/Informational event/);
  assert.match(calendarFeed([record]).replaceAll('\r\n ',''),/Informational event from Scout\\; registration may be required\./);
});
