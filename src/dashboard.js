import { KINDS, sourceLink, stamp, recordDates, eventLabel, eventTiming, filterRecords, trackerState, calendarFile } from './records.js';

const RECORD_FIELDS = [
  ['title', 'Title'], ['kind', 'Type'], ['organization', 'Organization'], ['summary', 'Summary'], ['description', 'Description'],
  ['location', 'Location'], ['status', 'Status'], ['start_on', 'Start date'], ['end_on', 'End date'],
  ['starts_at', 'Starts at (UTC)'], ['ends_at', 'Ends at (UTC)'], ['time_zone', 'Time zone'], ['published_on', 'Published on'],
  ['country', 'Country'], ['treaty_action', 'Treaty action'], ['recorded_on', 'Recorded on'],
  ['event_url', 'Event URL'], ['registration_url', 'Registration URL'], ['collected_at', 'Collected at (UTC)'],
  ['updated_at', 'Updated at (UTC)'], ['id', 'ID'], ['date_evidence', 'Date evidence'],
];
const TRACKER_FIELDS = [
  ['name', 'Name'], ['url', 'URL'], ['coverage', 'Coverage'], ['channel', 'Channel'], ['method', 'Method'],
  ['cadence', 'Cadence'], ['cadence_note', 'Cadence note'], ['configuration_note', 'Configuration note'], ['enabled', 'Enabled'],
  ['last_attempt_at', 'Last attempt (UTC)'], ['last_success_at', 'Last success (UTC)'], ['last_outcome', 'Last outcome'],
  ['last_error', 'Last error'], ['next_run_at', 'Next run (UTC)'], ['created_at', 'Created at (UTC)'],
  ['updated_at', 'Updated at (UTC)'], ['seed_key', 'Seed key'], ['id', 'ID'],
];

