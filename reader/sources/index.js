import {discoverBluesky,isBluesky} from './bluesky.js';
import {rssItems} from './rss.js';
import {webItems} from './web.js';
import {cbdRequest,prepareCBD} from './cbd.js';
export {isBluesky};
export async function discoverSource(tracker,options){
 if(isBluesky(tracker.url))return {native:true,items:await discoverBluesky(tracker,options)};
 const requestURL=cbdRequest(tracker.url)??tracker.url;
 const source=await options.readUrl(requestURL,{lastSuccessfulCheck:tracker.discovery_checked_at,previousRequestURL:tracker.discovery_request_url});
 if(source.unchanged)return {native:false,unchanged:true,items:[],source};
 const prepared=cbdRequest(tracker.url)?prepareCBD(source,tracker.url):source;
 const rss=prepared.media_type?.includes('xml')&&/<(?:rss|feed)\b/.test(prepared.content??'');
 const discovered=rss?{items:rssItems(prepared)}:await webItems(prepared,tracker.url,options);
 return {native:false,...discovered,source};
}
