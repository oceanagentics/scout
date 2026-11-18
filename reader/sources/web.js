import {sourceLink} from '../../shared/records.js';
const instruction=`Identify the publication entries on this supplied page. Return their observed public detail URLs and available text or summaries. Copy URLs verbatim from the supplied content, preserving path and query case, encoding and punctuation. Do not lowercase, normalize, reconstruct or correct URLs. Exclude navigation, cookie controls and unrelated links. Do not decide Scout relevance, investigate developments, search saved records or return findings. Never invent a URL, identifier or date. Use the supplied URL as one item only if the page itself is an individual publication or its developments have no separate addressable pages. Return useful observed entries even if some details are unavailable.`;
const schema={type:'object',properties:{items:{type:'array',items:{type:'object',properties:{url:{type:'string'},summary:{type:'string'}},required:['url','summary'],additionalProperties:false}}},required:['items'],additionalProperties:false};
export async function webItems(source,publicURL,{modelFor,deadline,readUrl}){
 if(!Object.hasOwn(source,'content')||typeof source.content==='string'&&!/\]\(https?:\/\//.test(source.content))return {items:[{key:publicURL,url:publicURL,version:null,source_kind:'web',content:source}],excluded:0};
 const answer=await modelFor({url:publicURL,source_kind:'web'},{deadline,readUrl})(instruction,{url:publicURL,content:source},schema);
 if(!Array.isArray(answer.items))throw Object.assign(new Error('invalid_output'),{reason:'invalid_output'});
 const observed=JSON.stringify(source.content),seen=new Set();let excluded=0;
 const items=answer.items.flatMap(entry=>{
  const url=sourceLink(entry?.url);
  if(url&&seen.has(url))return [];
  if(!url||(url!==publicURL&&!observed.includes(url))||typeof entry.summary!=='string'){excluded++;return [];}
  seen.add(url);return [{key:url,url,version:null,source_kind:'web',content:{url:source.url,media_type:'text/plain',content:entry.summary}}];
 });
 return {items,excluded};
}
