import { sourceLink, stamp } from './records.js';

export const RUN_STEPS = [['fetch','Fetch'],['detect','Detect changes'],['prepare','Extract and prepare'],
  ['generate','Generate records'],['validate','Validate and repair'],['save','Save records']];
const states = { pass:'Pass',fail:'Fail',skipped:'Skipped',running:'Running',uncertain:'Uncertain' };

export function stepState(report, step) {
  if (report?.version!==1) return 'Unavailable';
  // Attempts are diagnostic history; their enclosing generation owns the result.
  // Checkpoints can block work, but passing one is not a successful work outcome.
  const operations=Object.values(report.operations).filter(o=>o.step===step&&!o.attempt&&!o.recovered_by);
  const work=operations.filter(o=>!o.checkpoint);
  if (operations.some(o=>o.state==='running')) return 'Running';
  if (operations.some(o=>o.state==='fail')) return work.some(o=>o.state==='pass')?'Fail · mixed outcomes':'Fail';
  if (operations.some(o=>o.state==='uncertain')) return work.some(o=>o.state==='pass')?'Uncertain · mixed outcomes':'Uncertain';
  if (!work.length) return 'Not reached';
  return work.every(o=>o.state==='skipped')?'Skipped':'Pass';
}

export function runAPI(client) {
  const call=async(name,params,signal)=>{
    const {data,error}=await client.rpc(name,params).abortSignal(signal);
    if(error)throw error;
    return data;
  };
  return {
    history:(id,before,signal)=>call('run_history',{p_tracker_id:id,p_before_at:before?.started_at??null,p_before_id:before?.id??null},signal),
    detail:(id,signal)=>call('run_detail',{p_run_id:id},signal),
    artifact:(id,key,signal)=>call('run_artifact',{p_run_id:id,p_artifact_id:key},signal),
  };
}

const node=(tag,text,className)=>{
  const el=document.createElement(tag);
  if(text!=null)el.textContent=text;
  if(className)el.className=className;
  return el;
};
const button=(text,click)=>{const el=node('button',text,'secondary');el.type='button';el.addEventListener('click',click);return el;};

