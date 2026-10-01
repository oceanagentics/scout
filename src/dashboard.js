import { KINDS, sourceLink, stamp, eventLabel, eventTiming, filterRecords, trackerState,fieldLabel,orderRecords } from './records.js';

const RECORD_FIELDS = [
  ['title', 'Title'], ['kind', 'Type'], ['organization', 'Organization'], ['description', 'Description'],
  ['priority','Priority'], ['priority_reason','Priority reason'], ['location', 'Location'], ['status', 'Status'],
  ['starts_at', 'Starts at (UTC)'], ['ends_at', 'Ends at (UTC)'],
  ['event_url', 'Event URL'], ['registration_url', 'Registration URL'],
  ['updated_at', 'Updated at (UTC)'], ['id', 'ID'], ['date_evidence', 'Date evidence'],
];
const TRACKER_FIELDS = [
  ['name', 'Name'], ['url', 'URL'], ['coverage', 'Coverage'], ['collector', 'Collector'],
  ['cadence', 'Cadence'], ['enabled', 'Enabled'],
  ['last_attempt_at', 'Last attempt (UTC)'], ['last_success_at', 'Last success (UTC)'], ['last_outcome', 'Last outcome'],
  ['last_error', 'Last error'], ['seed_key', 'Seed key'], ['id', 'ID'],
];

export async function loadScout(client) {
  async function all(table, columns, order, tie = 'id') {
    const rows = [];
    for (let from = 0; ; from += 500) {
      const result = await client.from(table).select(columns).order(order, { ascending: table !== 'records' }).order(tie).range(from, from + 499);
      if (result.error) throw result.error;
      rows.push(...result.data);
      if (result.data.length < 500) return rows;
    }
  }
  const [records, trackers, sources] = await Promise.all([
    all('records', RECORD_FIELDS.map(([field]) => field).filter(field=>field!=='priority_reason').join(','), 'updated_at'),
    all('tracker_status', TRACKER_FIELDS.map(([field]) => field).join(','), 'name'),
    all('source_details', 'record_id,url,tracker_id,published_at,published_on,collected_at,last_seen_at,authoritative,priority_reason,assessed_at', 'record_id', 'url'),
  ]);
  const byRecord = new Map();
  for (const source of sources) {
    if (!byRecord.has(source.record_id)) byRecord.set(source.record_id, []);
    byRecord.get(source.record_id).push(source);
  }
  for (const record of records) {
    record.sources=byRecord.get(record.id)??[];
    record.priority_reason=record.sources.filter(source=>source.priority_reason).sort((a,b)=>Date.parse(b.assessed_at)-Date.parse(a.assessed_at))[0]?.priority_reason??null;
  }
  return { records, trackers };
}

const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
};
function link(text, url) {
  const href = sourceLink(url);
  if (!href) return node('span', text);
  const element = node('a', text);
  element.href = href; element.target = '_blank'; element.rel = 'noopener noreferrer';
  return element;
}

