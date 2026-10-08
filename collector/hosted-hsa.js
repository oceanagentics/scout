import { verifyAuth } from '@supabase/server/core';
import postgres from 'postgres';
import { collectHSA, DOCUMENT_TRACKERS } from './hsa.js';
import { gemini, modelLimits, modelBudgetSQL, MODEL_LIMITS } from './model.js';
import { processDocument, DOCUMENT_VERSION } from './document-records.js';
import { supportDocuments } from './octo-documents.js';
import { startReport } from './report.js';
import { prepareMessage, sendMessage, webhookTransport } from '../notifications/slack.js';

// A reserved session holds the collector lock. Individual record transactions
// can roll back without undoing earlier quota reservations or fetched evidence.
export function database(sql, inTransaction = false) {
  return {
    async query(query, params = []) {
      try {
        return { rows: await sql.unsafe(query, params) };
      } catch (error) {
        if (/Model quota reached/.test(error.message)) throw new Error('Model quota reached');
        throw new Error(`Collector database operation failed${/^[A-Z0-9_]{1,40}$/.test(error.code ?? '') ? ` (${error.code})` : ''}`);
      }
    },
    async transaction(work) {
      if (inTransaction) throw new Error('Nested collection transaction is unsupported');
      await sql.unsafe('begin');
      try { const result=await work(database(sql,true)); await sql.unsafe('commit'); return result; }
      catch (error) { await sql.unsafe('rollback'); throw error; }
    },
  };
}

