import {checkFreshness} from '../freshness.js';
import {scoutDay} from '../../shared/finding-dates.js';
const fail=reason=>Object.assign(new Error(reason),{reason});
export const isBluesky=value=>{try{const u=new URL(value);return u.hostname==='bsky.app'&&/^\/profile\/[^/]+\/?$/.test(u.pathname)||u.origin==='https://public.api.bsky.app'&&u.pathname==='/xrpc/app.bsky.feed.getAuthorFeed';}catch{return false;}};
export async function discoverBluesky(tracker,{through,fetch:send=fetch,signal}){
  let url;try{url=new URL(tracker.url);}catch{throw fail('source_invalid');}
  const profile=url.hostname==='bsky.app'&&url.pathname.match(/^\/profile\/([^/]+)\/?$/);
  if(profile)url=new URL('https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor='+encodeURIComponent(decodeURIComponent(profile[1])));
  url.searchParams.delete('cursor');url.searchParams.set('includePins','false');
  if(!url.searchParams.has('limit'))url.searchParams.set('limit','100');
  const after=tracker.last_successful_check==null?null:new Date(tracker.last_successful_check).getTime(),until=Date.parse(through),items=[],seen=new Set(),cursors=new Set();
  if(after!==null&&!Number.isFinite(after)||!/^\d{4}-\d{2}-\d{2}$/.test(tracker.oldest_date))throw fail('source_cutoff_invalid');
  for(;;){
    let response;
    try{({response}=await checkFreshness(url.href,{fetch:send,signal}));}catch{throw fail(signal?.aborted?'runtime_bound':'source_unavailable');}
    if(!response.ok)throw fail('source_unavailable');
    let page;try{page=await response.json();}catch{throw fail('source_invalid');}
    if(!Array.isArray(page.feed))throw fail('source_invalid');
    let boundary=false;
    for(const entry of page.feed){
      if(entry.reason?.$type==='app.bsky.feed.defs#reasonPin')continue;
      const post=entry.post,repost=entry.reason?.$type==='app.bsky.feed.defs#reasonRepost';
      const published=Math.min(Date.parse(post?.record?.createdAt),Date.parse(post?.indexedAt));
      const at=repost?Date.parse(entry.reason.indexedAt):published;
      const uri=post?.uri?.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/);
      if(!Number.isFinite(at)||!Number.isFinite(published)||!uri||typeof post.record?.text!=='string')throw fail('source_invalid');
      if(after!==null&&at<=after||scoutDay(new Date(at))<tracker.oldest_date){boundary=true;continue;}
      if(at>until)continue;
      const key=post.uri+' '+at;
      if(seen.has(key))continue;
      seen.add(key);
      items.push({key:post.uri,url:'https://bsky.app/profile/'+uri[1]+'/post/'+uri[2],at:new Date(at).toISOString(),published_at:new Date(published).toISOString(),source_kind:'post',content:entry});
    }
    if(boundary||!page.cursor)break;
    if(typeof page.cursor!=='string'||cursors.has(page.cursor))throw fail('source_cursor_repeated');
    cursors.add(page.cursor);url.searchParams.set('cursor',page.cursor);
  }
  return items.sort((a,b)=>a.at.localeCompare(b.at));
}
