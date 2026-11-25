import {sourceLink} from '../../shared/records.js';
import {checkContentFreshness} from '../freshness.js';

export async function discoverSearch(tracker,{search,signal}){
 const result=await search(tracker.search_query,{topic:tracker.search_topic,signal});
 const urls=result.urls.map(sourceLink);
 if(urls.some(url=>!url))throw Object.assign(new Error('source_invalid'),{reason:'source_invalid'});
 const distinct=[...new Set(urls)].sort();
 const {fingerprint}=checkContentFreshness({media_type:'application/json',content:distinct},tracker.discovery_fingerprint);
 // Result membership never establishes freshness of the linked resources.
 return {native:false,retainMissing:true,items:distinct.map(url=>({key:url,url,version:null,source_kind:'web'})),
  source:{request_url:null,checked_at:null,fingerprint}};
}
