import { prepareAuthorItem } from './bluesky-documents.js';

export const DISCOVERY_QUERIES = Object.freeze(['BBNJ','"High Seas Treaty"','"traité sur la haute mer"','BBNJCOP1']);
export const PREPARATION_VERSION = 'bluesky-discovery-documents-v2';
const endpoint='https://api.bsky.app/xrpc/app.bsky.feed.searchPosts';

// Source-only search. Query/window constraints describe retrieval coverage;
// returned publication timestamps never select findings or assign event dates.
export async function retrieveDiscoveryDocuments({tracker,read,sourceURL,budget,since,until,progress={},
  limits={searchPages:1,postsPerPage:5,requests:4},now=Date.now}) {
  if(tracker.collector!=='bluesky_search'||tracker.url!=='https://bsky.app/search?q=BBNJ')
    throw new Error('Unsupported Bluesky discovery tracker');
  if(!Number.isInteger(limits.searchPages)||limits.searchPages<1||!Number.isInteger(limits.postsPerPage)||limits.postsPerPage<1||limits.postsPerPage>100||!Number.isInteger(limits.requests)||limits.requests<1)
    throw new Error('Invalid discovery retrieval bounds');
  for(const timestamp of [since,until]) if(timestamp!=null&&(typeof timestamp!=='string'||!Number.isFinite(Date.parse(timestamp))))
    throw new Error('Invalid discovery retrieval window');
  if(since&&until&&Date.parse(since)>=Date.parse(until))throw new Error('Invalid discovery retrieval window');
  const pages=[],coverage=[],queries=[],posts=new Map(),next={history:!progress.history,queries:{...progress.queries}};let requests=0,blocked;
  for(const q of DISCOVERY_QUERIES) {
    const query={q,pages:0,state:'unfetched'};queries.push(query);
    if(blocked){query.reason=blocked;continue;}
    const retained=progress.queries?.[q],history=progress.history&&retained?.cursor;
    let cursor=history?retained.cursor:undefined;const cursors=new Set();
    const window=history?retained:{since,until};
    for(let page=0;page<limits.searchPages;page++) {
      if(requests>=limits.requests||budget.requests>=limits.requests||now()>=budget.deadline) {
        blocked=requests>=limits.requests||budget.requests>=limits.requests?'Discovery request bound reached':'Collection time limit reached';
        Object.assign(query,{state:'bounded',cursor,reason:blocked});break;
      }
      const params=new URLSearchParams({q,sort:'latest',limit:String(limits.postsPerPage)});
      if(window.since!=null)params.set('since',window.since);
      if(window.until!=null)params.set('until',window.until);
      if(cursor)params.set('cursor',cursor);
      const url=sourceURL(endpoint+'?'+params);
      try {
        requests++;
        const response=await read(url,budget);pages.push({q,page,url,response});query.pages++;
        if(sourceURL(response.url)!==url||response.status!=null&&(response.status<200||response.status>=300)||!/json/i.test(response.headers?.['content-type']??''))
          throw new Error('Unexpected discovery destination/status/format');
        const data=JSON.parse(response.body);
        if(!Array.isArray(data.posts)||data.posts.length>limits.postsPerPage||data.cursor!=null&&(typeof data.cursor!=='string'||!data.cursor))
          throw new Error('Invalid discovery posts/pagination');
        for(const [position,post] of data.posts.entries()) {
          const provenance={q,page,position,search_url:url};
          try {
            if(typeof post?.cid!=='string'||!/^baf[a-z2-7]+$/.test(post.cid)||!post.author?.did)
              throw new Error('Invalid discovery CID/author identity');
            const document=prepareAuthorItem({post},{actor:post.author.handle,sourceURL});
            document.prepared.version=PREPARATION_VERSION;document.prepared.input='search-post';
            document.cid=post.cid;document.provenance=[provenance];
            const variants=posts.get(document.id)??[];
            const identical=variants.find(v=>v.cid===document.cid&&v.raw===document.raw);
            if(identical)identical.provenance.push(provenance);
            else variants.push(document);
            posts.set(document.id,variants);
          }catch(error){coverage.push({...provenance,state:'failed',reason:error.message});}
        }
        cursor=data.cursor;
        if(history||!retained?.cursor)next.queries[q]={cursor,since:window.since,until:window.until};
        if(!cursor){Object.assign(query,{state:data.posts.length?'exhausted':'empty',reason:'Returned page only; search exhaustiveness is unproven'});break;}
        if(cursors.has(cursor))throw new Error('Repeated discovery cursor');
        cursors.add(cursor);
        Object.assign(query,{state:'bounded',cursor,reason:'Query page bound reached; cursor access/full search coverage unproven'});
      }catch(error){
        Object.assign(query,{state:'failed',cursor,reason:error.message});
        if(error.quota||now()>=budget.deadline)blocked=error.message;
        break;
      }
    }
  }
  const documents=[...posts.entries()].map(([id,variants])=>{
    if(variants.length===1)return {...variants[0],state:'retained'};
    coverage.push({id,state:'conflict',reason:'One URI returned differing CIDs or payloads; all variants retained, processing deferred'});
    return {id,url:variants[0].url,state:'conflict',variants};
  });
  coverage.push(...queries.map(query=>({...query,relationship:'search'})),
    {relationship:'discovery',state:'partial',reason:'Four configured query surfaces only; empty/exhausted pages do not establish all relevant posts'},
    {relationship:'support',state:'unfetched',reason:'Support destinations, complete quoted posts/threads and media bytes are not fetched by this adapter'});
  return {documents,pages,queries,coverage,complete:false,requests,limits,progress:next,window:{since:since??null,until:until??null}};
}
