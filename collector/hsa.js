import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { Agent, request } from 'undici';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { observe, assessmentInput, validateDecision, INSTRUCTION, SCHEMA, CONTENT_FIELDS, normalize, fingerprint, visibleText, dosiArticle, doalosArticle, ASSESSMENT_VERSION } from './assessment.js';

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
export const USER_AGENT = 'BBNJ-Scout-Bot/1.0 (+https://bbnj-scout.web.app)';
export const LIMITS = { feedPages: 2, postsPerPage: 25, pages: 6, redirects: 3, requests: 24, bytes: 524288, seconds: 120 };
const hash = value => createHash('sha256').update(value).digest('hex');
const normalized = value => value.normalize('NFKC').replace(/\s+/g, ' ').trim();
const eventPost = text => /webinar|register|registration|rescheduled|cancelled|canceled/i.test(text) && !/expression.?s? of interest|call for (?:proposals|EOI)/i.test(text);

function publicAddress(address) {
  if (isIP(address) === 6) return !/^(?:fc|fd|fe[89ab]|::)/i.test(address);
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
}

export function sourceURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Unsupported source URL');
  if (isIP(url.hostname.replaceAll(/[\[\]]/g, '')) || !url.hostname.includes('.')) throw new Error('Source must use a public hostname');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.href;
}

// Validate DNS at connection time, including each redirect; never fetch local services.
export async function readPublic(url, budget, redirects = 0) {
  url = sourceURL(url);
  if (++budget.requests > LIMITS.requests || Date.now() > budget.deadline) throw new Error('Request/time limit reached');
  const agent = new Agent({ connect: {
      lookup(host, options, callback) {
        lookup(host, { all: true }, (error, addresses) => {
          if (error) return callback(error);
          if (!addresses.length || addresses.some(item => !publicAddress(item.address))) return callback(new Error('Non-public source address'));
          callback(null, options.all ? addresses : addresses[0].address, options.all ? undefined : addresses[0].family);
        });
      },
    }, maxResponseSize: LIMITS.bytes, connections: 1, pipelining: 0 });
  let result;
  try {
    const response = await request(url, {
      dispatcher: agent, method: 'GET', maxRedirections: 0,
      signal: AbortSignal.timeout(Math.max(1, Math.min(12000, budget.deadline - Date.now()))),
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/html;q=0.9', 'Accept-Encoding': 'identity' },
    });
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > LIMITS.bytes) throw new Error('Source exceeds byte limit');
      chunks.push(chunk);
    }
    result = { status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8'), url };
  } finally { await agent.destroy(); }
  if (result.status >= 300 && result.status < 400 && result.headers.location) {
    if (redirects >= LIMITS.redirects) throw new Error('Redirect limit reached');
    return readPublic(new URL(result.headers.location, url).href, budget, redirects + 1);
  }
  if (result.status !== 200) {
    const error = new Error(`Source returned HTTP ${result.status}`);
    error.quota = result.status === 429;
    throw error;
  }
  return result;
}

function dates(start, end) {
  const result = { start_on: null, end_on: null, starts_at: null, ends_at: null, time_zone: null };
  const day = value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  const instant = value => /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value ?? '') && day(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
  if (day(start)) {
    result.start_on = start;
    if (day(end) && end >= start) result.end_on = end;
  } else if (instant(start)) {
    result.starts_at = new Date(start).toISOString();
    result.time_zone = start.endsWith('Z') ? 'UTC' : start.slice(-6);
    if (instant(end) && Date.parse(end) >= Date.parse(start)) result.ends_at = new Date(end).toISOString();
  }
  return result;
}

function postDates(text) {
  if (/deadline|register by|registration closes|submission/i.test(text)) return dates();
  const iso = text.match(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2}))?\b/g) ?? [];
  // Several dates may be old/new dates or deadlines: do not choose one by guessing.
  if (iso.length === 1) return dates(iso[0]);
  return dates();
}

function links(post) {
  const values = (post.record.facets ?? []).flatMap(facet => facet.features ?? []).filter(feature => feature.$type === 'app.bsky.richtext.facet#link').map(feature => feature.uri);
  if (post.embed?.external?.uri) values.push(post.embed.external.uri);
  return [...new Set(values.map(value => { try { return sourceURL(value); } catch { return null; } }).filter(Boolean))].sort();
}

function postRecord(post, urls) {
  const text = post.record.text;
  const kind = eventPost(text) ? 'event' : 'announcement';
  const eventURL = urls.find(url => /webinar\/register|\/events?\/|\/webinars?\/|registration/i.test(new URL(url).pathname));
  const registration = urls.find(url => /register|registration/i.test(new URL(url).pathname));
  // Narrow observed HSA format: the year must come from the same event's page.
  const times = [...text.matchAll(/\b(\d{1,2}) Sept?, (\d{1,2}):([0-5]\d) (AM|PM) EDT\b/g)];
  const time = post.author.handle === HSA && times.length === 1 ? times[0] : null;
  return {
    kind, title: text.split('\n').find(line => line.trim())?.trim() || text,
    organization: post.author.handle === HSA ? 'High Seas Alliance' : post.author.displayName || post.author.handle,
    description: text,
    ...dates(), ...(kind === 'event' ? postDates(text) : {}),
    location: null, event_url: kind === 'event' ? eventURL ?? null : null,
    registration_url: kind === 'event' ? registration ?? null : null,
    date_parts: time && +time[2] >= 1 && +time[2] <= 12 ? { month: 9, day: +time[1],
      hour: +time[2] % 12 + (time[4] === 'PM' ? 12 : 0), minute: +time[3], zone: 'EDT', offset: '-04:00' } : null,
    status: kind === 'event' && /\bcancell?ed\b/i.test(text) ? 'cancelled' : kind === 'event' && /\brescheduled\b/i.test(text) ? 'rescheduled' : null,
  };
}

function structuredEvents(html, pageURL) {
  const events = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(visit);
    if ([value['@type']].flat().includes('Event') && typeof value.name === 'string') events.push(value);
    if (value['@graph']) visit(value['@graph']);
  }
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(match[1])); } catch { /* A malformed block supplies no facts. */ }
  }
  // A listing page cannot identify which of several events the post referred to.
  if (!events.length && /(^|\.)zoom\.us$/.test(new URL(pageURL).hostname) && new URL(pageURL).pathname.startsWith('/webinar/register/')) {
    // Read Zoom's public registration metadata as data; never evaluate its scripts.
    const schedule = html.match(/\bscheduleTime:\s*(\[[^\]\n]*\])/);
    const topic = html.match(/\btopic:\s*'((?:\\.|[^'\\])*)'/);
    const description = html.match(/\bdesc:\s*'((?:\\.|[^'\\])*)'/);
    const decode = value => value.replace(/\\(['\\nrt])/g, (_, char) => ({ n: '\n', r: '\r', t: '\t' })[char] ?? char);
    if (schedule && topic) {
      let times;
      try { times = JSON.parse(schedule[1]); } catch { return null; }
      if (times.length !== 1) return null;
      const date = times[0].match(/^([A-Z][a-z]{2}) (\d{1,2}), (\d{4}) (0[1-9]|1[0-2]):([0-5]\d) (AM|PM)$/);
      const month = date && ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(date[1]) + 1;
      if (!month) return null;
      const parsedDate = dates(`${date[3]}-${String(month).padStart(2, '0')}-${date[2].padStart(2, '0')}`);
      if (!parsedDate.start_on) return null;
      const detail = description ? decode(description[1]) : '';
      return { kind: 'event', title: decode(topic[1]), organization: null,
        description: detail || null, ...parsedDate, location: null,
        local_schedule: { date: parsedDate.start_on, month, day: +date[2],
          hour: +date[4] % 12 + (date[6] === 'PM' ? 12 : 0), minute: +date[5] },
        event_url: pageURL, registration_url: pageURL, status: null,
        limitation: 'Registration page supplies a local time without a time zone; only its calendar date is stored',
      };
    }
  }
  if (events.length !== 1) return null;
  const event = events[0];
  const safe = value => { try { return sourceURL(value); } catch { return null; } };
  const organizer = typeof event.organizer?.name === 'string' ? event.organizer.name : null;
  const location = typeof event.location === 'string' ? event.location : event.location?.name ?? null;
  const parsedDate = dates(event.startDate, event.endDate);
  return {
    kind: 'event', title: event.name, organization: organizer,
    description: typeof event.description === 'string' ? event.description.replace(/<[^>]*>/g, ' ').trim() : null,
    ...parsedDate, location: typeof location === 'string' ? location : null,
    event_url: safe(event.url) ?? pageURL,
    registration_url: safe(event.offers?.url),
    status: ({ EventCancelled: 'cancelled', EventRescheduled: 'rescheduled', EventScheduled: 'scheduled' })[event.eventStatus?.split('/').pop()] ?? null,
    limitation: event.startDate && !parsedDate.start_on && !parsedDate.starts_at ? 'Structured event date is unsupported or lacks a time zone' : null,
  };
}

const fields = [...CONTENT_FIELDS, 'date_evidence', 'priority'];
// Observed DOSI Mailchimp caption/button layout. The observed button URL keys
// an item within its issue; it does not automatically identify an event page.
function dosiNewsletter(html, url) {
  if (!/^https:\/\/mailchi\.mp\/soton\.ac\.uk\/dosi-deep-sea-roundup-\d{2}-\d{2}-\d{4}$/.test(url)) throw new Error('Unsupported DOSI newsletter URL');
  const blocks=[...html.matchAll(/<table\b[^>]*class="mcnCaptionBlock"[^>]*>/gi)].map(m=>m.index);
  const items=[],seen=new Set();let unsupported=0;
  for (let i=0;i<blocks.length;i++) {
    const block=html.slice(blocks[i],blocks[i+1]??html.length);
    const cell=block.match(/<td\b[^>]*class="mcnTextContent"[^>]*>([\s\S]*?)<\/td>/i);
    const title=cell?.[1].match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i);
    const button=block.match(/<a\b[^>]*class="mcnButton\s*"[^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a>/i);
    if (!title || !button) continue;
    let link;try{link=sourceURL(button[1].replaceAll('&amp;','&'));}catch{unsupported++;continue;}
    if (seen.has(link)) throw new Error('Ambiguous DOSI newsletter item link; coverage incomplete');
    seen.add(link);
    const heading=visibleText(cell[1].match(/<h4\b[^>]*>([\s\S]*?)<\/h4>/i)?.[1]??'');
    const date=heading.match(/^(\d{1,2}) (January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})$/);
    const event=Boolean(heading && /\b(?:event|webinar|symposium|conference|session|seminar)\b/i.test(visibleText(cell[1])) && !/deadline/i.test(heading));
    const day=date && `${date[3]}-${String(['January','February','March','April','May','June','July','August','September','October','November','December'].indexOf(date[2])+1).padStart(2,'0')}-${date[1].padStart(2,'0')}`;
    const eventLink=event && /\/webinar\/register|\/events?\/|\/webinars?\//i.test(new URL(link).pathname);
    items.push({url,link,content:cell[0]+button[0],parsed:{kind:event?'event':'announcement',title:visibleText(title[1]),
      description:visibleText(cell[1].replace(/<h[34]\b[^>]*>[\s\S]*?<\/h[34]>/gi,' ')),organization:null,location:null,
      ...dates(event?day:null),event_url:eventLink?link:null,registration_url:eventLink&&/register/i.test(new URL(link).pathname)?link:null,status:null}});
  }
  if (!items.length) throw new Error('DOSI newsletter item layout unavailable; coverage incomplete');
  return {items,unsupported};
}

function treatyTable(html) {
  const fail=()=>{throw new Error('Incomplete or unsupported UN participant table/notes; previous status preserved');};
  const table=html.match(/<table\b[^>]*id="[^"]*_tblgrid"[^>]*>([\s\S]*?)<\/table>/i);
  const notesTable=html.match(/<table\b[^>]*id="[^"]*_dgNotesAll"[^>]*>([\s\S]*?)<\/table>/i);
  const counts=html.match(/Signatories\s*:\s*(\d+)\.\s*Parties\s*:\s*(\d+)/);
  if (!table || !notesTable || !counts || !/<\/html>\s*$/i.test(html) || !html.includes('Marine Biological Diversity of Areas beyond National Jurisdiction')) fail();
  const notes={};
  for (const match of notesTable[1].matchAll(/<div\b[^>]*id="[^"]*_divNotesAll"[^>]*>([\s\S]*?)<\/div>/gi)) {
    const anchor=match[1].match(/<a name=['"](\d+)['"]>\d+<\/a>/i);
    const text=visibleText(match[1].replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi,''));
    if (!anchor || !text || notes[anchor[1]]) fail();
    notes[anchor[1]]=text;
  }
  const rows=[...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  if (rows.length<2 || rows.length>251 || rows.length!==(table[1].match(/<tr\b/gi)??[]).length) fail();
  const header=visibleText(rows.shift()[1]);
  if (header!=='Participant Signature Ratification, Accession(a), Acceptance(A), Approval(AA)') fail();
  const parse=value=>{
    if (!value) return null;
    const m=value.match(/^(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4})(?: (AA|A|a))?$/);
    if (!m) fail();
    const on=dates(`${m[3]}-${String(['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(m[2])+1).padStart(2,'0')}-${m[1].padStart(2,'0')}`).start_on;
    if (!on) fail();
    return {date:on,symbol:m[4]??'',date_text:`${m[1]} ${m[2]} ${m[3]}`};
  };
  const participants=rows.map(row=>{
    const cells=[...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m=>m[1]);
    if (cells.length!==3) fail();
    const refs=[...cells[0].matchAll(/<sup\b[^>]*>([\s\S]*?)<\/sup>/gi)].flatMap(m=>visibleText(m[1]).split(/[,\s]+/));
    const country=visibleText(cells[0].replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi,''));
    const signature=parse(visibleText(cells[1])),action=parse(visibleText(cells[2]));
    if (!country || /&[^;\s]+;/.test(country) || refs.some(ref=>!notes[ref]) || signature?.symbol || !signature&&!action) fail();
    return {country,signature:signature?.date??null,...(action??{date:null,symbol:null,date_text:null}),
      action:action?({'':'ratification',a:'accession',A:'acceptance',AA:'approval'})[action.symbol]:null,note_refs:refs,content:row[0]};
  });
  if (new Set(participants.map(p=>p.country)).size!==participants.length || !+counts[1] || !+counts[2] ||
      participants.filter(p=>p.signature).length!==+counts[1] || participants.filter(p=>p.action).length!==+counts[2]) fail();
  return {participants,notes,signatories:+counts[1],parties:+counts[2],header};
}

function material(record) {
  const names = [...CONTENT_FIELDS, 'priority', 'start_on', 'end_on', 'time_zone'];
  const values = names.map(name => typeof record[name] === 'string' ? normalized(record[name]).toLowerCase() : record[name] ?? null);
  if (record.local_schedule) values.push(record.local_schedule);
  return hash(JSON.stringify(values));
}

async function save(db, identity, source, rank, observedAt, stats) {
  let record = source.parsed;
  let existing = (await db.query('select * from scout.records where identity_key=$1', [identity])).rows[0];
  if (existing) {
    for (const field of ['starts_at', 'ends_at']) if (existing[field] instanceof Date) existing[field] = existing[field].toISOString();
    const prior=source.parsed.source?.previous_id && (await db.query('select parsed from scout.evidence where id=$1',[source.parsed.source.previous_id])).rows[0]?.parsed;
    if (prior) {
      // A description edit cannot repeat an unchanged old schedule over a correction.
      record={...record};
      for (const field of [...CONTENT_FIELDS.filter(f=>f!=='kind'),'start_on','end_on','time_zone']) {
        if (['start_on','starts_at','ends_at','time_zone'].includes(field) && !isDeepStrictEqual(prior.local_schedule,record.local_schedule)) continue;
        if (isDeepStrictEqual(normalize(prior[field]),normalize(record[field]))) record[field]=null;
      }
    }
  }
  if (!record && !existing) return;
  // A shared capture belongs to each record independently. Reload ownership
  // because a cached page may already have been attached earlier in this run.
  source = (await db.query(`select * from scout.evidence where id=$1 or
    (record_id=$2 and tracker_id=$3 and url=$4 and content_hash=$5)
    order by (record_id=$2) desc nulls last limit 1`,
  [source.id, existing?.id ?? null, source.tracker_id, source.url, source.content_hash])).rows[0];
  if (source.record_id && source.record_id !== existing?.id) {
    source = (await db.query(`insert into scout.evidence (record_id,tracker_id,url,content_hash,content,published_at,collected_at,parsed,published_on)
      select $2,tracker_id,url,content_hash,content,published_at,collected_at,parsed,published_on from scout.evidence where id=$1
      on conflict (record_id,tracker_id,url,content_hash) do update set content_hash=excluded.content_hash returning *`,
    [source.id, existing?.id ?? null])).rows[0];
  }
  const references = existing ? (await db.query('select * from scout.current_evidence where record_id=$1', [existing.id])).rows : [];
  const previous = references.find(item => item.url === source.url);
  // Date-only values stay in captured sources, used here only to combine evidence.
  const established = existing?.date_evidence.schedule_source ? (await db.query('select url,parsed from scout.evidence where id=$1 and record_id=$2',
    [existing.date_evidence.schedule_source, existing.id])).rows[0] : null;
  const schedule = established?.parsed ??
    references.find(item => item.authoritative && (identity === `event:${item.url}` || existing?.event_url === item.url || existing?.registration_url === item.url))?.parsed ??
    references.find(item => item.parsed?.starts_at && item.parsed.starts_at === existing?.starts_at)?.parsed;
  let calendarDay = existing?.status !== 'rescheduled' || existing?.starts_at ? schedule?.start_on : null;
  // First page snapshots have unknown chronology. Only a change in their facts
  // starts a new evidence time, including a return to an older source version.
  const priorFacts = previous?.parsed ?? (established?.url === source.url ? established.parsed : null);
  const evidenceAt = source.parsed.source?.previous_id ? observedAt : source.published_at ?? (record && priorFacts && /^hsa-v[234]:/.test(previous?.content_hash) && material(priorFacts) !== material(record)
    ? observedAt : previous?.evidence_at ?? null);
  const baseline = !source.published_at && !evidenceAt;
  const accepted = record && (!existing || rank > existing.evidence_rank || (rank === existing.evidence_rank && (baseline || !existing.evidence_at || Date.parse(evidenceAt) >= Date.parse(existing.evidence_at))));
  const merged = Object.fromEntries(fields.map(field => [field, accepted ? record[field] ?? existing?.[field] ?? null : existing?.[field] ?? null]));
  merged.date_evidence ??= {};
  if (merged.description && Array.from(merged.description).length > 280) merged.description = Array.from(merged.description).slice(0, 279).join('').trimEnd() + '…';
  if (accepted) {
    for (const field of record.assessment?.clear_fields ?? []) merged[field] = null;
    if (baseline && existing?.evidence_rank === 2) merged.status = existing.status ?? record.status;
    // A newly evidenced date replaces the prior representation, including date-only/timed changes.
    const offset = schedule?.time_zone?.match(/^([+-])(\d{2}):(\d{2})$/);
    const localDay = existing?.starts_at && (offset || schedule?.time_zone === 'UTC') && new Date(Date.parse(existing.starts_at) +
      (offset ? (offset[1] === '+' ? 1 : -1) * (+offset[2] * 60 + +offset[3]) * 60000 : 0)).toISOString().slice(0, 10);
    const compatibleDay = record.start_on && existing?.starts_at && (schedule?.start_on ?? localDay) === record.start_on &&
      (!record.local_schedule || isDeepStrictEqual(schedule?.local_schedule, record.local_schedule));
    const protectsCorrection = baseline && existing?.evidence_rank === 2 && ['cancelled', 'rescheduled'].includes(existing.status);
    if ((record.start_on || record.starts_at) && !compatibleDay && !protectsCorrection) {
      calendarDay = record.start_on;
      for (const field of ['starts_at', 'ends_at']) merged[field] = record[field];
      merged.date_evidence = record.starts_at ? { schedule_source: source.id } : {};
    } else if (compatibleDay || protectsCorrection) {
      for (const field of ['starts_at', 'ends_at']) merged[field] = existing[field];
    }
    if (existing?.kind === 'event') {
      const before = existing.starts_at && new Date(existing.starts_at).toISOString();
      const after = record.start_on || record.starts_at;
      const comparable = existing.starts_at && record.starts_at;
      if (comparable && before !== after && merged.status !== 'cancelled') merged.status = 'rescheduled';
      if (existing.status === 'rescheduled' && merged.status === 'scheduled') merged.status = 'rescheduled';
      if (record.status === 'rescheduled' && !after) {
        calendarDay = null;
        for (const field of ['starts_at', 'ends_at']) merged[field] = null;
        merged.date_evidence = {};
      }
    }
  }
  // Combine only the observed Zoom schedule and matching HSA-authored components.
  const evidence = [...references.filter(item => item.url !== source.url), { ...source, authoritative: rank === 2 }];
  const page = evidence.find(item => item.parsed?.local_schedule && (identity === `event:${item.url}` || merged.event_url === item.url || merged.registration_url === item.url));
  let timing=[];
  if (page) {
    // A retained HSA post can supply compatible clock/zone facts without a
    // second relevance call. Only the latest capture of each source may do so.
    timing=(await db.query(`select * from (select distinct on(url) * from scout.evidence where tracker_id=$1
      order by url,coalesce((parsed#>>'{source,observed_at}')::timestamptz,collected_at) desc,last_seen_at desc nulls last,id) latest
      where parsed->>'event_url'=$2 and parsed#>>'{source,rank}'='2' and parsed->'date_parts' <> 'null'::jsonb
        and (record_id is null or record_id=$3)`,[source.tracker_id,page.url,existing?.id??null])).rows;
  }
  const post = timing.filter(item => item.published_at && item.parsed?.date_parts)
    .filter(item => new Date(item.published_at).getUTCFullYear() === Number(page.parsed.local_schedule.date.slice(0,4)))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
  let dateWarning = page ? page.parsed.limitation : null;
  if (page && post) {
    const schedule = page.parsed.local_schedule, parts = post.parsed.date_parts;
    const wall = value => `${String(value.hour).padStart(2, '0')}:${String(value.minute).padStart(2, '0')}`;
    if (['month', 'day', 'hour', 'minute'].every(key => schedule[key] === parts[key])) {
      if (calendarDay === schedule.date) {
        const timed = dates(`${schedule.date}T${wall(schedule)}:00${parts.offset}`);
        for (const field of ['starts_at', 'ends_at']) merged[field] = timed[field];
        merged.date_evidence = { schedule_source: page.id, zone_source: post.id };
        dateWarning = null;
      }
    } else dateWarning = `Conflicting event schedule: registration ${schedule.date} ${wall(schedule)}; HSA post ${parts.month}/${parts.day} ${wall(parts)} ${parts.zone}`;
  }
  if (accepted || (existing && material(merged) !== material(existing))) {
    const digest = material(merged);
    const recordEvidenceAt = accepted && !baseline ? evidenceAt : existing?.evidence_at ?? evidenceAt;
    const recordRank = accepted ? rank : existing.evidence_rank;
    if (!existing || digest !== material(existing)) {
      if (existing) {
        const changed = fields.filter(field => !isDeepStrictEqual(merged[field], existing[field]));
        const updates = [...changed, 'evidence_rank', 'evidence_at'];
        existing = (await db.query(`update scout.records set ${updates.map((field, index) => `${field}=$${index + 1}`).join(',')} where id=$${updates.length+1} returning *`, [...changed.map(field => merged[field]), recordRank, recordEvidenceAt, existing.id])).rows[0];
        stats.changed++;
      } else {
        existing = (await db.query(`insert into scout.records (${fields.join(',')},identity_key,evidence_rank,evidence_at) values (${Array.from({ length: fields.length+3 }, (_, i) => `$${i + 1}`).join(',')}) returning *`, [...fields.map(field => merged[field]), identity, recordRank, recordEvidenceAt])).rows[0];
        stats.created++;
      }
    } else {
      await db.query('update scout.records set evidence_rank=$1,evidence_at=$2 where id=$3', [recordRank, recordEvidenceAt, existing.id]);
    }
  }
  await db.query('update scout.evidence set record_id=$2,last_seen_at=clock_timestamp(),authoritative=$3,evidence_at=$4 where id=$1',
    [source.id, existing.id, rank === 2, evidenceAt]);
  if (post && merged.date_evidence.zone_source === post.id && !post.record_id) {
    await db.query('update scout.evidence set record_id=$2,authoritative=true where id=$1 and record_id is null',[post.id,existing.id]);
  }
  return {warning:dateWarning,recordId:existing.id,sourceId:source.id};
}

