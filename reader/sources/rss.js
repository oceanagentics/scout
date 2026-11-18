import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {createHash} from 'node:crypto';
import {sourceLink} from '../../shared/records.js';
const list=value=>value==null?[]:Array.isArray(value)?value:[value];
const text=value=>typeof value==='object'&&value!==null?value['#text']??'':String(value??'');
export function rssItems(source){
 if(XMLValidator.validate(source.content)!==true)throw Object.assign(new Error('source_invalid'),{reason:'source_invalid'});
 const data=new XMLParser({ignoreAttributes:false,parseTagValue:false,trimValues:true}).parse(source.content);
 const entries=data.rss?.channel?.item??data.feed?.entry??[];
 return list(entries).flatMap(entry=>{
  const link=typeof entry.link==='string'?entry.link:list(entry.link).find(l=>!l['@_rel']||l['@_rel']==='alternate')?.['@_href'];
  const url=sourceLink(link);if(!url)return [];
  const key=text(entry.guid??entry.id)||url;
  const content={title:text(entry.title),summary:text(entry.description??entry.summary),content:text(entry['content:encoded']??entry.content),published:text(entry.pubDate??entry.published),updated:text(entry.updated)};
  const parsed=Date.parse(content.published);
  return [{key,url,published_at:Number.isFinite(parsed)?new Date(parsed).toISOString():null,version:createHash('sha256').update(JSON.stringify({key,url,...content})).digest('hex'),source_kind:'web',
   content:{url:source.url,media_type:source.media_type,content}}];
 });
}
