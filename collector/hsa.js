import { collectDocuments } from './octo-documents.js';
import {sourceURL} from './source-url.js';
import { retrieveAuthorDocuments } from './bluesky-documents.js';
import { retrieveDiscoveryDocuments } from './bluesky-discovery-documents.js';
import { retrieveGFWDocuments, retrievePublisherDocuments, PUBLISHER_SOURCES } from './publisher-documents.js';
import { retrieveCbdDocuments } from './cbd-documents.js';
import { retrieveIUCNDocuments } from './iucn-documents.js';
import { retrieveDosiDocuments } from './dosi-documents.js';
import { retrieveIDDRIDocuments } from './iddri-documents.js';
import { retrieveHarvestDocuments } from './harvest-documents.js';
import { retrieveHubDocuments } from './hub-documents.js';
import { retrieveHSAWebDocuments } from './hsa-web-documents.js';
import { retrieveDoalosDocuments } from './doalos-documents.js';
import { retrieveUnSideDocuments } from './un-side-documents.js';
import { retrieveSymposiumDocuments } from './symposium-documents.js';
import { retrieveBlueMarineDocuments } from './bluemarine-documents.js';
import { retrieveGOFDocuments } from './gof-documents.js';
import { retrieveOceanCareDocuments } from './oceancare-documents.js';
import { retrieveRiseupDocuments } from './riseup-documents.js';
import { retrieveUntcDocuments } from './untc-documents.js';
import { Buffer } from 'node:buffer';
import { Agent, request } from 'undici';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';

export const HSA = 'highseasalliance.bsky.social';
export const HSA_WEB = 'https://highseasalliance.org/';
export const IDDRI = 'https://www.iddri.org/en/publications-and-events/high-seas?page=0';
export const DOSI_WEB = 'https://www.dosi-project.org/biodiversity-beyond-national-jurisdiction-bbnj/';
export const GFW_WEB = 'https://globalfishingwatch.org/mediacenter/';
export const IUCN = 'https://iucn.org/our-work/topic/high-seas';
export const GOF = 'https://globaloceanforum.com/';
export const OCEANCARE = 'https://www.oceancare.org/en/';
export const HARVEST = 'https://harveststrategies.org/abnj/';
export const RISE_UP = 'https://riseupfortheocean.org/latest/rise-up-navigator/';
export const BLUE_MARINE = 'https://www.bluemarinefoundation.com/our-events/';
export const SYMPOSIUM = 'https://bbnjsymposium.org/';
export const CBD_REGISTRY = 'https://www.cbd.int/side-events/';
export const OCTO = 'https://octogroup.org/webinars/';
export const EXPLORERS = 'https://www.explorers.org/calendar-of-events/';
export const UNTC = 'https://treaties.un.org/Pages/ViewDetails.aspx?src=TREATY&mtdsg_no=XXI-10&chapter=21&clang=_en';
export const DOALOS = 'https://www.un.org/bbnjagreement/en';
export const UN_SIDE_EVENTS = DOALOS+'/capacity-building-and-technical-assistance/side-events';
export const DOCUMENT_TRACKERS = [
  ...[HSA,'deepstewardship.bsky.social','globalfishingwatch.org','iddri.bsky.social'].map(actor=>({collector:'bluesky_feed',url:'https://bsky.app/profile/'+actor})),
  {collector:'bluesky_search',url:'https://bsky.app/search?q=BBNJ'},
  ...[OCTO,GFW_WEB,IUCN,DOSI_WEB,IDDRI,HARVEST,"https://www.hubocean.earth/events-calendar",HSA_WEB,DOALOS,UN_SIDE_EVENTS,SYMPOSIUM,BLUE_MARINE,GOF,OCEANCARE,RISE_UP,UNTC,CBD_REGISTRY,...PUBLISHER_SOURCES.map(p=>p.url)]
    .map(url=>({collector:'web',url})),
];
export const USER_AGENT = 'BBNJ-Scout-Bot/1.0 (+https://bbnj-scout.web.app)';
export const LIMITS = { feedPages: 2, postsPerPage: 25, pages: 6, redirects: 3, requests: 24, bytes: 524288, seconds: 120 };

