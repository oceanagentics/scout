export const PREPARATION_VERSION = 'bluesky-author-documents-v2';
const endpoint = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed';

// URI identity and source relationships only: finding count and fields belong to
// the shared extraction stage. Raw feed responses remain separate from items.
export function prepareAuthorItem(item, { actor, sourceURL }) {
  const post=item?.post, identity=post?.uri?.match(/^at:\/\/(did:[^/]+)\/app\.bsky\.feed\.post\/([a-zA-Z0-9_-]+)$/);
  if (!identity || typeof post.record?.text!=='string' || post.record.$type && post.record.$type!=='app.bsky.feed.post' ||
      typeof post.author?.handle!=='string' || post.author.did && post.author.did!==identity[1] ||
      !Number.isFinite(Date.parse(post.record.createdAt)) || !Number.isFinite(Date.parse(post.indexedAt)))
    throw new Error('Invalid author-feed post identity/content');
  const repost=item.reason?.$type==='app.bsky.feed.defs#reasonRepost';
  if (post.author.handle!==actor && !(repost && item.reason.by?.handle===actor))
    throw new Error('Post/repost does not identify the requested feed actor');
  const url=sourceURL(`https://bsky.app/profile/${identity[1]}/post/${identity[2]}`), raw=JSON.stringify(item);
  // JSON already has structural boundaries: HTML whitespace cleanup would alter
  // literal text (including bilingual context and external descriptions).
  const prepared={version:PREPARATION_VERSION,title:'',url,input:'author-feed-item',text:raw,
    blocks:[{id:0,tag:'structured-data',start:0,end:raw.length,headings:[]}],
    chunks:[{start:0,end:raw.length,block_ids:[0],context_block_ids:[],preceding_context:null}],links:[],omissions:[]};
  const coverage=[];
  function link(target, relationship, path) {
    const position=post.record.text.indexOf(target),prefix=position<0?'':post.record.text.slice(0,position).split('\n').at(-1);
    // An explicit adjacent label establishes the link relationship. A URL's
    // hostname/path and feed ownership never establish publisher authority.
    if(/\b(?:register|registration)\s*:\s*$/i.test(prefix))relationship='registration';
    try {prepared.links.push({target:sourceURL(target),label:target,tag:'a',relationship,context:path+' '+prefix,state:'unfetched'});}
    catch {coverage.push({target,relationship,path,state:'unsupported',reason:'Public HTTPS support URL required'});}
  }
  function walk(value,path) {
    if (!value || typeof value!=='object') return;
    if (value.$type==='app.bsky.richtext.facet#link') link(value.uri,'support',path);
    if (value.external?.uri) link(value.external.uri,'support',path+'.external');
    if (value.uri?.startsWith('at://')) {
      const quote=value.uri.match(/^at:\/\/(did:[^/]+)\/app\.bsky\.feed\.post\/([a-zA-Z0-9_-]+)$/);
      if (quote && value.uri!==post.uri) {
        const target=sourceURL(`https://bsky.app/profile/${quote[1]}/post/${quote[2]}`);
        coverage.push({target,path,state:value.value?'embedded':'unfetched',relationship:path.includes('.reply')?'reply':'quote',
          reason:'Only returned context retained; full thread/quoted post has not been fetched'});
        prepared.links.push({target,label:target,tag:'a',relationship:'support',context:path,state:'unfetched'});
      }
    }
    for (const key of ['fullsize','thumb','playlist']) if (typeof value[key]==='string')
      coverage.push({target:value[key],path:path+'.'+key,relationship:'media',state:'unfetched',reason:'Media bytes/transcription not retrieved; supplied alt text retained'});
    if (value.$type==='blob') coverage.push({path,relationship:'media',state:'unfetched',reason:'Blob bytes not retrieved; supplied metadata retained'});
    for (const [key,child] of Object.entries(value)) walk(child,path+'.'+key);
  }
  walk(item,'item');
  // Plain-text links are retained even when a facet is absent; no prefix clipping.
  for (const match of post.record.text.matchAll(/https:\/\/[^\s<>]+/g)) link(match[0],'support','item.post.record.text');
  coverage.push({relationship:'reply',state:item.reply||post.record.reply?'partial':'unfetched',reason:'Feed-returned reply context only; complete thread not retrieved'},
    {relationship:'repost',state:repost?'retained':'absent',reason:'Returned feed reason retained without publisher authority inference'});
  prepared.coverage=coverage;
  return {id:post.uri,url,raw,payload:item,prepared,coverage};
}

export async function retrieveAuthorDocuments({tracker,read,sourceURL,budget,limits={feedPages:2,postsPerPage:20}}) {
  const actor=tracker.collector==='bluesky_feed' && tracker.url?.match(/^https:\/\/bsky\.app\/profile\/([a-z0-9.-]+)$/)?.[1];
  if (!actor) throw new Error('Unsupported Bluesky author tracker');
  if (!Number.isInteger(limits.feedPages)||limits.feedPages<1||!Number.isInteger(limits.postsPerPage)||limits.postsPerPage<1||limits.postsPerPage>100)
    throw new Error('Invalid author-feed retrieval bounds');
  const documents=[],pages=[],coverage=[],cursors=new Set();
  let cursor;
  for(let page=0;page<limits.feedPages;page++) {
    const params=new URLSearchParams({actor,limit:String(limits.postsPerPage),filter:'posts_with_replies',includePins:'true'});
    if(cursor) params.set('cursor',cursor);
    const url=sourceURL(endpoint+'?'+params);
    try {
      const response=await read(url,budget);
      pages.push({url,response});
      if(sourceURL(response.url)!==url||!/json/i.test(response.headers?.['content-type']??'')) throw new Error('Unexpected author-feed destination/format');
      const feed=JSON.parse(response.body);
      if(!Array.isArray(feed.feed)||feed.cursor!=null&&(typeof feed.cursor!=='string'||!feed.cursor)) throw new Error('Invalid author-feed page/pagination');
      // getAuthorFeed prepends one author-owned pin on the first page, outside
      // the ordinary post/repost limit. Every item still passes source validation.
      const pins=feed.feed.filter(item=>item?.reason?.$type==='app.bsky.feed.defs#reasonPin');
      if(feed.feed.length-pins.length>limits.postsPerPage||pins.length>1||pins.length&&(cursor||feed.feed[0]!==pins[0]))
        throw new Error('Invalid author-feed ordinary/pinned bounds');
      for(const [position,item] of feed.feed.entries()) {
        try {
          const document=prepareAuthorItem(item,{actor,sourceURL});
          documents.push({...document,provenance:{page,position,feed_url:url}});
        } catch(error) {coverage.push({page,position,state:'failed',reason:error.message});}
      }
      cursor=feed.cursor;
      if(!cursor) return {documents,pages,coverage,complete:!coverage.some(c=>c.state==='failed'),pagination:{state:'exhausted'},limits};
      if(cursors.has(cursor)) throw new Error('Repeated author-feed cursor');
      cursors.add(cursor);
    } catch(error) {
      coverage.push({url,state:'failed',reason:error.message});
      return {documents,pages,coverage,complete:false,pagination:{state:'failed',cursor},limits};
    }
  }
  coverage.push({relationship:'pagination',state:'unfetched',reason:'Author-feed page bound reached',cursor});
  return {documents,pages,coverage,complete:false,pagination:{state:'bounded',cursor},limits};
}
