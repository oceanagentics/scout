import {sourceLink} from '../../shared/records.js';
const instruction=`This tracker is configured as an index of developments: publication entries, events, calls, opportunities, or forms. Identify its individual entries and return their observed public detail URLs and available text or summaries. The supplied index is not itself an item. Use read_url to open relevant linked collections, including newsletters and programmes, and return their individual entry URLs, including PDFs, instead of the collection URL. Do not read individual entries during discovery when their URLs and titles are already available in the listing. Copy URLs verbatim from the supplied content or pages read with read_url, preserving path and query case, encoding and punctuation. Do not lowercase, normalize, reconstruct or correct URLs. Exclude navigation, cookie controls, unrelated links and alternate XML/PDF/print exports of the index itself. Do not decide Scout relevance, investigate developments, search saved records or return findings. Never invent a URL, identifier or date. Return useful observed entries even if some details are unavailable.`;
const schema={type:'object',properties:{items:{type:'array',items:{type:'object',properties:{url:{type:'string'},summary:{type:'string'}},required:['url','summary'],additionalProperties:false}}},required:['items'],additionalProperties:false};
export async function webItems(source,publicURL,{modelFor,deadline,readUrl}){
 if(!Object.hasOwn(source,'content'))return {items:[{key:publicURL,url:publicURL,version:null,source_kind:'web',content:source}],excluded:0};
 if(typeof source.content==='string'&&!/\]\(https?:\/\//.test(source.content))return {items:[],excluded:0};
 const observed=[JSON.stringify(source.content)];
 const read=async(...args)=>{const page=await readUrl(...args);if(Object.hasOwn(page,'content'))observed.push(JSON.stringify(page.content));return page;};
 const answer=await modelFor({url:publicURL,source_kind:'web'},{deadline,readUrl:read})(instruction,{url:publicURL,content:source},schema);
 if(!Array.isArray(answer.items))throw Object.assign(new Error('invalid_output'),{reason:'invalid_output'});
 const seen=new Set([sourceLink(publicURL)]);let excluded=0;
 const items=answer.items.flatMap(entry=>{
  const url=sourceLink(entry?.url);
  if(url&&seen.has(url))return [];
  if(!url||(url!==publicURL&&!observed.some(content=>content.includes(url)))||typeof entry.summary!=='string'){excluded++;return [];}
  seen.add(url);return [{key:url,url,version:null,source_kind:'web',content:{url:source.url,media_type:'text/plain',content:entry.summary}}];
 });
 return {items,excluded};
}
