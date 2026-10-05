export const PREPARATION_VERSION = 'bluesky-author-documents-v3';
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
  // Literal content fields, not serialized transport JSON. Offsets refer to
  // decoded source strings (UTF-16); every original value remains in raw.
  const prepared={version:PREPARATION_VERSION,title:'',url,input:'author-feed-item',text:'',blocks:[],chunks:[],links:[],omissions:[]};
  const coverage=[],rendered=new Set(),fields=new Map();
  function content(text,path,field,context) {
    if(typeof text!=='string'||rendered.has(path))return;
    rendered.add(path);
    const attribution={relationship:context.relationship,author:context.author,uri:context.uri};
    const key=JSON.stringify([field,attribution,text]),existing=fields.get(key);
    if(existing){existing.source_paths.push(path);return;}
    if(prepared.blocks.length)prepared.text+='\n\n';
    const start=prepared.text.length;prepared.text+=text;
    const block={id:prepared.blocks.length,tag:'source-field',field,attribution,source_paths:[path],start,end:prepared.text.length,headings:[]};
    prepared.blocks.push(block);fields.set(key,block);
  }
  function link(target, relationship, path,context) {
    const position=context.text?.indexOf(target)??-1,prefix=position<0?'':context.text.slice(0,position).split('\n').at(-1);
    // An explicit adjacent label establishes the link relationship. A URL's
    // hostname/path and feed ownership never establish publisher authority.
    if(/\b(?:register|registration)\s*:\s*$/i.test(prefix))relationship='registration';
    try {prepared.links.push({target:sourceURL(target),label:target,tag:'a',relationship,context:path+' '+prefix,state:'unfetched'});}
    catch {coverage.push({target,relationship,path,state:'unsupported',reason:'Public HTTPS support URL required'});}
  }
  function walk(value,path,context,technical=false) {
    if (!value || typeof value!=='object') return;
    if(!Object.keys(value).length)prepared.omissions.push({path,reason:'Empty structural value retained in raw item'});
    const record=value.record?.text!=null?value.record:value.value?.text!=null?value.value:null;
    if(!technical&&value.uri?.startsWith('at://')){
      context={uri:value.uri,author:value.author?.handle??null,text:record?.text,
        relationship:value===post?'post':path.includes('.reply.root')?'reply-root':path.includes('.reply.parent')?'reply-parent':'quote'};
      if(record)content(record.text,path+(record===value.record?'.record.text':'.value.text'),'text',context);
      else content(value.uri,path+'.uri','reference',context);
    }
    if(!technical&&path.endsWith('.external'))context={...context,uri:value.uri??null,author:null,relationship:'external'};
    if (value.$type==='app.bsky.richtext.facet#link') link(value.uri,'support',path,context);
    if (value.external?.uri) link(value.external.uri,'support',path+'.external',context);
    if (value.uri?.startsWith('at://')) {
      const quote=value.uri.match(/^at:\/\/(did:[^/]+)\/app\.bsky\.feed\.post\/([a-zA-Z0-9_-]+)$/);
      if (quote && value.uri!==post.uri) {
        const target=sourceURL(`https://bsky.app/profile/${quote[1]}/post/${quote[2]}`);
        coverage.push({target,path,state:record?'embedded':'unfetched',relationship:path.includes('.reply')?'reply':'quote',
          reason:'Only returned context retained; full thread/quoted post has not been fetched'});
        prepared.links.push({target,label:target,tag:'a',relationship:'support',context:path,state:'unfetched'});
      }
    }
    for (const key of ['fullsize','thumb','playlist']) if (typeof value[key]==='string')
      coverage.push({target:value[key],path:path+'.'+key,relationship:'media',state:'unfetched',reason:'Media bytes/transcription not retrieved; supplied alt text retained'});
    if (value.$type==='blob') coverage.push({path,relationship:'media',state:'unfetched',reason:'Blob bytes not retrieved; supplied metadata retained'});
    for (const [key,child] of Object.entries(value)) {
      const sourcePath=path+'.'+key,excluded=technical||['author','by','reason','viewer','labels','image','thumb','aspectRatio'].includes(key)||value.$type==='blob';
      if(child&&typeof child==='object')walk(child,sourcePath,context,excluded);
      else if(!excluded&&typeof child==='string'&&(['text','title','description','alt','createdAt'].includes(key)||key==='uri'&&/^https?:/.test(child)))
        content(child,sourcePath,key,key==='alt'?{...context,relationship:context.relationship+'-image-alt'}:context);
      else if(!rendered.has(sourcePath))prepared.omissions.push({path:sourcePath,reason:'Non-content/profile/transport field excluded from model text; exact value retained in raw item'});
    }
  }
  const primary={uri:post.uri,author:post.author.handle,text:post.record.text,relationship:'post'};
  content(post.record.text,'item.post.record.text','text',primary);
  walk(item,'item',primary);
  for(const block of prepared.blocks)prepared.chunks.push({start:prepared.chunks.at(-1)?.end??0,end:block.end,block_ids:[block.id],context_block_ids:[],preceding_context:null});
  // Plain-text links are retained even when a facet is absent; no prefix clipping.
  for(const block of prepared.blocks)if(block.field==='text')for(const match of prepared.text.slice(block.start,block.end).matchAll(/https:\/\/[^\s<>]+/g))
    link(match[0],'support',block.source_paths[0],{text:prepared.text.slice(block.start,block.end)});
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