// Bodies are loaded only on expansion. Closing the view aborts reads and prevents
// late responses from restoring data after navigation or sign-out.
export function mountRunDetail(root, api, tracker, back) {
  const controller=new AbortController(),signal=controller.signal;
  let active=true,selection=0,page=0,pages=[null];
  root.replaceChildren();root.hidden=false;
  const heading=node('h2','Runs · '+tracker.name),status=node('p','Loading run history…','meta');status.setAttribute('role','status');
  const history=node('nav',null,'run-history');history.setAttribute('aria-label','Run history');
  const pagination=node('div',null,'actions'),detail=node('div');
  root.append(button('Back to trackers',back),heading,status,history,pagination,detail);

  async function show(id) {
    const current=++selection;detail.replaceChildren(node('p','Loading run…'));
    try {
      const run=await api.detail(id,signal);
      if(!active||current!==selection)return;
      if(!run){detail.replaceChildren(node('p','Run unavailable or access denied.'));return;}
      detail.replaceChildren(node('h3',run.outcome+' · '+stamp(run.started_at)));
      detail.append(node('p','Run '+run.id+' · Coverage since '+stamp(run.coverage_since)+' · Finished '+stamp(run.finished_at),'meta'));
      detail.append(button('Refresh this run',()=>show(id)));
      const counts=Object.entries(run.counts??{}).filter(([,v])=>v!=null).map(([k,v])=>k+': '+v).join(' · ');
      detail.append(node('p',counts||'Final counts unavailable; inspect checkpoints below.'));
      for(const warning of run.warnings??[])detail.append(node('p',warning,'warning'));
      const report=run.report?.version===1?run.report:null;
      const source={octo:'OCTO',author:'Author feed',gfw:'GFW'}[report?.path?.split('-')[0]];
      detail.append(node('p',source?source+(report.path.endsWith('-records')?' document processing. Extraction, support coverage, finding retrieval, identity resolution, repairs and saved associations are inspectable. Uncertain findings remain unresolved; accepted schema and citations do not establish rating accuracy.':' document fetch/prepare only. Generation, proposal validation and record saving were not requested. Prepared and reused inputs remain available for processing.'):report?'Legacy scripted collector. Selection, semantic preclassification and clipping remain; this is not the document-first pipeline. Pass means the reported boundary completed, not that the importance rating is correct.':'Legacy run: step outcomes, source associations and exact request artifacts were not instrumented. Unavailable details are not reconstructed from current code.','hint'));
      if(!run.finished_at)detail.append(node('p','No completion marker. Running checkpoints may still be active or may have been interrupted; refresh to check.','warning'));
      const bodies=new Map();
      function artifactPanel(key){
            const artifact=report.artifacts?.[key];if(!artifact)return node('p','Artifact unavailable.');
            const panel=node('div',null,'run-artifact');let loading=false,loaded=false;
            const open=button('Inspect '+artifact.title,async()=>{
              if(loading||loaded)return;
              loading=true;open.disabled=true;
              try{
                const value=bodies.has(key)?bodies.get(key):await api.artifact(run.id,key,signal);
                if(!active||current!==selection)return;
                bodies.set(key,value);loaded=true;
                // Source HTML/JSON/model text is textContent, never executable markup.
                panel.append(node('pre',value==null?'Artifact unavailable.':typeof value==='string'?value:JSON.stringify(value,null,2)));
              }catch{if(active&&current===selection)panel.append(node('p','Artifact could not be loaded. Try again.','error'));}
              finally{loading=false;if(active&&current===selection)open.disabled=loaded;}
            });
            panel.append(open);return panel;
      }
      for(const [step,label]of RUN_STEPS){
        const section=node('section',null,'run-step'),state=stepState(report,step);section.append(node('h4',label+' · '+state));
        const operations=Object.values(report?.operations??{}).filter(o=>o.step===step);
        if(state==='Pass'&&operations.some(o=>o.attempt&&o.state==='fail'))section.append(node('p','Generation succeeded after retry. Earlier failed attempts remain below.','hint'));
        if(!operations.length)section.append(node('p',report?'No checkpoint for this step.':'Step details unavailable for this historical run.','hint'));
        for(const op of operations){
          const entry=node('details'),title=(op.source_ids?.join(', ')||op.url||'Run boundary');
          entry.append(node('summary',(states[op.state]??'Unavailable')+(op.attempt?' · Attempt '+op.attempt:op.checkpoint?' · Checkpoint':'')+' · '+title));
          if(op.recovered_by)entry.append(node('p','Recovered by later operation '+op.recovered_by+'. Original failure retained.','hint'));
          entry.append(node('p',op.note??'No additional note recorded.'),node('p','Started '+stamp(op.started_at)+' · Finished '+stamp(op.finished_at),'meta'));
          if(op.http_status!=null)entry.append(node('p','HTTP '+op.http_status));
          if(op.bytes!=null)entry.append(node('p',op.bytes+' response bytes'));
          const url=sourceLink(op.final_url??op.url);
          if(url){const a=node('a','Source URL');a.href=url;a.target='_blank';a.rel='noopener noreferrer';entry.append(a);}
          for(const record of op.record_ids??[])if(/^[a-f0-9-]{36}$/i.test(record)){
            const a=node('a','Current record · '+record);a.href='/?record='+encodeURIComponent(record);a.target='_blank';a.rel='noopener noreferrer';entry.append(a);
          }
          for(const key of op.artifacts??[])entry.append(artifactPanel(key));
          section.append(entry);
        }
        detail.append(section);
      }
      const linked=new Set(Object.values(report?.operations??{}).flatMap(o=>o.artifacts??[]));
      const additional=Object.keys(report?.artifacts??{}).filter(key=>!linked.has(key));
      if(additional.length){detail.append(node('h4','Artifacts captured before a step checkpoint completed'));for(const key of additional)detail.append(artifactPanel(key));}
    }catch{if(active&&current===selection)detail.replaceChildren(node('p','Could not load this run. Select it again to retry.','error'));}
  }

  async function historyPage(index) {
    const current=++selection;page=index;status.textContent='Loading run history…';history.replaceChildren();pagination.replaceChildren();detail.replaceChildren();
    try{
      const rows=await api.history(tracker.id,pages[index],signal);
      if(!active||current!==selection)return;
      status.textContent=rows.length?'History page '+(index+1)+' · up to 20 runs per page':'No runs on this page.';
      for(const run of rows)history.append(button(stamp(run.started_at)+' · '+run.outcome+(!run.report_available?' · legacy details unavailable':''),()=>show(run.id)));
      if(index)pagination.append(button('Newer runs',()=>historyPage(index-1)));
      if(rows.length===20){pages[index+1]=rows.at(-1);pagination.append(button('Older runs',()=>historyPage(index+1)));}
      if(rows.length)await show(rows[0].id);
    }catch{if(active&&current===selection){status.textContent='Run history unavailable. The reporting migration may not be deployed or access may be unavailable.';pagination.append(button('Retry history',()=>historyPage(page)));}}
  }
  void historyPage(0);
  return ()=>{active=false;selection++;controller.abort();root.replaceChildren();root.hidden=true;};
}