export async function hostedHSA(request, { databaseURL, apiKey, webhook, env, limits = MODEL_LIMITS, connect = postgres, collect = collectHSA, post, modelFetch=fetch } = {}) {
  const { error } = await verifyAuth(request, { auth: 'secret:default', env });
  if (error) return Response.json({ error: 'Backend secret required' }, { status: 401 });
  if (request.method !== 'POST') return Response.json({ error: 'POST required' }, { status: 405, headers: { Allow: 'POST' } });
  const params = new URL(request.url).searchParams;
  let configuration;
  try {limits=modelLimits(limits);} catch {limits=MODEL_LIMITS;configuration={reason:'configuration',retry_at:new Date(Date.now()+300000).toISOString()};}
  const rotation=params.get('next')==='true';
  const notify=params.get('notify')==='true';
  const since = params.get('since') ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const attempts = params.get('max_attempts') ?? String(limits.run);
  const sourceId = params.get('source_id');
  const trackerId = params.get('tracker_id');
  const validate = params.get('validate') === 'true';
  const assessOnly = params.get('assess_only') === 'true';
  const documents = params.get('documents');
  const body = request.body?.getReader();
  const empty = !body || (await body.read()).done;
  await body?.cancel();
  if (!empty || (rotation||notify ? params.size!==1 : documents!=='process' || !validate || !trackerId || sourceId || assessOnly || params.getAll('documents').length!==1 ||
      [...params.keys()].some(key => !['since','max_attempts','source_id','tracker_id','validate','assess_only','documents'].includes(key)) || params.getAll('since').length > 1 ||
      params.getAll('assess_only').length > 1 || (params.has('assess_only') && (!assessOnly || !validate || !sourceId || !trackerId)) ||
      params.getAll('validate').length > 1 || (params.has('validate') && (!validate || !trackerId)) ||
      ['source_id','tracker_id'].some(key=>params.getAll(key).length>1 || (params.has(key) && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(params.get(key)))) ||
      params.getAll('max_attempts').length > 1 || !/^\d+$/.test(attempts) || !Number.isSafeInteger(Number(attempts)) || Number(attempts)>limits.run ||
      !/^\d{4}-\d{2}-\d{2}$/.test(since) || !Number.isFinite(Date.parse(since)) || new Date(since).toISOString().slice(0, 10) !== since)) {
    return Response.json({ error: `Use an empty POST with next=true, or documents=process&validate=true&tracker_id=UUID and optional since=YYYY-MM-DD/max_attempts=0..${limits.run}.` }, { status: 400 });
  }
  if (!databaseURL) return Response.json({ error: 'Collector database unavailable' }, { status: 503 });
  const deadline = Date.now() + 100000;
  let sql, session, acquired=false,selected,runId;
  try {
    sql = connect(databaseURL, { max: 1, prepare: false, connect_timeout: 5,
      types: { timestamp: { to:1184,from:[],serialize:value=>typeof value==='string'?value:value.toISOString() },
        json: { to: 114, from: [114, 3802], parse: JSON.parse,
        serialize: value => typeof value === 'string' ? value : JSON.stringify(value) } },
      connection: { application_name: 'scout-collect-hsa', statement_timeout: 5000 } });
    session=await sql.reserve();
    const [lock] = await session.unsafe(`select pg_try_advisory_lock(hashtextextended('scout:${notify?'notify':'collect-hsa'}',0)) as acquired`);
    acquired=lock.acquired;
    if (!acquired) return Response.json({ error: 'Scout collection already running' }, { status: 409 });
    const db=database(session);
    if(notify){
      await db.query("update scout.collection_runs set finished_at=clock_timestamp(),outcome='failed' where stats->>'purpose'='notification' and outcome='running' and started_at<clock_timestamp()-interval '120 seconds'");
      const excluded=(await db.query("select v.value from scout.collection_runs r cross join lateral jsonb_array_elements(r.stats#>'{delivery,records}') v"+
        " where r.stats->>'purpose'='notification' and (r.stats#>>'{delivery,status}' in ('dispatching','unknown') or " +
        "r.stats#>>'{delivery,status}'='sent' and coalesce((r.stats#>>'{delivery,communicated}')::int,0)<jsonb_array_length(r.stats#>'{delivery,records}'))")).rows.map(r=>r.value);
      const notification=(await db.query("insert into scout.collection_runs(tracker_id,stats) select id,'{\"purpose\":\"notification\"}' from scout.trackers order by id limit 1 returning id")).rows[0].id;
      try{
        if(configuration)throw Object.assign(new Error('Notification configuration deferred'),{deferred:configuration});
        const preview=await prepareMessage(db,{exclude:excluded,model:gemini({apiKey,ledger:db,runId:notification,limits,pace:true,deadline:deadline-5000,fetch:modelFetch})});
        let delivery={status:'no_change',communicated:0};
        if(preview.payload){
          // Durable intent before sending: a lost HTTP reply or database write
          // never makes this exact record version eligible for an automatic resend.
          await db.query("update scout.collection_runs set stats=stats||jsonb_build_object('delivery',$2::jsonb) where id=$1",
            [notification,JSON.stringify({status:'dispatching',records:preview.records.map(({id,updated_at})=>({id,updated_at}))})]);
          delivery=await sendMessage(db,preview,post??webhookTransport(webhook,fetch));
        }
        await db.query("update scout.collection_runs set finished_at=clock_timestamp(),outcome=$2,stats=jsonb_set(stats,'{delivery}',coalesce(stats->'delivery','{}')||$3::jsonb) where id=$1",
          [notification,['sent','no_change'].includes(delivery.status)?'no_change':'failed',JSON.stringify(delivery)]);
        return Response.json(delivery);
      }catch(error){
        await db.query("update scout.collection_runs set finished_at=clock_timestamp(),outcome='failed',stats=stats||jsonb_build_object('warnings',jsonb_build_array($2::text)) where id=$1",
          [notification,error.deferred?'Notification selection deferred: '+error.deferred.reason:'Notification interrupted; inspect delivery status before resending']);
        return Response.json({outcome:error.deferred?'deferred':'failed',...error.deferred?{deferred:error.deferred}:{} });
      }
    }
    if(rotation){
      // The session lock covers selection, claim, and every checkpoint. Dead
      // sessions release it; expired run rows retain their evidence and reports.
      await db.query("update scout.collection_runs set outcome='failed',finished_at=clock_timestamp(),stats=stats||"+
        "jsonb_build_object('retry_at',clock_timestamp(),'warnings',jsonb_build_array('Rotation interrupted; retained checkpoints can resume'))"+
        " where outcome='running' and stats->>'rotation'='true' and (stats->>'turn_expires_at')::timestamptz<=clock_timestamp()");
      selected=(await db.query(`select t.id,coalesce((latest.stats->>'failure_count')::int,0) failure_count
        from scout.trackers t left join lateral (
          select started_at,stats,outcome from scout.collection_runs where tracker_id=t.id
          and coalesce(stats->>'purpose','collection')='collection' and coalesce(stats->>'assessment_only','false')<>'true'
          and coalesce(stats->>'stage','fetch')='fetch'
          order by started_at desc,id desc limit 1
        ) latest on true
        where t.enabled and exists(select 1 from jsonb_to_recordset($1::jsonb) as supported(collector text,url text)
          where supported.collector=t.collector and supported.url=t.url)
        and (latest.stats->>'retry_at' is null or (latest.stats->>'retry_at')::timestamptz<=clock_timestamp())
        and not exists(select 1 from scout.collection_runs r where r.tracker_id=t.id and r.outcome='running'
          and r.stats->>'rotation'='true' and (r.stats->>'turn_expires_at')::timestamptz>clock_timestamp())
        order by latest.started_at asc nulls first,t.id limit 1`,[JSON.stringify(DOCUMENT_TRACKERS)])).rows[0];
      if(selected)runId=(await db.query("insert into scout.collection_runs(tracker_id,stats) values($1,jsonb_build_object("+
        "'rotation',true,'stage','fetch','turn_expires_at',clock_timestamp()+interval '180 seconds','failure_count',$2::int)) returning id",[selected.id,selected.failure_count])).rows[0].id;
    }
    let result={outcome:'idle'};
    if(!rotation||selected)result=await collect(db,{since:`${since}T00:00:00Z`,deadline:rotation?Math.min(deadline,Date.now()+35000):deadline,sourceId,trackerId:selected?.id??trackerId,
      validate:rotation?false:validate,assessOnly,documents:rotation?true:documents,rotation,runId,
      makeModel: Number(attempts) ? (runId,_deadline,trace) => gemini({apiKey,ledger:db,runId,deadline,runLimit:Number(attempts),trace,limits,pace:rotation})
        : () => async () => { throw new Error('Observation-only run: assessments deferred (max_attempts=0)'); }});
    if(rotation){
      const failed=result.fetch_failed>0&&!result.fetch_succeeded||result.outcome==='failed';
      const failures=failed?Math.min(selected.failure_count+1,7):0;
      const retry_at=failed?new Date(Date.now()+Math.min(3600000,60000*2**(failures-1))).toISOString():new Date(Date.now()+30000).toISOString();
      if(runId)await db.query("update scout.collection_runs set stats=stats||jsonb_build_object('retry_at',$2::text,'failure_count',$3::int) where id=$1",[runId,retry_at,failures]);
      if(configuration&&runId)await db.query("update scout.collection_runs set stats=stats||jsonb_build_object('model_retry_at',$2::text,'model_blocker','configuration') where id=$1",[runId,configuration.retry_at]);
      const allowance=configuration??(await db.query(modelBudgetSQL(null,limits.run,limits))).rows[0];
      if(allowance.reason)result.review={outcome:'deferred',...allowance};
      else if(Date.now()+10000<deadline){
        // Fair review across enabled trackers, independent of the tracker fetched.
        const source=(await db.query(`select q.* from scout.source_queue q join scout.trackers t on t.id=q.tracker_id
          where t.enabled and q.queue_state in ('awaiting_initial','deferred')
            and not exists(select 1 from scout.collection_runs n where n.stats->>'purpose'='notification'
              and n.outcome='running' and n.started_at>clock_timestamp()-interval '110 seconds')
            and exists(select 1 from jsonb_to_recordset($1::jsonb) supported(collector text,url text)
              where supported.collector=t.collector and supported.url=t.url)
            and (q.progress#>>'{deferred,retry_at}' is null or (q.progress#>>'{deferred,retry_at}')::timestamptz<=clock_timestamp())
          order by q.progress->>'attempted_at' asc nulls first,q.collected_at,q.id limit 1`,[JSON.stringify(DOCUMENT_TRACKERS)])).rows[0];
        if(source){
          const reviewId=(await db.query("insert into scout.collection_runs(tracker_id,stats) values($1,jsonb_build_object("+
            "'rotation',true,'stage','initial_review','turn_expires_at',clock_timestamp()+interval '180 seconds','source_id',$2::text)) returning id",[source.tracker_id,source.id])).rows[0].id;
          try{
            const trace=await startReport(db,reviewId,'initial-review');await trace.capture(source);
            const document=source.parsed.document,prepared=document.prepared_versions?.[document.preparation.version]??document.prepared;
            const prefix=DOCUMENT_VERSION+'/'+prepared.version+'/';
            const context=await supportDocuments(db,{source,prepared,trace,context:document.processing.version?.startsWith(prefix)?document.processing.version.slice(prefix.length):undefined});
            const review=await processDocument(db,{source,prepared:context,trace,deadline:deadline-5000,repairs:false,
              changed:document.processing.changed===true,
              model:gemini({apiKey,ledger:db,runId:reviewId,deadline:deadline-5000,limits,pace:true,wait:false,trace,fetch:modelFetch})});
            await db.query("update scout.collection_runs set finished_at=clock_timestamp(),outcome=$2,stats=stats||$3::jsonb where id=$1",
              [reviewId,review.state==='complete'?'success':'partial',JSON.stringify({...review,processed:review.state==='complete'?1:0,warnings:review.error?[review.error]:[]})]);
            result.review={run_id:reviewId,...review};
          }catch{
            await db.query("update scout.collection_runs set finished_at=clock_timestamp(),outcome='failed',stats=stats||"+
              "jsonb_build_object('warnings',jsonb_build_array('Initial review interrupted; capture and checkpoints retained')) where id=$1",[reviewId]);
            result.review={run_id:reviewId,outcome:'failed'};
          }
        }
      }
    }
    return Response.json(result);
  } catch (error) {
    if(rotation&&runId){
      const failures=Math.min(selected.failure_count+1,7);
      await database(session).query("update scout.collection_runs set outcome='failed',finished_at=clock_timestamp(),stats=stats||"+
        "jsonb_build_object('retry_at',$2::text,'failure_count',$3::int,'warnings',jsonb_build_array('Rotation interrupted; inspect retained checkpoints')) where id=$1",
        [runId,new Date(Date.now()+Math.min(3600000,60000*2**(failures-1))).toISOString(),failures]).catch(()=>{});
    }
    if (error.status === 400) return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ error: 'Hosted collection interrupted; inspect persisted run, pending evidence and quota reservations' }, { status: 500 });
  } finally {
    if (acquired) await session.unsafe(`select pg_advisory_unlock(hashtextextended('scout:${notify?'notify':'collect-hsa'}',0))`).catch(()=>{});
    session?.release();
    await sql?.end({ timeout: 1 }).catch(() => {});
  }
}
