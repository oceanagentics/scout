import { KINDS, sourceLink, stamp, recordDates, eventLabel, eventTiming, filterRecords, trackerState, calendarFile } from './records.js';

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
    all('records', 'id,kind,title,organization,description,summary,location,event_url,registration_url,start_on,end_on,starts_at,ends_at,time_zone,status,published_on,country,treaty_action,recorded_on,collected_at,updated_at,date_evidence,sources(url,tracker_id,published_at,published_on,collected_at,authoritative)', 'updated_at'),
    all('trackers', 'id,name,url,coverage,channel,method,cadence,cadence_note,configuration_note,enabled,last_attempt_at,last_success_at,last_outcome,last_error,next_run_at', 'name'),
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
  root.innerHTML = `<div class="workspace-heading"><nav aria-label="Scout views"><button type="button" data-view="findings" aria-pressed="true">Findings</button><button type="button" data-view="trackers" aria-pressed="false">Trackers</button></nav><button type="button" id="refresh" class="secondary">Refresh data</button></div>
    <p id="load-status" role="status"></p>
    <section id="findings" aria-label="Findings"><div class="findings-toolbar"><form id="filters" class="filters">
      <label class="search">Search findings<input name="search" type="search" placeholder="Title, organization, topic…"></label>
      </form><div class="view-switch" role="group" aria-label="Findings layout">
        <button type="button" data-layout="table" aria-label="Table view" title="Table view" aria-pressed="true"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18M10 9v11"/></svg></button>
        <button type="button" data-layout="cards" aria-label="Card view" title="Card view" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></button>
      </div></div><p id="record-count" role="status"></p><div id="record-list" tabindex="0" role="region" aria-label="Findings results"></div></section>
    <section id="trackers" aria-label="Trackers" hidden><h2>Every source, including gaps</h2><p class="hint">Cadence is the requested collection frequency. “Not scheduled” means no automatic run is configured. Manual collection is currently available only for the HSA Bluesky feed.</p>
      <p id="tracker-count"></p><div class="table-scroll" tabindex="0" aria-label="Tracker inventory"><table><caption class="visually-hidden">Source methods, status and freshness</caption><thead><tr><th scope="col">Source</th><th scope="col">Method & cadence</th><th scope="col">Collection status</th><th scope="col">Freshness</th></tr></thead><tbody id="tracker-list"></tbody></table></div></section>`;
  const status = root.querySelector('#load-status'), refresh = root.querySelector('#refresh');
  const filters = root.querySelector('#filters'), recordList = root.querySelector('#record-list');
  let data = null, active = true, loadedAt = null, clocks = [], calendarUrls = [], timings = new Map(), layout = 'table';

  function renderRecords() {
    calendarUrls.forEach(url => URL.revokeObjectURL(url)); calendarUrls = [];
    recordList.replaceChildren();
    const tableView = layout === 'table';
    recordList.className = tableView ? 'table-scroll' : 'record-grid';
    if (!data) return;
    timings = new Map(data.records.filter(record => record.kind === 'event').map(record => [record.id, eventTiming(record)]));
    const values = Object.fromEntries(new FormData(filters));
    const records = filterRecords(data.records, values);
    root.querySelector('#record-count').textContent = `${records.length} of ${data.records.length} findings`;
    if (!records.length) { recordList.append(node('p', data.records.length ? 'No findings match your search.' : 'No records yet. Collected findings will appear here with their sources.', 'empty')); return; }
    let body = recordList;
    if (tableView) {
      const table = node('table', null, 'findings-table');
      table.innerHTML = '<caption class="visually-hidden">Findings with organizations, dates and sources</caption><thead><tr><th scope="col">Finding</th><th scope="col">Organization</th><th scope="col">Date & status</th><th scope="col">Links & details</th></tr></thead>';
      body = node('tbody'); table.append(body); recordList.append(table);
    }
    const trackers = new Map(data.trackers.map(tracker => [tracker.id, tracker]));
    for (const record of records) {
      const article = node(tableView ? 'tr' : 'article', null, 'record');
      const finding = tableView ? node('td') : article, organization = tableView ? node('td') : article;
      const schedule = tableView ? node('td') : article, resources = tableView ? node('td') : article;
      finding.append(node('p', KINDS[record.kind] || record.kind, 'eyebrow'), node('h3', record.title));
      organization.append(node('p', record.organization || 'Unknown organization', 'organization'));
      if (record.kind === 'event') {
        const badges = node('div', null, 'badges');
        if (record.status === 'rescheduled') badges.append(node('span', 'Rescheduled', 'badge warning'));
        badges.append(node('span', eventTiming(record), `badge ${record.status === 'cancelled' ? 'warning' : ''}`));
        schedule.append(badges, node('p', eventLabel(record), 'event-date'));
      } else schedule.append(node('p', `${record.kind === 'treaty_status' ? 'Treaty action' : 'Published'} · ${recordDates(record)[0] || 'Date unknown'}`, 'event-date'));
      if (record.country || record.treaty_action) finding.append(node('p', [record.country, record.treaty_action].filter(Boolean).join(' · ')));
      const details = node('details'); details.append(node('summary', tableView ? 'Summary & sources' : 'Sources & record details'));
      const description = tableView ? details : article;
      if (record.summary || record.description) description.append(node('p', record.summary || record.description, 'summary'));
      if (record.location) description.append(node('p', `Location · ${record.location}`));
      const actions = node('div', null, 'actions');
      if (sourceLink(record.registration_url)) actions.append(link(record.status === 'cancelled' ? 'Original registration' : 'Registration', record.registration_url));
      if (sourceLink(record.event_url) && record.event_url !== record.registration_url) actions.append(link('Event page', record.event_url));
      if (record.kind === 'event') {
        const calendar = calendarFile(record);
        if (calendar) {
          const download = node('a', record.status === 'cancelled' ? 'Download cancellation (.ics)' : 'Add to calendar (.ics)', 'calendar-download secondary');
          download.href = URL.createObjectURL(new Blob([calendar], { type: 'text/calendar;charset=utf-8' }));
          download.download = `scout-${record.id.replace(/[^a-zA-Z0-9-]/g, '')}.ics`;
          calendarUrls.push(download.href); actions.append(download);
        } else actions.append(node('span', 'Calendar unavailable · date / time not yet known', 'hint'));
      }
      resources.append(actions);
      for (const [label, value] of [['Published', record.published_on], ['First collected', stamp(record.collected_at)], ['Record updated', stamp(record.updated_at)]]) if (value) details.append(node('p', `${label} · ${value}`, 'meta'));
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
      resources.append(details);
      if (tableView) article.append(finding, organization, schedule, resources);
      body.append(article);
    }
  }

  function renderTrackers() {
    const body = root.querySelector('#tracker-list'); body.replaceChildren(); clocks = [];
    root.querySelector('#tracker-count').textContent = `${data.trackers.length} trackers`;
    if (!data.trackers.length) root.querySelector('#tracker-count').textContent = 'No trackers have been imported yet.';
    for (const tracker of data.trackers) {
      const row = node('tr'), source = node('td'), method = node('td'), collection = node('td'), freshness = node('td');
      source.append(link(tracker.name, tracker.url), node('p', tracker.channel, 'meta'), node('p', tracker.coverage, 'meta'));
      method.append(node('p', tracker.method), node('p', tracker.cadence_note || tracker.cadence, 'meta'));
      if (tracker.configuration_note) method.append(node('p', tracker.configuration_note, 'hint'));
      const state = trackerState(tracker);
      collection.append(node('p', state.availability, 'badge'), node('p', `Last outcome · ${state.outcome}`));
      if (tracker.last_error) collection.append(node('p', tracker.last_error, 'error'));
      freshness.append(node('p', `Last success · ${state.success}`), node('p', `Last attempt · ${tracker.last_attempt_at ? stamp(tracker.last_attempt_at) : 'Never'}`, 'meta'));
      const schedule = node('p');
      const tick = () => { const current = trackerState(tracker); schedule.textContent = current.schedule; schedule.className = current.overdue ? 'overdue' : 'meta'; };
      tick(); clocks.push(tick); freshness.append(schedule);
      row.append(source, method, collection, freshness); body.append(row);
    }
  }

  async function reload() {
    refresh.disabled = true;
    status.textContent = data ? 'Refreshing data…' : 'Loading findings and trackers…';
    root.setAttribute('aria-busy', 'true');
    try {
      const next = await load();
      if (!active) return;
      data = next; loadedAt = new Date().toISOString();
      renderRecords(); renderTrackers();
      status.textContent = `Data loaded · ${stamp(loadedAt)}. Collection freshness is shown for each source.`;
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
    clocks.forEach(update => update());
    if (data?.records.some(record => record.kind === 'event' && timings.get(record.id) !== eventTiming(record))) renderRecords();
  };
  const timer = setInterval(tick, 30000);
  document.addEventListener('visibilitychange', tick);
  root.hidden = false; void reload();
  return () => { active = false; clearInterval(timer); calendarUrls.forEach(url => URL.revokeObjectURL(url)); document.removeEventListener('visibilitychange', tick); root.replaceChildren(); root.hidden = true; };
}