function publicAddress(address) {
  if (isIP(address) === 6) return !/^(?:fc|fd|fe[89ab]|::)/i.test(address);
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
}

export {sourceURL};

// Validate DNS at connection time, including each redirect; never fetch local services.
export async function readPublic(url, budget, redirects = 0) {
  url = sourceURL(url);
  if (++budget.requests > LIMITS.requests || Date.now() > budget.deadline) throw new Error('Request/time limit reached');
  const byteLimit=budget.support?LIMITS.bytes*4:LIMITS.bytes;
  const agent = new Agent({ connect: {
      lookup(host, options, callback) {
        lookup(host, { all: true }, (error, addresses) => {
          if (error) return callback(error);
          if (!addresses.length || addresses.some(item => !publicAddress(item.address))) return callback(new Error('Non-public source address'));
          callback(null, options.all ? addresses : addresses[0].address, options.all ? undefined : addresses[0].family);
        });
      },
    }, maxResponseSize: byteLimit, connections: 1, pipelining: 0 });
  let result;
  try {
    const response = await request(url, {
      dispatcher: agent, method: 'GET', maxRedirections: 0,
      signal: AbortSignal.timeout(Math.max(1, Math.min(12000, budget.deadline - Date.now()))),
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/html;q=0.9', 'Accept-Encoding': 'identity' },
    });
    let size = 0;
    const chunks = [];
    // A redirect is defined by its headers; an incomplete shortener body must
    // not hide the observed destination. The next hop repeats all safeguards.
    if(response.statusCode>=300&&response.statusCode<400&&response.headers.location){response.body.on('error',()=>{});response.body.destroy();}
    else for await (const chunk of response.body) {
      size += chunk.length;
      if (size > byteLimit) throw new Error('Source exceeds byte limit');
      chunks.push(chunk);
    }
    const encoding=budget.support&&/^application\/pdf\b/i.test(response.headers['content-type']??'')?'base64':'utf8';
    result = { status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString(encoding), url, ...encoding==='base64'?{encoding}:{} };
  } finally { await agent.destroy(); }
  if (result.status >= 300 && result.status < 400 && result.headers.location) {
    if (redirects >= LIMITS.redirects) throw new Error('Redirect limit reached');
    return readPublic(new URL(result.headers.location, url).href, budget, redirects + 1);
  }
  if (result.status !== 200) {
    const error = new Error(`Source returned HTTP ${result.status}`);
    error.quota = result.status === 429;
    error.response=result;
    if(result.status===429||result.status>=500){const header=result.headers['retry-after'],at=Number(header)>0?Date.now()+Number(header)*1000:Date.parse(header);
      error.deferred={reason:result.status===429?'provider':'network',retry_at:new Date(Math.max(at||0,Date.now()+60000)).toISOString()};}
    throw error;
  }
  return result;
}

