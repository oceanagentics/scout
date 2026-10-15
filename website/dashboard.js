import { KINDS, stamp, eventLabel, trackerState,fieldLabel } from './records.js';
import { sourceLink,eventTiming,orderRecords } from '../shared/records.js';
import {findingInterval,dateLabel} from '../shared/finding-dates.js';

const RECORD_FIELDS = [
  ['event_url', 'Source page'], ['registration_url', 'Registration URL'],
  ['organization', 'Organization'], ['description', 'Description'], ['kind', 'Type'], ['priority','Priority'],
  ['title', 'Title'], ['priority_reason','Priority reason'], ['location', 'Location'], ['status', 'Status'],
  ['starts_at', 'Start / publication / action date'], ['ends_at', 'End / effective date'],
  ['completeness','Completeness'], ['version','Record version'], ['accepted_version','Accepted version'], ['checked_at','Checked at'],
  ['updated_at', 'Updated at (UTC)'], ['id', 'ID'],
];
const TRACKER_FIELDS = [
  ['name', 'Name'], ['url', 'URL'], ['coverage', 'Coverage'], ['collector', 'Collector'],
  ['cadence', 'Cadence'], ['enabled', 'Enabled'],
  ['loop_state', 'Background loop'], ['awaiting_initial', 'Awaiting first review'], ['oldest_awaiting_at', 'Oldest awaiting review (UTC)'],
  ['parked', 'Parked for review/repair'], ['source_problems', 'Source problems'], ['processing_problems', 'Processing problems'],
  ['last_attempt_at', 'Last attempt (UTC)'], ['last_success_at', 'Last success (UTC)'], ['last_outcome', 'Last outcome'],
  ['last_error', 'Last error'], ['seed_key', 'Seed key'], ['id', 'ID'],
];

