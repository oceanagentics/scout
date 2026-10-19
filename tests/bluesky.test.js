import {test} from 'node:test';
import assert from 'node:assert/strict';
import {authorFeed,nextBlueskyPost} from '../reader/bluesky.js';

const url='https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=example.org&limit=20';
const entry=n=>({post:{uri:`at://did:plc:author/app.bsky.feed.post/${n}`,record:{text:'Post '+n},
  embed:{images:[{alt:'First poster',fullsize:'https://example.org/1'},{alt:'Second poster',fullsize:'https://example.org/2'}]}}});

test('author feed selection leaves search and other URLs alone',()=>{
  assert.equal(authorFeed(url),true);
  for(const value of ['not a URL',url.replace('getAuthorFeed','searchPosts'),url.replace('public.api.bsky.app','example.org')])
    assert.equal(authorFeed(value),false);
});

test('initial window starts at oldest post; pagination reaches boundary and keeps every image',async()=>{
  const requests=[],source={url,reader_progress:entry(1).post.uri};
  const fetch=async target=>{requests.push(String(target));return Response.json(requests.length===1?
    {feed:[entry(4),entry(3)],cursor:'older'}:{feed:[entry(2),entry(1)],cursor:'oldest'});};
  const next=await nextBlueskyPost(source,{fetch});
  assert.equal(next.progress,entry(2).post.uri);
  assert.deepEqual(next.post.embed.images,entry(2).post.embed.images);
  assert.equal(new URL(requests[1]).searchParams.get('cursor'),'older');
  const first=await nextBlueskyPost({url},{fetch:async()=>Response.json({feed:[entry(3),entry(2),entry(1)]})});
  assert.equal(first.progress,entry(1).post.uri);
});

test('reposts use feed identity; deleted boundaries and repeated cursors never skip forward',async()=>{
  const repost={...entry(1),reason:{uri:'at://did:plc:source/app.bsky.feed.repost/new'}};
  assert.equal((await nextBlueskyPost({url},{fetch:async()=>Response.json({feed:[repost]})})).progress,repost.reason.uri);
  assert.equal(await nextBlueskyPost({url,reader_progress:repost.reason.uri},{fetch:async()=>Response.json({feed:[repost]})}),null);
  await assert.rejects(nextBlueskyPost({url,reader_progress:'missing'},{fetch:async()=>Response.json({feed:[entry(2)]})}),{reason:'source_bound'});
  let calls=0;
  await assert.rejects(nextBlueskyPost({url,reader_progress:'missing'},{fetch:async()=>{calls++;return Response.json({feed:[entry(2)],cursor:'same'});}}),{reason:'source_bound'});
  assert.equal(calls,2);
});
