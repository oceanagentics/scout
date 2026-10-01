import { createHash } from 'node:crypto';
import { request } from 'node:https';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';

export const HSA = 'highseasalliance.bsky.social';
export const USER_AGENT = 'BBNJ-Scout-Bot/1.0 (+https://bbnj-scout.web.app)';
export const LIMITS = { feedPages: 2, postsPerPage: 25, pages: 6, redirects: 3, requests: 24, bytes: 524288, seconds: 120 };
const hash = value => createHash('sha256').update(value).digest('hex');
const normalized = value => value.normalize('NFKC').replace(/\s+/g, ' ').trim();
const relevant = text => /bbnj|high\s*seas(?:\s*treaty)?|haute mer/i.test(text.normalize('NFKC'));
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
  return url.href;
}

// Validate DNS at connection time, including each redirect; never fetch local services.
export async function readPublic(url, budget, redirects = 0) {
  url = sourceURL(url);
  if (++budget.requests > LIMITS.requests || Date.now() > budget.deadline) throw new Error('Request/time limit reached');
  const result = await new Promise((resolve, reject) => {
    const req = request(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/html;q=0.9', 'Accept-Encoding': 'identity' },
      lookup(host, options, callback) {
        lookup(host, { all: true }, (error, addresses) => {
          if (error) return callback(error);
          if (!addresses.length || addresses.some(item => !publicAddress(item.address))) return callback(new Error('Non-public source address'));
          callback(null, options.all ? addresses : addresses[0].address, options.all ? undefined : addresses[0].family);
        });
      },
    }, response => {
      let size = 0;
      const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > LIMITS.bytes) response.destroy(new Error('Source exceeds byte limit'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8'), url }));
    });
    const timeout = setTimeout(() => req.destroy(new Error('Source request timed out')), 12000);
    req.on('close', () => clearTimeout(timeout));
    req.on('error', reject);
    req.end();
  });
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
  return [...new Set(values.map(value => { try { return sourceURL(value); } catch { return null; } }).filter(Boolean))];
}

