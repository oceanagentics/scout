export function mountCalendar(client,root){
  if(!root)return ()=>{};
  let closed=false,busy=false,state;
  root.innerHTML=`<summary>Scout calendar</summary>
    <p>Subscribe to a separate Scout calendar for all past and upcoming events with a known date.</p>
    <div class="actions"><button id="calendar-feed" type="button">Get subscription link</button></div>
    <p id="calendar-status" class="hint" role="status">Checking calendar access…</p>
    <div id="calendar-subscription" hidden><label>Private calendar URL<input id="calendar-url" readonly></label>
      <p class="hint">In Google Calendar, choose Other calendars → + → From URL, paste this link, and add the calendar.
      Google controls how often it refreshes. Anyone with this link can read these Scout events. Keep it private.</p></div>`;
  const get=id=>root.querySelector('#calendar-'+id),message=get('status');
  const controls=()=>{get('feed').disabled=busy||!state?.manager;};
  async function call(action){
    const {data,error}=await client.functions.invoke('scout-calendar/'+action,{method:action==='status'?'GET':'POST'});
    if(error){
      const detail=await error.context?.json?.().catch(()=>null);
      throw new Error(detail?.error??'Calendar service is unavailable. Try again later.');
    }
    if(data?.error)throw new Error(data.error);
    return data;
  }
  async function run(work){
    if(busy||closed)return;busy=true;controls();
    try{await work();}catch(error){if(!closed){
      root.hidden=false;message.textContent=error.message;
    }}
    finally{busy=false;if(!closed)controls();}
  }
  get('feed').addEventListener('click',()=>run(async()=>{
    const result=await call('feed-link');if(closed)return;
    get('url').value=result.url;get('subscription').hidden=false;
    message.textContent='Subscription link ready.';
    get('url').focus();get('url').select();
  }));
  void run(async()=>{
    state=await call('status');if(closed||!state.manager)return;
    root.hidden=false;
    message.textContent='Subscription updates are automatic.';
  });
  return ()=>{closed=true;root.hidden=true;root.replaceChildren();};
}
