import { PRIORITIES, TYPES } from './records.js';
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
  root.innerHTML=`<div class="review-heading"><div><p class="eyebrow">The human perspective</p>
    <h1>A little judgment.<br>A better Scout.</h1><p class="review-intro">Help us spot what matters. Review one finding at a time.</p></div>
    <div class="review-score" aria-label="Your review progress"><span class="eyebrow">Your contribution</span>
      <p><strong id="review-total">0</strong> <span>findings ranked</span></p>
      <span id="review-plus" aria-hidden="true">+1</span><div class="review-steps" aria-hidden="true">${'<i></i>'.repeat(12)}</div>
      <p id="review-progress">12 to your first milestone</p></div></div>
    <p id="review-status" role="status">Loading your next finding…</p><button id="review-retry" type="button" class="secondary" hidden>Reload finding</button>
    <article class="review-card" id="review-card" aria-labelledby="review-description" hidden>
      <div class="review-card-top"><span id="review-type" class="eyebrow"></span><span class="model-ranking">Model ranking <strong id="review-model"></strong></span></div>
      <h2 id="review-description" tabindex="-1"></h2><div id="review-links" class="review-links"></div>
      <form id="review-form"><fieldset><legend>Your assessed ranking</legend><p class="hint">How much attention does this finding deserve?</p>
        <div class="review-choices"><label><input type="radio" name="priority" value="high" required><span><b>High</b><small>Make it a priority</small></span></label>
        <label><input type="radio" name="priority" value="normal" required><span><b>Normal</b><small>Worth knowing</small></span></label>
        <label><input type="radio" name="priority" value="low" required><span><b>Low</b><small>Less relevant</small></span></label></div>
        <details class="review-rubric"><summary>What do the rankings mean?</summary><p><b>High:</b> technical BBNJ Clearing-House developments, consequential treaty institutions or official positions, verified ratifications, or substantive ocean funding news.</p>
        <p><b>Normal:</b> other substantive BBNJ events, papers and announcements.</p><p><b>Low:</b> general advocacy, repeated commentary, promotion or incidental mentions.</p><p>Missing dates or scheduling details do not lower priority.</p></details>
        <label for="review-notes">Your notes <span class="optional">(optional)</span></label>
        <textarea id="review-notes" name="notes" rows="3" placeholder="What stood out? What did Scout miss?"></textarea>
        <div class="review-submit"><span class="hint">Your perspective helps Scout improve.</span><button type="submit">Save & next finding</button></div>
      </fieldset></form></article>
    <div id="review-empty" class="review-empty" hidden><span aria-hidden="true">✦</span><h2>You’re all caught up.</h2><p>Thanks for lending your perspective. Come back when there are new findings to review.</p></div>
    <dialog class="review-milestone" aria-labelledby="milestone-heading"><div class="milestone-burst" aria-hidden="true">${'<i></i>'.repeat(12)}</div>
      <div class="milestone-content"><p class="eyebrow">That’s a milestone</p><div class="milestone-star" aria-hidden="true">✦</div>
      <h2 id="milestone-heading"></h2><p>A dozen more human perspectives.<br>Thanks for making Scout sharper.</p><button type="button" autofocus>Keep going</button></div></dialog>`;
  const form=root.querySelector('#review-form'),fieldset=form.querySelector('fieldset');
  const status=root.querySelector('#review-status'),card=root.querySelector('#review-card');
  const retry=root.querySelector('#review-retry'),milestone=root.querySelector('.review-milestone');
  let state,active=true,busy=false;

  function render(next) {
    state=next;
    root.querySelector('#review-total').textContent=String(state.reviewed_count);
    const progress=state.reviewed_count%12;
    root.querySelector('#review-progress').textContent=state.reviewed_count===0?'12 to your first milestone':`${12-progress} to your next milestone`;
    root.querySelectorAll('.review-steps i').forEach((step,index)=>step.classList.toggle('complete',index<progress));
    card.hidden=!state.record;
    root.querySelector('#review-empty').hidden=Boolean(state.record);
    form.reset();
    if(!state.record)return;
    root.querySelector('#review-description').textContent=state.record.description;
    root.querySelector('#review-type').textContent=TYPES[state.record.type]??'Finding';
    root.querySelector('#review-model').textContent=PRIORITIES[state.record.priority]??'Not yet assessed';
    const links=root.querySelector('#review-links');links.replaceChildren();
    for(const source of state.record.sources) {
      const href=sourceLink(source.url);if(!href)continue;
      const link=document.createElement('a');link.href=href;link.textContent=source.url;
      link.target='_blank';link.rel='noopener noreferrer';links.append(link);
    }
    if(!links.childElementCount)links.textContent='No source link available.';
  }

  function celebrate(previous,total) {
    if(total<=previous)return;
    if(!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      root.querySelector('#review-total').animate([{transform:'scale(1)'},{transform:'scale(1.25)',color:'#bc572b'},{transform:'scale(1)'}],{duration:600});
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

  form.addEventListener('submit',async event=>{
    event.preventDefault();
    if(busy||!state?.record||!form.reportValidity())return;
    const values=new FormData(form),previous=state.reviewed_count;
    busy=true;fieldset.disabled=true;retry.hidden=true;status.hidden=false;status.textContent='Saving your review…';
    try {
      const next=await submit(state.record,values.get('priority'),values.get('notes'));if(!active)return;
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
