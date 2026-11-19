import { TYPES, stamp, eventLabel,fieldLabel } from './records.js';
import { sourceLink,eventTiming,orderRecords } from '../shared/records.js';
import {findingInterval,scoutDay} from '../shared/finding-dates.js';
import {mountReview} from './review.js';

const RECORD_FIELDS = [
  'description', 'type', 'priority', 'organizations', 'date',
  'starttime', 'timezone', 'enddate', 'endtime', 'sources', 'modified', 'id',
];
const TRACKER_FIELDS = [
  ['name','Name'], ['url','URL'], ['collector','Read as'], ['coverage','Coverage'], ['cadence','Cadence'], ['enabled','Enabled'],
  ['retire_on','Retire on (New York)'],
  ['last_checked_at','Last attempted (New York)'], ['last_successful_check','Consumed through (New York)'],
  ['failure_count','Consecutive attempts without success'], ['last_error','Last error'], ['id','ID'],
];

export async function loadScout(client,{filters={},after=null}={}) {
  const params=Object.fromEntries(['type','priority','from','to','organization','search','order'].map(key=>['p_'+key,filters[key]||null]));
  const [page,inventory]=await Promise.all([
    client.rpc('findings',{...params,p_after:after,p_limit:50,p_id:filters.record||null}),
    client.from('trackers').select(TRACKER_FIELDS.map(([field])=>field).join(','))
      .or('retire_on.is.null,retire_on.gt.'+scoutDay()).order('name').limit(500)
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

export function mountDashboard(root, load, views, reviews) {
  // Static markup only; every source-supplied value is rendered with textContent.
  root.innerHTML = `<section id="review" aria-label="Review findings"></section><p id="load-status" role="status" hidden></p>
    <section id="findings" aria-label="Records" hidden><div class="findings-toolbar"><form id="filters" class="filters">
      <label class="search">Search records<input name="search" type="search" placeholder="Description, organization, topic…"></label>
      <label>Record type<select name="type"><option value="">All</option><option value="announcement">Announcements</option><option value="event">Events</option></select></label>
      <label>Priority<select name="priority"><option value="">All priorities</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option><option value="unassessed">Not yet assessed</option></select></label>
      <label>From<input name="from" type="date"></label><label>Through<input name="to" type="date"></label>
      </form><div class="view-switch" role="group" aria-label="Records layout">
        <button type="button" data-layout="table" aria-label="Table view" title="Table view" aria-pressed="true"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18M10 9v11"/></svg></button>
        <button type="button" data-layout="cards" aria-label="Card view" title="Card view" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></button>
      </div></div><p id="record-count" role="status"></p><div id="record-list" tabindex="0" role="region" aria-label="Records results"></div><button type="button" id="first-page" class="secondary">First page</button><button type="button" id="next-page" class="secondary">Next page</button></section>
    <section id="trackers" aria-label="Trackers" hidden>
      <p id="tracker-count"></p><div class="table-scroll" tabindex="0" role="region" aria-label="Tracker inventory"><table class="data-table"><caption class="visually-hidden">Tracker record fields</caption><thead id="tracker-head"></thead><tbody id="tracker-list"></tbody></table></div></section>
    <section id="calendar" aria-label="Calendar" hidden>
      <h1>Scout Calendar</h1><p class="calendar-intro">Keep Scout events alongside your own calendar. Add it once; new events appear automatically.</p>
      <div class="calendar-actions"><a class="calendar-add" href="https://calendar.google.com/calendar/u/0?cid=Y19jNGViYTU2OTdkM2EzZTMzYzQ1OTBkYWE3YzIwYzg3OTFkN2Q2MDhiNzg3ZmY5NTliZjMxMTdmM2E3ZDAyZGY1QGdyb3VwLmNhbGVuZGFyLmdvb2dsZS5jb20" target="_blank" rel="noopener noreferrer">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 2v4M16 2v4M3 10h18M8 15h8M12 11v8"/></svg>Add to Google Calendar</a>
        <span class="hint">Use your Ocean Agentics account on a computer.</span></div>
      <p class="hint">When Google Calendar opens, choose <strong>Add</strong> if prompted. You don't need to paste the link into <strong>From URL</strong>.</p>
      <ol class="calendar-steps">
        <li><h2>1. Check your account</h2><p>Use the account icon at the far right of Google Calendar's header. Choose your Ocean Agentics account. Your icon may have a different photo or initial.</p>
          <figure class="calendar-screenshot calendar-header-shot"><img src="/calendar/google-calendar-header.jpg" width="1280" height="64" loading="lazy" alt="The full Google Calendar header, from its logo on the left to the circled account icon at the far right."></figure>
          <div class="calendar-detail"><p class="hint">Account icon, close up:</p><figure class="calendar-screenshot calendar-account-shot">
            <img src="/calendar/google-account.jpg" width="176" height="100" loading="lazy" alt="Close-up of the account icon circled in red."></figure></div></li>
        <li><h2>2. Show the events</h2><p>In the left sidebar, scroll below the small month calendar. Click <strong>Other calendars</strong> to expand the list, or <strong>My calendars</strong> if you own Scout. Then tick the box beside <strong>Scout</strong>.</p>
          <div class="calendar-location"><figure class="calendar-screenshot calendar-sidebar-shot">
            <img src="/calendar/google-calendar-sidebar.jpg" width="256" height="635" loading="lazy" alt="Google Calendar's full left navigation column, with My calendars and Other calendars outlined near the bottom."></figure>
            <div class="calendar-detail"><p class="hint">Expand the list, then look for this checkbox:</p><figure class="calendar-screenshot calendar-scout-shot">
              <img src="/calendar/google-scout-checkbox.jpg" width="244" height="128" loading="lazy" alt="Close-up of the Scout checkbox circled in red."></figure></div></div></li>
      </ol>
      <div class="calendar-help"><h2>Already have Scout?</h2><p>If Google says the calendar already exists, you're set. <a href="https://calendar.google.com/calendar/" target="_blank" rel="noopener noreferrer">Open Google Calendar</a> and tick <strong>Scout</strong> in the list.</p>
        <img class="calendar-message" src="/calendar/google-already-added.jpg" width="379" height="48" loading="lazy" alt="Google Calendar notification: This calendar already exists in your calendar list.">
        <p>If adding still fails, check your Ocean Agentics account first, then ask Danny if you need access.</p></div>
      <p class="hint">On your phone, open Google Calendar with the same account and turn on Scout in the menu. <a href="https://support.google.com/calendar/answer/37100" target="_blank" rel="noopener noreferrer">Google's calendar instructions</a></p>
    </section>`;
  const status = root.querySelector('#load-status');
  const filters = root.querySelector('#filters'), recordList = root.querySelector('#record-list');
  let data = null, active = true, loadedAt = null, timings = new Map(), layout = 'table', after=null,request=0,filterTimer,started=false;
  const closeReview=mountReview(root.querySelector('#review'),reviews.load,reviews.submit);
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
    const selected = new URLSearchParams(location.search).get('record');
    const records = sorts.records?orderRecords(data.records,sorts.records):data.records;
    const count = root.querySelector('#record-count');
    count.textContent = `${records.length} records on this page${data.next?' · More available':''}`;
    root.querySelector('#first-page').disabled=!after;root.querySelector('#next-page').disabled=!data.next;
    if (selected) {
      const all = node('a', 'Show all records'); all.href = '/#findings'; count.append(' · ', all);
    }
    if (!records.length) { recordList.append(node('p', data.records.length ? 'No records match your search.' : 'No records yet. Collected records will appear here with their sources.', 'empty')); return; }
    let body = recordList;
    if (tableView) {
      const table = node('table', null, 'data-table');
      table.append(node('caption', 'Record fields and sources', 'visually-hidden'));
      const head = node('thead'), row = node('tr');
      const sort = sorts.records??{ field: 'priority', direction: 'ascending' };
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
        if(record.type==='event')article.append(node('p',eventTiming(record),'badge'));
        article.append(node('p',fieldLabel(record,'priority')));
      }
      const sourcesButton = node('button', tableView ? 'View sources' : 'Sources & record details', 'secondary'); sourcesButton.type = 'button';
      sourcesButton.addEventListener('click', () => {
        sourceContent.replaceChildren(node('h3', record.description), node('p', `Modified · ${stamp(record.modified.at(-1))}`, 'meta'));
        if(record.details)sourceContent.append(node('p',record.details,'finding-details'));
        if (!record.sources.length) sourceContent.append(node('p', 'No source URLs available.', 'hint'));
        for (const source of record.sources) {
          const section = node('p', null, 'source-entry'); section.append(link(source.url,source.role+' · '+source.url)); sourceContent.append(section);
        }
        sourceDialog.showModal();
      });
      const actions = node('div', null, 'actions');
      if (!tableView) for(const source of record.sources)if(sourceLink(source.url))actions.append(link(source.url,source.role+' · '+source.url));
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
        if(field==='collector')cell.textContent=value==='bluesky_feed'?'Bluesky feed':value==='web_page'?'Page':'Index';
        else if (field === 'url' && value) cell.append(link(value, value));
        else cell.textContent = value == null || value === '' ? '—' : typeof value === 'boolean' ? value ? 'Yes' : 'No'
          : field.endsWith('_at')||field==='last_successful_check' ? stamp(value) : value;
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
    status.hidden = false;
    status.textContent = data ? 'Refreshing data…' : 'Loading records and trackers…';
    root.setAttribute('aria-busy', 'true');
    try {
      const next = await load({filters:{...Object.fromEntries(new FormData(filters)),record:new URLSearchParams(location.search).get('record')},after});
      if (!active||sequence!==request) return;
      data = next; loadedAt = new Date().toISOString();
      renderRecords(); renderTrackers();
      status.textContent = '';
      status.hidden = true;
    } catch {
      if (active&&sequence===request) status.textContent = `Could not load Scout data. ${data ? `Showing data loaded ${stamp(loadedAt)}. ` : ''}Reload the page to try again.`;
    } finally { if (active&&sequence===request) root.removeAttribute('aria-busy'); }
  }
  for (const link of views.querySelectorAll('[data-view]')) {
    if (link.dataset.view==='review') link.setAttribute('aria-current','page');
    else link.removeAttribute('aria-current');
  }
  const navigate = event => {
    const link = event.target.closest('[data-view]');
    if (!link) return;
    event.preventDefault();
    for (const other of views.querySelectorAll('[data-view]')) {
      const selected = other === link;
      if (selected) other.setAttribute('aria-current','page');
      else other.removeAttribute('aria-current');
      root.querySelector(`#${other.dataset.view}`).hidden = !selected;
    }
    if(['findings','trackers'].includes(link.dataset.view)&&!started){started=true;void reload();}
    status.hidden=!['findings','trackers'].includes(link.dataset.view)||!status.textContent;
  };
  views.addEventListener('click', navigate);
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
      const previous = sorts[group]??{ field: 'priority', direction: 'ascending' };
      sorts[group] = { field, direction: previous.field===field&&previous.direction==='ascending'?'descending':'ascending' };
      render();
      root.querySelector(`${section} button[data-sort="${field}"]`)?.focus({ preventScroll: true });
    });
  }
  filters.addEventListener('input', () => {
    after=null;clearTimeout(filterTimer);filterTimer=setTimeout(reload,250);
  });
  filters.addEventListener('submit', event => event.preventDefault());
  root.querySelector('#first-page').addEventListener('click',()=>{after=null;void reload();});
  root.querySelector('#next-page').addEventListener('click',()=>{after=data?.next;void reload();});
  const tick = () => {
    if (data?.records.some(record => record.type === 'event' && timings.get(record.id) !== eventTiming(record))) renderRecords();
  };
  const timer = setInterval(tick, 30000);
  document.addEventListener('visibilitychange', tick);
  root.hidden = false;
  const initialView=new URLSearchParams(location.search).has('record')?'findings':location.hash.slice(1);
  if(['findings','trackers','calendar'].includes(initialView))views.querySelector(`[data-view="${initialView}"]`).click();
  return () => { active = false;closeReview(); views.removeEventListener('click', navigate);clearTimeout(filterTimer);if (sourceDialog.open) sourceDialog.close();clearInterval(timer); document.removeEventListener('visibilitychange', tick); root.replaceChildren(); root.hidden = true; };
}