export async function collectHSA(db, { since = new Date(Date.now() - 30 * 86400000).toISOString(), read = readPublic, now = () => new Date().toISOString(), deadline = Date.now() + LIMITS.seconds * 1000, model, makeModel, sourceId = null, trackerId = null, validate = false, assessOnly = false } = {}) {
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
  const octo=tracker.collector==='web' && tracker.url===OCTO;
  const explorers=tracker.collector==='web' && tracker.url===EXPLORERS;
  const discovery=tracker.collector==='bluesky_search' && tracker.url==='https://bsky.app/search?q=BBNJ';
  if (!actor && !hub && !untc && !doalos && !sideEvents && !hsaWeb && !iddri && !dosiWeb && !gfw && !iucn && !gof && !oceancare && !harvest && !riseup && !blueMarine && !symposium && !cbd && !octo && !explorers && !discovery) throw Object.assign(new Error('Unsupported tracker configuration; review before collecting'), { status: 400 });
  const publisherHost=({[HSA]:'highseasalliance.org','deepstewardship.bsky.social':'dosi-project.org','globalfishingwatch.org':'globalfishingwatch.org','iddri.bsky.social':'iddri.org'})[actor];
  const started = now();
  if (!assessOnly && discovery && (Date.parse(since)>=Date.parse(started)||Date.parse(started)-Date.parse(since)>35*86400000)) throw Object.assign(new Error('Discovery requires a publication window of at most 35 days'),{status:400});
  const run = (await db.query('insert into scout.collection_runs (tracker_id,coverage_since,started_at,stats) values ($1,$2,$3,$4) returning id', [tracker.id, since, started, {...(validate ? { validation: true } : {}),...(assessOnly ? { assessment_only: true, source_id: sourceId } : {})}])).rows[0];
  const stats = { created: 0, changed: 0, posts: 0, pages: 0, candidates: 0, skipped: 0, assessed: 0, reused_uncertain: 0, warnings: [] };
  const budget = { requests: 0, deadline: Math.min(deadline, Date.now() + LIMITS.seconds * 1000) };
  model ??= makeModel?.(run.id,budget.deadline);
  const pages = new Map();
  const dateWarnings = new Map();
  let cursor, covered = false, quota = false, feedFailed = false;
  try {
    if (assessOnly) {
      stats.warnings.push('Stored evidence assessment only; source freshness and collection coverage were not checked');
    } else if (discovery) {
      const queries=['BBNJ','"High Seas Treaty"','"traité sur la haute mer"','BBNJCOP1'];
      const results=[],posts=new Map(),supports=new Map();
      // The public AppView is documented; the caching host denies search. Cursor
      // requests also returned 403, so this path deliberately takes one page/query.
      for (const q of queries) {
        const params=new URLSearchParams({q,sort:'latest',since:new Date(since).toISOString(),until:started,limit:'5'});
        try {
          const url='https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?'+params;
          const r=await read(url,budget);stats.pages++;
          if (sourceURL(r.url)!==sourceURL(url)) throw new Error('Unexpected search destination');
          const data=JSON.parse(r.body);
          if (!Array.isArray(data.posts)||data.posts.length>5) throw new Error('Unsupported search response');
          results.push({q,url:r.url,posts:data.posts});
          if (data.cursor) stats.warnings.push('Discovery one-page query bound reached; cursor access/full search coverage unproven');
        } catch(error) {quota ||= Boolean(error.quota);stats.warnings.push(`Search ${q}: ${error.message}`);if(quota)break;}
      }
      // Interleave queries so one language/topic cannot consume all support slots.
      for (let index=0;index<5;index++) for (const result of results) {
        const post=result.posts[index];if (!post) continue;
        const uri=post.uri?.match(/^at:\/\/(did:[^/]+)\/app\.bsky\.feed\.post\/([a-z0-9]+)$/);
        if (!uri || uri[1]!==post.author?.did || typeof post.author.handle!=='string' || typeof post.cid!=='string' || !/^baf[a-z2-7]+$/.test(post.cid) || post.record?.$type!=='app.bsky.feed.post' || typeof post.record.text!=='string' || !dates(post.record.createdAt).starts_at || !dates(post.indexedAt).starts_at) {
          stats.warnings.push('Skipped malformed discovery identity/record');continue;
        }
        // API since/until constrain sortAt, not necessarily createdAt. Retain both
        // timestamps, and independently bound publication time for this collector.
        if (Date.parse(post.record.createdAt)<Date.parse(since)||Date.parse(post.record.createdAt)>=Date.parse(started)) {stats.warnings.push('Discovery publication outside requested window');continue;}
        const old=posts.get(post.uri);
        if (old) {old.conflict ||= old.post.cid!==post.cid;old.queries.push({q:result.q,url:result.url});continue;}
        posts.set(post.uri,{post,url:`https://bsky.app/profile/${uri[1]}/post/${uri[2]}`,queries:[{q:result.q,url:result.url}],urls:links(post)});
      }
      const selected=[...posts.values()].filter(item=>!item.conflict);
      if (selected.length!==posts.size) stats.warnings.push('Conflicting search CIDs for one URI; capture deferred');
      // One explicit destination/post, six distinct supports/run, registration first.
      for (const item of [...selected].sort((a,b)=>Number(b.urls.some(u=>/\/register\//.test(u)))-Number(a.urls.some(u=>/\/register\//.test(u))))) {
        const url=item.urls.find(u=>/\/register\//.test(u))??item.post.embed?.external?.uri??item.urls[0];
        if (!url) continue;
        let link;try{link=sourceURL(url);}catch{continue;}item.link=link;
        if (supports.has(link)) continue;
        if (supports.size>=LIMITS.pages) {stats.warnings.push('Discovery supporting-page bound reached');continue;}
        supports.set(link,null);
        try {
          const r=await read(link,budget);stats.pages++;
          if (!/text\/html/i.test(r.headers['content-type']??'') || !/<\/html>(?:\s|<!--[\s\S]*?-->)*$/i.test(r.body)) throw new Error('Supporting page format/integrity unavailable');
          const parsed=structuredEvents(r.body,r.url);
          const body=r.body.match(/<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)>/i)?.[1]??r.body;
          supports.set(link,{url:r.url,body:r.body,text:visibleText(body.replace(/<!--[\s\S]*?-->/g,'')),parsed});
        } catch(error) {quota ||= Boolean(error.quota);stats.warnings.push(`Discovery support ${link}: ${error.message}`);}
      }
      for (const item of selected) {
        const {post,url,urls}=item,support=supports.get(item.link);
        const extracted=support?.parsed;
        const words=post.record.text.toLowerCase().match(/[\p{L}]{5,}/gu)??[];
        const verified=extracted && new Set(words.filter(w=>extracted.title.toLowerCase().includes(w)&&!['treaty','webinar','event','register','registration','conference'].includes(w))).size>=2;
        const scripted={...postRecord(post,[]),organization:null,...dates(),event_url:null,registration_url:null,status:null,date_parts:null};
        if (/\bside[- ]event\b/i.test(post.record.text) && /attending|join|invited|invitation/i.test(post.record.text)) scripted.kind='event';
        if (verified) Object.assign(scripted,extracted);
        scripted.discovery={event_verified:Boolean(verified),support:item.link?(support?'fetched':'unavailable_or_bounded'):'no_link',
          treaty_unverified:/ratif|accession|\b\d+\s+(?:parties|parti[es])\b|entr[ée]e? en vigueur/i.test([post.record.text,support?.text].filter(Boolean).join(' '))};
        const text=[post.record.text,support?.text,verified?extracted.description:null].filter(Boolean).join('\n');
        const source=await observe(db,tracker.id,url,JSON.stringify({text,post,urls,search:{queries:item.queries,since,until:started},support:support??null}),post.record.createdAt,scripted,
          {uri:post.uri,cid:post.cid,record:post.record,author:{did:post.author.did,handle:post.author.handle,displayName:post.author.displayName??null},urls,
            support:support?{url:support.url,text:support.text,structured:extracted}:null},
          {rank:0,identity:`post:${post.uri}`,uri:post.uri,cid:post.cid,queries:item.queries,links:urls.slice(0,10)},now());
        stats.posts++;stats[source.changed?'candidates':'skipped']++;pages.set(source.id,true);
        if (post.embed?.$type?.includes('record')) stats.warnings.push('Discovery quoted posts are not expanded');
      }
      stats.queries=results.length;
      covered=results.length===queries.length;
      feedFailed=!results.length;
      stats.warnings.push('Discovery covers four configured queries, five posts each and six supporting pages; no exhaustive search or publisher authority is implied');
    } else if (untc) {
      const response=await read(tracker.url,budget);stats.pages++;
      if (sourceURL(response.url)!==sourceURL(tracker.url)) throw new Error('Unexpected UN source destination; status preserved');
      const parsed=treatyTable(response.body);
      const facts={...parsed,participants:parsed.participants.map(({content,...row})=>row)};
      const previous=(await db.query(`select * from scout.evidence where tracker_id=$1 and parsed#>>'{source,item_key}'='baseline'
        and parsed#>>'{assessment,state}'='baseline' order by coalesce((parsed#>>'{source,observed_at}')::timestamptz,collected_at) desc,last_seen_at desc nulls last,id limit 1`,[tracker.id])).rows[0];
      if (previous?.parsed.participants.some(old=>!facts.participants.some(row=>row.country===old.country && (!old.action||row.action))) ||
          Object.keys(previous?.parsed.notes??{}).some(ref=>!facts.notes[ref])) throw new Error('UN participant or note disappeared; baseline/diff withheld for review');
      await db.transaction(async tx=>{
        const baseline=await observe(tx,tracker.id,tracker.url,response.body,null,facts,facts,
          {rank:2,identity:'untc:XXI-10:baseline',item_key:'baseline',coverage_since:previous?.parsed.source.coverage_since??since},now());
        stats[baseline.changed?'candidates':'skipped']++;
        if (baseline.changed) await tx.query("update scout.evidence set parsed=jsonb_set(parsed,'{assessment,state}','\"baseline\"') where id=$1",[baseline.id]);
        for (const item of parsed.participants.filter(row=>row.action)) {
          const old=previous?.parsed.participants.find(row=>row.country===item.country);
          const {content,...current}=item;
          const changed=previous && (!old?.action || !isDeepStrictEqual(current,old) || item.note_refs.some(ref=>parsed.notes[ref]!==previous.parsed.notes[ref]));
          if (!changed && (previous || item.date<since.slice(0,10))) continue;
          const notes=item.note_refs.map(ref=>`${ref}: ${parsed.notes[ref]}`).join(' ');
          const title=`${item.country} — ${item.action} — ${item.date_text}`;
          const scripted={kind:'treaty_status',title,organization:item.country,description:title,
            ...Object.fromEntries(['location','event_url','registration_url','starts_at','ends_at','status'].map(field=>[field,null])),treaty:{...current,notes}};
          const source=await observe(tx,tracker.id,tracker.url,`<p>${parsed.header}</p>${content}<p>${notes}</p>`,null,scripted,{...current,notes},
            {rank:2,identity:`untc:XXI-10:${item.country}`,item_key:`participant:${item.country}`,baseline_id:baseline.id,
              change_type:old?.action?'correction':previous?'addition':'initial_window'},now());
          stats[source.changed?'candidates':'skipped']++;
        }
      });
      stats.baseline_participants=parsed.participants.length;stats.baseline_parties=parsed.parties;covered=true;
    } else if (doalos) {
      const home=await read(tracker.url,budget);stats.pages++;
      const listingURL=DOALOS+'/notifications';
      if (home.url!==tracker.url || !home.body.includes('href="/bbnjagreement/en/notifications"') || !/<\/html>\s*$/.test(home.body)) throw new Error('DOALOS notifications link unavailable');
      const listing=await read(listingURL,budget);stats.pages++;
      if (listing.url!==listingURL) throw new Error('Unexpected DOALOS listing destination');
      const article=doalosArticle(listing.body,listing.url);
      const day=text=>{
        if (!/^\d{1,2} (January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/.test(text)) throw new Error('Invalid DOALOS notice date');
        const date=new Date(text+' 00:00:00 GMT');
        if (!Number.isFinite(+date) || date.toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'})!==text.replace(/^0/,'')) throw new Error('Invalid DOALOS notice date');
        return date.toISOString().slice(0,10);
      };
      const news=home.body.match(/<h2\b[^>]*>\s*New\s*<\/h2>[\s\S]*?<ul>([\s\S]*?)<\/ul>/)?.[1];
      if (!news) stats.warnings.push('DOALOS homepage New list unavailable');
      const conferences=[...(news??'').matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].filter(m=>/International Conference on BBNJ/.test(visibleText(m[1])));
      if (conferences.length>1) stats.warnings.push('DOALOS homepage conference limit reached');
      for (const item of conferences.slice(0,1)) {
        const link=item[1].match(/<a\b[^>]*href="(https:\/\/www\.deepoceanbbnj\.cn\/\d{4}\.html)"[^>]*>([\s\S]*?)<\/a>/);
        const heading=link && visibleText(link[2]).match(/^(.+) \((\d{1,2} [A-Za-z]+ \d{4})\)$/);
        const deadline=visibleText(item[1]).match(/Registration by (\d{1,2} [A-Za-z]+ \d{4})/);
        if (!heading || !deadline) {stats.warnings.push('Unsupported DOALOS homepage conference item');continue;}
        const start=day(heading[2]),due=day(deadline[1]);
        if (start<since.slice(0,10) && due<since.slice(0,10)) continue;
        const url=sourceURL(link[1]);
        const scripted={kind:'event',title:heading[1],description:visibleText(item[1]),organization:null,location:null,
          ...dates(start),event_url:url,registration_url:null,status:null,registration_deadline_on:due};
        let detail=null,detailText='',technicalText='';
        try {
          const response=await read(url,budget);stats.pages++;
          if (response.url!==url || !/text\/html/i.test(response.headers['content-type']??'') || !/<\/html>\s*$/.test(response.body)) throw new Error('Conference detail destination/format unavailable');
          const body=response.body.replace(/<!--[\s\S]*?-->/g,'');
          const from=body.indexOf('<div class="info-bar">'),to=body.indexOf('<h3>Contact</h3>');
          if (from<0 || to<from || visibleText(body.match(/<title>([\s\S]*?)<\/title>/)?.[1]??'')!==heading[1]) throw new Error('Conference detail layout unavailable');
          const content=body.slice(from,to);
          const date=visibleText(content.match(/<h4>DATE<\/h4>\s*<p>([^<]+)<\/p>/)?.[1]??'');
          const closing=visibleText(content).match(/Registration deadline: (\d{1,2} [A-Za-z]+ \d{4})/);
          if (day(date)!==start || !closing || day(closing[1])!==due) throw new Error('Conference listing/detail dates disagree');
          scripted.organization=visibleText(content.match(/<h4>HOST<\/h4>\s*<small>([\s\S]*?)<\/small>/)?.[1]??'')||null;
          const venue=content.match(/<h4>VENUE<\/h4>\s*<p>([^<]+)<\/p>\s*<small>([^<]+)<\/small>/);
          scripted.location=venue?visibleText(venue[1]+' '+venue[2]):null;
          const register=content.match(/onClick="document\.location='([^']+)'"[^>]*>\s*<h1>Registration and participation<\/h1>/);
          scripted.registration_url=register?sourceURL(new URL(register[1],url).href):null;
          const paragraphs=[...content.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map(m=>visibleText(m[1]));
          const technical=paragraphs.find(p=>p.includes('This Panel will explore'));
          if (technical) {
            technicalText=technical;
            scripted.description=Array.from(technical.match(/^.*?\.(?:\s|$)/)?.[0].trim()??technical).slice(0,280).join('');
          }
          detail={url,body:response.body};detailText=visibleText(content);
        } catch(error) {
          quota ||= Boolean(error.quota);stats.warnings.push(error.message+'; conference listing facts only');
          // An outage must not replace richer accepted evidence or spend a call on stale detail.
          if ((await db.query("select id from scout.evidence where tracker_id=$1 and url=$2 and parsed#>>'{source,item_key}'=$3 limit 1",[tracker.id,DOALOS,url])).rows.length) continue;
        }
        const text=[visibleText(item[1]),scripted.organization,scripted.location,technicalText||scripted.description,
          detailText.match(/Roundtable Discussion: The Clearing-House Mechanism \(CHM\) and Data Sharing/)?.[0]].filter(Boolean).join(' ');
        const source=await observe(db,tracker.id,DOALOS,JSON.stringify({text,listing:item[1],detail}),null,scripted,
          {listing:visibleText(item[1]),detail:detailText,structured:scripted},
          {rank:2,identity:`event:${url}`,item_key:url,links:[url,scripted.registration_url].filter(Boolean)},now());
        stats[source.changed?'candidates':'skipped']++;pages.set(DOALOS,{source});
        stats.warnings.push('Conference has date-only evidence; draft programme clocks lack a time zone and individual panels are not extracted');
      }
      const rows=[...article.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(match=>{
        const cells=[...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)];
        const links=[...match[1].matchAll(/href="(https:\/\/www\.un\.org\/bbnjagreement\/en\/notification-(\d{4}-\d{3}))"/g)];
        if (cells.length!==2 || links.length!==1) throw new Error('Invalid DOALOS notice row');
        return {url:links[0][1],number:links[0][2],issued_on:day(visibleText(cells[0][1])),text:visibleText(match[1])};
      });
      if (!rows.length || rows.length>50 || new Set(rows.map(r=>r.url)).size!==rows.length) throw new Error('Invalid DOALOS notifications list');
      const seen=(await db.query('select distinct url from scout.evidence where tracker_id=$1',[tracker.id])).rows.map(r=>r.url);
      const selected=rows.filter(r=>r.issued_on>=since.slice(0,10)||seen.includes(r.url)).sort((a,b)=>b.issued_on.localeCompare(a.issued_on));
      stats.notices_listed=rows.length;stats.notices_in_window=selected.length;
      stats.warnings.push('DOALOS covers the notifications table and one linked homepage conference; other homepage announcements, PDFs and side-event programmes are not collected');
      const detailLimit=LIMITS.pages-2-conferences.slice(0,1).length;
      if (selected.length>detailLimit) stats.warnings.push('DOALOS notice detail limit reached');
      if (/class="[^"]*\bpager\b|rel="next"/.test(article)) stats.warnings.push('DOALOS listing pagination is not followed');
      for (const item of selected.slice(0,detailLimit)) {
        try {
          const response=await read(item.url,budget);stats.pages++;
          if (response.url!==item.url || !/text\/html/i.test(response.headers['content-type']??'')) throw new Error('Unexpected DOALOS notice destination/format');
          const content=doalosArticle(response.body,item.url),text=visibleText(content);
          const headings=[...content.matchAll(/<h4\b[^>]*>([\s\S]*?)<\/h4>/g)].map(m=>visibleText(m[1]));
          if (headings.length!==3 || !headings[0] || day(headings[1])!==item.issued_on || !item.text.includes(headings[0]) || !item.text.includes(headings[2])) throw new Error('DOALOS notice/list facts disagree');
          const required=headings[2].match(/^Action required by (.+)$/);
          if (!required && headings[2]!=='No action required') throw new Error('Unrecognized DOALOS notice action');
          const links=[...new Set([...content.matchAll(/href="([^"]+)"/g)].map(m=>{
            try{return sourceURL(new URL(m[1].replaceAll('&amp;','&'),item.url).href);}catch{return null;}
          }).filter(Boolean))].sort();
          if (links.length>10) throw new Error('DOALOS notice link limit reached');
          const description=[...content.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map(m=>visibleText(m[1])).find(p=>p.startsWith('In this regard,'))??headings[0];
          const scripted={kind:'announcement',title:headings[0],organization:text.includes('Division for Ocean Affairs and the Law of the Sea')?'Division for Ocean Affairs and the Law of the Sea':null,
            description:Array.from(description).slice(0,280).join(''),...Object.fromEntries(['location','event_url','registration_url','starts_at','ends_at','status'].map(f=>[f,null])),
            notification:{number:item.number,issued_on:item.issued_on,action_required_by:required?day(required[1]):null}};
          const source=await observe(db,tracker.id,item.url,response.body,null,scripted,{text,links,notification:scripted.notification},
            {rank:2,identity:`page:${item.url}`,listing_url:listingURL,links},now());
          stats[source.changed?'candidates':'skipped']++;
          pages.set(item.url,{source});
        } catch(error) {quota ||= Boolean(error.quota);stats.warnings.push(error.message);}
      }
      covered=selected.length<=detailLimit;
    } else if (explorers) {
      const text=html=>visibleText(html.replace(/&#(x[\da-f]+|\d+);/gi,(_m,n)=>String.fromCodePoint(n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):+n)));
      const marine=/\b(?:oceans?|marine|sea stories|underwater|coral|whales?|sharks?|shipwrecks?|scuba|sailing|high[- ]seas|BBNJ)\b/i;
      const home=await read(tracker.url,budget);stats.pages++;
      const api='https://www.explorers.org/wp-json/tribe/events/v1/';
      if(home.url!==tracker.url||!/<\/html>\s*$/.test(home.body)||!home.body.includes('href="'+api+'"'))throw new Error('Explorers public calendar API discovery unavailable');
      const start=new Date(since).toISOString().slice(0,10),end=new Date(Date.parse(start)+180*86400000).toISOString().slice(0,10),rows=[];
      let total;
      for(let page=1;page<=2;page++){
        const url=sourceURL(api+'events?'+new URLSearchParams({start_date:start,end_date:end,per_page:'20',page:String(page)}));
        const r=await read(url,budget);stats.pages++;
        if(sourceURL(r.url)!==url||!/json/i.test(r.headers['content-type']??''))throw new Error('Explorers public API destination/format unavailable');
        const data=JSON.parse(r.body);
        if(!Array.isArray(data.events)||data.events.length>20||!Number.isSafeInteger(data.total)||data.total<0||data.total_pages!==Math.ceil(data.total/20)||total!==undefined&&total!==data.total||data.events.length!==Math.min(20,Math.max(0,data.total-(page-1)*20)))throw new Error('Explorers calendar page/count conflict');
        total=data.total;rows.push(...data.events);if(page>=data.total_pages)break;
      }
      if(new Set(rows.map(e=>e.id)).size!==rows.length||rows.some(e=>!Number.isSafeInteger(e.id)||e.id<=0||e.global_id!=='www.explorers.org?id='+e.id||e.status!=='publish'||!/^https:\/\/www\.explorers\.org\/calendar-of-events\/[^/?#]+\/$/.test(e.url)||typeof e.title!=='string'||typeof e.description!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(e.start_date??'')||e.start_date.slice(0,10)<start||e.start_date.slice(0,10)>end))throw new Error('Explorers calendar identity/date window unavailable');
      stats.calendar_items=rows.length;
      const relevant=rows.filter(e=>marine.test(text(e.title+' '+e.description)));
      stats.irrelevant=rows.length-relevant.length;
      const eligible=relevant.filter(e=>e.start_date.slice(0,10)===e.end_date?.slice(0,10)&&!e.all_day);
      const selected=eligible.sort((a,b)=>Number(a.start_date.slice(0,10)<started.slice(0,10))-Number(b.start_date.slice(0,10)<started.slice(0,10))||a.start_date.localeCompare(b.start_date)||a.id-b.id).slice(0,3);
      stats.warnings.push('Explorers coverage is two twenty-event API pages in a 180-day window from since, with three single-day details, upcoming first. Other vocabulary, older/later events, multi-day programmes, individual programme talks and recordings remain unexamined; overall event ranges are not individual talk times');
      if(total>rows.length||eligible.length>selected.length||relevant.length>eligible.length)stats.warnings.push('Explorers pagination/detail or multi-day bound leaves relevant calendar items unexamined');
      for(const e of selected){
        try{
          const r=await read(e.url,budget);stats.pages++;
          const own=r.body.match(/<section class="section section--news-details[^"]*">([\s\S]*?)<\/section>/)?.[1];
          const body=own?.match(/<div class="news-details__content">([\s\S]*?)<\/div>/)?.[1],event=structuredEvents(r.body,e.url);
          const title=text(e.title),year=e.start_date.slice(0,4),schedule=dates(e.utc_start_date?.replace(' ','T')+'Z',e.utc_end_date?.replace(' ','T')+'Z');
          if(r.url!==e.url||!/<\/html>\s*$/.test(r.body)||!own||!body||text(body)!==text(e.description)||!event||text(event.title)!==title||event.event_url!==e.url||!schedule.starts_at||!schedule.ends_at||event.starts_at!==schedule.starts_at||event.ends_at!==schedule.ends_at||typeof e.timezone!=='string'||!e.timezone.includes('/')||e.is_recurring||e.recurrence||e.recurrence_rules||e.series)throw new Error('Explorers detail/API identity, content, single occurrence or schedule conflict');
          if(title.match(/\b20\d{2}\b/g)?.some(y=>y!==year)||/\b(?:watch (?:the )?(?:recording|replay)|recording of|this (?:event|session) (?:originally aired|was recorded))\b/i.test(text(body)))throw new Error('Explorers edition/recording identity requires review');
          for(const [instant,local]of [[schedule.starts_at,e.start_date],[schedule.ends_at,e.end_date]]){
            const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:e.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(instant)).map(p=>[p.type,p.value]));
            if(p.year+'-'+p.month+'-'+p.day+' '+p.hour+':'+p.minute+':'+p.second!==local)throw new Error('Explorers explicit time zone disagrees with local/UTC clocks');
          }
          const icons=Object.fromEntries([...own.matchAll(/assets\/svg\/(date|start_time|location)\.svg" alt="([^"]*)"/g)].map(m=>[m[1],text(m[2])]));
          const expectedDay=new Date(schedule.starts_at).toLocaleDateString('en-US',{timeZone:e.timezone,month:'long',day:'numeric',year:'numeric'}),expectedClock=new Date(schedule.starts_at).toLocaleTimeString('en-US',{timeZone:e.timezone,hour:'numeric',minute:'2-digit'});
          if(icons.date?.replaceAll(' ','')!==expectedDay.replaceAll(' ','')||icons.start_time!==expectedClock)throw new Error('Explorers visible date/clock conflicts with structured schedule');
          const paragraphs=[...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map(m=>text(m[1])),description=paragraphs.flatMap(p=>p.match(/[^.!?]+[.!?](?=\s|$)/g)??[]).map(p=>p.trim()).find(p=>p.length<=280&&marine.test(p));
          if(!description)throw new Error('Explorers complete ocean-relevant description unavailable');
          const registrations=[...new Set([...own.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].filter(m=>/^(?:click here (?:for tickets|to purchase tickets|to register))$/i.test(text(m[2]))).map(m=>sourceURL(text(m[1]))))];
          if(registrations.length>1||registrations.some(u=>!/^https:\/\/(?:store\.explorers\.org\/products\/|[a-z0-9]+\.zoom\.us\/meeting\/register\/)/.test(u)))throw new Error('Explorers registration identity needs review');
          if(/\bThis (?:event|lecture|programme|program|session) (?:has been|is) cancell?ed\b/i.test(text(body))&&event.status!=='cancelled')throw new Error('Explorers cancellation conflicts with structured status; retained status needs review');
          const programme=own.includes('class="schedule-event-item"'),itemKey=e.id+':'+year;
          const scripted={kind:'event',title,description,organization:/\bJoin The Explorers Club\b/.test(text(body))?'The Explorers Club':event.organization,
            ...schedule,time_zone:e.timezone,location:icons.location||null,event_url:e.url,registration_url:registrations[0]??null,status:event.status,
            explorers:{id:String(e.id),year,scope:programme?'programme':'event'}};
          const links=[e.url,...registrations],context=[title,description,...paragraphs.filter(p=>marine.test(p)),text(own)].join(' ');
          const source=await observe(db,tracker.id,e.url,JSON.stringify({text:context,api:e,detail:{url:r.url,body:r.body}}),dates(e.date_utc?.replace(' ','T')+'Z').starts_at,scripted,
            {text:text(own),structured:scripted,links},{rank:2,identity:'explorers:'+itemKey,item_key:itemKey,listing_url:tracker.url,links},now());
          stats[source.changed?'candidates':'skipped']++;pages.set(source.id,{source});
        }catch(error){quota ||= Boolean(error.quota);stats.warnings.push('Explorers '+e.id+': '+error.message);}
      }
      covered=true;
    } else if (octo) {
      const text=html=>visibleText(html.replace(/&#(x[\da-f]+|\d+);/gi,(_m,n)=>String.fromCodePoint(n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):+n)));
      const home=await read(tracker.url,budget);stats.pages++;
      const feedURL='https://octogroup.org/feed/';
      if(home.url!==tracker.url||!/<\/html>\s*$/.test(home.body)||!home.body.includes('href="'+feedURL+'"')||!home.body.includes('rel="canonical" href="'+tracker.url+'"'))throw new Error('OCTO feed discovery unavailable');
      const feed=await read(feedURL,budget);stats.pages++;
      if(feed.url!==feedURL||!/<\/rss>\s*$/.test(feed.body))throw new Error('OCTO feed incomplete');
      const items=[...feed.body.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0,10).map(m=>{
        const id=m[1].match(/<guid[^>]*>https:\/\/octogroup\.org\/\?p=(\d+)<\/guid>/)?.[1],url=m[1].match(/<link>([^<]+)<\/link>/)?.[1],title=text(m[1].match(/<title>([\s\S]*?)<\/title>/)?.[1]??''),date=m[1].match(/<pubDate>([^<]+)<\/pubDate>/)?.[1];
        const categories=[...m[1].matchAll(/<category><!\[CDATA\[([^\]]+)\]\]><\/category>/g)].map(m=>m[1]);
        if(!id||!url?.startsWith('https://octogroup.org/')||!title||!/[+-]\d{4}$/.test(date??'')||!Number.isFinite(Date.parse(date)))throw new Error('OCTO feed item identity/publication unavailable');
        return{id,url:sourceURL(url),title,published:new Date(date).toISOString(),upcoming:categories.includes('Upcoming Webinars'),past:categories.includes('Past Webinars'),raw:m[0],categories};
      });
      if(!items.length||new Set(items.map(i=>i.id)).size!==items.length)throw new Error('OCTO feed item identities unavailable');
      const eligible=items.filter(i=>i.categories.includes('Webinars')&&i.upcoming!==i.past);
      const upcoming=eligible.filter(i=>i.upcoming).slice(0,3),past=eligible.filter(i=>i.past&&i.published>=new Date(since).toISOString()).slice(0,3);
      const selected=items.filter(i=>upcoming.includes(i)||past.includes(i));
      stats.items_listed=items.length;stats.items_selected=selected.length;
      stats.warnings.push('OCTO coverage is the latest ten RSS posts, at most three upcoming webinars and three recordings within the publication window. Archive pagination, older editions, other formats and video contents remain unexamined; publication dates do not supply session years');
      if(eligible.filter(i=>i.upcoming).length>3)stats.warnings.push('OCTO upcoming webinar limit reached');
      if(!selected.length)covered=true;
      else{
        // The individual post advertises this public REST collection; one bounded batch leaves room for three Zoom reads.
        const apiURL=sourceURL('https://octogroup.org/wp-json/wp/v2/posts?'+new URLSearchParams({include:selected.map(i=>i.id).join(','),per_page:String(selected.length),_fields:'id,date_gmt,link,title,content,categories,status'}));
        const response=await read(apiURL,budget);stats.pages++;
        if(sourceURL(response.url)!==apiURL||!/json/i.test(response.headers['content-type']??''))throw new Error('OCTO public post API destination/format unavailable');
        const posts=JSON.parse(response.body);
        if(!Array.isArray(posts)||posts.length!==selected.length||new Set(posts.map(p=>p.id)).size!==selected.length||posts.some(p=>!selected.some(i=>+i.id===p.id)))throw new Error('OCTO public post batch incomplete');
        const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
        for(const item of selected)try{
          const post=posts.find(p=>p.id===+item.id),html=post.content?.rendered;
          if(post.status!=='publish'||sourceURL(post.link)!==item.url||text(post.title?.rendered??'')!==item.title||dates(post.date_gmt+'Z').starts_at!==item.published||typeof html!=='string'||post.content.protected||!post.categories?.includes(item.upcoming?594:595)||post.categories.includes(item.upcoming?595:594))throw new Error('OCTO post/feed identity, category or publication conflict');
          const paragraphs=[...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map(m=>text(m[1])),body=text(html),descriptionText=paragraphs.find(p=>p.startsWith('Description:'))?.replace(/^Description:\s*/,'');
          const description=descriptionText?.match(/[^.!?]+[.!?](?=\s|$)/g)?.map(s=>s.trim()).find(s=>s.length<=280)??null;
          const host=paragraphs.find(p=>/^Hosted by\s*:/.test(p))?.replace(/^Hosted by\s*:\s*/,'').split(/Register\s*:/)[0].trim(),cancelled=paragraphs.some(p=>/^This webinar (?:has been|is) cancell?ed[.!]$/i.test(p));
          if(!descriptionText||!description||!host||!/\b(?:ocean|marine|coastal|kelp|seagrass|MPA|conservation)\b/i.test(item.title+' '+descriptionText))throw new Error('OCTO webinar content/host or relevance unconfirmed');
          const links=[...new Set([...html.matchAll(/(?:href|src)="([^"]+)"/g)].map(m=>{try{return sourceURL(m[1].replaceAll('&amp;','&'));}catch{return null;}}).filter(Boolean))].sort();
          const scripted={kind:item.upcoming?'event':'announcement',title:item.title,description,organization:host,location:null,...dates(),event_url:null,registration_url:null,status:null,octo:{id:item.id,recording:item.past,year:null,aired_on:null}};
          let support=null,year;
          if(item.upcoming){
            const registrations=links.filter(u=>/^https:\/\/[a-z0-9]+\.zoom\.us\/webinar\/register\/WN_[\w-]+$/.test(u));
            const schedule=paragraphs.find(p=>p.startsWith('Date/Time:'))?.replace(/^Date\/Time:\s*/,'');
            if(registrations.length!==1||!schedule)throw new Error('OCTO single session registration/date unavailable');
            const r=await read(registrations[0],budget);stats.pages++;
            const zoom=JSON.parse(r.body.match(/\bregisterVO:(\{[^\n]+\}),\s*\n/)?.[1]??'null'),url=zoom?.shareVO?.url,agenda=zoom?.meetingVO?.agenda,when=zoom?.viewerEmail?.match(/\nWhen: ([A-Z][a-z]{2}) (\d{1,2}), (20\d{2}) (0[1-9]|1[0-2]):([0-5]\d) (AM|PM) ([^\n]+)\n/);
            if(url!==registrations[0]||sourceURL(r.url)!==url||!/<\/html>\s*$/.test(r.body)||zoom?.uuid!==url.split('/').pop()||zoom.recurringRegType!==null||text(zoom.meetingVO?.topic??'')!==item.title||typeof agenda!=='string'||!text(agenda).includes(description)||!agenda.includes('Hosted by: OCTO')||!when||(zoom.viewerEmail.match(/\nWhen:/g)??[]).length!==1||when[7]!==zoom.timezoneVO?.timezoneName)throw new Error('OCTO Zoom session identity or single schedule unconfirmed');
            year=when[3];const month=months.findIndex(m=>m.startsWith(when[1]))+1,day=dates(year+'-'+String(month).padStart(2,'0')+'-'+when[2].padStart(2,'0')).start_on;
            const line=schedule.match(/^([A-Z][a-z]+), ([A-Z][a-z]+) (\d{1,2})(?:, (20\d{2}))?, (.+)$/),clocks=line?.[5].split('/').map(c=>c.trim().match(/^(Noon|\d{1,2}(?::[0-5]\d)? (?:am|pm)) (?:US )?(EDT|PDT|UTC|BST|CEST|CET)$/i));
            if(!day||!line||line[2]!==months[month-1]||+line[3]!==+when[2]||line[4]&&line[4]!==year||new Date(day+'T12:00:00Z').toLocaleDateString('en-US',{timeZone:'UTC',weekday:'long'})!==line[1]||!clocks?.length||clocks.some(c=>!c))throw new Error('OCTO page/Zoom calendar date conflict');
            const instants=clocks.map(c=>{const clock=c[1].match(/^(\d{1,2})(?::([0-5]\d))? (am|pm)$/i);if(clock&&(+clock[1]<1||+clock[1]>12))throw new Error('OCTO invalid clock');const hour=clock?+clock[1]%12+(clock[3].toLowerCase()==='pm'?12:0):12;return Date.parse(day+'T00:00:00Z')+(hour*60+(+(clock?.[2]??0))-({EDT:-240,PDT:-420,UTC:0,BST:60,CEST:120,CET:60})[c[2].toUpperCase()])*60000;});
            if(new Set(instants).size!==1)throw new Error('OCTO published clocks conflict');
            const start=new Date(instants[0]).toISOString(),parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:zoom.timezoneVO.timezoneId,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(start)).map(p=>[p.type,p.value]));
            if(parts.year!==year||+parts.month!==month||+parts.day!==+when[2]||+parts.hour!==+when[4]%12+(when[6]==='PM'?12:0)||parts.minute!==when[5])throw new Error('OCTO public registration time zone conflicts with publisher clocks');
            Object.assign(scripted,dates(start),{time_zone:zoom.timezoneVO.timezoneId,event_url:url,registration_url:url,status:cancelled?'cancelled':'scheduled'});
            support={url,body:r.body,facts:{title:item.title,when:when[0].trim(),zone:zoom.timezoneVO.timezoneId,agenda}};
            scripted.octo.schedule=schedule;
          }else{
            const aired=paragraphs.find(p=>p.startsWith('This webinar originally aired on '))?.match(/^This webinar originally aired on (?:(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), )?([A-Z][a-z]+) (\d{1,2}), (20\d{2})\.$/);
            if(!aired||!links.some(u=>/^https:\/\/(?:player\.)?vimeo\.com\/|^https:\/\/(?:www\.)?youtube\.com\/|^https:\/\/youtu\.be\//.test(u)))throw new Error('OCTO recording/date identity unconfirmed');
            year=aired[4];const day=dates(year+'-'+String(months.indexOf(aired[2])+1).padStart(2,'0')+'-'+aired[3].padStart(2,'0')).start_on;
            if(day&&(!aired[1]||new Date(day+'T12:00:00Z').toLocaleDateString('en-US',{timeZone:'UTC',weekday:'long'})===aired[1]))scripted.octo.aired_on=day;
            else stats.warnings.push('OCTO '+item.id+': recording date/weekday conflict; aired date remains unknown');
          }
          scripted.octo.year=year;const key=item.id+':'+year+':'+(item.past?'recording':'event');
          const excerpt=[item.title,description,host,scripted.starts_at,scripted.status,support?.facts.when,body].filter(Boolean).join(' ');
          const source=await observe(db,tracker.id,item.url,JSON.stringify({text:excerpt,feed_item:item.raw,post,support}),item.published,scripted,
            {body,links,structured:scripted,registration:support?.facts??null},{rank:2,identity:'octo:'+key,item_key:key,feed_url:feedURL,api_url:apiURL,links:links.slice(0,10)},now());
          stats[source.changed?'candidates':'skipped']++;pages.set(source.id,{source});
        }catch(error){quota ||= Boolean(error.quota);stats.warnings.push(item.url+': '+error.message+'; retained session facts require review');}
        covered=true;
      }
    } else if (cbd) {
      // Queries/joins follow the public registry's index.js and mongo-storage.js.
      // Two latest meetings and two ten-row phrase-search pages; never all history.
      const responses=[],api=async(path,params={})=>{
        const url=sourceURL('https://api.cbd.int/api/'+path+(Object.keys(params).length?'?'+new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k,v])=>[k,typeof v==='object'?JSON.stringify(v):String(v)]))):''));
        if(stats.pages>=LIMITS.pages)throw new Error('CBD supporting-page limit reached');
        const r=await read(url,budget);stats.pages++;
        if(sourceURL(r.url)!==url||!/json/i.test(r.headers['content-type']??''))throw new Error('Unexpected CBD registry destination/format');
        const rows=JSON.parse(r.body);if(!Array.isArray(rows))throw new Error('Invalid CBD registry response');
        responses.push({url:r.url});return rows;
      };
      const meetings=await api('v2016/conferences',{q:{$and:[{$or:[{institution:'CBD'},{institution:'cbd'}]},{$or:[{'schedule.sideEvents.seTiers':{$exists:true}}]}]},s:{StartDate:-1},l:2,
        f:{Title:1,code:1,StartDate:1,EndDate:1,timezone:1,venueId:1,institution:1,'schedule.sideEvents.sideEventsPublished':1,'schedule.sideEvents.seTiers':1}});
      if(!meetings.length||meetings.length>2||new Set(meetings.map(m=>m._id)).size!==meetings.length||meetings.some(m=>!/^[a-f0-9]{24}$/.test(m._id)||!m.Title?.en||!m.code||!['CBD','cbd'].includes(m.institution)||!Number.isFinite(Date.parse(m.StartDate))||typeof m.schedule?.sideEvents?.sideEventsPublished!=='boolean')||meetings.some((m,i)=>i&&m.StartDate>meetings[i-1].StartDate))throw new Error('CBD meeting identity/publication unavailable');
      const types=['570fd0a52e3fa5cfa61d90ee','570fd2b82e3fa5cfa61d90f9','572bda113fa4920100f1f0f6','5720c12b10019e01006fa798','570fd27a2e3fa5cfa61d90f8','572bcfa4240149400a234903'];
      const q={start:{$ne:null},'location.conference':{$in:meetings.map(m=>m._id)},$text:{$search:'"BBNJ"'},'meta.status':{$nin:['deleted','archived']},type:{$in:types}};
      const f={start:1,end:1,open:1,type:1,'meta.status':1,'location.conference':1,'location.room':1,'sideEvent.id':1,'sideEvent.title':1,'sideEvent.description':1,'sideEvent.hostOrgs':1,'sideEvent.conference':1,'sideEvent.links':1,'sideEvent.publications':1,'sideEvent.meta.status':1};
      const rows=[];
      for(let page=0;page<2;page++){
        const part=await api('v2016/reservations',{q,f,s:{start:1,_id:1},sk:page*10,l:10});
        if(part.length>10)throw new Error('CBD pagination bound not respected');
        rows.push(...part);if(part.length<10)break;
        if(page===1)stats.warnings.push('CBD reservation pagination limit reached; additional matching sessions remain unexamined');
      }
      if(new Set(rows.map(r=>r.sideEvent?.id)).size!==rows.length||rows.some(r=>!Number.isSafeInteger(r.sideEvent?.id)||r.sideEvent.id<=0||!r.sideEvent.title||typeof r.sideEvent.description!=='string'||!meetings.some(m=>m._id===r.sideEvent.conference&&m._id===r.location?.conference)||!types.includes(r.type)||['deleted','archived'].includes(r.meta?.status)))throw new Error('CBD session/meeting identity or filter conflict; observations withheld');
      const selected=rows.filter(r=>/\bBBNJ\b/i.test(r.sideEvent.title+' '+visibleText(r.sideEvent.description)));
      const valid=selected.filter(r=>['scheduled','published'].includes(r.sideEvent.meta?.status));
      if(valid.length!==selected.length)stats.warnings.push('CBD publisher status does not confirm a session; cancellation/publication changes need review and retained facts are preserved');
      if(valid.some(r=>!Array.isArray(r.sideEvent.hostOrgs)||r.sideEvent.hostOrgs.length>10||new Set(r.sideEvent.hostOrgs).size!==r.sideEvent.hostOrgs.length||r.sideEvent.hostOrgs.some(h=>!/^(?:[a-f0-9]{24}|[a-z]{2})$/.test(h))))throw new Error('Unsupported CBD host identity/bound');
      const hostIds=[...new Set(valid.flatMap(r=>r.sideEvent.hostOrgs).filter(h=>h.length===24))].sort();
      const roomIds=[...new Set(valid.filter(r=>meetings.find(m=>m._id===r.sideEvent.conference).schedule.sideEvents.sideEventsPublished&&r.open===true).map(r=>r.location.room).filter(Boolean))].sort();
      if(hostIds.length>80||roomIds.some(r=>!/^[a-f0-9]{24}$/.test(r)))throw new Error('CBD supporting identity/bound unavailable');
      const hosts=hostIds.length?await api('v2016/inde-orgs',{q:{_id:{$in:hostIds.map(v=>({$oid:v}))}},f:{title:1,acronym:1}}):[];
      const rooms=roomIds.length?await api('v2016/venue-rooms',{q:{_id:{$in:roomIds.map(v=>({$oid:v}))}},f:{title:1,location:1}}):[];
      const countries=valid.some(r=>r.sideEvent.hostOrgs.some(h=>h.length===2))?await api('v2015/countries'):[];
      stats.meetings=meetings.map(m=>({id:m._id,code:m.code,published:m.schedule.sideEvents.sideEventsPublished}));
      stats.sessions_listed=rows.length;stats.sessions_selected=valid.length;stats.irrelevant=rows.length-selected.length;
      stats.warnings.push('CBD coverage is limited to the two newest meetings, BBNJ in title/body and at most two ten-row public search pages. Unscheduled, other phrases/languages, older meetings, PDFs and linked materials remain unexamined; application windows are not attendance registration');
      for(const r of valid){
        try{
          const event=r.sideEvent,meeting=meetings.find(m=>m._id===event.conference),url=CBD_REGISTRY+event.id,body=visibleText(event.description);
          const old=(await db.query("select parsed#>>'{cbd_registry,meeting,id}' as meeting from scout.evidence where tracker_id=$1 and parsed#>>'{side_event,id}'=$2",[tracker.id,String(event.id)])).rows;
          if(old.some(o=>o.meeting!==meeting._id))throw new Error('CBD official session ID changed meeting; identity needs review');
          const orgs=event.hostOrgs.map(id=>id.length===2?countries.filter(c=>c.code?.toLowerCase()===id).map(c=>c.name?.en):hosts.filter(h=>h._id===id).map(h=>h.title));
          if(orgs.some(names=>names.length!==1||typeof names[0]!=='string'||!names[0]))throw new Error('CBD host identity unavailable');
          const paragraphs=[...event.description.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map(m=>visibleText(m[1]));
          const sentences=paragraphs.flatMap(p=>p.match(/[^.!?]+[.!?](?=\s|$)/g)??[]).map(s=>s.trim()).filter(s=>s.length<=280);
          const description=sentences.find(s=>/\b(?:this|the) (?:side event|session)\b/i.test(s))??sentences[0]??null;
          const scripted={kind:'event',title:visibleText(event.title),description,organization:orgs.flat().join('; ')||null,location:null,...dates(),event_url:url,registration_url:null,status:null,
            side_event:{id:String(event.id),schedule_published:meeting.schedule.sideEvents.sideEventsPublished},
            cbd_registry:{meeting:{id:meeting._id,code:meeting.code,title:meeting.Title.en},publisher_status:event.meta.status}};
          if(scripted.side_event.schedule_published&&r.open===true){
            const schedule=dates(r.start,r.end);
            if(!schedule.starts_at||!schedule.ends_at||!meeting.timezone)throw new Error('CBD published session timestamps/zone unavailable; retained schedule needs review');
            new Intl.DateTimeFormat('en',{timeZone:meeting.timezone});
            Object.assign(scripted,schedule,{time_zone:meeting.timezone,status:'scheduled'});
            if(r.location.room){const matched=rooms.filter(room=>room._id===r.location.room);if(matched.length!==1||typeof matched[0].title!=='string')throw new Error('CBD room identity unavailable');scripted.location=[matched[0].title,matched[0].location].filter(v=>typeof v==='string'&&v).join(', ')||null;}
          }else stats.warnings.push('CBD '+event.id+': schedule unpublished or reservation closed; session clocks, zone and room withheld, retained schedule requires review');
          const materials=[...(event.links??[]),...(event.publications??[])].map(m=>({url:sourceURL(m.uri),title:m.title??null,description:m.description?visibleText(m.description):null}));
          if(materials.length>10)throw new Error('CBD material link bound exceeded');
          const text=[scripted.title,description,scripted.organization,scripted.location,scripted.starts_at,scripted.ends_at,scripted.status,meeting.Title.en,body].filter(Boolean).join(' ');
          const source=await observe(db,tracker.id,url,JSON.stringify({text,reservation:r,conference:meeting,responses,hosts:event.hostOrgs.map((id,i)=>({id,title:orgs[i][0]})),room:scripted.location}),null,scripted,
            {body,structured:scripted,materials},{rank:2,identity:'event:'+url,item_key:meeting._id+':'+event.id,listing_url:tracker.url,links:[url,...materials.map(m=>m.url)]},now());
          stats[source.changed?'candidates':'skipped']++;pages.set(source.id,{source});
        }catch(error){quota ||= Boolean(error.quota);stats.warnings.push(error.message);}
      }
      covered=true;
    } else if (sideEvents) {
      const listing=await read(tracker.url,budget);stats.pages++;
      if (listing.url!==tracker.url || !/text\/html/i.test(listing.headers['content-type']??'')) throw new Error('Unexpected UN side-event listing destination/format');
      const article=doalosArticle(listing.body,listing.url),cache=new Map();
      const items=[...article.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map(m=>{
        const anchors=[...m[1].matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
        const text=visibleText(m[1]),year=text.match(/\b(20\d{2})$/)?.[1];
        if (!anchors.length || !year) throw new Error('UN side-event item identity/meeting year unavailable');
        const links=anchors.map(a=>sourceURL(new URL(a[1].replaceAll('&amp;','&'),tracker.url).href));
        if (links.length>10) throw new Error('UN side-event link limit reached');
        return {content:m[1],title:visibleText(anchors[0][2]),links,year,document:links[anchors.findIndex(a=>/^(Programme|Concept note)$/.test(visibleText(a[2])))]??links.find(u=>/\.pdf$/i.test(u))};
      });
      if (!items.length || items.length>50 || new Set(items.map(i=>i.links[0])).size!==items.length) throw new Error('Invalid UN side-event listing');
      const seen=(await db.query("select parsed#>>'{source,item_key}' as key from scout.evidence where tracker_id=$1",[tracker.id])).rows.map(r=>r.key);
      const selected=items.filter(i=>i.year>=since.slice(0,4)||seen.includes(i.links[0]));
      stats.sessions_listed=items.length;stats.sessions_selected=selected.length;
      stats.warnings.push('Side-event coverage uses meeting years only for discovery; parent meeting ranges are not session dates. PDFs/images and unexamined programmes remain unsupported');
      if (selected.length>3) stats.warnings.push('UN side-event item limit reached');
      const fetchDetail=async url=>{
        url=sourceURL(url);
        if (cache.has(url)) {if(!cache.get(url))throw new Error('Side-event detail unavailable');return cache.get(url);}
        if (cache.size>=LIMITS.pages-1) throw new Error('Side-event supporting-page limit reached');
        cache.set(url,null);const r=await read(url,budget);stats.pages++;cache.set(url,r);return r;
      };
      const api=async(path,q,f)=>{
        const r=await fetchDetail('https://api.cbd.int/api/v2016/'+path+'?'+new URLSearchParams({q:JSON.stringify(q),f:JSON.stringify(f)}));
        const rows=JSON.parse(r.body);if(!Array.isArray(rows))throw new Error('Invalid CBD public API response');return {response:{url:r.url,body:r.body},rows};
      };
      for (const item of selected.slice(0,3)) {
        const url=item.links[0],id=url.match(/^https:\/\/www\.cbd\.int\/side-events\/(\d+)$/)?.[1],raw=[];
        const scripted={kind:'event',title:item.title,description:null,organization:null,location:null,...dates(),event_url:id?url:null,registration_url:null,status:null,
          side_event:{id:id??null,parent_meeting_year:item.year,schedule_published:false}};
        let description='';
        try {
          if (id) {
            const result=await api('reservations/',{'sideEvent.id':+id},{start:1,end:1,'location.room':1,open:1,'sideEvent.id':1,'sideEvent.title':1,'sideEvent.description':1,'sideEvent.hostOrgs':1,'sideEvent.conference':1,'sideEvent.publications':1,'sideEvent.links':1,'sideEvent.meta.status':1});
            const reservation=result.rows[0],event=reservation?.sideEvent;
            if (result.rows.length!==1 || event?.id!==+id || normalize(event.title)!==normalize(item.title) || !/^[a-f0-9]{24}$/.test(event.conference) || typeof event.description!=='string') throw new Error('CBD reservation identity/content unavailable');
            raw.push(result.response);description=visibleText(event.description);
            const purpose=[...event.description.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map(m=>visibleText(m[1])).find(p=>/^Against this background/.test(p));
            scripted.description=purpose?Array.from(purpose.match(/^.*?\.(?:\s|$)/)?.[0].trim()??purpose).slice(0,280).join(''):null;
            const conference=await api('conferences',{_id:{$oid:event.conference}},{Title:1,timezone:1,'schedule.sideEvents.sideEventsPublished':1});raw.push(conference.response);
            if (conference.rows.length!==1 || conference.rows[0]._id!==event.conference) throw new Error('CBD conference identity unavailable');
            scripted.side_event.schedule_published=conference.rows[0].schedule?.sideEvents?.sideEventsPublished===true;
            if (!['scheduled','published'].includes(event.meta?.status)) throw new Error('CBD schedule conflict: publisher status does not confirm a session; any retained schedule requires review, cancellation is unconfirmed');
            if (scripted.side_event.schedule_published && reservation.open===true) {
              const schedule=dates(reservation.start,reservation.end);
              if (!schedule.starts_at || !schedule.ends_at || Date.parse(schedule.ends_at)<Date.parse(schedule.starts_at)) throw new Error('CBD schedule conflict: session timestamps missing or reversed; any retained schedule requires review');
              Object.assign(scripted,schedule);scripted.status='scheduled';
              if (/^[a-f0-9]{24}$/.test(reservation.location?.room)) {
                const room=await api('venue-rooms',{_id:{$oid:reservation.location.room}},{title:1,location:1});raw.push(room.response);
                if (room.rows.length!==1 || room.rows[0]._id!==reservation.location.room) throw new Error('CBD room identity unavailable');
                scripted.location=[room.rows[0].title,room.rows[0].location].filter(v=>typeof v==='string'&&v).join(', ')||null;
              }
            } else stats.warnings.push('CBD schedule is unpublished or reservation is not open; session timestamps and room are withheld, any retained schedule requires review');
            if (!Array.isArray(event.hostOrgs)||event.hostOrgs.length>4||event.hostOrgs.some(v=>!/^[a-f0-9]{24}$/.test(v))) throw new Error('Unsupported CBD hosts');
            if (event.hostOrgs.length) {
              const hosts=await api('inde-orgs',{_id:{$in:event.hostOrgs.map(v=>({$oid:v}))}},{title:1,acronym:1});raw.push(hosts.response);
              if (hosts.rows.length!==event.hostOrgs.length || event.hostOrgs.some(v=>!hosts.rows.some(h=>h._id===v&&typeof h.title==='string'))) throw new Error('CBD host identity unavailable');
              scripted.organization=event.hostOrgs.map(v=>hosts.rows.find(h=>h._id===v).title).join('; ');
            }
          } else stats.warnings.push('Side-event detail is not a supported CBD public record; listing facts only');
        } catch(error) {
          quota ||= Boolean(error.quota);stats.warnings.push(error.message);
          // Do not replace a known item with a less complete snapshot during outages/layout changes.
          if (seen.includes(url)) continue;
          description='';Object.assign(scripted,{description:null,organization:null,location:null,...dates(),status:null});scripted.side_event.schedule_published=false;raw.length=0;
        }
        if (item.document) {
          try {const doc=await fetchDetail(item.document);stats.warnings.push(`Linked side-event document is not parsed (${doc.headers['content-type']??'unknown format'})`);}
          catch(error){quota ||= Boolean(error.quota);stats.warnings.push('Linked side-event programme: '+error.message);}
        }
        scripted.limitation=scripted.starts_at?'Only the explicit session reservation supplies timestamps; programme/PDF coverage remains limited':'Exact session schedule/room unconfirmed; parent meeting ranges and tentative reservations must not supply event timestamps';
        const purpose=description.match(/Against this background[\s\S]*?(?=Programme|$)/)?.[0]??'';
        const text=[item.title,purpose,scripted.organization,scripted.location].filter(Boolean).join(' ');
        const source=await observe(db,tracker.id,tracker.url,JSON.stringify({text,listing:item.content,responses:raw}),null,scripted,
          {listing:visibleText(item.content),description,structured:scripted,links:item.links},
          {rank:2,identity:id?`event:${url}`:`side-event:${tracker.url}:${url}`,item_key:url,links:item.links.slice(0,10)},now());
        stats[source.changed?'candidates':'skipped']++;pages.set(url,{source});
      }
      covered=selected.length<=3;
    } else if (riseup) {
      const clean=html=>html.replace(/<!--[\s\S]*?-->/g,'');
      const text=html=>visibleText(clean(html).replace(/&#(\d{1,7});/g,(_m,n)=>String.fromCodePoint(+n)).replace(/&#x([a-f0-9]{1,6});/gi,(_m,n)=>String.fromCodePoint(parseInt(n,16))));
      // Public Past Issues destination observed in the Navigator's Mailchimp issues.
      // Its archive is newer than the website list; signup and oversized RSS are unused.
      const archiveURL='https://us11.campaign-archive.com/home/?id=e2f06a2916&u=740487e7a7306085143176166';
      const archive=await read(archiveURL,budget);stats.pages++;
      if (archive.url!==archiveURL || !/<\/html>\s*$/.test(clean(archive.body)) || !archive.body.includes('id="archive-list"')) throw new Error('RISE UP public campaign archive unavailable');
      const rows=[...archive.body.matchAll(/<li class="campaign">(\d{2})\/(\d{2})\/(20\d{2}) - <a href="([^"]+)"[^>]*>[\s\S]*?<\/a><\/li>/g)].map(m=>({raw:m[0],url:m[4],day:dates(`${m[3]}-${m[1]}-${m[2]}`).start_on,month:`${m[3]}-${m[1]}`}));
      if (!rows.length || rows.length!==(archive.body.match(/<li class="campaign">/g)??[]).length || rows.some(r=>!r.day) || new Set(rows.map(r=>r.url)).size!==rows.length) throw new Error('RISE UP campaign archive date/issue identity unavailable');
      const latest=rows.sort((a,b)=>b.day.localeCompare(a.day))[0];
      if (rows.filter(r=>r.day===latest.day).length!==1) throw new Error('RISE UP latest archive day has multiple issues; selection needs review');
      // Only the publisher's observed eepurl link is upgraded to HTTPS, retaining its token.
      const issueURL=sourceURL(text(latest.url.replace(/^http:\/\/eepurl\.com\//,'https://eepurl.com/')));
      if (!/^https:\/\/(?:eepurl\.com\/[^/?]+|mailchi\.mp\/riseupfortheocean\.org\/[^/?]+|us11\.campaign-archive\.com\/\?)/.test(issueURL)) throw new Error('Unsupported RISE UP public issue link');
      const issue=await read(issueURL,budget);stats.pages++;
      const destination=new URL(issue.url),html=clean(issue.body),months=['January','February','March','April','May','June','July','August','September','October','November','December'];
      if (!(destination.hostname==='us11.campaign-archive.com' && destination.searchParams.get('u')==='740487e7a7306085143176166' && /^[a-f0-9]{10}$/.test(destination.searchParams.get('id')??'') || destination.hostname==='mailchi.mp'&&destination.pathname.startsWith('/riseupfortheocean.org/')) ||
          !/text\/html/i.test(issue.headers['content-type']??'') || !/<\/html>\s*$/.test(html) || !text(html).includes(`| ${months[+latest.month.slice(5)-1].toUpperCase()} ${latest.month.slice(0,4)}`)) throw new Error('RISE UP issue destination/publication month disagreement');
      const headings=[...html.matchAll(/<h([123])\b[^>]*>([\s\S]*?)<\/h\1>/gi)];
      const begin=headings.findIndex(m=>m[1]==='1'&&text(m[2])==='Updates'),end=headings.findIndex((m,i)=>i>begin&&m[1]==='1');
      if (begin<0 || end<0 || !headings.slice(begin+1,end).length || headings.slice(begin+1,end).some(m=>m[1]!=='2')) throw new Error('RISE UP Updates item layout unavailable');
      const items=headings.slice(begin+1,end).map((heading,index)=>{
        const block=html.slice(heading.index,headings[begin+index+2].index);
        const button=[...block.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a>/g)].find(m=>/mso-style-priority:100/.test(m[0])||/^Read More About /.test(text(m[0])));
        const body=button?block.slice(0,button.index+button[0].length):block,paragraphs=[...body.matchAll(/<p\b[^>]*>[\s\S]*?<\/p>/g)].filter(m=>!/<p\b[^>]*font-size:11px/.test(m[0])).map(m=>text(m[0])).filter(Boolean);
        if (!paragraphs.length) throw new Error('RISE UP Updates body unavailable');
        const link=button?sourceURL(text(button[1])):`heading:${hash(text(heading[2]))}`,links=[...new Set([...body.matchAll(/href="([^"]+)"/g)].map(m=>sourceURL(text(m[1]))))].sort();
        const when=paragraphs[0].match(/^From (\d{1,2})[–-](\d{1,2}) (January|February|March|April|May|June|July|August|September|October|November|December) (20\d{2}), .*?Summit\b/);
        const eventURL=links.find(u=>/^https:\/\/www\.fao\.org\/voluntary-guidelines-small-scale-fisheries\/home\/ssf-summit\/20\d{2}\/en$/.test(u));
        const event=Boolean(when&&eventURL),recording=/Watch the (?:Recording|Video)/i.test(text(button?.[0]??''));
        const date=when&&`${when[4]}-${String(months.indexOf(when[3])+1).padStart(2,'0')}-`;
        const schedule=dates(event?date+when[1].padStart(2,'0'):null,event?date+when[2].padStart(2,'0'):null);
        if (event&&(!schedule.start_on||!schedule.end_on||!eventURL.includes('/'+when[4]+'/'))) throw new Error('RISE UP summit date/edition disagreement');
        const sentences=paragraphs.join(' ').match(/[^.!?]+[.!?](?=\s|$)/g)?.map(s=>s.trim()).filter(s=>Array.from(s).length<=280)??[];
        const description=sentences.find(s=>s.startsWith('Participants exchanged practical experience'))??sentences[0]??null;
        return {body,link,links,paragraphs,scripted:{kind:event?'event':'announcement',title:text(heading[2]),description,organization:null,location:null,
          ...schedule,event_url:event?eventURL:null,registration_url:null,status:null,
          riseup:{publication_on:latest.day,recording,multiple:/Save the Date/i.test(paragraphs.join(' '))||!event&&!recording&&/\bwill (?:host|bring together)\b/i.test(paragraphs.join(' '))}}};
      });
      const action=headings.findIndex(m=>m[1]==='1'&&text(m[2])==='Take Action'),actionEnd=headings.findIndex((m,i)=>i>action&&m[1]==='1');
      const workshops=action<0||actionEnd<0?[]:headings.slice(action+1,actionEnd).filter(m=>m[1]==='3'&&text(m[2])==='BBNJ Webinar: Designing the BBNJ Clearing-House Mechanism');
      if (workshops.length>1) throw new Error('RISE UP technical workshop item identity ambiguous');
      const selected=items.slice(0,5);
      for (const heading of workshops) {
        const block=html.slice(heading.index,headings[headings.indexOf(heading)+1].index),buttons=[...block.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a>/g)].filter(m=>text(m[0])==='Register Here'),button=buttons.length===1?buttons[0]:null;
        const body=button&&block.slice(0,button.index+button[0].length),paragraphs=[...(body??'').matchAll(/<p\b[^>]*>[\s\S]*?<\/p>/g)].map(m=>text(m[0])).filter(Boolean);
        const link=button&&sourceURL(text(button[1]));
        if (!link || !/^https:\/\/[a-z0-9]+\.zoom\.us\/meeting\/register\/[\w-]+$/.test(link) || paragraphs.length!==1 || !paragraphs[0].includes('High Seas Alliance and partners will host the first in a series of virtual technical workshops')) throw new Error('RISE UP technical workshop body/registration unavailable');
        const description=paragraphs[0].match(/The session will focus [^.]+\./)?.[0];
        if (!description || Array.from(description).length>280) throw new Error('RISE UP technical workshop description unavailable');
        selected.push({body,link,links:[link],paragraphs,scripted:{kind:'event',title:text(heading[2]),description,organization:'High Seas Alliance and partners',location:null,
          ...dates(),event_url:null,registration_url:null,status:null,riseup:{publication_on:latest.day,recording:false,multiple:false,workshop:true}}});
      }
      if (new Set(items.map(i=>i.link)).size!==items.length) throw new Error('RISE UP issue has ambiguous repeated item links');
      stats.issues_listed=rows.length;stats.items_listed=items.length+workshops.length;
      stats.warnings.push('RISE UP uses the observed public Mailchimp archive because the configured website returns hosted HTTP 403 and its listing is stale. Up to five Updates items, one Take Action CHM workshop and their bounded FAO/Zoom details are covered; other issues, Member Spotlight, other advocacy calls, papers, calendar, PDFs/video and multiple-event items remain outside proven coverage. Publication is date-only; NGO treaty claims are not official actions');
      let details=0;
      for (const item of selected) {
        try {
          let detail=null;
          if (item.scripted.riseup.workshop) {
            try {
            detail=await read(item.link,budget);stats.pages++;
            const zoom=JSON.parse(detail.body.match(/\nregisterVO:(\{[^\n]+\}),?\s*\n/)?.[1]??'null'),canonical=zoom?.shareVO?.url;
            const final=new URL(detail.url),title=zoom?.meetingVO?.topic,agenda=zoom?.meetingVO?.agenda;
            const local=zoom?.viewerEmail?.match(/\nWhen: ([A-Z][a-z]{2}) (\d{1,2}), (20\d{2}) (0[1-9]|1[0-2]):([0-5]\d) (AM|PM) ([^\n]+)\n/);
            const newsletter=item.paragraphs[0].match(/^On (\d{1,2}) (\w+) at ([01]?\d|2[0-3]):([0-5]\d) Paris time\s*,/);
            if (!canonical || !/^https:\/\/[a-z0-9]+\.zoom\.us\/webinar\/register\/WN_[\w-]+$/.test(canonical) || final.origin+final.pathname!==canonical ||
                !/<\/html>\s*$/.test(detail.body) || !detail.body.includes(`property="og:url" content="${canonical}"`) || zoom.uuid!==canonical.split('/').pop() || zoom.recurringRegType!==null ||
                !title?.startsWith('Session 1 - Designing the BBNJ Clearing-House Mechanism:') || !agenda?.includes('The first session will focus on basic functions across the Agreement.') ||
                !agenda.includes(item.scripted.organization) || !local || !newsletter || (zoom.viewerEmail.match(/\nWhen:/g)??[]).length!==1 || local[7]!==zoom.timezoneVO?.timezoneName || !zoom.viewerEmail.includes(`Topic:  ${title}\n`)) throw new Error('RISE UP Zoom workshop identity/schedule unconfirmed');
            const month=months.findIndex(m=>m.startsWith(local[1]))+1,day=dates(`${local[3]}-${String(month).padStart(2,'0')}-${local[2].padStart(2,'0')}`).start_on;
            if (!day) throw new Error('RISE UP Zoom workshop date invalid');
            const localHour=+local[4]%12+(local[6]==='PM'?12:0),guess=Date.parse(`${day}T${String(localHour).padStart(2,'0')}:${local[5]}:00Z`);
            const clock=new Intl.DateTimeFormat('en-GB',{timeZone:zoom.timezoneVO.timezoneId,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
            const parts=Object.fromEntries(clock.formatToParts(new Date(guess)).map(p=>[p.type,p.value]));
            const start=2*guess-Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`);
            const verified=Object.fromEntries(clock.formatToParts(new Date(start)).map(p=>[p.type,p.value])),paris=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Paris',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(start)).map(p=>[p.type,p.value]));
            if (`${verified.year}-${verified.month}-${verified.day}`!==day || +verified.hour!==localHour || verified.minute!==local[5] || +paris.day!==+newsletter[1] || paris.month!==newsletter[2] || +paris.hour!==+newsletter[3] || paris.minute!==newsletter[4]) throw new Error('RISE UP newsletter/Zoom workshop clocks conflict');
            Object.assign(item.scripted,{title,...dates(new Date(start).toISOString()),event_url:canonical,registration_url:canonical});
            item.links.push(canonical);
            item.paragraphs.push(`Zoom registration: ${title}. ${zoom.viewerEmail.split('\nTopic:')[0].trim()} ${agenda}`);
            const existing=(await db.query("select id,title,organization,starts_at,event_url from scout.records where event_url=$1 or (kind='event' and title=$2 and organization=$3 and starts_at=$4)",[canonical,title,item.scripted.organization,new Date(start).toISOString()])).rows;
            if (existing.length) {
              if (existing.length!==1 || existing[0].event_url!==canonical || existing[0].title!==title || existing[0].organization!==item.scripted.organization || Date.parse(existing[0].starts_at)!==start) throw new Error('RISE UP retained registration facts conflict; session identity needs review');
              item.scripted.riseup.corroborates=existing[0].id;
            }
            } catch(error) {quota ||= Boolean(error.quota);stats.warnings.push(error.message);item.scripted.riseup.identity_unconfirmed=true;}
          } else if (item.scripted.kind==='event') {
            if (++details>1) throw new Error('RISE UP linked summit detail limit reached');
            detail=await read(item.scripted.event_url,budget);stats.pages++;
            const block=detail.body.match(/<div class="sfContentBlock sf-Long-text"[^>]*>([\s\S]*?The 3rd Small-Scale Fisheries Summit[\s\S]*?)<\/div>/)?.[1];
            const proof=text(block??''),when=item.paragraphs[0].match(/^From (\d{1,2})[–-](\d{1,2}) (\w+) (20\d{2}),/);
            if (detail.url!==item.scripted.event_url || !/<\/html>\s*$/.test(detail.body) || !proof.includes(`SSF Summit ${when[4]}`) || !proof.includes(`held from ${when[1]} to ${when[2]} ${when[3]}, at the FAO Headquarters in Rome, Italy`)) throw new Error('RISE UP newsletter/FAO summit schedule disagreement');
            item.scripted.location='FAO Headquarters in Rome';
          }
          const scripted=item.scripted,key=`${destination.searchParams.get('id')??destination.pathname}:${latest.month}:${item.link}${scripted.riseup.workshop?':workshop':''}`;
          const source=await observe(db,tracker.id,issue.url,JSON.stringify({text:[scripted.title,scripted.description,...item.paragraphs].filter(Boolean).join(' '),body:issue.body,archive:latest.raw,item:item.body,detail}),null,scripted,
            {text:[scripted.title,...item.paragraphs].join(' '),links:item.links,structured:scripted},
            {rank:2,identity:`riseup:${key}`,item_key:key,parent_url:tracker.url,links:item.links},now());
          stats[source.changed?'candidates':'skipped']++;pages.set(source.id,{source});
        } catch(error) {quota ||= Boolean(error.quota);stats.warnings.push(error.message);}
      }
      covered=true;
    } else if (harvest) {
      const home=await read(tracker.url,budget);stats.pages++;
      const listing='https://harveststrategies.org/what-are-harvest-strategies/resources-webinars/';
      const block=home.body.match(/id="Coming-Soon">[\s\S]*?(<h4\b[^>]*>[\s\S]*?)<div class="wp-block-buttons\b/)?.[1];
      const text=html=>visibleText(html.replace(/&#(\d{1,7});/g,(_m,n)=>String.fromCodePoint(+n)));
      const heading=block&&text(block.match(/<h4\b[^>]*>([\s\S]*?)<\/h4>/)?.[1]??'');
      const paragraphs=[...(block??'').matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map(m=>text(m[1]));
      const title=paragraphs[0],when=paragraphs[1]?.match(/^Date: (January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (20\d{2}), ([01]?\d|2[0-3]):([0-5]\d) GMT$/);
      const links=[...(block??'').matchAll(/href="([^"]+)"/g)].map(m=>sourceURL(text(m[1])));
      const registration=links[0],meeting=registration?.match(/^https:\/\/[a-z0-9]+\.zoom\.us\/meeting\/register\/([\w-]+)$/)?.[1];
      if (home.url!==tracker.url || !/<\/html>\s*$/.test(home.body) || !home.body.includes(`rel="canonical" href="${tracker.url}"`) || !home.body.includes(`href="${listing}"`) ||
          !['UPCOMING WEBINAR','CANCELLED WEBINAR','CANCELED WEBINAR'].includes(heading) || !title || !when || paragraphs.length!==3 || links.length!==1 || !meeting) throw new Error('Harvest current webinar identity/GMT schedule unavailable; archives are not upcoming events');
      const month=['January','February','March','April','May','June','July','August','September','October','November','December'].indexOf(when[1])+1;
      const day=dates(`${when[3]}-${String(month).padStart(2,'0')}-${when[2].padStart(2,'0')}`).start_on;
      if (!day) throw new Error('Invalid Harvest webinar date');
      const key=`${meeting}:${when[3]}`,cancelled=/CANCEL/.test(heading);
      const previous=(await db.query(`select * from scout.evidence where tracker_id=$1 and parsed#>>'{source,item_key}'=$2 and parsed->>'starts_at' is not null and record_id is not null
        order by coalesce((parsed#>>'{source,observed_at}')::timestamptz,collected_at) desc limit 1`,[tracker.id,key])).rows[0];
      if (previous && previous.parsed.title!==title) throw new Error('Harvest reused registration title changed; session identity needs review');
      const scripted={kind:'event',title,organization:null,location:null,description:null,...dates(day+'T'+when[4].padStart(2,'0')+':'+when[5]+':00Z'),
        event_url:registration,registration_url:registration,status:cancelled?'cancelled':'scheduled',harvest:{meeting,year:when[3]}};
      const raw=[home];let detail='',agenda='';
      try {
        const index=await read(listing,budget);stats.pages++;raw.push(index);
        const section=index.body.match(/<h4 class="wp-block-heading">Our (?:upcoming|cancelled|canceled) webinar: ([\s\S]*?)<\/h4>([\s\S]*?)<\/ul> <\/li>[\s\S]*?<\/ul>/);
        if (index.url!==listing || !/<\/html>\s*$/.test(index.body) || !index.body.includes(`rel="canonical" href="${listing}"`) || !section || text(section[1])!==title ||
            new Set([...section[0].matchAll(/href="([^"]+)"/g)].map(m=>sourceURL(text(m[1])))).size!==1 || !section[0].includes(registration)) throw new Error('Harvest webinar detail/registration identity disagreement');
        detail=text(section[0]);
        const expected=new Date(scripted.starts_at).toLocaleDateString('en-US',{timeZone:'UTC',weekday:'long',month:'long',day:'numeric',year:'numeric'});
        const date=detail.match(/Date: (.*?) Duration:/)?.[1],duration=detail.match(/Duration: (\d+(?:\.\d+)?) hours? Description:/)?.[1];
        const description=detail.match(/Description: (.*?) Featured Speakers:/)?.[1];
        if (date!==expected || !duration || +duration<=0 || +duration>24 || !description) throw new Error('Harvest webinar detail date/duration/description disagreement');
        const response=await read(registration,budget);stats.pages++;raw.push(response);
        const zoom=JSON.parse(response.body.match(/\nmeeting: (\{[^\n]+\}),\s*\n/)?.[1]??'null');
        const zone=response.body.match(/\ntimezoneId: "([^"]+)"/)?.[1],local=response.body.match(/\nmeetingTime: '([A-Z][a-z]{2}) (\d{1,2}), (\d{4}) (\d{2}):([0-5]\d) (AM|PM)'/);
        if (response.url!==registration || !/<\/html>\s*$/.test(response.body) || !zoom || normalize(zoom.topic)!==title || typeof zoom.agenda!=='string' || !zone || !local) throw new Error('Harvest Zoom identity/schedule unavailable');
        const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:zone,month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true}).formatToParts(new Date(scripted.starts_at)).map(p=>[p.type,p.value]));
        if (['month','day','year','hour','minute','dayPeriod'].some((k,i)=>parts[k]!==local[i+1])) throw new Error('Harvest publisher/Zoom clocks conflict');
        agenda=normalize(zoom.agenda.split(/\n\s*\n/)[0]);
        if (agenda.replace(/\s/g,'')!==description.replace(/\s/g,'')) throw new Error('Harvest publisher/Zoom descriptions conflict');
        scripted.ends_at=new Date(Date.parse(scripted.starts_at)+Number(duration)*3600000).toISOString();
        scripted.end_on=scripted.ends_at.slice(0,10);
        scripted.description=agenda.match(/[^.!?]+[.!?](?=\s|$)/g)?.map(s=>s.trim()).filter(s=>Array.from(s).length<=280).at(-1)??null;
      } catch(error) {
        // A publisher can cancel an established session after its registration disappears.
        if (!cancelled || previous?.parsed.title!==title || previous.parsed.starts_at!==scripted.starts_at || !previous.record_id || /disagreement|conflict/.test(error.message)) throw error;
        stats.warnings.push(`Harvest cancellation retained from publisher; supporting detail unavailable: ${error.message}`);
        Object.assign(scripted,dates(),{description:null});detail='';agenda='';
      }
      stats.warnings.push('Harvest covers the one named current webinar in at most three reads; archived recordings, ABNJ resource cards, factsheets, tools, PDFs, videos, translations and other sessions remain outside this slice');
      const source=await observe(db,tracker.id,tracker.url,JSON.stringify({text:[title,heading,paragraphs[1],agenda].filter(Boolean).join(' '),responses:raw}),null,scripted,
        {listing:text(block),detail,agenda,structured:scripted},
        {rank:2,identity:`harvest:meeting:${key}`,item_key:key,links:[listing,registration]},now());
      stats[source.changed?'candidates':'skipped']++;pages.set(source.id,{source});covered=true;
    } else if (symposium) {
      const home=await read(tracker.url,budget);stats.pages++;
      const valid=(page,url)=>page.url===url&&/<\/html>\s*$/.test(page.body)&&page.body.includes(`property="og:url" content="${url.replace(/\/$/,'')}"`);
      const text=html=>visibleText(html.replace(/&#(\d{1,7});/g,(_m,n)=>String.fromCodePoint(+n)));
      const sentence=value=>value.match(/[^.!?]+[.!?](?=\s|$)/g)?.map(s=>s.trim()).filter(s=>Array.from(s).length<=280)??[];
      if (!valid(home,tracker.url)) throw new Error('Symposium home unavailable');
      const editions=[...home.body.matchAll(/field="li_title__(\d+)">([\s\S]*?)<\/span>/g)].map(m=>({id:m[1],title:text(m[2]),year:m[2].match(/href="https:\/\/bbnjsymposium\.org\/(20\d\d)"/)?.[1]})).filter(r=>r.year).sort((a,b)=>b.year.localeCompare(a.year));
      if (!editions.length || new Set(editions.map(e=>e.year)).size!==editions.length) throw new Error('Symposium annual timeline ambiguous');
      const edition=editions[0],year=edition.year,editionURL=SYMPOSIUM+year;
      const timeline=home.body.match(new RegExp(`field="li_descr__${edition.id}">([\\s\\S]*?)<\\/div>`))?.[1],summary=timeline&&text(timeline.split(/<br\s*\/?\s*>/)[0]);
      const date=summary?.match(/was held on (\d{1,2})-(\d{1,2}) March (20\d\d) at the (.+?), and focused/);
      const calendar=date&&date[3]===year?dates(`${year}-03-${date[1].padStart(2,'0')}`,`${year}-03-${date[2].padStart(2,'0')}`):dates();
      if (!summary || !calendar.start_on || !calendar.end_on || !edition.title.includes(year)) throw new Error('Symposium parent edition date/content unconfirmed');
      const base={organization:null,location:null,event_url:null,registration_url:null,status:null,...dates()};
      const items=[{page:home,key:'edition',text:summary,html:timeline,links:[editionURL],scripted:{...base,kind:'event',title:edition.title,description:sentence(summary)[0]??null,...calendar,location:date[4],event_url:editionURL}}];
      stats.warnings.push('Symposium covers the latest explicit timeline edition, named Friday workshop and four matching technical panel recordings. Oversized edition pages, full programmes, other satellite sessions/recordings, PDFs, reports and verified participation schedules remain outside this slice; no completed coverage is claimed');
      for (const [kind,path] of [['workshop',`satellite-events-${year}`],['recording',`session_recordings_${year}`]]) try {
        const url=SYMPOSIUM+path;
        if (!home.body.includes(`href="/${path}"`)) throw new Error('Symposium observed source link unavailable');
        const page=await read(url,budget);stats.pages++;
        if (!valid(page,url)) throw new Error('Symposium detail destination/format unavailable');
        if (kind==='workshop') {
          const blocks=page.body.split(/(?=<div id="rec\d+" class="r t-rec\b)/).filter(b=>/field="text"><strong>Friday Workshop:/.test(b));
          if (blocks.length!==1 || !page.body.includes(`<title>Satellite events ${year}</title>`)) throw new Error('Symposium named workshop boundary ambiguous');
          const block=blocks[0],id=block.match(/^<div id="rec(\d+)"/)?.[1],body=block.match(/class="t166__text t-text t-text_md" field="text">([\s\S]*?)<\/div>/)?.[1];
          const title=body&&text(body.match(/^<strong>([\s\S]*?)<\/strong>/)?.[1]??''),description=body&&text(body.match(/<em>([\s\S]*?)<\/em>/)?.[1]??'');
          const organization=description?.match(/, the (.+?) \(funded by the European Union\) will host/)?.[1]??null;
          const address=block.match(/class="t166__textsmall[^>]*field="title"><strong>Address<\/strong>([\s\S]*?)<\/div>/)?.[1];
          if (!id || !title || !description || !organization || !address) throw new Error('Symposium workshop facts unavailable');
          const heading=text(page.body.match(/class="t183__title\b[^>]*field="title">([\s\S]*?)<\/div>/)?.[1]??'');
          const subtitle=text(page.body.match(/class="t183__uptitle\b[^>]*field="subtitle">([\s\S]*?)<\/div>/)?.[1]??'');
          const local=description.match(/^On (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) (\d{1,2}) March,/),day=local&&dates(`${year}-03-${local[2].padStart(2,'0')}`).start_on;
          const confirmed=day&&heading===`Satellite Events Third BBNJ Symposium ${year}`&&subtitle.match(/March (20\d\d)\b/)?.[1]===year&&new Date(day+'T00:00:00Z').toLocaleDateString('en-US',{weekday:'long',timeZone:'UTC'})===local[1];
          // The same-page edition establishes the year; this workshop supplies
          // its own weekday/month/day. No parent range or clock is inherited.
          const schedule=dates(confirmed?day:null),date_parts={heading,subtitle,session:local?.[0]??null,confirmed:Boolean(confirmed)};
          if (!confirmed) stats.warnings.push('Symposium workshop date components disagree; date remains unknown');
          items.push({page,key:`workshop:${id}`,text:text(body)+' '+text(address)+' '+heading+' '+subtitle,html:block,links:[],scripted:{...base,...schedule,kind:'event',title,organization,description:sentence(description)[0]??null,location:text(address),event_url:url,date_parts}});
        } else {
          if (!page.body.includes(`<title>Session Recordings ${year}</title>`)) throw new Error('Symposium recording edition unconfirmed');
          const cards=[...page.body.matchAll(/<li\b[^>]*class="[^"]*\bt-card__col\b[^"]*"[^>]*>([\s\S]*?)<\/li>/g)].map(m=>{
            const heading=m[1].match(/class="t-card__title[^>]*field="li_title__(\d+)">\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/),title=heading&&text(heading[3]);
            const body=heading&&m[1].match(new RegExp(`field="li_descr__${heading[1]}">([\\s\\S]*?)<\\/div>`))?.[1];
            return {html:m[0],title,body:body?.split(/<br\s*\/?\s*>/)[0],number:title?.match(/^Panel (\d+):/)?.[1],url:heading?.[2]};
          }).filter(c=>c.number);
          if (!cards.length || new Set(cards.map(c=>c.number)).size!==cards.length || cards.some(c=>!c.body||!c.url)) throw new Error('Symposium recording cards ambiguous');
          const selected=cards.filter(c=>/interoperable|Scientific and Technical Body|marine technolog|Clearing.House/i.test(text(c.body))).slice(0,4);
          for (const card of selected) {
            const link=new URL(text(card.url));if (link.hostname!=='www.youtube.com'||!(link.pathname==='/watch'&&/^[\w-]{11}$/.test(link.searchParams.get('v')??'')||/^\/live\/[\w-]{11}$/.test(link.pathname))) throw new Error('Symposium recording link unconfirmed');
            link.searchParams.delete('si');const recording=sourceURL(link.href),body=text(card.body),sentences=sentence(body);
            items.push({page,key:`recording:panel:${card.number}`,text:card.title+' '+body,html:card.html,links:[recording],scripted:{...base,kind:'announcement',title:card.title,description:sentences.find(s=>/interoperable|Clearing.House|marine technolog/i.test(s))??sentences[0]??null}});
          }
        }
      } catch(error) {stats.warnings.push(`${kind}: ${error.message}`);}
      for (const item of items) {
        const scripted={...item.scripted,symposium:{edition:year,key:item.key}},source=await observe(db,tracker.id,item.page.url,JSON.stringify({text:scripted.title+' '+item.text,body:item.page.body,item:item.html}),null,scripted,{text:item.text,structured:scripted,links:item.links},
          {rank:2,identity:`symposium:${year}:${item.key}`,item_key:`${year}:${item.key}`,parent_url:editionURL,links:item.links},now());
        stats[source.changed?'candidates':'skipped']++;pages.set(source.id,{source});
      }
      covered=true;
    } else if (blueMarine) {
      const home=await read(tracker.url,budget);stats.pages++;
      const main=home.body.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1];
      const complete=page=>/<\/html>\s*$/.test(page.body.replace(/<!--[\s\S]*?-->/g,''));
      const text=html=>visibleText(html.replace(/&#(\d{1,7});/g,(_m,n)=>String.fromCodePoint(+n)).replace(/&#x([a-f0-9]{1,6});/gi,(_m,n)=>String.fromCodePoint(parseInt(n,16))));
      if (home.url!==tracker.url || !main || !complete(home) || !home.body.includes(`rel="canonical" href="${tracker.url}"`)) throw new Error('Blue Marine listing unavailable');
      const rows=[...main.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/g)].map(m=>({card:m[0],
        url:m[1].match(/href="(https:\/\/www\.bluemarinefoundation\.com\/our-events\/[^"?#]+\/)"/)?.[1],
        title:text(m[1].match(/<h[34] class="(?:featureCard|cards)__title">([\s\S]*?)<\/h[34]>/)?.[1]??'')}));
      if (!rows.length || rows.some(r=>!r.url||!r.title) || new Set(rows.map(r=>r.url)).size!==rows.length) throw new Error('Blue Marine listing cards ambiguous');
      const relevant=rows.filter(r=>/conference|summit|ocean hub|\bCOP\d+|\bBBNJ\b|high.seas|treaty/i.test(r.title)),selected=relevant.slice(0,LIMITS.pages-1);
      stats.events_listed=rows.length;stats.events_selected=selected.length;
      stats.warnings.push(`Blue Marine covers the first ${selected.length} of ${relevant.length} matching listing cards and explicitly named workshop recaps; remaining cards, archive pages, full programmes, PDFs and unverified registration/session schedules remain outside this slice. Upcoming badges do not establish status`);
      for (const row of selected) try {
        const page=await read(row.url,budget);stats.pages++;
        const id=page.body.match(/<link rel="alternate" title="JSON" type="application\/json" href="https:\/\/www\.bluemarinefoundation\.com\/wp-json\/wp\/v2\/events\/(\d+)"/)?.[1];
        const title=text(page.body.match(/<h1 class="postBanner__title animTitle">([\s\S]*?)<\/h1>/)?.[1]??'');
        const content=page.body.match(/<div id="post-content"[^>]*>([\s\S]*?)<section id="media" class="related events\b/)?.[1];
        const body=content?.match(/<section\s+class="postContent\b[^>]*>([\s\S]*?)<\/section>/)?.[1];
        const years=title.match(/\b20\d\d\b/g)??[];
        if (page.url!==row.url || !complete(page) || !id || !body || title!==row.title || years.length!==1 || !row.url.includes(years[0]) || !page.body.includes(`rel="canonical" href="${row.url}"`)) throw new Error('Blue Marine detail identity/content unavailable');
        const dateText=text(content.match(/<h5 class="sidebar__title">Dates<\/h5>\s*<div[^>]*>\s*<p>([^<]+)<\/p>/)?.[1]??'');
        const location=text(content.match(/<h5 class="sidebar__title">Location<\/h5>\s*<div[^>]*>\s*<p>([^<]+)<\/p>/)?.[1]??'')||null;
        const range=dateText.match(/^(\d{1,2})(?:[-–](\d{1,2}))? (January|February|March|April|May|June|July|August|September|October|November|December) (20\d\d)$/);
        const iso=day=>`${range[4]}-${String(['January','February','March','April','May','June','July','August','September','October','November','December'].indexOf(range[3])+1).padStart(2,'0')}-${day.padStart(2,'0')}`;
        const schedule=range&&range[4]===years[0]?dates(iso(range[1]),iso(range[2]??range[1])):dates();
        const cardDate=text(row.card.match(/<p class="(?:featureCard|cards)__dateText infoText">([^<]+)<\/p>/)?.[1]??'');
        const heroDate=text(page.body.match(/<p class="postBanner__dateText">([^<]+)<\/p>/)?.[1]??'');
        if (!schedule.start_on || !schedule.end_on || [cardDate,heroDate].some(d=>d!==dateText&&d+' '+years[0]!==dateText)) throw new Error('Blue Marine parent date range unconfirmed');
        const paragraphs=[...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map(m=>({html:m[1],text:text(m[1])})).filter(p=>p.text);
        const workshops=paragraphs.filter(p=>/^Blue Marine Foundation hosted a workshop alongside the event on /.test(p.text));
        if (!paragraphs.length || workshops.length>1) throw new Error('Blue Marine paragraph/session boundary unavailable');
        const workshop=workshops[0],at=paragraphs.indexOf(workshop);
        const parent=paragraphs.slice(0,workshop?at:paragraphs.length).map(p=>p.text).join(' ');
        const links=[...new Set([...content.matchAll(/href="([^"]+)"/g)].map(m=>{try{return sourceURL(new URL(text(m[1]),row.url).href);}catch{return null;}}).filter(Boolean))].sort();
        const sentence=value=>value.match(/[^.!?]+[.!?](?=\s|$)/g)?.map(s=>s.trim()).find(s=>Array.from(s).length<=280)??null;
        const items=[{key:'event',text:parent,scripted:{kind:'event',title,organization:null,description:sentence(parent),...schedule,location,event_url:row.url,registration_url:null,status:null}}];
        if (workshop) {
          const name=text(workshop.html.match(/<strong>([\s\S]*?)<\/strong>/)?.[1]??''),recap=paragraphs.slice(at+1).map(p=>p.text).join(' ');
          if (!name || !recap || !sentence(recap)) throw new Error('Blue Marine named workshop recap unavailable');
          // The recap gives 17 February without its own year/clock/place. Keep it an
          // announcement; the parent conference's 18–20 dates are not session facts.
          items.push({key:'workshop',text:workshop.text+' '+recap,
            scripted:{kind:'announcement',title:name,organization:'Blue Marine Foundation',description:sentence(recap),...dates(),location:null,event_url:null,registration_url:null,status:null}});
        }
        for (const item of items) {
          const key=`${id}:${years[0]}:${item.key}`,scripted={...item.scripted,blue_marine:{id,edition:years[0],recap:item.key!=='event'}};
          const source=await observe(db,tracker.id,row.url,JSON.stringify({text:scripted.title+' '+item.text+(scripted.kind==='event'?' '+dateText+' '+location:''),body:page.body,card:row.card}),null,scripted,{text:item.text,structured:scripted,links},
            {rank:2,identity:`bluemarine:${key}`,item_key:key,parent_url:tracker.url,links},now());
          stats[source.changed?'candidates':'skipped']++;pages.set(source.id,{source});
        }
      } catch(error) {stats.warnings.push(`${row.url}: ${error.message}`);}
      covered=true;
    } else if (oceancare) {
      const home=await read(tracker.url,budget);stats.pages++;
      const listing=OCEANCARE+'stories-and-news/';
      if (home.url!==tracker.url || !/<\/html>\s*$/.test(home.body.replace(/<!--[\s\S]*?-->/g,'')) || !home.body.includes(`rel="canonical" href="${tracker.url}"`) || !home.body.includes(`href="${listing}"`)) throw new Error('OceanCare listing discovery unavailable');
      const index=await read(listing,budget);stats.pages++;
      const main=index.body.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1];
      if (index.url!==listing || !main || !/<\/html>\s*$/.test(index.body.replace(/<!--[\s\S]*?-->/g,'')) || !index.body.includes(`rel="canonical" href="${listing}"`)) throw new Error('OceanCare listing unavailable');
      const text=html=>visibleText(html.replace(/&#(\d{1,7});/g,(_m,n)=>String.fromCodePoint(+n)).replace(/&#x([a-f0-9]{1,6});/gi,(_m,n)=>String.fromCodePoint(parseInt(n,16))));
      const rows=[...main.matchAll(/<a href="(https:\/\/www\.oceancare\.org\/en\/stories_and_news\/[^"?#]+\/)">([\s\S]*?)<\/a>/g)].map(m=>({url:m[1],card:m[0],title:text(m[2].match(/<div class="headline">([\s\S]*?)<\/div>/)?.[1]??''),date:m[2].match(/<span class="date">([^<]+)<\/span>/)?.[1]}));
      if (!rows.length || rows.some(r=>!r.title) || new Set(rows.map(r=>r.url)).size!==rows.length) throw new Error('OceanCare listing cards unavailable/ambiguous');
      const relevant=rows.filter(r=>/\bbbnj\b|high[ -]seas|clearing.house/i.test(r.title+' '+r.url)),selected=relevant.slice(0,LIMITS.pages-2);
      stats.articles_listed=rows.length;stats.articles_selected=selected.length;
      stats.warnings.push(`OceanCare title/URL filter selected ${selected.length} of ${relevant.length} matching articles; other ${rows.length-relevant.length} articles, remaining matches, PDFs, translations and dedicated event/session schedules remain outside this slice`);
      for (const row of selected) try {
        const page=await read(row.url,budget);stats.pages++;
        const id=page.body.match(/<body\b[^>]*class="[^"]*\bpostid-(\d+)\b/)?.[1];
        const article=page.body.match(/<h1>([\s\S]*?)<\/h1><div class="by"><span class="date">([^<]+)<\/span><\/div>([\s\S]*?)<div class="oc-share-wrapper">/);
        const publishedRaw=page.body.match(/<meta property="article:published_time" content="([^"]+)"/)?.[1],published=dates(publishedRaw).starts_at;
        const graph=JSON.parse(page.body.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/)?.[1]??'null')?.['@graph'];
        const metadata=graph?.find(n=>n['@type']==='Article'&&n['@id']===row.url+'#richSnippet');
        const title=article&&text(article[1]),date=new Date(publishedRaw?.slice(0,10)+'T00:00:00Z');
        if (page.url!==row.url || !id || !article || !published || !metadata || metadata.datePublished!==publishedRaw || metadata.publisher?.['@id']!==OCEANCARE+'#organization/' ||
            !/<\/html>\s*$/.test(page.body.replace(/<!--[\s\S]*?-->/g,'')) || !page.body.includes(`rel="canonical" href="${row.url}"`) || !page.body.includes('single-storeisnews') ||
            !page.body.includes(`data-title="${article[1]}"`) || !/\bbbnj\b|high[ -]seas|clearing.house/i.test(title) ||
            article[2]!==date.toLocaleDateString('en-US',{timeZone:'UTC',month:'long',day:'numeric',year:'numeric'}) ||
            row.date&&Date.parse(row.date+' UTC')!==Date.parse(publishedRaw.slice(0,10)+'T00:00:00Z')) throw new Error('OceanCare article identity/content/publication disagreement');
        const blocks=[...article[3].matchAll(/<(p|h[2-6]|li)\b[^>]*>[\s\S]*?<\/\1>/g)].map(m=>m[0]),content=blocks.join('\n');
        const paragraphs=blocks.filter(b=>/^<p\b/.test(b)).map(text),context=paragraphs.find(p=>/Clearing-House Mechanism/.test(p)&&/prototype/.test(p))??paragraphs.find(p=>/Clearing-House Mechanism/.test(p))??paragraphs[0];
        if (!context || paragraphs.length<2) throw new Error('OceanCare article paragraphs unavailable');
        const seen=(await db.query('select 1 from scout.evidence where tracker_id=$1 and url=$2 limit 1',[tracker.id,row.url])).rows.length;
        if (published<new Date(since).toISOString()&&!seen) continue;
        const sentences=context.match(/[^.!?]+[.!?](?=\s|$)/g)?.map(s=>s.trim()).filter(s=>Array.from(s).length<=280)??[];
        const description=sentences.find(s=>/Clearing-House Mechanism/.test(s))??sentences[0]??null;
        const scripted={kind:'announcement',title,organization:'OceanCare',description,location:null,starts_at:null,ends_at:null,event_url:null,registration_url:null,status:null,oceancare:{id}};
        const links=[...new Set([...content.matchAll(/href="([^"]+)"/g)].map(m=>{try{return sourceURL(new URL(text(m[1]),row.url).href);}catch{return null;}}).filter(Boolean))].sort();
        const source=await observe(db,tracker.id,row.url,JSON.stringify({text:title+' '+context,body:page.body,card:row.card}),published,scripted,{text:text(article[3]),links,published_at:published,structured:scripted},
          {rank:2,identity:`oceancare:post:${id}`,item_key:id,parent_url:listing},now());
        stats[source.changed?'candidates':'skipped']++;pages.set(source.id,{source});
      } catch(error) {stats.warnings.push(`${row.url}: ${error.message}`);}
      covered=true;
    } else if (gof) {
      const home=await read(tracker.url,budget);stats.pages++;
      const projectURL=GOF+'8624-2/',apiURL=GOF+'wp-json/wp/v2/pages/8624';
      if (home.url!==tracker.url || !/<\/html>\s*$/.test(home.body.replace(/<!--[\s\S]*?-->/g,'')) || !home.body.includes(`rel="canonical" href="${tracker.url}"`) || !home.body.includes(`href="${projectURL}">BBNJ G&#038;R Project</a>`)) throw new Error('GOF project discovery unavailable');
      const page=await read(projectURL,budget);stats.pages++;
      if (page.url!==projectURL || !/<\/html>\s*$/.test(page.body.replace(/<!--[\s\S]*?-->/g,'')) || !page.body.includes('article id="post-8624"') || !page.body.includes(`rel="canonical" href="${projectURL}"`) || !page.body.includes(`type="application/json" href="${apiURL}"`)) throw new Error('GOF project detail/API identity unavailable');
      const response=await read(apiURL,budget);stats.pages++;
      if (response.url!==apiURL || !/application\/json/i.test(response.headers['content-type']??'')) throw new Error('Unexpected GOF project API destination/format');
      const article=JSON.parse(response.body),published=dates(article.date_gmt+'Z').starts_at;
      if (article.id!==8624 || article.type!=='page' || article.status!=='publish' || article.link!==projectURL || !published || article.content?.protected!==false || typeof article.content.rendered!=='string') throw new Error('GOF project API facts unavailable');
      const text=html=>visibleText(html.replace(/&#(\d{1,7});/g,(_m,n)=>String.fromCodePoint(+n)).replace(/&#x([a-f0-9]{1,6});/gi,(_m,n)=>String.fromCodePoint(parseInt(n,16))));
      const body=article.content.rendered,first=body.match(/^\s*<p\b[^>]*>([\s\S]*?)<\/p>/)?.[1],title=text(first?.split(/<br\s*\/?\s*>/)[1]??'');
      const updates=body.match(/<h4 class="wp-block-heading">Updates on UNEP-led Outputs<\/h4>([\s\S]*?)<hr\b/)?.[1];
      if (!title || !updates || !/<\/p>\s*$/.test(body) || !text(page.body).includes(title)) throw new Error('GOF project content boundary unavailable');
      const paragraphs=[...updates.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map(m=>({html:m[0],text:text(m[1])}));
      const workshop=paragraphs.filter(p=>/will also be featured in Workshop \d+,/.test(p.text)),project=paragraphs.filter(p=>!workshop.includes(p));
      if (!project.length || workshop.length>1 || paragraphs.some(p=>!text(page.body).includes(p.text))) throw new Error('GOF project update/detail disagreement');
      stats.warnings.push('GOF covers the linked BBNJ G&R project and its named upcoming workshop in three reads; homepage recaps, other projects, the older RSS/archive, PDFs and full programmes remain outside this slice');
      const items=[{key:'project',kind:'announcement',title,organization:'Global Ocean Forum',context:project.find(p=>p.text.startsWith('Since kickoff,'))?.text??project.map(p=>p.text).join(' '),
        content:body.replace(workshop[0]?.html??'','').split(/<p\b[^>]*><strong>PROJECT AT-A-GLANCE<\/strong>/)[0]}];
      for (const item of workshop) {
        const session=item.text.match(/will also be featured in Workshop (\d+),/),name=item.html.match(/<em>([^<]+)<\/em>/),conference=item.html.match(/href="(https:\/\/www\.unep\.org\/gef\/events\/conference\/(\d+)-gef-international-waters-conference-iwc\2)"/),edition=item.text.match(/\(IWC(\d+)\).* from (\d{1,2}) to (\d{1,2}) ([A-Z][a-z]+) (20\d{2})\./);
        if (!session || !name || !conference || !edition || conference[2]!==edition[1]) {stats.warnings.push('GOF workshop edition/identity unavailable');continue;}
        items.push({key:`iwc${edition[1]}:${edition[5]}:workshop${session[1]}`,kind:'event',title:text(name[1]),organization:null,context:item.text,content:item.html,
          parent:conference[1],edition:edition[1],year:edition[5],session:session[1]});
        stats.warnings.push('GOF workshop schedule, organizer and registration remain unconfirmed: UNEP returned HTTP 403 during discovery; its observed IW:LEARN alternative and HTML agenda identify the parent conference, not the specific session. PDF programme remains unparsed');
      }
      const seen=(await db.query('select 1 from scout.evidence where tracker_id=$1 and url=$2 limit 1',[tracker.id,projectURL])).rows.length;
      if (published>=new Date(since).toISOString()||seen) for (const item of items) {
        const sentences=item.context.match(/[^.!?]+[.!?](?=\s|$)/g)?.map(s=>s.trim()).filter(s=>Array.from(s).length<=280)??[];
        const description=sentences.find(s=>s.startsWith('Work has started'))??sentences[0]??null;
        const scripted={kind:item.kind,title:item.title,description,organization:item.organization,location:null,starts_at:null,ends_at:null,event_url:null,registration_url:null,status:null,
          gof:{id:8624,item:item.key,...(item.parent?{parent_conference:item.parent,edition:item.edition,year:item.year,session:item.session,schedule_unconfirmed:true}:{})}};
        const links=[...new Set([...item.content.matchAll(/href="([^"]+)"/g)].map(m=>{try{return sourceURL(new URL(text(m[1]),projectURL).href);}catch{return null;}}).filter(Boolean))].sort();
        const source=await observe(db,tracker.id,projectURL,JSON.stringify({text:item.title+' '+item.context,body:page.body,api:response,item:item.content}),published,scripted,
          {text:text(item.content),links,published_at:published,structured:scripted},
          {rank:2,identity:`gof:8624:${item.key}`,item_key:item.key,parent_url:tracker.url},now());
        stats[source.changed?'candidates':'skipped']++;pages.set(source.id,{source});
      }
      covered=true;
    } else if (iucn) {
      const home=await read(tracker.url,budget);stats.pages++;
      if (home.url!==tracker.url || !/<\/html>\s*$/.test(home.body) || !home.body.includes(`rel="canonical" href="${tracker.url}"`) || !home.body.includes('Topic Search View')) throw new Error('IUCN High Seas discovery unavailable');
      const text=html=>visibleText(html.replace(/&#(\d{1,7});/g,(_m,n)=>String.fromCodePoint(+n)).replace(/&#x([a-f0-9]{1,6});/gi,(_m,n)=>String.fromCodePoint(parseInt(n,16))));
      const rows=[...home.body.matchAll(/<li>\s*<div class="wrapper-line">([\s\S]*?)<\/li>/g)].map(m=>{
        const title=m[1].match(/<div class="wrapper-title">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
        return {url:title&&sourceURL(new URL(text(title[1]),tracker.url).href),title:text(title?.[2]??''),
          type:text(m[1].match(/<span class="label">([^<]+)<\/span>/)?.[1]??''),
          publication:text(m[1].match(/<span class="search-date">([\s\S]*?)<\/span>/)?.[1]??''),
          instant:m[1].match(/<time datetime="([^"]+)"/)?.[1]??null,raw:m[0]};
      });
      if (!rows.length || rows.length>12 || rows.some(r=>!r.url||!r.title||!r.type||!r.publication) || new Set(rows.map(r=>r.url)).size!==rows.length) throw new Error('Invalid IUCN topic listing');
      stats.articles_listed=rows.length;
      const blog=home.body.match(/<span class="label">Blog<\/span>\s*<span class="date">([^<]+)<\/span>[\s\S]*?<a class="primary-link" href="(https:\/\/iucn\.org\/blog\/[^"?]+)"><span>([^<]+)<\/span><\/a>/);
      const selected=[...rows,...(blog?[{url:blog[2],title:text(blog[3]),type:'Blog',publication:text(blog[1]),instant:null,raw:blog[0]}]:[])]
        .sort((a,b)=>(({ 'Information brief':0,'Policy brief':1,Blog:2 }[a.type]??3)-({ 'Information brief':0,'Policy brief':1,Blog:2 }[b.type]??3)));
      const seen=(await db.query('select distinct url from scout.evidence where tracker_id=$1',[tracker.id])).rows.map(r=>r.url);
      stats.articles_selected=selected.length;
      stats.warnings.push('IUCN covers five details from the current topic results/featured blog, prioritizing information and policy briefs; archives, dedicated events/registration, older featured stories, PDFs and other linked resources remain outside this slice. Resource years do not establish publication days');
      if (selected.length>LIMITS.pages-1) stats.warnings.push(`IUCN page limit: ${selected.length-LIMITS.pages+1} listed items not followed`);
      // Count detail attempts, including failures, within the existing page allowance.
      for (const item of selected.slice(0,LIMITS.pages-1)) {
        try {
          const resource=/^https:\/\/iucn\.org\/(?:index%2Ephp\/)?resources\/(?:information-brief|policy-brief|dataset)\/[^/?]+$/.test(item.url);
          if (!(resource&&['Information brief','Policy brief','Dataset'].includes(item.type)) && !(/^https:\/\/iucn\.org\/(?:index%2Ephp\/)?(?:news|blog)\/\d{6}\/[^/?]+$/.test(item.url)&&['News','Blog'].includes(item.type))) throw new Error('Unsupported IUCN detail type; session or resource needs separate proof');
          const day=new Date(item.publication.replace(',','')+' 00:00:00 GMT');
          const publication=resource?/^20\d{2}$/.test(item.publication)?item.publication:null:
            /^\d{2} [A-Z][a-z]{2}, 20\d{2}$/.test(item.publication)&&Number.isFinite(+day)&&day.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric',timeZone:'UTC'})===item.publication.replace(',','')?day.toISOString().slice(0,10):null;
          const published=item.instant?dates(item.instant).starts_at:null;
          if (!publication || item.instant&&(!published||item.instant.slice(0,10)!==publication)) throw new Error('IUCN publication precision/date unavailable');
          if (publication<(resource?since.slice(0,4):since.slice(0,10))&&!seen.includes(item.url)) continue;
          const response=await read(item.url,budget);stats.pages++;
          if (response.url!==item.url || !/text\/html/i.test(response.headers['content-type']??'') || !/<\/html>\s*$/.test(response.body) || !response.body.includes(`rel="canonical" href="${item.url}"`)) throw new Error('Unexpected IUCN detail destination/format');
          const article=response.body.match(/<article data-history-node-id="(\d+)" class="node node--type-(resource|article)\b[^>]*>([\s\S]*?)<\/article>/);
          if (!article || (article[2]==='resource')!==resource || !response.body.includes(`rel="shortlink" href="https://iucn.org/${item.url.includes('/index%2Ephp/')?'index%2Ephp/':''}node/${article[1]}"`)) throw new Error('IUCN detail identity unavailable');
          const title=text(article[3].match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1]??'');
          const detailDate=resource?response.body.match(/name="dcterms.date" content="([^"]+)"/)?.[1]:text(article[3].match(/<span class="date">([^<]+)<\/span>/)?.[1]??'');
          if (!title || !title.startsWith(item.title.replace(/(?:…|\.\.\.)$/,'').trim()) || detailDate!==item.publication) throw new Error('IUCN listing/detail facts disagree');
          const fields=[...article[3].matchAll(/<div class="clearfix text-formatted field field--name-field-(lead|body)\b[^>]*>/g)].map(m=>{
            const rest=article[3].slice(m.index+m[0].length);let depth=1;
            for (const tag of rest.matchAll(/<\/?div\b[^>]*>/g)) {depth+=tag[0].startsWith('</')?-1:1;if (!depth) return {name:m[1],html:rest.slice(0,tag.index)};}
            throw new Error('IUCN detail body boundary unavailable');
          });
          if (fields.length!==2 || !fields.some(f=>f.name==='lead') || !fields.some(f=>f.name==='body') || fields.some(f=>!text(f.html))) throw new Error('IUCN detail body boundary unavailable');
          const content=fields.map(f=>f.html).join(' '),paragraphs=[...content.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map(m=>text(m[1]));
          const description=paragraphs.flatMap(p=>p.match(/[^.!?]+[.!?](?=\s|$)/g)?.map(s=>s.trim())??[]).find(s=>Array.from(s).length<=280)??null;
          const scripted={kind:'announcement',title,description,organization:'IUCN',location:null,starts_at:null,ends_at:null,event_url:null,registration_url:null,status:null,
            iucn:{id:article[1],type:item.type,publication,precision:resource?'year':published?'instant':'day'}};
          const links=[...new Set([...content.matchAll(/href="([^"]+)"/g)].map(m=>{try{return sourceURL(new URL(text(m[1]),item.url).href);}catch{return null;}}).filter(Boolean))].sort();
          const source=await observe(db,tracker.id,item.url,JSON.stringify({text:[title,...paragraphs].join(' '),listing:item.raw,body:response.body}),published,scripted,
            {text:text(content),links,publication,published_at:published,structured:scripted},
            {rank:2,identity:`iucn:node:${article[1]}`,parent_url:tracker.url},now());
          stats[source.changed?'candidates':'skipped']++;pages.set(source.id,{source});
        } catch(error) {quota ||= Boolean(error.quota);stats.warnings.push(error.message);}
      }
      covered=true;
    } else if (gfw) {
      const home=await read(tracker.url,budget);stats.pages++;
      if (home.url!==tracker.url || !/<\/html>\s*$/.test(home.body.replace(/<!--[\s\S]*?-->/g,'')) || !home.body.includes(`rel="canonical" href="${tracker.url}"`) ||
          !home.body.includes('rel="https://api.w.org/" href="https://globalfishingwatch.org/wp-json/"')) throw new Error('GFW media-centre discovery unavailable');
      const text=html=>visibleText(html.replace(/&#(\d{1,7});/g,(_m,n)=>String.fromCodePoint(+n)).replace(/&#x([a-f0-9]{1,6});/gi,(_m,n)=>String.fromCodePoint(parseInt(n,16))));
      const rows=[...home.body.matchAll(/<article id="post-(\d+)"[^>]*>([\s\S]*?)<\/article>/g)].map(m=>{
        const title=m[2].match(/<h3 class="post-title">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h3>/);
        const publication=text(m[2].match(/<span class="entry-date">([^<]+)<\/span>/)?.[1]??''),day=new Date(publication+' 00:00:00 GMT');
        if (!title || !/^[A-Z][a-z]+ \d{1,2}, \d{4}$/.test(publication) || !Number.isFinite(+day) || day.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric',timeZone:'UTC'})!==publication) throw new Error('GFW listing identity/date unavailable');
        const url=sourceURL(title[1]);
        if (!/^https:\/\/globalfishingwatch\.org\/(?:press-release|statement|news-story)\/[^/]+\/$/.test(url)) throw new Error('Unsupported GFW media-centre article');
        return {id:+m[1],url,title:text(title[2]),publication_on:day.toISOString().slice(0,10),raw:m[0]};
      });
      if (!rows.length || rows.length>50 || new Set(rows.map(r=>r.id)).size!==rows.length || new Set(rows.map(r=>r.url)).size!==rows.length) throw new Error('Invalid GFW media-centre listing');
      const seen=(await db.query('select distinct url from scout.evidence where tracker_id=$1',[tracker.id])).rows.map(r=>r.url);
      const selected=rows.filter(r=>r.publication_on>=since.slice(0,10)||seen.includes(r.url)).sort((a,b)=>b.publication_on.localeCompare(a.publication_on));
      stats.articles_listed=rows.length;stats.articles_selected=selected.length;
      stats.warnings.push('GFW covers the current media-centre listing and four news articles; archives, languages, media/PDFs, supporting datasets and separately scheduled events are not fully collected');
      if (selected.length>4) stats.warnings.push('GFW article limit reached');
      let supportRead=false;
      for (const item of selected.slice(0,4)) {
        try {
          const apiURL='https://globalfishingwatch.org/wp-json/wp/v2/posts/'+item.id,response=await read(apiURL,budget);stats.pages++;
          if (response.url!==apiURL || !/application\/json/i.test(response.headers['content-type']??'')) throw new Error('Unexpected GFW article API destination/format');
          const article=JSON.parse(response.body),published=dates(article.date_gmt+'Z').starts_at;
          if (article.id!==item.id || article.status!=='publish' || article.type!=='post' || article.link!==item.url || article.yoast_head_json?.canonical!==item.url ||
              text(article.title?.rendered??'')!==item.title || !published || article.date?.slice(0,10)!==item.publication_on ||
              article.content?.protected!==false || typeof article.content.rendered!=='string' || !article.content.rendered.includes(`data-elementor-id="${item.id}"`) || !/<\/div>\s*$/.test(article.content.rendered)) throw new Error('GFW article/list facts disagree');
          // The publisher's rendered post appends a rotating Related Content grid.
          if (/anwp-pg-/.test(article.content.rendered) && !/<h2\b[^>]*>Related Content<\/h2>/.test(article.content.rendered)) throw new Error('GFW article/related-content boundary unavailable');
          const content=article.content.rendered.split(/<h2\b[^>]*>Related Content<\/h2>/)[0];
          const paragraphs=[...content.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map(m=>text(m[1])).filter(Boolean);
          if (!paragraphs.length) throw new Error('GFW article body unavailable');
          const links=[...new Set([...content.matchAll(/href="([^"]+)"/g)].map(m=>{try{return sourceURL(new URL(text(m[1]),item.url).href);}catch{return null;}}).filter(Boolean))].sort();
          const excerpt=text(article.excerpt?.rendered??''),description=[excerpt,...paragraphs].find(p=>p.length<=280&&/[.!?]$/.test(p))??null;
          const scripted={kind:'announcement',title:item.title,description,organization:'Global Fishing Watch',location:null,...dates(),event_url:null,registration_url:null,status:null,
            gfw:{id:item.id,publication_on:item.publication_on}};
          let support=null;
          const partnership=item.url==='https://globalfishingwatch.org/press-release/ai2-and-global-fishing-watch-unite-to-bring-ai-agents-to-ocean-monitoring/';
          if (partnership) {
            // Verify the retained Ai2 post's actual link against the partner's matching announcement, not topic/title similarity alone.
            const retained=(await db.query(`select e.record_id,e.content from scout.current_evidence e join scout.trackers t on t.id=e.tracker_id
              where t.url='https://bsky.app/profile/globalfishingwatch.org' and e.parsed#>>'{source,identity}' like 'post:%'`)).rows.map(e=>({...e,post:JSON.parse(e.content)}))
              .filter(e=>e.post.author?.handle==='ai2.bsky.social'&&e.post.createdAt?.slice(0,10)===published.slice(0,10)&&/announced a partnership/.test(e.post.text));
            if (retained.length) {
              scripted.gfw.identity_unconfirmed=true;
              try {
                if (retained.length!==1 || retained[0].post.urls?.length!==1 || supportRead) throw new Error('GFW retained partnership link is ambiguous');
                supportRead=true;const link=sourceURL(retained[0].post.urls[0]);
                // This redirect was observed during public-source discovery; the hosted shortener fails TLS. Read its observed publisher destination directly.
                const resolved=link==='https://buff.ly/l7e7st4'?'https://skylight.global/news/ai2-gfw':link;
                const fetched=await read(resolved,budget);stats.pages++;
                support={...fetched,link,requested_url:resolved};
                const supportTitle=text(fetched.body.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1]??''),supportText=text(fetched.body);
                const matches=paragraphs.filter(p=>p.length>=160&&supportText.includes(p));
                if (fetched.url!=='https://skylight.global/news/ai2-gfw' || !/text\/html/i.test(fetched.headers['content-type']??'') || !/<\/html>\s*$/.test(fetched.body) ||
                    supportTitle!==item.title || matches.length<2 || !matches.some(p=>p.includes('jointly develop machine learning models'))) throw new Error('GFW partner announcement identity unconfirmed');
                delete scripted.gfw.identity_unconfirmed;scripted.gfw.corroborates=retained[0].record_id;
              } catch(error) {
                quota ||= Boolean(error.quota);stats.warnings.push(error.message);support??={error:error.message};
                if (seen.includes(item.url)) continue;
              }
            }
          }
          // Preserve the complete concrete technical paragraph; the opening press-release boilerplate would crowd it out.
          const technical=partnership?paragraphs.find(p=>p.startsWith('The technical collaboration also extends beyond Shippy.')):null;
          const context=[item.title,excerpt,technical??paragraphs.slice(0,2).join(' ')].filter(Boolean).join(' ');
          const meaningful={text:text(content),links,published_at:published,structured:scripted};
          if (scripted.gfw.corroborates) {
            const accepted=(await db.query(`select parsed#>'{source,fields}' as fields from scout.evidence where tracker_id=$1 and url=$2
              and parsed#>>'{assessment,state}'='complete' and parsed#>>'{gfw,corroborates}'=$3 order by parsed#>>'{assessment,accepted_at}' desc limit 1`,[tracker.id,item.url,scripted.gfw.corroborates])).rows[0];
            if (accepted && Object.entries(meaningful).some(([key,value])=>accepted.fields[key]!==fingerprint(value))) {
              scripted.gfw.revision_unconfirmed=true;stats.warnings.push('GFW materially revised corroborating article requires review; retained facts preserved');
            }
          }
          const source=await observe(db,tracker.id,item.url,JSON.stringify({text:context,listing:item.raw,api:response,support}),published,scripted,
            meaningful,
            {rank:2,identity:`page:${item.url}`,links:[item.url],parent_url:tracker.url},now());
          stats[source.changed?'candidates':'skipped']++;pages.set(source.id,{source});
        } catch(error) {quota ||= Boolean(error.quota);stats.warnings.push(error.message);}
      }
      covered=true;
    } else if (dosiWeb) {
      const home=await read(tracker.url,budget);stats.pages++;
      const feedURL='https://www.dosi-project.org/feed/';
      const section=home.body.match(/<a class="elementor-toggle-title"[^>]*>BBNJ IGC Participation<\/a>[\s\S]*?<div\b[^>]*class="elementor-tab-content[^>]*>([\s\S]*?)<\/div>/)?.[1];
      if (home.url!==tracker.url || !/<\/html>\s*$/.test(home.body) || !section ||
          !home.body.includes(`rel="canonical" href="${tracker.url}"`) ||
          !home.body.match(/<link\b[^>]*type="application\/rss\+xml"[^>]*href="https:\/\/www\.dosi-project\.org\/feed\/"/)) throw new Error('DOSI BBNJ page/discovery layout unavailable');
      const text=html=>visibleText(html.replace(/&#(\d{1,7});/g,(_m,n)=>String.fromCodePoint(+n)));
      const seen=(await db.query('select distinct url from scout.evidence where tracker_id=$1',[tracker.id])).rows.map(r=>r.url);
      stats.warnings.push('DOSI covers one linked PrepCom guide and eight items from one current RSS newsletter; static group text, year-only recaps, publications/PDFs, older issues and other articles are not fully collected');
      const guide=section.match(/href="(https:\/\/www\.dosi-project\.org\/a-dosi-guide-to-bbnj-prepcom\/)"/);
      if (!guide) stats.warnings.push('DOSI linked PrepCom guide unavailable');
      if (guide) {
        try {
          const response=await read(guide[1],budget);stats.pages++;
          if (response.url!==guide[1] || !/text\/html/i.test(response.headers['content-type']??'') || !/<\/html>\s*$/.test(response.body)) throw new Error('Unexpected DOSI guide destination/format');
          const article=dosiArticle(response.body,response.url),title=text(article.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1]??'');
          const header=response.body.match(/<div class="post_header post_header_single entry-header">[\s\S]*?<h1\b[^>]*>[\s\S]*?<\/h1>/)?.[0]??'';
          const publication=text(header.match(/<span\b[^>]*class="post_meta_item post_date\s*"[^>]*>([^<]+)<\/span>/)?.[1]??'');
          const day=new Date(publication+' 00:00:00 GMT');
          if (!title || !/^[A-Z][a-z]+ \d{1,2}, \d{4}$/.test(publication) || !Number.isFinite(+day) ||
              day.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric',timeZone:'UTC'})!==publication) throw new Error('DOSI guide publication date/title unavailable');
          const publishedOn=day.toISOString().slice(0,10);
          if (publishedOn>=since.slice(0,10)||seen.includes(response.url)) {
            const paragraphs=[...article.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map(m=>text(m[1]));
            // Keep the complete observed CHM paragraph in bounded context, rather than losing it behind the treaty introduction.
            const technical=paragraphs.find(p=>p.startsWith('The Clearing-House Mechanism:'));
            const description=(technical?.replace(/^The Clearing-House Mechanism:\s*/,'')??paragraphs[0])?.match(/^[^.]+\./)?.[0];
            const scripted={kind:'announcement',title,description:description&&Array.from(description).length<=280?description:null,organization:null,location:null,
              ...dates(),event_url:null,registration_url:null,status:null,dosi_web:{publication_on:publishedOn}};
            const context=[title,publication,technical??paragraphs[0]].filter(Boolean).join(' ');
            const links=[...new Set([...article.matchAll(/href="([^"]+)"/g)].map(m=>{try{return sourceURL(new URL(text(m[1]),response.url).href);}catch{return null;}}).filter(Boolean))].sort();
            const source=await observe(db,tracker.id,response.url,JSON.stringify({text:context,body:response.body,discovered_from:tracker.url}),null,scripted,
              {text:text(article),links,publication_on:publishedOn,structured:scripted},
              {rank:2,identity:`page:${response.url}`,links:[response.url],parent_url:tracker.url},now());
            stats[source.changed?'candidates':'skipped']++;pages.set(source.id,{source});
          }
        } catch(error) {quota ||= Boolean(error.quota);stats.warnings.push(error.message);}
      }
      try {
        const feed=await read(feedURL,budget);stats.pages++;
        if (feed.url!==feedURL || !/xml/i.test(feed.headers['content-type']??'') || !/<\/rss>\s*$/.test(feed.body)) throw new Error('Invalid DOSI RSS feed');
        const rows=[...feed.body.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m=>{
          const url=sourceURL(text(m[1].match(/<link>([^<]+)<\/link>/)?.[1]??''));
          const published=m[1].match(/<pubDate>([^<]+)<\/pubDate>/)?.[1];
          const id=m[1].match(/<guid isPermaLink="false">https:\/\/www\.dosi-project\.org\/\?p=(\d+)<\/guid>/)?.[1];
          if (!id || !url.startsWith('https://www.dosi-project.org/') || !Number.isFinite(Date.parse(published))) throw new Error('DOSI RSS identity/date unavailable');
          return {url,published:new Date(published).toISOString(),id,raw:m[0]};
        });
        if (!rows.length || rows.length>50 || new Set(rows.map(r=>r.id)).size!==rows.length || new Set(rows.map(r=>r.url)).size!==rows.length) throw new Error('Invalid DOSI RSS items');
        const selected=rows.filter(r=>/^https:\/\/www\.dosi-project\.org\/dosi-deep-sea-round-up(?:-\d+)?\/$/.test(r.url)&&Date.parse(r.published)>=Date.parse(since)).sort((a,b)=>b.published.localeCompare(a.published));
        stats.issues_listed=rows.length;stats.issues_selected=selected.length;
        if (selected.length>1) stats.warnings.push(`DOSI RSS issue limit reached: ${selected.length-1} issues not followed`);
        for (const issue of selected.slice(0,1)) {
          const roundup=await read(issue.url,budget);stats.pages++;
          if (roundup.url!==issue.url || !/text\/html/i.test(roundup.headers['content-type']??'') || !/<\/html>\s*$/.test(roundup.body)) throw new Error('Unexpected DOSI roundup destination/format');
          const article=dosiArticle(roundup.body,roundup.url);
          const newsletters=[...new Set([...article.matchAll(/href="(https:\/\/mailchi\.mp\/soton\.ac\.uk\/dosi-deep-sea-roundup-\d{2}-\d{2}-\d{4})"/g)].map(m=>m[1]))];
          if (newsletters.length!==1) throw new Error('DOSI newsletter link missing or ambiguous');
          const newsletter=await read(newsletters[0],budget);stats.pages++;
          if (newsletter.url!==newsletters[0] || !/text\/html/i.test(newsletter.headers['content-type']??'') || !/<\/html>\s*$/.test(newsletter.body)) throw new Error('Unexpected DOSI newsletter destination/format');
          const {items,unsupported}=dosiNewsletter(newsletter.body,newsletter.url);
          if (unsupported) stats.warnings.push(`DOSI newsletter has ${unsupported} unsupported item links`);
          if (items.length>8) stats.warnings.push(`DOSI newsletter item limit reached: ${items.length-8} linked items not captured`);
          for (const item of items.slice(0,8)) {
            const scripted={...item.parsed,dosi_web:{issue_published_at:issue.published}};
            const source=await observe(db,tracker.id,item.url,JSON.stringify({text:visibleText(item.content),item:item.content,
              discovery:{page:tracker.url,feed:feedURL,rss:issue.raw,roundup:{url:roundup.url,body:article}}}),null,scripted,
              {text:visibleText(item.content),link:item.link,structured:scripted},
              {rank:2,identity:`newsletter:${item.url}:${item.link}`,item_key:item.link,parent_url:roundup.url,links:[item.link]},now());
            stats[source.changed?'candidates':'skipped']++;pages.set(source.id,{source});
          }
        }
      } catch(error) {quota ||= Boolean(error.quota);stats.warnings.push(error.message);}
      covered=true;
    } else if (hsaWeb) {
      const feedURL=tracker.url+'feed/',feed=await read(feedURL,budget);stats.pages++;
      if (feed.url!==feedURL || !/xml/i.test(feed.headers['content-type']??'') || !/<\/rss>\s*$/.test(feed.body)) throw new Error('Invalid HSA RSS feed');
      const text=html=>visibleText(html.replace(/^<!\[CDATA\[|\]\]>$/g,'').replace(/&#(\d{1,7});/g,(_m,n)=>String.fromCodePoint(+n)));
      const items=[...feed.body.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m=>{
        const url=sourceURL(m[1].match(/<link>([^<]+)<\/link>/)?.[1]),title=text(m[1].match(/<title>([\s\S]*?)<\/title>/)?.[1]??'');
        const id=m[1].match(/<post-id\b[^>]*>(\d+)<\/post-id>/)?.[1],published=m[1].match(/<pubDate>([^<]+)<\/pubDate>/)?.[1];
        if (!id || !title || !url.startsWith(HSA_WEB) || !Number.isFinite(Date.parse(published))) throw new Error('HSA feed item identity/date unavailable');
        return {id,url,title,published:new Date(published).toISOString(),raw:m[0]};
      });
      if (!items.length || items.length>50 || new Set(items.map(i=>i.id)).size!==items.length || new Set(items.map(i=>i.url)).size!==items.length) throw new Error('Invalid HSA feed items');
      const previous=(await db.query("select distinct on(url) url,parsed,content from scout.evidence where tracker_id=$1 order by url,coalesce((parsed#>>'{source,observed_at}')::timestamptz,collected_at) desc,last_seen_at desc nulls last,id",[tracker.id])).rows;
      const seen=previous.map(r=>r.url);
      const selected=items.filter(i=>Date.parse(i.published)>=Date.parse(since)||seen.includes(i.url));let followed=false;
      stats.articles_listed=items.length;stats.articles_selected=selected.length;
      stats.warnings.push('HSA coverage is limited to the current RSS page and four article details; archives, attachments and other pages are not fully collected');
      if (selected.length>4) stats.warnings.push('HSA article limit reached');
      for (const item of selected.slice(0,4)) {
        try {
          const apiURL=sourceURL(tracker.url+'wp-json/wp/v2/posts/'+item.id+'?_fields=id,link,date_gmt,modified_gmt,title,content,excerpt,status,type');
          const response=await read(apiURL,budget);stats.pages++;
          if (response.url!==apiURL || !/application\/json/i.test(response.headers['content-type']??'')) throw new Error('Unexpected HSA article API format/destination');
          const article=JSON.parse(response.body);
          if (article.id!==+item.id || article.status!=='publish' || article.type!=='post' || sourceURL(article.link)!==item.url ||
              text(article.title?.rendered??'')!==item.title || new Date(article.date_gmt+'Z').toISOString()!==item.published ||
              article.content?.protected!==false || typeof article.content.rendered!=='string' || !text(article.content.rendered)) throw new Error('HSA article/feed facts disagree');
          const content=article.content.rendered,body=text(content),paragraphs=[...content.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map(m=>text(m[1]));
          const links=[...new Set([...content.matchAll(/href="([^"]+)"/g)].map(m=>{try{return sourceURL(text(m[1]));}catch{return null;}}).filter(Boolean))].sort();
          const registrations=[...content.matchAll(/<p\b[^>]*>\s*REGISTER HERE:\s*<a\b[^>]*href="([^"]+)"/gi)].map(m=>sourceURL(text(m[1])));
          if (registrations.length>1) throw new Error('Multiple HSA sessions/registration links need review');
          const cancelled=paragraphs.some(p=>/^(?:This|The) (?:webinar|session|event) (?:has been|is) cancell?ed\b/i.test(p));
          const saved=previous.find(p=>p.url===item.url),prior=saved?.parsed;
          const knownSession=prior?.hsa_web?.session===true&&text(JSON.parse(JSON.parse(saved.content).api.body).title.rendered)===item.title;
          const session=(registrations.length===1||knownSession)&&/\bwebinar|\bsession/i.test(body),recap=/watch the full recording/i.test(body);
          const description=paragraphs.find(p=>/^The first webinar will focus/.test(p))??paragraphs.find(p=>p&&!/^Blog by /.test(p))??body;
          const scripted={kind:session?'event':'announcement',title:item.title,description:Array.from(description).slice(0,280).join(''),organization:null,location:null,...dates(),
            event_url:session?item.url:null,registration_url:session?registrations[0]??null:null,status:session&&cancelled?'cancelled':null,hsa_web:{id:item.id,session,recap,multiple:/co-hosting two events/i.test(body)}};
          if (session&&!registrations.length) {scripted.title=prior.title;scripted.event_url=prior.event_url;}
          if (scripted.hsa_web.multiple) stats.warnings.push('HSA article contains multiple sessions; separate session extraction remains unsupported');
          let support=null;
          if (session) {
            const schedules=paragraphs.map(p=>p.match(/\b(\d{1,2}) (January|February|March|April|May|June|July|August|September|October|November|December) (\d{4}),\s*(.+)$/)).filter(Boolean);
            if (schedules.length>1) throw new Error('Conflicting HSA session dates; existing schedule requires review');
            if (schedules.length) {
              const m=schedules[0],month=['January','February','March','April','May','June','July','August','September','October','November','December'].indexOf(m[2])+1;
              const day=dates(m[3]+'-'+String(month).padStart(2,'0')+'-'+m[1].padStart(2,'0')).start_on;
              if (!day) throw new Error('Invalid HSA session date');
              Object.assign(scripted,dates(day));
              const clocks=m[4].split('|').map(c=>c.trim().match(/^(\d{1,2})(?::([0-5]\d))?\s*(AM|PM) (CEST|EDT|UTC[+-]\d{1,2})$/));
              if (clocks.some(c=>!c||+c[1]<1||+c[1]>12||c[4].startsWith('UTC')&&Math.abs(+c[4].slice(3))>14)) stats.warnings.push('HSA session clock format/zone unsupported; date only');
              else {
                const instants=clocks.map(c=>Date.parse(day+'T00:00:00Z')+((+c[1]%12+(c[3]==='PM'?12:0))*60+(+c[2]||0)-(c[4]==='CEST'?120:c[4]==='EDT'?-240:+c[4].slice(3)*60))*60000);
                if (new Set(instants).size!==1) throw new Error('Conflicting HSA session clocks; existing schedule requires review');
                Object.assign(scripted,dates(new Date(instants[0]).toISOString()));
              }
            } else stats.warnings.push('HSA session date/time unavailable');
            if (registrations.length&&followed) stats.warnings.push('HSA registration detail limit reached');
            else if (registrations.length) {
              followed=true;
              try {
                const r=await read(registrations[0],budget);stats.pages++;support={url:r.url,body:r.body};
                if (!/^https:\/\/[^/]+\.zoom\.us\/webinar\/register\/WN_[\w-]+(?:\?|$)/.test(r.url)) throw new Error('Unsupported HSA registration destination');
                const zoom=JSON.parse(r.body.match(/\bregisterVO:(\{[^\n]+\}),\s*\n/)?.[1]??'null');
                const url=sourceURL(zoom?.shareVO?.url),title=zoom?.meetingVO?.topic,agenda=zoom?.meetingVO?.agenda;
                const when=zoom?.viewerEmail?.match(/When: ([A-Z][a-z]{2}) (\d{1,2}), (\d{4}) (\d{2}):([0-5]\d) (AM|PM) /);
                const words=item.title.toLowerCase().match(/[a-z]{5,}/g)??[];
                if (new URL(url).origin!==new URL(r.url).origin || new URL(url).pathname!==new URL(r.url).pathname || typeof title!=='string' || typeof agenda!=='string' ||
                    words.filter(w=>title.toLowerCase().includes(w)).length<2 || !when || !scripted.starts_at || typeof zoom.timezoneVO?.timezoneId!=='string' || !zoom.timezoneVO.timezoneId) throw new Error('HSA registration identity/schedule unconfirmed');
                const local=new Intl.DateTimeFormat('en-US',{timeZone:zoom.timezoneVO?.timezoneId,month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true}).formatToParts(new Date(scripted.starts_at));
                const parts=Object.fromEntries(local.map(p=>[p.type,p.value]));
                if (['month','day','year','hour','minute','dayPeriod'].some((k,i)=>parts[k]!==when[i+1])) throw new Error('HSA article/registration clocks conflict; existing schedule requires review');
                scripted.title=title;scripted.event_url=url;scripted.registration_url=url;
                scripted.organization=agenda.match(/High Seas Alliance and partners(?= are organizing)/)?.[0]??null;
                support.facts={title,agenda,url};links.push(url);
              } catch(error) {
                quota ||= Boolean(error.quota);stats.warnings.push(error.message);
                if (cancelled&&knownSession&&!/clocks conflict/.test(error.message)) Object.assign(scripted,dates(),{title:prior.title,event_url:prior.event_url,registration_url:prior.registration_url});
                else if (seen.includes(item.url) || /clocks conflict/.test(error.message)) continue;
              }
            }
          }
          if (links.length>10) stats.warnings.push('HSA article model-link limit reached');
          const context=[scripted.title,scripted.description,body,scripted.organization,support?.facts?.agenda].filter(Boolean).join(' ');
          const source=await observe(db,tracker.id,item.url,JSON.stringify({text:context,feed_item:item.raw,api:{url:response.url,body:response.body},support}),item.published,scripted,
            {title:item.title,text:body,links,structured:scripted,registration:support?.facts??null},
            {rank:2,identity:session?`event:${scripted.event_url}`:`page:${item.url}`,feed_url:feedURL,links:links.slice(0,10)},now());
          stats[source.changed?'candidates':'skipped']++;pages.set(item.url,{source});
        } catch(error) {quota ||= Boolean(error.quota);stats.warnings.push(`HSA article ${item.url}: ${error.message}`);}
      }
      covered=selected.length<=4;
    } else if (iddri) {
      const text=html=>visibleText(html.replace(/&#(x[\da-f]+|\d+);/gi,(_m,n)=>String.fromCodePoint(n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):+n)));
      const months=['jan january janvier','feb february fev fevrier','mar march mars','apr april avr avril','may mai','jun june juin','jul july juil juillet','aug august aou aout','sep sept september septembre','oct october octobre','nov november novembre','dec december decembre'];
      const date=value=>{
        const parts=text(value).normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/(\d)(?:st|nd|rd|th|er)\b/g,'$1').split(' ');
        const year=parts.find(p=>/^\d{4}$/.test(p)),month=months.findIndex(m=>m.split(' ').some(p=>parts.includes(p))),day=parts.find(p=>/^\d{1,2}$/.test(p));
        if (!year || month<0 || parts.length!==(day?3:2)) throw new Error('Unsupported IDDRI date');
        const valueISO=year+'-'+String(month+1).padStart(2,'0')+(day?'-'+day.padStart(2,'0'):'');
        if (day&&!dates(valueISO).start_on) throw new Error('Invalid IDDRI date');
        return valueISO;
      };
      const eventDays=html=>[...html.matchAll(/<span class="event-date__day">([^<]+)<\/span>\s*<span class="event-date__month">([^<]+)<\/span>/g)].map(m=>date(m[1]+' '+m[2]));
      const previous=(await db.query('select distinct url from scout.evidence where tracker_id=$1',[tracker.id])).rows.map(r=>r.url);
      const items=[],details=new Map();let listURL=tracker.url;
      for (let page=0;page<2;page++) {
        const r=await read(listURL,budget);stats.pages++;
        if (r.url!==listURL || !/<\/html>\s*$/.test(r.body)) throw new Error('Invalid IDDRI listing destination/layout');
        const found=[...r.body.matchAll(/<article class="line-teaser">([\s\S]*?)<\/article>/g)];
        if (!found.length||found.length>30) throw new Error('IDDRI listing items unavailable');
        for (const m of found) {
          const url=sourceURL(new URL(m[1].match(/<a href="([^"]+)"/)?.[1],listURL).href);
          const title=text(m[1].match(/<h3 class="line-teaser__title">([\s\S]*?)<\/h3>/)?.[1]??'');
          const days=eventDays(m[1]),metas=m[1].match(/<div class="publication__metas">([\s\S]*?)<\/div>/)?.[1];
          const publication=days.length?null:date((metas??'').replace(/<span[\s\S]*?<\/span>/g,''));
          if (!/^https:\/\/www\.iddri\.org\/(?:en\/publications-and-events|fr\/publications-et-evenements)\/[^/]+\/[^/?#]+$/.test(url)||!title||days.length>2) throw new Error('Unsupported IDDRI listing identity');
          if (!items.some(i=>i.url===url)) items.push({url,title,days,publication,raw:m[0],listing:listURL});
        }
        const next=r.body.match(/<link rel="next" href="([^"]+)"/)?.[1];
        if (next) stats.warnings.push('IDDRI pagination is bounded to page 0 of each language; older pages are not fully collected');
        if (page===0) {
          const french=r.body.match(/<link rel="alternate" hreflang="fr" href="([^"]+)"/)?.[1];
          if (french!=='https://www.iddri.org/fr/publications-et-evenements/haute-mer') throw new Error('IDDRI French listing link unavailable');
          listURL=french+'?page=0';
        }
      }
      const selected=items.filter(i=>previous.includes(i.url)||(i.days.at(-1)??i.publication)>=since.slice(0,(i.publication?.length===7?7:10)));
      stats.articles_listed=items.length;stats.articles_selected=selected.length;
      if (selected.length>3) stats.warnings.push('IDDRI three-detail limit reached; remaining language editions/items deferred');
      let followed=false;
      for (const item of selected.slice(0,3)) {
        try {
          const r=await read(item.url,budget);stats.pages++;
          const lang=new URL(item.url).pathname.split('/')[1],canonical=r.body.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
          const node=r.body.match(/<link rel="shortlink" href="https:\/\/www\.iddri\.org\/(en|fr)\/node\/(\d+)"/);
          const header=r.body.match(/<article class="(?:publication publication-full page-wrapper|page-wrapper event-full)">\s*<header\b[^>]*>([\s\S]*?)<\/header>/)?.[1];
          const content=r.body.match(/<div class="page-content">([\s\S]*?)<div class="footnotes_container /)?.[1];
          const title=text(header?.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1]??'');
          const type=r.body.match(/<meta property="og:type" content="(article|event)"/)?.[1];
          if (r.url!==item.url||canonical!==item.url||node?.[1]!==lang||!header||!content||!title||title!==item.title||!type||!/<\/html>\s*$/.test(r.body)) throw new Error('IDDRI detail identity/layout disagrees with listing');
          const event=type==='event',days=eventDays(header),pub=event?null:date(header.match(/<div class="publication__metas">([\s\S]*?)<\/div>/)?.[1].replace(/<span[\s\S]*?<\/span>/g,'')??'');
          if (event!==Boolean(item.days.length)||!isDeepStrictEqual(days,item.days)||pub!==item.publication) throw new Error('IDDRI detail/listing dates disagree');
          const body=text(content),intro=text(header.match(/<p class="page-intro">([\s\S]*?)<\/p>/)?.[1]??'');
          const paragraphs=[...content.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map(m=>text(m[1]));
          const links=[...new Set([...(header+content).matchAll(/href="([^"]+)"/g)].map(m=>{try{return sourceURL(new URL(text(m[1]),item.url).href);}catch{return null;}}).filter(Boolean))].sort();
          const buttons=[...content.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].filter(m=>/^(register|s'inscrire|inscription|programme|program)$/i.test(text(m[2]))).map(m=>sourceURL(new URL(text(m[1]),item.url).href));
          const multiple=event&&(/<hr\b/i.test(content)&&buttons.length>1||/Events &amp; Publications|Événements et publications/.test(content));
          const description=paragraphs.flatMap(p=>p.match(/[^.!?]+[.!?](?:\s|$)/g)??[]).map(p=>p.trim()).find(p=>p.length>80&&p.length<=280)??body;
          const scripted={kind:event?'event':'announcement',title,description:Array.from(description).slice(0,280).join(''),organization:event?null:'IDDRI',location:null,...(event&&!multiple?dates(days[0],days[1]):dates()),event_url:event?item.url:null,registration_url:event&&!multiple?buttons.find(u=>/\/webinar\/register\//.test(u))??null:null,status:null,
            iddri:{node:node[2],language:lang,publication:pub,multiple}};
          const english=r.body.match(/<link rel="alternate" hreflang="en" href="([^"]+)"/)?.[1],other=details.get(english);
          if (lang==='fr'&&english&&english!==item.url) {
            const reciprocal=other?.body.match(/<link rel="alternate" hreflang="fr" href="([^"]+)"/)?.[1]===item.url;
            const common=event?scripted.registration_url&&scripted.registration_url===other?.scripted.registration_url&&isDeepStrictEqual(days,other.days)
              :links.some(u=>u.endsWith('.pdf')&&other?.links.includes(u));
            if (reciprocal&&common&&other.scripted.kind===scripted.kind&&other.scripted.iddri.node===node[2]) scripted.iddri.translation_of=english;
            else {scripted.iddri.translation_unconfirmed=true;stats.warnings.push('IDDRI translation needs reciprocal publication/session corroboration before assessment');}
          }
          let support=null;
          if (multiple) stats.warnings.push('IDDRI programme contains multiple sessions; parent dates cannot supply a session schedule');
          if (event&&!multiple) {
            const practical=text(r.body.match(/field--name-field-event-infos[^>]*>([\s\S]*?)<\/div>/)?.[1]??'');
            const clocks=[...new Set([...text(intro+' '+practical).matchAll(/\b(\d{1,2})(?::([0-5]\d))?\s*(am|pm)\s+(EST|EDT|CET|CEST|UTC)\b/gi)].map(m=>JSON.stringify(m.slice(1))))].map(s=>JSON.parse(s));
            if (clocks.length>1) throw new Error('Conflicting IDDRI clocks; schedule requires review');
            if (days.length===1&&clocks.length===1) {
              const [h,m,ap,z]=clocks[0];if (+h<1||+h>12) throw new Error('Invalid IDDRI clock');
              const offset={EST:-300,EDT:-240,CET:60,CEST:120,UTC:0}[z.toUpperCase()];
              Object.assign(scripted,dates(new Date(Date.parse(days[0]+'T00:00:00Z')+((+h%12+(ap.toLowerCase()==='pm'?12:0))*60+(+m||0)-offset)*60000).toISOString()));
            } else stats.warnings.push('IDDRI event has date-only or unsupported clock/zone; UTC times remain unknown');
            if (/^On Zoom(?:,|$)/.test(practical)) scripted.location='On Zoom';
          }
          if (buttons.length&&!followed) {
            followed=true;
            try {const s=await read(buttons[0],budget);stats.pages++;support={url:s.url,body:s.body};stats.warnings.push('IDDRI linked programme/registration captured; unconfirmed external facts are not assigned to sessions');}
            catch(error) {quota ||= Boolean(error.quota);support={url:buttons[0],error:error.message};stats.warnings.push('IDDRI programme/registration: '+error.message);}
          } else if (buttons.length) stats.warnings.push('IDDRI supporting-page limit reached');
          stats.warnings.push('IDDRI PDFs, images and embedded media are not parsed; HTML evidence only');
          const source=await observe(db,tracker.id,item.url,JSON.stringify({text:[title,intro,body].filter(Boolean).join(' '),listing:item.raw,detail:r,support}),null,scripted,
            {title,intro,text:body,links,structured:scripted},
            {rank:2,identity:'page:'+(scripted.iddri.translation_of??item.url),listing_url:item.listing,links:links.slice(0,6)},now());
          details.set(item.url,{body:r.body,links,scripted,days});
          stats[source.changed?'candidates':'skipped']++;pages.set(item.url,{source});
        } catch(error) {quota ||= Boolean(error.quota);stats.warnings.push('IDDRI article '+item.url+': '+error.message);}
      }
      covered=selected.length<=3;
    } else if (hub) {
      const feedURL=tracker.url+'?format=json';
      const response=await read(feedURL,budget);stats.pages++;
      const feed=JSON.parse(response.body);
      if (!Array.isArray(feed.upcoming)||!Array.isArray(feed.past)) throw new Error('Invalid HUB Ocean calendar response');
      if ([...feed.upcoming,...feed.past].some(event=>!event||!Number.isFinite(event.endDate))) throw new Error('Invalid calendar event date');
      const events=[...feed.upcoming,...feed.past].filter(event=>Number.isFinite(event.endDate)&&event.endDate>=Date.parse(since));
      covered=events.length<LIMITS.pages;
      if (!covered) stats.warnings.push('Calendar event limit reached');
      for (const event of events.slice(0,LIMITS.pages-1)) {
        try {
          const url=sourceURL(new URL(event.fullUrl,tracker.url).href);
          if (new URL(url).origin!==new URL(tracker.url).origin || typeof event.title!=='string' || typeof event.body!=='string') throw new Error('Invalid calendar event');
          const calendar=await read(url+'?format=ical',budget);stats.pages++;
          if (!calendar.body.includes(`UID:${event.id}@squarespace.com`)) throw new Error('Calendar event identity mismatch');
          const times=['DTSTART','DTEND'].map(name=>{
            const match=calendar.body.match(new RegExp(`^${name}:(\\d{4})(\\d{2})(\\d{2})T(\\d{2})(\\d{2})(\\d{2})Z\\r?$`,'m'));
            return match?`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`:null;
          });
          const schedule=dates(...times);
          if (!schedule.starts_at || !schedule.ends_at) throw new Error('Calendar lacks an unambiguous UTC schedule');
          const registration=[...event.body.matchAll(/href\s*=\s*"([^"]+)"/gi)].map(match=>{try{return sourceURL(match[1].replaceAll('&amp;','&'));}catch{return null;}})
            .find(link=>link && new URL(link).hostname==='events.teams.microsoft.com')??null;
          const scripted={kind:'event',title:event.title,organization:feed.website?.siteTitle?.includes('HUB Ocean')?'HUB Ocean':null,
            description:visibleText(event.excerpt||event.body),...schedule,location:event.location?.addressTitle??null,event_url:url,registration_url:registration,status:null};
          const meaningful={title:event.title,body:visibleText(event.body),...schedule,location:scripted.location,registration_url:registration};
          const source=await observe(db,tracker.id,url,JSON.stringify({...event,calendar:calendar.body}),Number.isFinite(event.publishOn)?new Date(event.publishOn).toISOString():null,
            scripted,meaningful,{rank:2,identity:`event:${url}`,feed_url:feedURL,links:[url+'?format=ical',registration].filter(Boolean)},now());
          stats[source.changed?'candidates':'skipped']++;
        } catch(error) { quota ||= Boolean(error.quota);stats.warnings.push(error.message); }
      }
    } else for (let page = 0; page < LIMITS.feedPages; page++) {
      const params = new URLSearchParams({ actor, limit: String(LIMITS.postsPerPage), filter: 'posts_no_replies', includePins: 'false' });
      if (cursor) params.set('cursor', cursor);
      const response = await read(`https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?${params}`, budget);
      const feed = JSON.parse(response.body);
      if (!Array.isArray(feed.feed)) throw new Error('Invalid feed response');
      let reachedBoundary = feed.feed.length > 0;
      for (const item of feed.feed) {
        if (Date.now() > budget.deadline) throw new Error('Collection time limit reached');
        const post = item.post;
        const indexed = item.reason?.indexedAt ?? post?.indexedAt;
        if (!post?.uri || typeof post.record?.text !== 'string' || !Number.isFinite(Date.parse(post.record.createdAt)) || !Number.isFinite(Date.parse(indexed))) {
          stats.warnings.push('Skipped malformed feed item'); continue;
        }
        if (Date.parse(indexed) < Date.parse(since)) continue;
        reachedBoundary = false;
        stats.posts++;
        const urls = links(post);
        const uri = post.uri.match(/^at:\/\/(did:[^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/);
        if (!uri) { stats.warnings.push('Skipped invalid post identity'); continue; }
        const postURL = `https://bsky.app/profile/${uri[1]}/post/${uri[2]}`;
        const content = JSON.stringify({ text: post.record.text, author: { handle: post.author.handle, displayName: post.author.displayName ?? null }, createdAt: post.record.createdAt, urls });
        const scripted = postRecord(post, urls);
        const doc = await observe(db, tracker.id, postURL, content, post.record.createdAt, scripted,
          { text:post.record.text.replace(/https:\/\/[^\s]+/g,value=>{try{return sourceURL(value);}catch{return value;}}), author:post.author.handle, organizer:post.author.displayName??null, urls, createdAt:post.record.createdAt },
          {rank:post.author.handle === actor ? 2 : 0, identity:`post:${post.uri}`}, now());
        stats[doc.changed ? 'candidates' : 'skipped']++;
        if (post.embed?.$type?.includes('record')) stats.warnings.push('Quoted post content is not expanded');
        // Supporting technical/official links are checked even on unchanged posts.
        if (urls.length > 2) stats.warnings.push('Post link limit reached');
        const follow = [...new Set([doc.parsed.registration_url, doc.parsed.event_url, ...urls].filter(Boolean))];
        for (const url of follow.slice(0, 2)) {
          if (!pages.has(url)) {
            if (pages.size >= LIMITS.pages) { stats.warnings.push('Page limit reached'); break; }
            try {
              const fetched = await read(url, budget);
              stats.pages++;
              if (!/text\/html/i.test(fetched.headers['content-type'] ?? '')) throw new Error('Unsupported page format');
              const parsed = structuredEvents(fetched.body, fetched.url);
              const authoritative = new URL(fetched.url).hostname.replace(/^www\./, '') === publisherHost || (post.author.handle === actor && url === scripted.registration_url);
              const article=dosiArticle(fetched.body,fetched.url);
              const text = visibleText(article);
              const pageLinks=[...new Set([...article.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)].map(match=>{
                try{return sourceURL(new URL(match[1].replaceAll('&amp;','&'),fetched.url).href);}catch{return null;}
              }).filter(Boolean))].sort();
              const meaningful = {text:normalized(text), structured:parsed, links:pageLinks};
              const source = await observe(db, tracker.id, fetched.url, fetched.body, null, parsed, meaningful,
                {rank:authoritative?2:0, identity:`page:${fetched.url}`,links:pageLinks.slice(0,10)}, now());
              stats[source.changed?'candidates':'skipped']++;
              pages.set(url, { source, authoritative, observedAt: now() });
              if (parsed?.limitation && !parsed.local_schedule) stats.warnings.push(parsed.limitation);
              if (actor==='deepstewardship.bsky.social' && article!==fetched.body) {
                const newsletters=pageLinks.filter(link=>/^https:\/\/mailchi\.mp\/soton\.ac\.uk\/dosi-deep-sea-roundup-\d{2}-\d{2}-\d{4}$/.test(link));
                if (newsletters.length>1) stats.warnings.push('DOSI newsletter link limit reached');
                for (const link of newsletters.slice(0,1)) {
                  if (pages.has(link)) continue;
                  if (pages.size>=LIMITS.pages) {stats.warnings.push('Page limit reached');break;}
                  pages.set(link,null);
                  try {
                    const newsletter=await read(link,budget);stats.pages++;
                    if (!/text\/html/i.test(newsletter.headers['content-type']??'')) throw new Error('Unsupported DOSI newsletter format');
                    const {items,unsupported}=dosiNewsletter(newsletter.body,newsletter.url);
                    if (unsupported) stats.warnings.push(`DOSI newsletter has ${unsupported} unsupported item links`);
                    if (items.length>8) stats.warnings.push(`DOSI newsletter item limit reached: ${items.length-8} linked items not captured`);
                    for (const item of items.slice(0,8)) {
                      const captured=await observe(db,tracker.id,item.url,item.content,null,item.parsed,
                        {text:visibleText(item.content),link:item.link,structured:item.parsed},
                        {rank:2,identity:`newsletter:${item.url}:${item.link}`,item_key:item.link,parent_url:fetched.url,links:[item.link]},now());
                      stats[captured.changed?'candidates':'skipped']++;
                    }
                  } catch(error) {quota ||= Boolean(error.quota);stats.warnings.push(error.message);}
                }
              }
            } catch (error) {
              quota ||= Boolean(error.quota);
              pages.set(url, null);
              stats.warnings.push(error.message);
            }
          }
        }
      }
      cursor = feed.cursor;
      if (!cursor || reachedBoundary) { covered = true; break; }
    }
  } catch (error) {
    quota ||= Boolean(error.quota);
    feedFailed = true;
    stats.warnings.push(error.message);
  }
  if (!assessOnly && !covered && !feedFailed && !hub && !untc && !doalos && !sideEvents && !hsaWeb && !iddri && !dosiWeb && !gfw && !iucn && !gof && !oceancare && !harvest && !riseup && !blueMarine && !symposium && !cbd && !octo && !explorers) stats.warnings.push('Feed page limit reached before coverage boundary');
  const pendingQuery=`select *,last_seen_at::text as observed_last_seen_at from (select distinct on(url,parsed#>>'{source,item_key}') * from scout.evidence where tracker_id=$1
    order by url,parsed#>>'{source,item_key}',coalesce((parsed#>>'{source,observed_at}')::timestamptz,collected_at) desc,last_seen_at desc nulls last,id) latest
    where parsed#>>'{assessment,state}' in ('pending','uncertain')`;
  const queued = (untc || doalos || sideEvents || hsaWeb || iddri || dosiWeb || gfw || iucn || gof || oceancare || harvest || riseup || blueMarine || symposium || cbd || octo || explorers || discovery) && feedFailed ? [] : (await db.query(`${pendingQuery} and ($2::uuid is null or id=$2) order by (parsed#>>'{assessment,state}'='uncertain'),collected_at,id limit 20`,[tracker.id,sourceId])).rows.filter(source=>assessOnly||(!(doalos||hsaWeb||iddri)||pages.has(source.url))&&(!sideEvents||pages.has(source.parsed.source.item_key))&&(!(dosiWeb||gfw||iucn||gof||oceancare||harvest||riseup||blueMarine||symposium||cbd||octo||explorers||discovery)||pages.has(source.id)));
  if (assessOnly && !queued.length) stats.warnings.push('Selected source is not latest pending/uncertain evidence for this tracker');
  const pending=[];
  for (const source of queued) {
    if (!assessOnly && source.parsed.assessment.state==='uncertain' && source.parsed.assessment.input_fingerprint) {
      const input=await assessmentInput(db,source,tracker);
      const context=fingerprint({source:source.content_hash,coverage:input.coverage,candidates:JSON.stringify(input.candidates)});
      if (source.parsed.assessment.input_fingerprint===context) { stats.reused_uncertain++; stats.warnings.push(source.parsed.assessment.reason); continue; }
    }
    pending.push(source);
  }
  for (let index=0; index<pending.length;) {
    // A post and its exact event page need the first accepted finding available
    // before the second assessment. Independent sources can share one request.
    const sameEvent=pending[index].parsed.event_url && pending[index].parsed.event_url===pending[index+1]?.parsed.event_url ||
      pending[index].parsed.iddri && pending[index].parsed.source.identity===pending[index+1]?.parsed.source.identity;
    const batch=pending.slice(index,index+(sameEvent?1:2));
    index+=batch.length;
    try {
      if (Date.now()>=budget.deadline) throw new Error('Assessment time limit reached');
      if (!model) throw new Error('Assessment pending: configure model and shared hosted quota accounting');
      const inputs=await Promise.all(batch.map(source=>assessmentInput(db,source,tracker)));
      if (batch.length===2 && Buffer.byteLength(JSON.stringify([INSTRUCTION,inputs,SCHEMA]))>7400) {batch.pop();inputs.pop();index--;}
      // Keep provenance/version bookkeeping for validation and uncertainty reuse,
      // but spend model context on the finding facts and exact IDs.
      const decisions=await model(INSTRUCTION,inputs.map(({changes,candidates,scripted,...input})=>({...input,
        scripted:assessOnly?Object.fromEntries(Object.entries(scripted).filter(([key,value])=>value!=null&&(key!=='description'||!normalize(input.text).includes(normalize(value))))):scripted,
        candidates:candidates.map(({identity_key,updated_at,evidence,exact,...candidate})=>
        Object.fromEntries(Object.entries(candidate).filter(([,value])=>value!=null&&value!==false)))})),SCHEMA);
      (stats.assessment_results??=[]).push({source_ids:batch.map(source=>source.id),decisions});
      if (!Array.isArray(decisions)||decisions.length!==batch.length||new Set(decisions.map(d=>d.source_id)).size!==batch.length) throw new Error('Incomplete assessment batch');
      for (let i=0;i<batch.length;i++) {
        const source=batch[i], input=inputs[i];
        let decision=validateDecision(decisions.find(d=>d.source_id===source.id),input);
        // A parsed registration page supplies its own URL. An explicit link in
        // the retained post can resolve "new" only after the normal identity checks.
        const modelDecision=decision;
        if ((harvest||riseup) && decision.candidate?.kind==='event' && ['new','update'].includes(decision.action)) {
          const fields=['starts_at','ends_at','event_url','registration_url','status',...(riseup?['location']:[])].filter(field=>
            decision.candidate[field]===null && input.scripted[field]!=null && !decision.clear_fields.includes(field));
          if (fields.length) decision=validateDecision({...decision,candidate:{...decision.candidate,
            ...Object.fromEntries(fields.map(field=>[field,input.scripted[field]]))}},input);
        }
        if ((source.parsed.local_schedule || source.parsed.hsa_web?.session || (doalos || sideEvents) && source.parsed.source.item_key) && decision.candidate?.kind==='event' && ['new','update'].includes(decision.action)) {
          const linked=input.candidates.filter(candidate=>candidate.registration_link);
          decision={...decision,candidate:{...decision.candidate,...Object.fromEntries(['event_url','registration_url']
            .filter(field=>!decision.candidate[field]&&!decision.clear_fields.includes(field)).map(field=>[field,input.scripted[field]??null]))}};
          if (decision.action==='new' && linked.length===1) decision={...decision,action:'update',record_id:linked[0].id};
          if (decision.action==='new' && linked.length>1) throw new Error('Ambiguous registration identity; assessment remains pending');
          validateDecision(decision,input);
        }
        const evaluatedUncertainty=decision.action==='uncertain';
        if (decision.action==='new' && decision.candidate && decision.priority!=='low') {
          const fresh=await assessmentInput(db,source,tracker);
          const matches=fresh.candidates.filter(candidate=>{
            const seen=input.candidates.some(item=>item.id===candidate.id);
            const exact=input.exact_ids.includes(candidate.id) || (decision.candidate.event_url &&
              decision.candidate.event_url===candidate.event_url && normalize(decision.candidate.title)===normalize(candidate.title));
            // Only unseen candidates invalidate a reviewed distinct-finding
            // decision; retain stable-source/exact-event identity protection.
            if (seen && !exact) return false;
            try { validateDecision({...decision,action:'update',record_id:candidate.id},fresh);return true; } catch {return false;}
          });
          if (matches.length) decision={...decision,action:'uncertain',reason:'Possible existing finding; reassess against the refreshed shortlist before creating a duplicate'};
        }
        const assessment={...decision,state:decision.action==='uncertain'?'uncertain':'complete',version:ASSESSMENT_VERSION,
          fingerprint:source.content_hash,accepted_at:now()};
        if (assessOnly) assessment.previous=source.parsed.assessment;
        if (decision!==modelDecision) assessment.model_decision=modelDecision;
        if (evaluatedUncertainty) assessment.input_fingerprint=fingerprint({source:source.content_hash,coverage:input.coverage,candidates:JSON.stringify(input.candidates)});
        const parsed={...source.parsed,...(['supporting_evidence','no_substantive_change'].includes(decision.action)?{}:decision.candidate??{}),assessment};
        await db.transaction(async tx=>{
          const before={created:stats.created,changed:stats.changed};
          let target;
          await tx.query('update scout.evidence set parsed=$2 where id=$1',[source.id,JSON.stringify(parsed)]);
          if (decision.action==='uncertain') { stats.warnings.push(decision.reason); return; }
          if (['new','update'].includes(decision.action) && (decision.priority!=='low'||decision.record_id)) {
            const existing=input.candidates.find(row=>row.id===decision.record_id);
            let identity=existing?.identity_key ?? (parsed.kind==='event'&&parsed.event_url ? `event:${parsed.event_url}` : parsed.source.identity);
            if (!existing && (await tx.query('select id from scout.records where identity_key=$1',[identity])).rows.length) {
              // An event URL may be reused for a different edition or session.
              // The validated "new" decision must not silently become an update.
              identity=`${parsed.source.identity}:${hash(JSON.stringify([parsed.kind,parsed.title,parsed.starts_at,parsed.start_on]))}`;
            }
            target=await save(tx,identity,{...source,parsed:{...parsed,priority:decision.priority}},parsed.source.rank,parsed.source.observed_at,stats);
            dateWarnings.set(identity,target.warning);
          } else if (decision.record_id) {
            await tx.query('update scout.evidence set record_id=$2,last_seen_at=clock_timestamp(),authoritative=$3 where id=$1',[source.id,decision.record_id,parsed.source.rank===2]);
            target={recordId:decision.record_id,sourceId:source.id};
          }
          // Relevance uses combined evidence independently of which source wins
          // fact precedence. A weak source still cannot replace an official date.
          if (target && decision.candidate && decision.priority!==null) {
            const changed=await tx.query(`update scout.records set priority=$2
              where id=$1 and priority is distinct from $2 returning id`,[target.recordId,decision.priority]);
            if (changed.rows.length && stats.created===before.created && stats.changed===before.changed) stats.changed++;
            await tx.query("update scout.evidence set parsed=jsonb_set(parsed,'{assessment,priority_accepted}','true') where id=$1 and record_id is not null",[target.sourceId]);
          }
          if (assessOnly) await tx.query('update scout.evidence set last_seen_at=$2::text::timestamptz where id=$1',[source.id,source.observed_last_seen_at]);
        });
        stats.assessed++;
      }
    } catch (error) { stats.warnings.push(error.message); quota ||= /quota|limit|429/.test(error.message); break; }
  }
  stats.pending=(await db.query(`select count(*)::int n from (${pendingQuery}) pending`,[tracker.id])).rows[0].n;
  if (stats.pending) stats.warnings.push(`${stats.pending} source assessments pending`);
  stats.warnings = [...new Set([...stats.warnings, ...dateWarnings.values()].filter(Boolean))];
  stats.requests = budget.requests;
  const outcome = quota ? 'quota' : feedFailed && stats.posts === 0 ? 'failed' : !covered || stats.warnings.length ? 'partial' : stats.created || stats.changed ? 'success' : 'no_change';
  const finished = now();
  await db.query('update scout.collection_runs set finished_at=$1,outcome=$2,stats=stats || $3::jsonb where id=$4', [finished, outcome, JSON.stringify(stats), run.id]);
  return { run_id: run.id, outcome, coverage_since: since, ...stats };
}