export async function loadScout(client,{filters={},after=null,jobsAfter=null}={}) {
  const params=Object.fromEntries(['kind','priority','from','to','organization','search','meaning','order'].map(key=>['p_'+key,filters[key]||null]));
  const [page,inventory,backlog]=await Promise.all([
    client.rpc('findings',{...params,p_after:after,p_limit:50,p_id:filters.record||null}),
    client.from('tracker_status').select(TRACKER_FIELDS.map(([field])=>field).join(',')).order('name').limit(500),
    client.rpc('finding_jobs',{p_after:jobsAfter})
  ]);
  if(page.error||inventory.error||backlog.error)throw page.error??inventory.error??backlog.error;
  const records=page.data.map(r=>({...r,organization:r.organizations.map(o=>o.name).join(' / '),
    event_url:r.canonical_url,registration_url:r.details.registration_url,location:r.details.location,status:r.details.status}));
  const last=records.at(-1);
  return {records,trackers:inventory.data,jobs:backlog.data,jobsNext:backlog.data.length===50?backlog.data.at(-1).id:null,next:records.length===50?{rank:filters.order==='date'?0:({high:0,normal:1,low:2}[last.priority]??3),day:findingInterval(last)[0],id:last.id}:null};
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
  root.innerHTML = `<div class="workspace-heading"><nav aria-label="Scout views"><button type="button" data-view="findings" aria-pressed="true">Records</button><button type="button" data-view="discoveries" aria-pressed="false">Awaiting review</button><button type="button" data-view="trackers" aria-pressed="false">Trackers</button></nav><button type="button" id="refresh" class="secondary">Refresh data</button></div>
    <p id="load-status" role="status"></p>
    <section id="findings" aria-label="Records"><div class="findings-toolbar"><form id="filters" class="filters">
      <label class="search">Search records<input name="search" type="search" placeholder="Title, organization, topic…"></label>
      <div class="kind-filters" role="group" aria-label="Record type">
        <label><input class="visually-hidden" type="radio" name="kind" value="" checked><span>All</span></label>
        <label><input class="visually-hidden" type="radio" name="kind" value="announcement"><span>Announcements</span></label>
        <label><input class="visually-hidden" type="radio" name="kind" value="event"><span>Events</span></label>
        <label><input class="visually-hidden" type="radio" name="kind" value="treaty_status"><span>Treaty changes</span></label>
      </div>
      <label>Priority<select name="priority"><option value="">All priorities</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option><option value="unassessed">Not yet assessed</option></select></label>
      <label>Organization<input name="organization" placeholder="Exact organization name"></label>
      <label>From<input name="from" type="date"></label><label>Through<input name="to" type="date"></label>
      <label>Date meaning<select name="meaning"><option value="primary">Start / publication / action</option><option value="effective">Effective date</option></select></label>
      <label>Order<select name="order"><option value="priority">Priority, then date</option><option value="date">Date</option><option value="column" hidden disabled>Selected column</option></select></label>
      </form><div class="view-switch" role="group" aria-label="Records layout">
        <button type="button" data-layout="table" aria-label="Table view" title="Table view" aria-pressed="true"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18M10 9v11"/></svg></button>
        <button type="button" data-layout="cards" aria-label="Card view" title="Card view" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></button>
      </div></div><p id="record-count" role="status"></p><div id="record-list" tabindex="0" role="region" aria-label="Records results"></div><button type="button" id="first-page" class="secondary">First page</button><button type="button" id="next-page" class="secondary">Next page</button></section>
    <section id="discoveries" aria-label="Awaiting review" hidden></section>
    <section id="trackers" aria-label="Trackers" hidden>
      <p id="tracker-count"></p><div class="table-scroll" tabindex="0" role="region" aria-label="Tracker inventory"><table class="data-table"><caption class="visually-hidden">Tracker record fields</caption><thead id="tracker-head"></thead><tbody id="tracker-list"></tbody></table></div></section>`;
  const status = root.querySelector('#load-status'), refresh = root.querySelector('#refresh');
  const filters = root.querySelector('#filters'), recordList = root.querySelector('#record-list');
  let data = null, active = true, loadedAt = null, timings = new Map(), layout = 'table', after=null,jobsAfter=null,request=0,filterTimer;
  const sourceDialog = node('dialog', null, 'source-dialog'), sourceContent = node('div');
  sourceDialog.setAttribute('aria-labelledby', 'source-heading');
  const sourceHeading = node('h2', 'Sources'); sourceHeading.id = 'source-heading';
  const closeSources = node('button', 'Close', 'secondary'); closeSources.type = 'button'; closeSources.autofocus = true;
  closeSources.addEventListener('click', () => sourceDialog.close());
  const sourceHeader = node('div', null, 'workspace-heading'); sourceHeader.append(sourceHeading, closeSources);
  sourceDialog.append(sourceHeader, sourceContent); root.append(sourceDialog);
  const sorts = { records: null, trackers: { field: 'name', direction: 'ascending' } };

  function renderRecords() {
    recordList.replaceChildren();
    const tableView = layout === 'table';
    recordList.className = tableView ? 'table-scroll' : 'record-grid';
    if (!data) return;
    timings = new Map(data.records.filter(record => record.kind === 'event').map(record => [record.id, eventTiming(record)]));
    const values = Object.fromEntries(new FormData(filters));
    const selected = new URLSearchParams(location.search).get('record');
    const records = sorts.records?orderRecords(data.records,sorts.records):data.records;
    const count = root.querySelector('#record-count');
    count.textContent = `${records.length} records on this page${data.next?' · More available':''}`;
    root.querySelector('#first-page').disabled=!after;root.querySelector('#next-page').disabled=!data.next;
    if (selected) {
      const all = node('a', 'Show all records'); all.href = '/'; count.append(' · ', all);
    }
    if (!records.length) { recordList.append(node('p', data.records.length ? 'No records match your search.' : 'No records yet. Collected records will appear here with their sources.', 'empty')); return; }
    let body = recordList;
    if (tableView) {
      const table = node('table', null, 'data-table');
      table.append(node('caption', 'Record fields and sources', 'visually-hidden'));
      const head = node('thead'), row = node('tr');
      const sort = sorts.records??{ field: values.order==='date'?'starts_at':'priority', direction: 'ascending' };
      for (const [field, label] of [...RECORD_FIELDS, ['sources', 'Sources']]) {
        const heading = node('th'); heading.scope = 'col'; row.append(heading);
        const button = node('button', label); button.type = 'button'; button.dataset.sort = field; heading.append(button);
        if (sort.field===field) heading.setAttribute('aria-sort',sort.direction);
        button.title = 'Sort this page by '+label.toLowerCase();
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
          if (cell.textContent.length > 240 && field === 'description') {
            const text = node('div', cell.textContent, 'field-value'); text.tabIndex = 0; cell.replaceChildren(text);
          }
          article.append(cell);
        }
      } else {
        article.append(node('p', KINDS[record.kind] || record.kind, 'eyebrow'), node('h3', record.title), node('p', fieldLabel(record,'organization'), 'organization'));
        article.append(node('p',record.completeness.state),node('p',eventLabel(record),'event-date'));
        for(const [field,label]of [['effective','Effective'],['response_due','Response due']])if(record.details[field])article.append(node('p',`${label} · ${dateLabel(record.details[field])}`,'event-date'));
        if (record.kind === 'event') {
          const badges = node('div', null, 'badges');
          if (record.status === 'rescheduled') badges.append(node('span', 'Rescheduled', 'badge warning'));
          badges.append(node('span', eventTiming(record), `badge ${record.status === 'cancelled' ? 'warning' : ''}`));
          article.append(badges);
        }
        article.append(node('p',`${fieldLabel(record,'priority')} · ${fieldLabel(record,'priority_reason')}`));
        article.append(node('p',fieldLabel(record,'description'),'description'));
        if(record.kind==='event')article.append(node('p',`Location · ${fieldLabel(record,'location')}`));
      }
      const sourcesButton = node('button', tableView ? 'View sources' : 'Sources & record details', 'secondary'); sourcesButton.type = 'button';
      sourcesButton.addEventListener('click', () => {
        sourceContent.replaceChildren(node('h3', record.title), node('p', `Record updated · ${stamp(record.updated_at)}`, 'meta'));
        if (!(record.sources ?? []).length) sourceContent.append(node('p', 'No supporting source links available.', 'hint'));
        for (const [index, source] of (record.sources ?? []).entries()) {
          const section = node('section', null, 'source-entry'), fields = node('dl');
          section.append(node('h3', `Source ${index + 1}`), fields);
          const tracker = trackers.get(source.tracker_id), state = tracker && trackerState(tracker);
          for (const [label, value] of [
            ['Source URL', source.url ? link(source.url, source.url) : 'Unknown'],
            ['Tracker', tracker?.name || 'Unknown'], ['Relationship', source.relationship || 'Unknown'],
            ['Published', source.published_at ? stamp(source.published_at) : source.published_on || 'Unknown'],
            ['Record priority reason', record.relevance?.reason || 'Unknown'], ['Record priority assessed', stamp(record.relevance?.assessed_at)],
            ['Last successful collection', state?.success || 'Unknown'], ['Last collection outcome', state?.outcome || 'Unknown'],
            ['Collection error', tracker ? tracker.last_error || 'None recorded' : 'Unknown'],
          ]) {
            const detail = node('dd'); detail.append(value); fields.append(node('dt', label), detail);
          }
          sourceContent.append(section);
        }
        for(const [field,unknown]of Object.entries(record.completeness.unknowns??{}))sourceContent.append(node('p',`${field}: ${unknown.explanation??unknown.reason}`));
        sourceDialog.showModal();
      });
      const actions = node('div', null, 'actions');
      if (!tableView && sourceLink(record.registration_url)) actions.append(link(record.status === 'cancelled' ? 'Original registration' : 'Registration', record.registration_url));
      if (!tableView && sourceLink(record.event_url) && record.event_url !== record.registration_url) actions.append(link('Source page', record.event_url));
      if (tableView) {
        const sources = node('td'); sources.append(sourcesButton); article.append(sources);
      } else article.append(actions, sourcesButton);
      body.append(article);
    }
  }

  function renderTrackers() {
    const body = root.querySelector('#tracker-list'); body.replaceChildren();
    const head = root.querySelector('#tracker-head'), headings = node('tr');
    for (const [field, label] of TRACKER_FIELDS) {
      const heading = node('th'); heading.scope = 'col'; headings.append(heading);
      const button = node('button', label); button.type = 'button'; button.dataset.sort = field; heading.append(button);
      if (sorts.trackers.field===field) heading.setAttribute('aria-sort',sorts.trackers.direction);
    }
    head.replaceChildren(headings);
    root.querySelector('#tracker-count').textContent = `${data.trackers.length} trackers`;
    if (!data.trackers.length) root.querySelector('#tracker-count').textContent = 'No trackers have been imported yet.';
    for (const tracker of orderRecords(data.trackers,sorts.trackers)) {
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
    const sequence=++request;
    refresh.disabled = true;
    status.classList.remove('loaded');
    status.textContent = data ? 'Refreshing data…' : 'Loading records and trackers…';
    root.setAttribute('aria-busy', 'true');
    try {
      const next = await load({filters:{...Object.fromEntries(new FormData(filters)),record:new URLSearchParams(location.search).get('record')},after,jobsAfter});
      if (!active||sequence!==request) return;
      data = next; loadedAt = new Date().toISOString();
      renderRecords(); renderTrackers();
      const discoveries=root.querySelector('#discoveries');discoveries.replaceChildren(node('p',`${data.jobs.length} pending items on this page.`));
      for(const job of data.jobs){const item=node('article',null,'record');item.append(link(job.title,job.url),node('p',job.explanation??job.state),node('p',job.state==='parked'?'Reconsider explicitly.':'Retry after due time.'));discoveries.append(item);}
      for(const [label,cursor,disabled]of [['First page',null,!jobsAfter],['Next page',data.jobsNext,!data.jobsNext]]){
        const button=node('button',label,'secondary');button.type='button';button.disabled=disabled;button.addEventListener('click',()=>{jobsAfter=cursor;void reload();});discoveries.append(button);
      }
      status.textContent = `Data loaded · ${stamp(loadedAt)}. Collection freshness is shown for each source.`;
      status.classList.add('loaded');
    } catch {
      if (active&&sequence===request) status.textContent = `Could not load Scout data. ${data ? `Showing data loaded ${stamp(loadedAt)}. ` : ''}Use “Refresh data” to try again.`;
    } finally { if (active&&sequence===request) { refresh.disabled = false; root.removeAttribute('aria-busy'); } }
  }
  for (const button of root.querySelectorAll('[data-view]')) button.addEventListener('click', () => {
    for (const other of root.querySelectorAll('[data-view]')) { const selected = other === button; other.setAttribute('aria-pressed', String(selected)); root.querySelector(`#${other.dataset.view}`).hidden = !selected; }
  });
  for (const button of root.querySelectorAll('[data-layout]')) button.addEventListener('click', () => {
    layout = button.dataset.layout;
    for (const other of root.querySelectorAll('[data-layout]')) other.setAttribute('aria-pressed', String(other === button));
    renderRecords();
  });
  for (const [group, section, render] of [['records', '#findings', renderRecords], ['trackers', '#trackers', renderTrackers]]) {
    root.querySelector(section).addEventListener('click', event => {
      const button = event.target.closest('button[data-sort]');
      if (!button) return;
      const field = button.dataset.sort;
      const previous = sorts[group]??{ field: filters.elements.order.value==='date'?'starts_at':'priority', direction: 'ascending' };
      sorts[group] = { field, direction: previous.field===field&&previous.direction==='ascending'?'descending':'ascending' };
      if (group==='records') {
        const option = filters.querySelector('[value="column"]'); option.hidden = false;
        option.textContent = `${button.textContent} (${sorts.records.direction})`; filters.elements.order.value = 'column';
      }
      render();
      root.querySelector(`${section} button[data-sort="${field}"]`)?.focus({ preventScroll: true });
    });
  }
  filters.addEventListener('input', event => {
    if (event.target.name==='order') { sorts.records = null; filters.querySelector('[value="column"]').hidden = true; }
    after=null;clearTimeout(filterTimer);filterTimer=setTimeout(reload,250);
  });
  filters.addEventListener('submit', event => event.preventDefault());
  refresh.addEventListener('click', reload);
  root.querySelector('#first-page').addEventListener('click',()=>{after=null;void reload();});
  root.querySelector('#next-page').addEventListener('click',()=>{after=data?.next;void reload();});
  const tick = () => {
    if (data?.records.some(record => record.kind === 'event' && timings.get(record.id) !== eventTiming(record))) renderRecords();
  };
  const timer = setInterval(tick, 30000);
  document.addEventListener('visibilitychange', tick);
  root.hidden = false; void reload();
  return () => { active = false; clearTimeout(filterTimer);if (sourceDialog.open) sourceDialog.close();clearInterval(timer); document.removeEventListener('visibilitychange', tick); root.replaceChildren(); root.hidden = true; };
}