function postRecord(post, urls) {
  const text = post.record.text;
  if (!relevant(text)) return null;
  const kind = eventPost(text) ? 'event' : 'announcement';
  const eventURL = urls.find(url => /webinar\/register|\/events?\/|\/webinars?\/|registration/i.test(new URL(url).pathname));
  const registration = urls.find(url => /register|registration/i.test(new URL(url).pathname));
  return {
    kind, title: text.split('\n').find(line => line.trim())?.trim() || text,
    organization: post.author.handle === HSA ? 'High Seas Alliance' : post.author.displayName || post.author.handle,
    description: text, summary: text, published_on: post.record.createdAt.slice(0, 10),
    ...dates(), ...(kind === 'event' ? postDates(text) : {}),
    location: null, event_url: kind === 'event' ? eventURL ?? null : null,
    registration_url: kind === 'event' ? registration ?? null : null,
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
      const date = times[0].match(/^([A-Z][a-z]{2}) (\d{1,2}), (\d{4}) \d{2}:\d{2} [AP]M$/);
      const month = date && ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(date[1]) + 1;
      if (!month) return null;
      const parsedDate = dates(`${date[3]}-${String(month).padStart(2, '0')}-${date[2].padStart(2, '0')}`);
      if (!parsedDate.start_on) return null;
      const detail = description ? decode(description[1]) : '';
      return { kind: 'event', title: decode(topic[1]), organization: null,
        description: `${detail}\n\nSource schedule: ${times[0]}. Time zone not supplied by this registration page.`,
        summary: detail || decode(topic[1]), ...parsedDate, location: null,
        event_url: pageURL, registration_url: pageURL, status: null, published_on: null,
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
    summary: typeof event.description === 'string' ? event.description.replace(/<[^>]*>/g, ' ').trim() : null,
    ...parsedDate, location: typeof location === 'string' ? location : null,
    event_url: safe(event.url) ?? pageURL,
    registration_url: safe(event.offers?.url),
    status: ({ EventCancelled: 'cancelled', EventRescheduled: 'rescheduled', EventScheduled: 'scheduled' })[event.eventStatus?.split('/').pop()] ?? null,
    published_on: null,
    limitation: event.startDate && !parsedDate.start_on && !parsedDate.starts_at ? 'Structured event date is unsupported or lacks a time zone' : null,
  };
}

const fields = ['kind', 'title', 'organization', 'description', 'summary', 'location', 'event_url', 'registration_url', 'start_on', 'end_on', 'starts_at', 'ends_at', 'time_zone', 'status', 'published_on'];
function material(record) {
  const names = record.kind === 'event' ? ['kind', 'organization', 'location', 'event_url', 'registration_url', 'start_on', 'end_on', 'starts_at', 'ends_at', 'time_zone', 'status'] : ['kind', 'summary'];
  return hash(JSON.stringify(names.map(name => typeof record[name] === 'string' ? normalized(record[name]).toLowerCase() : record[name] ?? null)));
}

async function version(db, tracker, url, content, publishedAt, parse, fingerprint = content) {
  const digest = `hsa-v1:${hash(fingerprint)}`;
  const old = (await db.query('select * from scout.source_versions where tracker_id=$1 and url=$2 and content_hash=$3', [tracker, url, digest])).rows[0];
  if (old) return old;
  const parsed = parse();
  return (await db.query('insert into scout.source_versions (tracker_id,url,content_hash,content,published_at,parsed) values ($1,$2,$3,$4,$5,$6) returning *', [tracker, url, digest, content, publishedAt, JSON.stringify(parsed)])).rows[0];
}

async function save(db, tracker, identity, source, rank, evidenceAt, stats) {
  const record = source.parsed;
  let existing = (await db.query('select * from scout.records where identity_key=$1', [identity])).rows[0];
  if (existing) {
    for (const field of ['start_on', 'end_on', 'published_on']) if (existing[field] instanceof Date) existing[field] = existing[field].toISOString().slice(0, 10);
    for (const field of ['starts_at', 'ends_at']) if (existing[field] instanceof Date) existing[field] = existing[field].toISOString();
  }
  if (!record && !existing) return;
  const old = existing ? Object.fromEntries(fields.map(field => [field, existing[field]])) : null;
  // Lower-rank reports never override organizer evidence. Equal rank is chronological.
  const accepted = record && (!existing || rank > existing.evidence_rank || (rank === existing.evidence_rank && Date.parse(evidenceAt) >= Date.parse(existing.evidence_at)));
  if (accepted) {
    const merged = Object.fromEntries(fields.map(field => [field, record[field] ?? existing?.[field] ?? null]));
    // A newly evidenced date replaces the prior representation, including date-only/timed changes.
    if (record.start_on || record.starts_at) for (const field of ['start_on', 'end_on', 'starts_at', 'ends_at', 'time_zone']) merged[field] = record[field];
    if (existing?.kind === 'event') {
      const before = existing.start_on || (existing.starts_at && new Date(existing.starts_at).toISOString());
      const after = record.start_on || record.starts_at;
      const comparable = (existing.start_on && record.start_on) || (existing.starts_at && record.starts_at);
      if (comparable && before !== after && merged.status !== 'cancelled') merged.status = 'rescheduled';
      if (existing.status === 'rescheduled' && merged.status === 'scheduled') merged.status = 'rescheduled';
      if (record.status === 'rescheduled' && !after) for (const field of ['start_on', 'end_on', 'starts_at', 'ends_at', 'time_zone']) merged[field] = null;
    }
    const digest = material(merged);
    if (!existing || digest !== existing.material_hash) {
      if (existing) {
        existing = (await db.query(`update scout.records set ${fields.map((field, index) => `${field}=$${index + 1}`).join(',')}, material_hash=$16,evidence_rank=$17,evidence_at=$18 where id=$19 returning *`, [...fields.map(field => merged[field]), digest, rank, evidenceAt, existing.id])).rows[0];
        stats.changed++;
      } else {
        existing = (await db.query(`insert into scout.records (${fields.join(',')},identity_key,material_hash,evidence_rank,evidence_at) values (${Array.from({ length: 19 }, (_, i) => `$${i + 1}`).join(',')}) returning *`, [...fields.map(field => merged[field]), identity, digest, rank, evidenceAt])).rows[0];
        stats.created++;
      }
      await db.query('insert into scout.record_changes (record_id,source_version_id,previous,current) values ($1,$2,$3,$4)', [existing.id, source.id, old ? JSON.stringify(old) : null, JSON.stringify(merged)]);
    } else {
      await db.query('update scout.records set evidence_rank=$1,evidence_at=$2 where id=$3', [rank, evidenceAt, existing.id]);
    }
  }
  await db.query(`insert into scout.sources (record_id,tracker_id,url,published_at,excerpt,content_hash,authoritative)
    values ($1,$2,$3,$4,$5,$6,$7) on conflict (record_id,url) do update set
    content_hash=excluded.content_hash,excerpt=excluded.excerpt,collected_at=now(),authoritative=excluded.authoritative`,
  [existing.id, tracker, source.url, source.published_at, source.content, source.content_hash, rank === 2]);
}

export async function collectHSA(db, { since = new Date(Date.now() - 30 * 86400000).toISOString(), read = readPublic, now = () => new Date().toISOString() } = {}) {
  if (!Number.isFinite(Date.parse(since))) throw new Error('A valid coverage start is required');
  const tracker = (await db.query("select * from scout.trackers where seed_key='bbnj-trackers-2026-10-01:17'")).rows[0];
  if (!tracker?.enabled) throw new Error('HSA tracker is missing or paused');
  if (tracker.url !== `https://bsky.app/profile/${HSA}` || tracker.method !== 'Bluesky API: getAuthorFeed') throw new Error('HSA tracker configuration changed; review before collecting');
  const started = now();
  const run = (await db.query('insert into scout.collection_runs (tracker_id,coverage_since) values ($1,$2) returning id', [tracker.id, since])).rows[0];
  await db.query('update scout.trackers set last_attempt_at=$1 where id=$2', [started, tracker.id]);
  const stats = { created: 0, changed: 0, posts: 0, pages: 0, warnings: [], models: 0 };
  const budget = { requests: 0, deadline: Date.now() + LIMITS.seconds * 1000 };
  const pages = new Map();
  let cursor, covered = false, quota = false, feedFailed = false;
  try {
    for (let page = 0; page < LIMITS.feedPages; page++) {
      const params = new URLSearchParams({ actor: HSA, limit: String(LIMITS.postsPerPage), filter: 'posts_no_replies', includePins: 'false' });
      if (cursor) params.set('cursor', cursor);
      const response = await read(`https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?${params}`, budget);
      const feed = JSON.parse(response.body);
      if (!Array.isArray(feed.feed)) throw new Error('Invalid feed response');
      let reachedBoundary = feed.feed.length > 0;
      for (const item of feed.feed) {
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
        const doc = await version(db, tracker.id, postURL, content, post.record.createdAt, () => postRecord(post, urls));
        if (post.embed?.$type?.includes('record')) stats.warnings.push('Quoted post content is not expanded');
        if (!doc.parsed) continue;
        const identity = doc.parsed.kind === 'event' && doc.parsed.event_url ? `event:${doc.parsed.event_url}` : `post:${post.uri}`;
        await db.transaction(tx => save(tx, tracker.id, identity, doc, post.author.handle === HSA ? 1 : 0, post.record.createdAt, stats));
        // Only event/registration references need follow-up pages in this HSA collector.
        if (doc.parsed.kind !== 'event') continue;
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
              const authoritative = new URL(fetched.url).hostname.replace(/^www\./, '') === 'highseasalliance.org' || (post.author.handle === HSA && url === doc.parsed.registration_url);
              const source = await version(db, tracker.id, fetched.url, fetched.body, null, () => parsed, parsed ? JSON.stringify(parsed) : fetched.body);
              pages.set(url, { source, authoritative, observedAt: now() });
              if (!parsed) stats.warnings.push(`No unambiguous structured event at ${new URL(fetched.url).hostname}`);
              else if (parsed.limitation) stats.warnings.push(parsed.limitation);
            } catch (error) {
              quota ||= Boolean(error.quota);
              pages.set(url, null);
              stats.warnings.push(error.message);
            }
          }
          const found = pages.get(url);
          if (found?.source) await db.transaction(tx => save(tx, tracker.id, identity, found.source, found.authoritative && found.source.parsed ? 2 : 0, found.observedAt, stats));
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
  if (!covered && !feedFailed) stats.warnings.push('Feed page limit reached before coverage boundary');
  stats.warnings = [...new Set(stats.warnings)];
  stats.requests = budget.requests;
  const outcome = quota ? 'quota' : feedFailed && stats.posts === 0 ? 'failed' : !covered || stats.warnings.length ? 'partial' : stats.created || stats.changed ? 'success' : 'no_change';
  const finished = now();
  const error = stats.warnings.length ? stats.warnings.join('; ') : null;
  await db.query('update scout.collection_runs set finished_at=$1,outcome=$2,error=$3,stats=$4 where id=$5', [finished, outcome, error, JSON.stringify(stats), run.id]);
  await db.query("update scout.trackers set last_outcome=$1,last_error=$2,last_success_at=case when $1 in ('success','no_change') then $3 else last_success_at end where id=$4", [outcome, error, finished, tracker.id]);
  return { run_id: run.id, outcome, coverage_since: since, ...stats };
}
