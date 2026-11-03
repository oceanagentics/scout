export function mountCalendar(client,root){
  if(!root)return ()=>{};
  let closed=false,busy=false;
  root.innerHTML=`<button id="calendar-feed" class="secondary" type="button" title="Get subscription link">
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/></svg>
      Scout Calendar</button>
    <p id="calendar-status" class="hint" role="status" hidden></p>
    <div id="calendar-subscription" hidden><label>Private calendar URL<input id="calendar-url" readonly></label>
      <p class="hint">In Google Calendar, choose Other calendars → + → From URL, paste this link, and add the calendar.
      Google controls how often it refreshes. Anyone with this link can read these Scout events. Keep it private.</p></div>`;
  const get=id=>root.querySelector('#calendar-'+id),button=get('feed'),message=get('status');
  root.hidden=false;
  button.addEventListener('click',async()=>{
    if(busy||closed)return;
    busy=true;button.disabled=true;message.hidden=true;
    try{
      const {data,error}=await client.functions.invoke('scout-calendar/feed-link',{method:'POST'});
      if(closed)return;
      if(error){
        const detail=await error.context?.json?.().catch(()=>null);
        throw new Error(detail?.error??'Calendar service is unavailable. Try again later.');
      }
      if(data?.error)throw new Error(data.error);
      get('url').value=data.url;get('subscription').hidden=false;
      get('url').focus();get('url').select();
    }catch(error){if(!closed){message.hidden=false;message.textContent=error.message;}}
    finally{busy=false;if(!closed)button.disabled=false;}
  });
  return ()=>{closed=true;root.hidden=true;root.replaceChildren();};
}
