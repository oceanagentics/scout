import { TYPES, fieldLabel } from './records.js';
import { sourceLink } from '../shared/records.js';

export async function loadReview(client) {
  const {data,error}=await client.rpc('review_queue');
  if(error)throw error;
  return data;
}

export async function submitReview(client,record,priority,notes) {
  const {data,error}=await client.rpc('submit_review',{
    p_record_id:record.id,p_modified:record.modified,p_priority:priority,p_notes:notes,
  });
  if(error)throw error;
  return data;
}

export function mountReview(root,load,submit) {
  // Static markup only; finding text and URLs are assigned through DOM properties.
  root.innerHTML=`<div class="review-heading"><h1>Review findings</h1>
    <div class="review-score" aria-label="Your review progress">
      <p><strong id="review-total">0</strong> <span>ranked</span></p>
      <span id="review-plus" aria-hidden="true">+1</span><div class="review-steps" aria-hidden="true">${'<i></i>'.repeat(12)}</div>
      <p id="review-progress">12 to milestone</p></div></div>
    <div class="review-feedback"><p id="review-status" role="status">Loading your next finding…</p><button id="review-retry" type="button" class="secondary" hidden>Reload finding</button></div>
    <article class="review-card" id="review-card" aria-labelledby="review-description" hidden>
      <div class="review-card-top"><span id="review-type" class="eyebrow"></span></div>
      <div class="review-content"><div class="review-description-body" tabindex="0" role="region" aria-label="Finding description"><h2 id="review-description" tabindex="-1"></h2></div>
        <div class="review-source-meta"><div id="review-links" class="review-links"></div><span class="model-ranking">Model <strong id="review-model"></strong></span></div></div>
      <form id="review-form"><fieldset><legend>Your ranking</legend>
        <div class="review-choices" role="group" aria-label="Your ranking"><button type="button" data-priority="high" aria-pressed="false">High</button>
        <button type="button" data-priority="normal" aria-pressed="false">Normal</button>
        <button type="button" data-priority="low" aria-pressed="false">Low</button></div>
        <label for="review-notes">Your notes</label>
        <textarea id="review-notes" name="notes" rows="2" placeholder="Explain your ranking and note any incorrect source URLs." required></textarea>
        <div class="review-submit" role="group" aria-label="Save review" tabindex="0" aria-describedby="review-save-hint"><button type="submit" disabled aria-describedby="review-save-hint">Save & next finding</button>
          <span id="review-save-hint" role="tooltip">To save, open a source link, choose a ranking and add a note.</span></div>
      </fieldset></form></article>
    <div id="review-empty" class="review-empty" hidden><span aria-hidden="true">✦</span><h2>You’re all caught up.</h2><p>Thanks for lending your perspective. Come back when there are new findings to review.</p></div>
    <dialog class="review-milestone" aria-labelledby="milestone-heading"><div class="milestone-burst" aria-hidden="true">${'<i></i>'.repeat(12)}</div>
      <div class="milestone-content"><p class="eyebrow">That’s a milestone</p><div class="milestone-star" aria-hidden="true">✦</div>
      <h2 id="milestone-heading"></h2><p>A dozen more human perspectives.<br>Thanks for making Scout sharper.</p><button type="button" autofocus>Keep going</button></div></dialog>`;
  const form=root.querySelector('#review-form'),fieldset=form.querySelector('fieldset');
  const status=root.querySelector('#review-status'),card=root.querySelector('#review-card');
  const retry=root.querySelector('#review-retry'),milestone=root.querySelector('.review-milestone');
  const choices=form.querySelectorAll('[data-priority]'),notes=form.querySelector('#review-notes'),save=form.querySelector('[type="submit"]');
  const links=root.querySelector('#review-links'),saveHelp=root.querySelector('.review-submit');
  let state,active=true,busy=false,sourceOpened=false;

  function updateSave() {
    save.disabled=!state?.record||!sourceOpened||!notes.value.trim()||!form.querySelector('[data-priority][aria-pressed="true"]');
    saveHelp.tabIndex=save.disabled?0:-1;
  }

  function render(next) {
    state=next;
    root.querySelector('#review-total').textContent=String(state.reviewed_count);
    const progress=state.reviewed_count%12;
    root.querySelector('#review-progress').textContent=`${12-progress} to milestone`;
    root.querySelectorAll('.review-steps i').forEach((step,index)=>step.classList.toggle('complete',index<progress));
    card.hidden=!state.record;
    root.querySelector('#review-empty').hidden=Boolean(state.record);
    form.reset();
    for(const button of choices)button.setAttribute('aria-pressed','false');
    sourceOpened=false;notes.setCustomValidity('');updateSave();
    if(!state.record)return;
    root.querySelector('.review-description-body').scrollTop=0;
    root.querySelector('#review-description').textContent=state.record.description;
    root.querySelector('#review-type').textContent=TYPES[state.record.type]??'Finding';
    root.querySelector('#review-model').textContent=fieldLabel(state.record,'score');
    links.replaceChildren();
    for(const source of state.record.sources) {
      const href=sourceLink(source.url);if(!href)continue;
      const link=document.createElement('a');link.href=href;link.textContent='Open source · '+new URL(href).hostname;
      link.dataset.opened='false';
      link.target='_blank';link.rel='noopener noreferrer';links.append(link);
    }
    if(!links.childElementCount)links.textContent='No source link available.';
  }

  function celebrate(previous,total) {
    if(total<=previous)return;
    if(!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      root.querySelector('#review-total').animate([{transform:'scale(1)'},{transform:'scale(1.25)',color:'#1d5fbf'},{transform:'scale(1)'}],{duration:600});
      root.querySelector('#review-plus').animate([{opacity:0,transform:'translateY(8px) scale(.5)'},{opacity:1,offset:.25,transform:'translateY(-8px) scale(1.2)'},{opacity:0,transform:'translateY(-42px) scale(1)'}],{duration:1000});
    }
    if(Math.floor(total/12)>Math.floor(previous/12)) {
      root.querySelector('#milestone-heading').textContent=`${total} findings ranked!`;
      milestone.showModal();
    }
  }

  async function refresh() {
    if(busy)return;
    busy=true;retry.hidden=true;status.hidden=false;retry.disabled=true;fieldset.disabled=true;
    status.textContent='Loading your next finding…';
    try {
      const next=await load();if(!active)return;
      render(next);status.hidden=true;
    } catch {
      if(active){status.textContent='Could not load your findings. Please try again.';retry.hidden=false;}
    } finally {if(active){busy=false;retry.disabled=false;fieldset.disabled=false;}}
  }

  for(const button of choices)button.addEventListener('click',()=>{
    for(const other of choices)other.setAttribute('aria-pressed',String(other===button));
    updateSave();
  });
  notes.addEventListener('input',()=>{notes.setCustomValidity('');updateSave();});
  for(const type of ['click','auxclick'])links.addEventListener(type,event=>{
    if(event.type==='auxclick'&&event.button!==1)return;
    const link=event.target.closest('a');if(!link)return;
    link.dataset.opened='true';link.textContent='✓ Source opened · '+new URL(link.href).hostname;
    sourceOpened=true;updateSave();
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    if(busy||!state?.record)return;
    updateSave();
    const priority=form.querySelector('[data-priority][aria-pressed="true"]')?.dataset.priority;
    notes.setCustomValidity(notes.value.trim()?'':'Explain why you chose this ranking.');
    if(save.disabled||!form.reportValidity())return;
    const previous=state.reviewed_count;
    busy=true;fieldset.disabled=true;retry.hidden=true;status.hidden=false;status.textContent='Saving your review…';
    try {
      const next=await submit(state.record,priority,notes.value);if(!active)return;
      render(next);status.textContent='Review saved. Thank you!';celebrate(previous,next.reviewed_count);
      if(!milestone.open)(next.record?root.querySelector('#review-description'):root.querySelector('#review-empty')).focus();
    } catch(error) {
      if(!active)return;
      status.textContent=['40001','P0002'].includes(error.code)?error.message:'Could not confirm your review was saved. Your notes are still here; try saving again.';
      retry.hidden=!['40001','P0002'].includes(error.code);
    } finally {if(active){busy=false;fieldset.disabled=false;}}
  });
  retry.addEventListener('click',refresh);
  milestone.querySelector('button').addEventListener('click',()=>milestone.close());
  milestone.addEventListener('close',()=>{if(active&&!root.hidden)root.querySelector(state?.record?'#review-description':'#review-empty').focus();});
  root.querySelector('#review-empty').tabIndex=-1;
  void refresh();
  return ()=>{active=false;if(milestone.open)milestone.close();root.replaceChildren();};
}
