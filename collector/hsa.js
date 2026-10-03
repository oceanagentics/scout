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

export async function collectHSA(db, { since = new Date(Date.now() - 30 * 86400000).toISOString(), read = readPublic, now = () => new Date().toISOString(), deadline = Date.now() + LIMITS.seconds * 1000, model, makeModel, sourceId = null, trackerId = null, validate = false } = {}) {
  if (!Number.isFinite(Date.parse(since))) throw new Error('A valid coverage start is required');
  if (validate !== false && (validate !== true || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(trackerId ?? ''))) {
    throw Object.assign(new Error('Validation requires an explicit tracker UUID'), { status: 400 });
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
  if (!actor && !hub && !untc && !doalos && !sideEvents && !hsaWeb && !iddri && !dosiWeb && !gfw && !iucn && !gof) throw Object.assign(new Error('Unsupported tracker configuration; review before collecting'), { status: 400 });
  const publisherHost=({[HSA]:'highseasalliance.org','deepstewardship.bsky.social':'dosi-project.org','globalfishingwatch.org':'globalfishingwatch.org','iddri.bsky.social':'iddri.org'})[actor];
  const started = now();
  const run = (await db.query('insert into scout.collection_runs (tracker_id,coverage_since,started_at,stats) values ($1,$2,$3,$4) returning id', [tracker.id, since, started, validate ? { validation: true } : {}])).rows[0];
  const stats = { created: 0, changed: 0, posts: 0, pages: 0, candidates: 0, skipped: 0, assessed: 0, reused_uncertain: 0, warnings: [] };
  const budget = { requests: 0, deadline: Math.min(deadline, Date.now() + LIMITS.seconds * 1000) };
  model ??= makeModel?.(run.id,budget.deadline);
  const pages = new Map();
  const dateWarnings = new Map();
  let cursor, covered = false, quota = false, feedFailed = false;
  try {
    if (untc) {
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
  if (!covered && !feedFailed && !hub && !untc && !doalos && !sideEvents && !hsaWeb && !iddri && !dosiWeb && !gfw && !iucn && !gof) stats.warnings.push('Feed page limit reached before coverage boundary');
  const pendingQuery=`select * from (select distinct on(url,parsed#>>'{source,item_key}') * from scout.evidence where tracker_id=$1
    order by url,parsed#>>'{source,item_key}',coalesce((parsed#>>'{source,observed_at}')::timestamptz,collected_at) desc,last_seen_at desc nulls last,id) latest
    where parsed#>>'{assessment,state}' in ('pending','uncertain')`;
  const queued = (untc || doalos || sideEvents || hsaWeb || iddri || dosiWeb || gfw || iucn || gof) && feedFailed ? [] : (await db.query(`${pendingQuery} and ($2::uuid is null or id=$2) order by (parsed#>>'{assessment,state}'='uncertain'),collected_at,id limit 20`,[tracker.id,sourceId])).rows.filter(source=>(!(doalos||hsaWeb||iddri)||pages.has(source.url))&&(!sideEvents||pages.has(source.parsed.source.item_key))&&(!(dosiWeb||gfw||iucn||gof)||pages.has(source.id)));
  const pending=[];
  for (const source of queued) {
    if (source.parsed.assessment.state==='uncertain' && source.parsed.assessment.input_fingerprint) {
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
      const decisions=await model(INSTRUCTION,inputs,SCHEMA);
      if (!Array.isArray(decisions)||decisions.length!==batch.length||new Set(decisions.map(d=>d.source_id)).size!==batch.length) throw new Error('Incomplete assessment batch');
      for (let i=0;i<batch.length;i++) {
        const source=batch[i], input=inputs[i];
        let decision=validateDecision(decisions.find(d=>d.source_id===source.id),input);
        // A parsed registration page supplies its own URL. An explicit link in
        // the retained post can resolve "new" only after the normal identity checks.
        const modelDecision=decision;
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