export async function collectHSA(db, { since = new Date(Date.now() - 30 * 86400000).toISOString(), read = readPublic, now = () => new Date().toISOString(), deadline = Date.now() + LIMITS.seconds * 1000, model, makeModel, sourceId = null, trackerId = null, validate = false, assessOnly = false, documents = false, documentVersion, rotation = false, runId } = {}) {
  if (!Number.isFinite(Date.parse(since))) throw new Error('A valid coverage start is required');
  if (validate !== false && (validate !== true || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(trackerId ?? ''))) {
    throw Object.assign(new Error('Validation requires an explicit tracker UUID'), { status: 400 });
  }
  if (assessOnly !== false && (assessOnly !== true || !validate || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(sourceId ?? ''))) {
    throw Object.assign(new Error('Stored assessment requires validation and an explicit source UUID'), { status: 400 });
  }
  const tracker = (await db.query("select * from scout.trackers where id=$1 or ($1::uuid is null and seed_key='bbnj-trackers-2026-10-01:17')",[trackerId])).rows[0];
  if (!tracker || (!validate && !tracker.enabled)) throw Object.assign(new Error('Tracker is missing or its collector is not yet proven'), { status: 400 });
  const actor=tracker.collector==='bluesky_feed' && tracker.url?.match(/^https:\/\/bsky\.app\/profile\/([a-z0-9.-]+)$/)?.[1];
  const hub=tracker.collector==='web' && tracker.url==='https://www.hubocean.earth/events-calendar';
  const untc=tracker.collector==='web' && tracker.url===UNTC;
  const doalos=tracker.collector==='web' && tracker.url===DOALOS;
  const sideEvents=tracker.collector==='web' && tracker.url===UN_SIDE_EVENTS;
  const hsaWeb=tracker.collector==='web' && tracker.url===HSA_WEB;
  const iddri=tracker.collector==='web' && tracker.url===IDDRI;
  const dosiWeb=tracker.collector==='web' && tracker.url===DOSI_WEB;
  const gfw=tracker.collector==='web' && tracker.url===GFW_WEB;
  const iucn=tracker.collector==='web' && tracker.url===IUCN;
  const gof=tracker.collector==='web' && tracker.url===GOF;
  const oceancare=tracker.collector==='web' && tracker.url===OCEANCARE;
  const harvest=tracker.collector==='web' && tracker.url===HARVEST;
  const riseup=tracker.collector==='web' && tracker.url===RISE_UP;
  const blueMarine=tracker.collector==='web' && tracker.url===BLUE_MARINE;
  const symposium=tracker.collector==='web' && tracker.url===SYMPOSIUM;
  const cbd=tracker.collector==='web' && tracker.url===CBD_REGISTRY;
  const publisher=tracker.collector==='web' && PUBLISHER_SOURCES.some(p=>p.url===tracker.url);
  const octo=tracker.collector==='web' && tracker.url===OCTO;
  const discovery=tracker.collector==='bluesky_search' && tracker.url==='https://bsky.app/search?q=BBNJ';
  if(documents!==false){
    const author=[HSA,'deepstewardship.bsky.social','globalfishingwatch.org','iddri.bsky.social'].includes(actor);
    if(![true,'process'].includes(documents)||!(octo||author||gfw||discovery||iucn||dosiWeb||iddri||harvest||hub||hsaWeb||doalos||sideEvents||symposium||blueMarine||gof||oceancare||riseup||untc||cbd||publisher)||(!validate&&!rotation)||rotation&&!tracker.enabled||assessOnly||sourceId)throw Object.assign(new Error('Document processing requires explicit supported tracker validation without assessment/source selection'),{status:400});
    return collectDocuments(db,{tracker,read,sourceURL,now,since,deadline,limits:LIMITS,process:documents==='process',model,makeModel,documentVersion,rotation,runId,
      path:publisher?'publisher':cbd?'cbd':untc?'untc':octo?'octo':author?'author':gfw?'gfw':discovery?'discovery':iucn?'iucn':dosiWeb?'dosi':iddri?'iddri':hub?'hub':hsaWeb?'hsa':doalos?'doalos':sideEvents?'un-side':symposium?'symposium':blueMarine?'bluemarine':gof?'gof':oceancare?'oceancare':riseup?'riseup':'harvest',
      retrieve:publisher?retrievePublisherDocuments:cbd?options=>retrieveCbdDocuments({...options,priorityMeetings:['69a875b3475867d4716ad6bc']}):untc?retrieveUntcDocuments:author?retrieveAuthorDocuments:gfw?retrieveGFWDocuments:discovery?retrieveDiscoveryDocuments:iucn?retrieveIUCNDocuments:dosiWeb?retrieveDosiDocuments:iddri?retrieveIDDRIDocuments:harvest?retrieveHarvestDocuments:hub?retrieveHubDocuments:hsaWeb?retrieveHSAWebDocuments:doalos?retrieveDoalosDocuments:sideEvents?retrieveUnSideDocuments:symposium?retrieveSymposiumDocuments:blueMarine?retrieveBlueMarineDocuments:gof?retrieveGOFDocuments:oceancare?retrieveOceanCareDocuments:riseup?retrieveRiseupDocuments:undefined});
  }
  throw Object.assign(new Error('Use the supported document workflow'),{status:400});
}