export function mountDashboard(root, load) {
  // Static markup only; every source-supplied value is rendered with textContent.
  root.innerHTML = `<div class="workspace-heading"><nav aria-label="Scout views"><button type="button" data-view="findings" aria-pressed="true">Records</button><button type="button" data-view="trackers" aria-pressed="false">Trackers</button></nav><button type="button" id="refresh" class="secondary">Refresh data</button></div>
    <p id="load-status" role="status"></p>
    <section id="findings" aria-label="Records"><div class="findings-toolbar"><form id="filters" class="filters">
      <label class="search">Search records<input name="search" type="search" placeholder="Title, organization, topic…"></label>
      <div class="kind-filters" role="group" aria-label="Record type">
        <label><input class="visually-hidden" type="radio" name="kind" value="" checked><span>All</span></label>
        <label><input class="visually-hidden" type="radio" name="kind" value="announcement"><span>Announcements</span></label>
        <label><input class="visually-hidden" type="radio" name="kind" value="event"><span>Events</span></label>
      </div>
      <label>Priority<select name="priority"><option value="">All priorities</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option><option value="unassessed">Not yet assessed</option></select></label>
      <label>Order<select name="order"><option value="priority">Priority, then date</option><option value="date">Date</option></select></label>
      </form><div class="view-switch" role="group" aria-label="Records layout">
        <button type="button" data-layout="table" aria-label="Table view" title="Table view" aria-pressed="true"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18M10 9v11"/></svg></button>
        <button type="button" data-layout="cards" aria-label="Card view" title="Card view" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></button>
      </div></div><p id="record-count" role="status"></p><div id="record-list" tabindex="0" role="region" aria-label="Records results"></div></section>
    <section id="trackers" aria-label="Trackers" hidden>
      <p id="tracker-count"></p><div class="table-scroll" tabindex="0" role="region" aria-label="Tracker inventory"><table class="data-table"><caption class="visually-hidden">Tracker record fields</caption><thead id="tracker-head"></thead><tbody id="tracker-list"></tbody></table></div></section>`;
  const status = root.querySelector('#load-status'), refresh = root.querySelector('#refresh');
  const filters = root.querySelector('#filters'), recordList = root.querySelector('#record-list');
  let data = null, active = true, loadedAt = null, timings = new Map(), layout = 'table';

  function renderRecords() {
    recordList.replaceChildren();
    const tableView = layout === 'table';
    recordList.className = tableView ? 'table-scroll' : 'record-grid';
    if (!data) return;
    timings = new Map(data.records.filter(record => record.kind === 'event').map(record => [record.id, eventTiming(record)]));
    const values = Object.fromEntries(new FormData(filters));
    const selected = new URLSearchParams(location.search).get('record');
    const records = orderRecords(filterRecords(data.records,{...values,record:selected}),values.order);
    const count = root.querySelector('#record-count');
    count.textContent = `${records.length} of ${data.records.length} records`;
    if (selected) {
      const all = node('a', 'Show all records'); all.href = '/'; count.append(' · ', all);
    }
    if (!records.length) { recordList.append(node('p', data.records.length ? 'No records match your search.' : 'No records yet. Collected records will appear here with their sources.', 'empty')); return; }
    let body = recordList;
    if (tableView) {
      const table = node('table', null, 'data-table');
      table.append(node('caption', 'Record fields and sources', 'visually-hidden'));
      const head = node('thead'), row = node('tr');
      for (const label of [...RECORD_FIELDS.map(([, label]) => label), 'Sources']) {
        const heading = node('th', label); heading.scope = 'col'; row.append(heading);
      }
      head.append(row); table.append(head);
      body = node('tbody'); table.append(body); recordList.append(table);
    }
    const trackers = new Map(data.trackers.map(tracker => [tracker.id, tracker]));
    for (const record of records) {
      const article = node(tableView ? 'tr' : 'article', null, 'record');
      if (tableView) {
        for (const [field] of RECORD_FIELDS) {
          const value = record[field], cell = node('td', null, `field-${field}`);
          if (field.endsWith('_url') && value) cell.append(link(value, value));
          else cell.textContent = fieldLabel(record,field);
          if (cell.textContent.length > 240 && ['description', 'date_evidence'].includes(field)) {
            const text = node('div', cell.textContent, 'field-value'); text.tabIndex = 0; cell.replaceChildren(text);
          }
          article.append(cell);
        }
      } else {
        article.append(node('p', KINDS[record.kind] || record.kind, 'eyebrow'), node('h3', record.title), node('p', record.organization || 'Unknown organization', 'organization'));
        if (record.kind === 'event') {
          const badges = node('div', null, 'badges');
          if (record.status === 'rescheduled') badges.append(node('span', 'Rescheduled', 'badge warning'));
          badges.append(node('span', eventTiming(record), `badge ${record.status === 'cancelled' ? 'warning' : ''}`));
          article.append(badges, node('p', eventLabel(record), 'event-date'));
        }
        article.append(node('p',`${fieldLabel(record,'priority')} · ${fieldLabel(record,'priority_reason')}`));
        article.append(node('p',fieldLabel(record,'description'),'description'),node('p',`Location · ${fieldLabel(record,'location')}`));
        if (record.kind!=='event') article.append(node('p','Event date · Not applicable'));
        for (const field of ['event_url','registration_url']) if (!sourceLink(record[field])) article.append(node('p',`${field==='event_url'?'Event page':'Registration'} · ${fieldLabel(record,field)}`));
      }
      const details = node('details'); details.append(node('summary', tableView ? 'View sources' : 'Sources & record details'));
      const actions = node('div', null, 'actions');
      if (!tableView && sourceLink(record.registration_url)) actions.append(link(record.status === 'cancelled' ? 'Original registration' : 'Registration', record.registration_url));
      if (!tableView && sourceLink(record.event_url) && record.event_url !== record.registration_url) actions.append(link('Event page', record.event_url));
      if (!tableView) details.append(node('p', `Record updated · ${stamp(record.updated_at)}`, 'meta'));
      if (!(record.sources ?? []).length) details.append(node('p', 'No supporting source links available.', 'hint'));
      const seen = new Set();
      for (const source of record.sources ?? []) {
        const href = sourceLink(source.url);
        if (href) details.append(link(`Source · ${new URL(href).hostname}${source.authoritative ? ' · Authoritative' : ''}`, href));
        details.append(node('p', `Source published · ${source.published_at ? stamp(source.published_at) : source.published_on || 'Unknown'} · Captured · ${stamp(source.collected_at)} · Last seen · ${stamp(source.last_seen_at)}`, 'meta'));
        const tracker = trackers.get(source.tracker_id);
        if (tracker && !seen.has(tracker.id)) {
          seen.add(tracker.id);
          const state = trackerState(tracker);
          details.append(node('p', `${tracker.name} · Last successful collection: ${state.success} · Last outcome: ${state.outcome}${tracker.last_error ? ` · ${tracker.last_error}` : ''}`, 'meta'));
        }
      }
      if (tableView) {
        const sources = node('td'); sources.append(details); article.append(sources);
      } else article.append(actions, details);
      body.append(article);
    }
  }

  function renderTrackers() {
    const body = root.querySelector('#tracker-list'); body.replaceChildren();
    const head = root.querySelector('#tracker-head'), headings = node('tr');
    for (const [, label] of TRACKER_FIELDS) {
      const heading = node('th', label); heading.scope = 'col'; headings.append(heading);
    }
    head.replaceChildren(headings);
    root.querySelector('#tracker-count').textContent = `${data.trackers.length} trackers`;
    if (!data.trackers.length) root.querySelector('#tracker-count').textContent = 'No trackers have been imported yet.';
    for (const tracker of data.trackers) {
      const row = node('tr');
      for (const [field] of TRACKER_FIELDS) {
        const value = tracker[field], cell = node('td', null, `field-${field}`);
        if (field === 'url' && value) cell.append(link(value, value));
        else cell.textContent = value == null || value === '' ? '—' : typeof value === 'boolean' ? value ? 'Yes' : 'No'
          : field.endsWith('_at') ? stamp(value) : value;
        if (cell.textContent.length > 240 && ['coverage', 'last_error'].includes(field)) {
          const text = node('div', cell.textContent, 'field-value'); text.tabIndex = 0; cell.replaceChildren(text);
        }
        row.append(cell);
      }
      body.append(row);
    }
  }

  async function reload() {
    refresh.disabled = true;
    status.classList.remove('loaded');
    status.textContent = data ? 'Refreshing data…' : 'Loading records and trackers…';
    root.setAttribute('aria-busy', 'true');
    try {
      const next = await load();
      if (!active) return;
      data = next; loadedAt = new Date().toISOString();
      renderRecords(); renderTrackers();
      status.textContent = `Data loaded · ${stamp(loadedAt)}. Collection freshness is shown for each source.`;
      status.classList.add('loaded');
    } catch {
      if (active) status.textContent = `Could not load Scout data. ${data ? `Showing data loaded ${stamp(loadedAt)}. ` : ''}Use “Refresh data” to try again.`;
    } finally { if (active) { refresh.disabled = false; root.removeAttribute('aria-busy'); } }
  }
  for (const button of root.querySelectorAll('[data-view]')) button.addEventListener('click', () => {
    for (const other of root.querySelectorAll('[data-view]')) { const selected = other === button; other.setAttribute('aria-pressed', String(selected)); root.querySelector(`#${other.dataset.view}`).hidden = !selected; }
  });
  for (const button of root.querySelectorAll('[data-layout]')) button.addEventListener('click', () => {
    layout = button.dataset.layout;
    for (const other of root.querySelectorAll('[data-layout]')) other.setAttribute('aria-pressed', String(other === button));
    renderRecords();
  });
  filters.addEventListener('input', renderRecords);
  filters.addEventListener('submit', event => event.preventDefault());
  refresh.addEventListener('click', reload);
  const tick = () => {
    if (data?.records.some(record => record.kind === 'event' && timings.get(record.id) !== eventTiming(record))) renderRecords();
  };
  const timer = setInterval(tick, 30000);
  document.addEventListener('visibilitychange', tick);
  root.hidden = false; void reload();
  return () => { active = false; clearInterval(timer); document.removeEventListener('visibilitychange', tick); root.replaceChildren(); root.hidden = true; };
}