export async function loadScout(client) {
  async function all(table, columns, order) {
    const rows = [];
    for (let from = 0; ; from += 500) {
      const result = await client.from(table).select(columns).order(order, { ascending: table === 'trackers' }).order('id').range(from, from + 499);
      if (result.error) throw result.error;
      rows.push(...result.data);
      if (result.data.length < 500) return rows;
    }
  }
  const [records, trackers] = await Promise.all([
    all('records', `${RECORD_FIELDS.map(([field]) => field).join(',')},sources(url,tracker_id,published_at,published_on,collected_at,authoritative)`, 'updated_at'),
    all('trackers', TRACKER_FIELDS.map(([field]) => field).join(','), 'name'),
  ]);
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
      </form><div class="view-switch" role="group" aria-label="Records layout">
        <button type="button" data-layout="table" aria-label="Table view" title="Table view" aria-pressed="true"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18M10 9v11"/></svg></button>
        <button type="button" data-layout="cards" aria-label="Card view" title="Card view" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></button>
      </div></div><p id="record-count" role="status"></p><div id="record-list" tabindex="0" role="region" aria-label="Records results"></div></section>
    <section id="trackers" aria-label="Trackers" hidden>
      <p id="tracker-count"></p><div class="table-scroll" tabindex="0" role="region" aria-label="Tracker inventory"><table class="data-table"><caption class="visually-hidden">Tracker record fields</caption><thead id="tracker-head"></thead><tbody id="tracker-list"></tbody></table></div></section>`;
  const status = root.querySelector('#load-status'), refresh = root.querySelector('#refresh');
  const filters = root.querySelector('#filters'), recordList = root.querySelector('#record-list');
  let data = null, active = true, loadedAt = null, calendarUrls = [], timings = new Map(), layout = 'table';

  function renderRecords() {
    calendarUrls.forEach(url => URL.revokeObjectURL(url)); calendarUrls = [];
    recordList.replaceChildren();
    const tableView = layout === 'table';
    recordList.className = tableView ? 'table-scroll' : 'record-grid';
    if (!data) return;
    timings = new Map(data.records.filter(record => record.kind === 'event').map(record => [record.id, eventTiming(record)]));
    const values = Object.fromEntries(new FormData(filters));
    const records = filterRecords(data.records, values);
    root.querySelector('#record-count').textContent = `${records.length} of ${data.records.length} records`;
    if (!records.length) { recordList.append(node('p', data.records.length ? 'No records match your search.' : 'No records yet. Collected records will appear here with their sources.', 'empty')); return; }
    let body = recordList;
    if (tableView) {
      const table = node('table', null, 'data-table');
      table.append(node('caption', 'Finding record fields, calendars and sources', 'visually-hidden'));
      const head = node('thead'), row = node('tr');
      for (const label of [...RECORD_FIELDS.map(([, label]) => label), 'Calendar', 'Sources']) {
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
          else cell.textContent = value == null || value === '' ? '—' : field === 'kind' ? KINDS[value] || value
            : typeof value === 'object' ? JSON.stringify(value, null, 2) : field.endsWith('_at') ? stamp(value) : value;
          if (cell.textContent.length > 240 && ['summary', 'description', 'date_evidence'].includes(field)) {
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
        } else article.append(node('p', `${record.kind === 'treaty_status' ? 'Treaty action' : 'Published'} · ${recordDates(record)[0] || 'Date unknown'}`, 'event-date'));
        if (record.country || record.treaty_action) article.append(node('p', [record.country, record.treaty_action].filter(Boolean).join(' · ')));
        if (record.summary || record.description) article.append(node('p', record.summary || record.description, 'summary'));
        if (record.location) article.append(node('p', `Location · ${record.location}`));
      }
      const details = node('details'); details.append(node('summary', tableView ? 'View sources' : 'Sources & record details'));
      const actions = node('div', null, 'actions');
      if (!tableView && sourceLink(record.registration_url)) actions.append(link(record.status === 'cancelled' ? 'Original registration' : 'Registration', record.registration_url));
      if (!tableView && sourceLink(record.event_url) && record.event_url !== record.registration_url) actions.append(link('Event page', record.event_url));
      if (record.kind === 'event') {
        const calendar = calendarFile(record);
        if (calendar) {
          const download = node('a', record.status === 'cancelled' ? 'Download cancellation (.ics)' : 'Add to calendar (.ics)', 'calendar-download secondary');
          download.href = URL.createObjectURL(new Blob([calendar], { type: 'text/calendar;charset=utf-8' }));
          download.download = `scout-${record.id.replace(/[^a-zA-Z0-9-]/g, '')}.ics`;
          calendarUrls.push(download.href); actions.append(download);
        } else actions.append(node('span', 'Calendar unavailable · date / time not yet known', 'hint'));
      }
      if (!tableView) for (const [label, value] of [['Published', record.published_on], ['First collected', stamp(record.collected_at)], ['Record updated', stamp(record.updated_at)]]) if (value) details.append(node('p', `${label} · ${value}`, 'meta'));
      if (!(record.sources ?? []).length) details.append(node('p', 'No supporting source links available.', 'hint'));
      const seen = new Set();
      for (const source of record.sources ?? []) {
        const href = sourceLink(source.url);
        if (href) details.append(link(`Source · ${new URL(href).hostname}${source.authoritative ? ' · Authoritative' : ''}`, href));
        details.append(node('p', `Source published · ${source.published_at ? stamp(source.published_at) : source.published_on || 'Unknown'} · Evidence collected · ${stamp(source.collected_at)}`, 'meta'));
        const tracker = trackers.get(source.tracker_id);
        if (tracker && !seen.has(tracker.id)) {
          seen.add(tracker.id);
          const state = trackerState(tracker);
          details.append(node('p', `${tracker.name} · Last successful collection: ${state.success} · Last outcome: ${state.outcome}${tracker.last_error ? ` · ${tracker.last_error}` : ''}`, 'meta'));
        }
      }
      if (tableView) {
        const calendar = node('td'), sources = node('td');
        calendar.append(actions.childElementCount ? actions : node('span', '—')); sources.append(details); article.append(calendar, sources);
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
        if (cell.textContent.length > 240 && ['coverage', 'cadence_note', 'configuration_note', 'last_error'].includes(field)) {
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
  return () => { active = false; clearInterval(timer); calendarUrls.forEach(url => URL.revokeObjectURL(url)); document.removeEventListener('visibilitychange', tick); root.replaceChildren(); root.hidden = true; };
}
