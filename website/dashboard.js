import { TYPES, stamp, eventLabel,fieldLabel } from './records.js';
import { sourceLink,eventTiming,orderRecords } from '../shared/records.js';
import {findingInterval} from '../shared/finding-dates.js';

const RECORD_FIELDS = [
  'id', 'description', 'type', 'priority', 'organizations', 'deadline', 'date',
  'starttime', 'timezone', 'sources', 'modified',
];
const TRACKER_FIELDS = [
  ['name','Name'], ['url','URL'], ['coverage','Coverage'], ['cadence','Cadence'], ['enabled','Enabled'],
  ['last_checked_at','Last checked (UTC)'], ['next_check_at','Next check (UTC)'],
  ['failure_count','Consecutive attempts without success'], ['last_error','Last error'], ['id','ID'],
];

export async function loadScout(client,{filters={},after=null}={}) {
  const params=Object.fromEntries(['type','priority','from','to','organization','search','meaning','order'].map(key=>['p_'+key,filters[key]||null]));
  const [page,inventory]=await Promise.all([
    client.rpc('findings',{...params,p_after:after,p_limit:50,p_id:filters.record||null}),
    client.from('trackers').select(TRACKER_FIELDS.map(([field])=>field).join(',')).order('name').limit(500)
  ]);
  if(page.error||inventory.error)throw page.error??inventory.error;
  const records=page.data;
  const last=records.at(-1);
  return {records,trackers:inventory.data,next:records.length===50?{rank:filters.order==='date'?0:({high:0,normal:1,low:2}[last.priority]??3),day:findingInterval(last)[0],id:last.id}:null};
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
      <label class="search">Search records<input name="search" type="search" placeholder="Description, organization, topic…"></label>
      <div class="kind-filters" role="group" aria-label="Record type">
        <label><input class="visually-hidden" type="radio" name="type" value="" checked><span>All</span></label>
        <label><input class="visually-hidden" type="radio" name="type" value="announcement"><span>Announcements</span></label>
        <label><input class="visually-hidden" type="radio" name="type" value="event"><span>Events</span></label>
        <label><input class="visually-hidden" type="radio" name="type" value="treaty_status"><span>Treaty changes</span></label>
      </div>
      <label>Priority<select name="priority"><option value="">All priorities</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option><option value="unassessed">Not yet assessed</option></select></label>
      <label>Organization<input name="organization" placeholder="Exact organization name"></label>
      <label>From<input name="from" type="date"></label><label>Through<input name="to" type="date"></label>
      <label>Date meaning<select name="meaning"><option value="date">date</option><option value="deadline">deadline</option></select></label>
      <label>Order<select name="order"><option value="priority">Priority, then date</option><option value="date">Date</option><option value="column" hidden disabled>Selected column</option></select></label>
      </form><div class="view-switch" role="group" aria-label="Records layout">
        <button type="button" data-layout="table" aria-label="Table view" title="Table view" aria-pressed="true"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18M10 9v11"/></svg></button>
        <button type="button" data-layout="cards" aria-label="Card view" title="Card view" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></button>
      </div></div><p id="record-count" role="status"></p><div id="record-list" tabindex="0" role="region" aria-label="Records results"></div><button type="button" id="first-page" class="secondary">First page</button><button type="button" id="next-page" class="secondary">Next page</button></section>
    <section id="trackers" aria-label="Trackers" hidden>
      <p id="tracker-count"></p><div class="table-scroll" tabindex="0" role="region" aria-label="Tracker inventory"><table class="data-table"><caption class="visually-hidden">Tracker record fields</caption><thead id="tracker-head"></thead><tbody id="tracker-list"></tbody></table></div></section>`;
  const status = root.querySelector('#load-status'), refresh = root.querySelector('#refresh');
  const filters = root.querySelector('#filters'), recordList = root.querySelector('#record-list');
  let data = null, active = true, loadedAt = null, timings = new Map(), layout = 'table', after=null,request=0,filterTimer;
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
    timings = new Map(data.records.filter(record => record.type === 'event').map(record => [record.id, eventTiming(record)]));
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
      const sort = sorts.records??{ field: values.order==='date'?'date':'priority', direction: 'ascending' };
      for (const field of RECORD_FIELDS) {
        const heading = node('th'); heading.scope = 'col'; row.append(heading);
        const button = node('button', field); button.type = 'button'; button.dataset.sort = field; heading.append(button);
        if (sort.field===field) heading.setAttribute('aria-sort',sort.direction);
        button.title = 'Sort this page by '+field;
      }
      head.append(row); table.append(head);
      body = node('tbody'); table.append(body); recordList.append(table);
    }
    for (const record of records) {
      const article = node(tableView ? 'tr' : 'article', null, 'record');
      if (tableView) {
        for (const field of RECORD_FIELDS) {
          const value = record[field], cell = node('td', null, `field-${field}`);
          if (value !== null && typeof value === 'object') {
            const text = node('pre', JSON.stringify(value, null, 2), 'field-value'); text.tabIndex = 0; cell.append(text);
          }
          else cell.textContent = String(value);
          if (cell.textContent.length > 240 && field === 'description') {
            const text = node('div', cell.textContent, 'field-value'); text.tabIndex = 0; cell.replaceChildren(text);
          }
          article.append(cell);
        }
      } else {
        article.append(node('p', TYPES[record.type] || 'Unknown type', 'eyebrow'), node('h3', record.description), node('p', fieldLabel(record,'organizations'), 'organization'));
        article.append(node('p',eventLabel(record),'event-date'));
        if(record.deadline)article.append(node('p',`Deadline · ${record.deadline}`,'event-date'));
        if(record.type==='event')article.append(node('p',eventTiming(record),'badge'));
        article.append(node('p',fieldLabel(record,'priority')));
      }
      const sourcesButton = node('button', tableView ? 'View sources' : 'Sources & record details', 'secondary'); sourcesButton.type = 'button';
      sourcesButton.addEventListener('click', () => {
        sourceContent.replaceChildren(node('h3', record.description), node('p', `Modified · ${stamp(record.modified.at(-1))}`, 'meta'));
        if (!record.sources.length) sourceContent.append(node('p', 'No source URLs available.', 'hint'));
        for (const source of record.sources) {
          const section = node('p', null, 'source-entry'); section.append(link(source, source)); sourceContent.append(section);
        }
        sourceDialog.showModal();
      });
      const actions = node('div', null, 'actions');
      if (!tableView) for(const source of record.sources)if(sourceLink(source))actions.append(link(source,source));
      if (tableView) {
        article.querySelector('.field-sources').append(sourcesButton);
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
      const next = await load({filters:{...Object.fromEntries(new FormData(filters)),record:new URLSearchParams(location.search).get('record')},after});
      if (!active||sequence!==request) return;
      data = next; loadedAt = new Date().toISOString();
      renderRecords(); renderTrackers();
      status.textContent = `Data loaded · ${stamp(loadedAt)}. Tracker checking times are shown for each source.`;
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
      const previous = sorts[group]??{ field: filters.elements.order.value==='date'?'date':'priority', direction: 'ascending' };
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
    if (data?.records.some(record => record.type === 'event' && timings.get(record.id) !== eventTiming(record))) renderRecords();
  };
  const timer = setInterval(tick, 30000);
  document.addEventListener('visibilitychange', tick);
  root.hidden = false; void reload();
  return () => { active = false; clearTimeout(filterTimer);if (sourceDialog.open) sourceDialog.close();clearInterval(timer); document.removeEventListener('visibilitychange', tick); root.replaceChildren(); root.hidden = true; };
}
