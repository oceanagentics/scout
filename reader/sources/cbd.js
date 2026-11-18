import {readable} from '../url.js';
export function cbdRequest(value){
 const url=new URL(value),match=url.hostname==='www.cbd.int'&&url.pathname.match(/^\/conferences\/(\d{4})\/parallel-meetings(?:\/([^/]+))?\/?$/);
 if(!match)return null;
 const endpoint=new URL('https://www.cbd.int/api/v2017/articles');
 endpoint.searchParams.set('q',JSON.stringify({adminTags:{$all:['conferences',match[1],'parallel-meetings',match[2]??'introduction']}}));
 return endpoint.href;
}
export function prepareCBD(source,publicURL){
 if(source.unchanged)return {...source,url:publicURL};
 if(!Array.isArray(source.content))throw Object.assign(new Error('source_invalid'),{reason:'source_invalid'});
 const content=source.content.map(a=>({title:a.title?.en??'',content:readable(a.content?.en??'',publicURL)})).filter(a=>a.content);
 if(!content.length)throw Object.assign(new Error('source_unavailable'),{reason:'source_unavailable'});
 return {...source,url:publicURL,content};
}
