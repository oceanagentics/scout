export function mountCalendar(client,session,root){
  if(!root)return ()=>{};
  let closed=false,busy=false,state,accessToken,connectionBlocked=false;
  root.innerHTML=`<summary>Scout calendar</summary>
    <p>All upcoming events with a known date. Choose direct sync to your calendar or a separate calendar subscription.</p>
    <div class="actions"><button id="calendar-connect" type="button">Connect Google Calendar</button>
      <button id="calendar-sync" type="button" disabled>Sync all events now</button>
      <button id="calendar-feed" class="secondary" type="button">Get subscription link</button></div>
    <p id="calendar-status" class="hint" role="status">Checking calendar connection…</p>
    <div id="calendar-subscription" hidden><label>Private calendar URL<input id="calendar-url" readonly></label>
      <p class="hint">In Google Calendar, choose Other calendars → + → From URL, paste this link, and add the calendar.
      Google controls how often it refreshes. Anyone with this link can read these Scout events. Keep it private.</p>
      <p class="hint">If you try both options, hide one calendar to avoid seeing each event twice.</p></div>`;
  const get=id=>root.querySelector('#calendar-'+id),message=get('status');
  const buttons=['connect','sync','feed'].map(get);
  const active=()=>state?.expires_at&&Date.parse(state.expires_at)>Date.now()&&state.remaining>0;
  const controls=()=>{
    buttons.forEach(button=>button.disabled=busy||!active());
    get('connect').disabled=busy||!active()||connectionBlocked;
    get('sync').disabled=busy||!active()||!(accessToken||state?.connected&&state?.backend_ready);
  };
  async function call(action,body){
    const {data,error}=await client.functions.invoke('scout-calendar/'+action,{method:action==='status'?'GET':'POST',...(body?{body}:{})});
    if(error){
      const detail=await error.context?.json?.().catch(()=>null);
      throw Object.assign(new Error(detail?.error??'Calendar service is unavailable. Try again later.'),{code:detail?.code});
    }
    if(data?.error)throw new Error(data.error);
    return data;
  }
  async function run(work){
    if(busy||closed)return;busy=true;controls();
    try{await work();}catch(error){if(!closed){
      if(error.code==='calendar_api_disabled')connectionBlocked=true;
      root.hidden=false;message.textContent=error.message;
    }}
    finally{busy=false;if(!closed)controls();}
  }
  get('connect').addEventListener('click',()=>run(async()=>{
    window.sessionStorage.setItem('scout-calendar-connect',String(Date.now()));
    message.textContent='Opening Google to grant Calendar access…';
    const {error}=await client.auth.signInWithOAuth({provider:'google',options:{redirectTo:window.location.origin+'/',
      scopes:'openid email profile https://www.googleapis.com/auth/calendar.events',
      queryParams:{hd:'oceanagentics.com',login_hint:state.calendar_id,access_type:'offline',prompt:'consent'}}});
    if(error){window.sessionStorage.removeItem('scout-calendar-connect');throw new Error('Google connection could not be opened.');}
  }));
  get('sync').addEventListener('click',()=>run(async()=>{
    message.textContent='Syncing Scout events…';
    const result=await call('sync',accessToken?{access_token:accessToken}:{});
    if(!closed)message.textContent=`${result.created} added, ${result.updated} updated, ${result.removed} removed; ${result.unchanged} unchanged. No invitations sent.`;
  }));
  get('feed').addEventListener('click',()=>run(async()=>{
    const result=await call('feed-link');if(closed)return;
    get('url').value=result.url;get('subscription').hidden=false;
    message.textContent='Subscription link ready. Direct Google authorization is not needed for this option.';
    get('url').focus();get('url').select();
  }));
  void run(async()=>{
    state=await call('status');if(closed||!state.manager)return;
    root.hidden=false;
    const pending=Number(window.sessionStorage.getItem('scout-calendar-connect'));
    // Tokens exist only in this callback/session memory; refresh authorization goes to Vault.
    if(pending&&session.provider_token){
      window.sessionStorage.removeItem('scout-calendar-connect');
      if(Date.now()-pending<600000){
        root.open=true;
        const connected=await call('connect',{access_token:session.provider_token,refresh_token:session.provider_refresh_token});
        if(closed)return;
        accessToken=session.provider_token;Object.assign(state,connected);
      }
    }
    if(!active())message.textContent='The calendar trial is paused. Its allowance needs review before continuing.';
    else message.textContent=(state.connected&&!accessToken&&!state.backend_ready?'Reconnect Google Calendar to sync in this session. ':state.connected?'Google Calendar connected. ':'')+
      'Direct sync runs when you click Sync all events now. Subscription updates are automatic. Trial ends '+
      new Date(state.expires_at).toLocaleDateString()+'.';
  });
  return ()=>{closed=true;accessToken=null;root.hidden=true;root.replaceChildren();};
}
