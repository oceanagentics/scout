import { verifyAuth } from '@supabase/server/core';
import postgres from 'postgres';
import { collectHSA, DOCUMENT_TRACKERS } from './hsa.js';
import { gemini, modelLimits, modelBudgetSQL, MODEL_LIMITS } from './model.js';

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

export async function hostedHSA(request, { databaseURL, apiKey, env, limits = MODEL_LIMITS, connect = postgres, collect = collectHSA } = {}) {
  const { error } = await verifyAuth(request, { auth: 'secret:default', env });
  if (error) return Response.json({ error: 'Backend secret required' }, { status: 401 });
  if (request.method !== 'POST') return Response.json({ error: 'POST required' }, { status: 405, headers: { Allow: 'POST' } });
  const params = new URL(request.url).searchParams;
  try {limits=modelLimits(limits);} catch {return Response.json({error:'Invalid model configuration'},{status:503});}
  const rotation=params.get('next')==='true';
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
  if (!empty || (rotation ? params.size!==1 : documents!=='process' || !validate || !trackerId || sourceId || assessOnly || params.getAll('documents').length!==1 ||
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
      types: { json: { to: 114, from: [114, 3802], parse: JSON.parse,
        serialize: value => typeof value === 'string' ? value : JSON.stringify(value) } },
      connection: { application_name: 'scout-collect-hsa', statement_timeout: 5000 } });
    session=await sql.reserve();
    const [lock] = await session.unsafe("select pg_try_advisory_lock(hashtextextended('scout:collect-hsa',0)) as acquired");
    acquired=lock.acquired;
    if (!acquired) return Response.json({ error: 'Scout collection already running' }, { status: 409 });
    const db=database(session);
    if(rotation){
      // The session lock covers selection, claim, and every checkpoint. Dead
      // sessions release it; expired run rows retain their evidence and reports.
      await db.query("update scout.collection_runs set outcome='failed',finished_at=clock_timestamp(),stats=stats||"+
        "jsonb_build_object('retry_at',clock_timestamp(),'warnings',jsonb_build_array('Rotation interrupted; retained checkpoints can resume'))"+
        " where outcome='running' and stats->>'rotation'='true' and (stats->>'turn_expires_at')::timestamptz<=clock_timestamp()");
      const allowance=(await db.query(modelBudgetSQL(null,limits.run,limits))).rows[0];
      if(allowance.reason)return Response.json({outcome:'deferred',...allowance});
      selected=(await db.query(`select t.id,coalesce((latest.stats->>'failure_count')::int,0) failure_count
        from scout.trackers t left join lateral (
          select started_at,stats,outcome from scout.collection_runs where tracker_id=t.id
          and coalesce(stats->>'purpose','collection')='collection' and coalesce(stats->>'assessment_only','false')<>'true'
          order by started_at desc,id desc limit 1
        ) latest on true
        where t.enabled and exists(select 1 from jsonb_to_recordset($1::jsonb) as supported(collector text,url text)
          where supported.collector=t.collector and supported.url=t.url)
        and (latest.stats->>'retry_at' is null or (latest.stats->>'retry_at')::timestamptz<=clock_timestamp())
        and not exists(select 1 from scout.collection_runs r where r.tracker_id=t.id and r.outcome='running'
          and r.stats->>'rotation'='true' and (r.stats->>'turn_expires_at')::timestamptz>clock_timestamp())
        order by latest.started_at asc nulls first,t.id limit 1`,[JSON.stringify(DOCUMENT_TRACKERS)])).rows[0];
      if(!selected)return Response.json({outcome:'idle'});
      runId=(await db.query("insert into scout.collection_runs(tracker_id,stats) values($1,jsonb_build_object("+
        "'rotation',true,'turn_expires_at',clock_timestamp()+interval '180 seconds','failure_count',$2::int)) returning id",[selected.id,selected.failure_count])).rows[0].id;
    }
    const result=await collect(db,{since:`${since}T00:00:00Z`,deadline,sourceId,trackerId:selected?.id??trackerId,
      validate:rotation?false:validate,assessOnly,documents:rotation?'process':documents,rotation,runId,
      makeModel: Number(attempts) ? (runId,_deadline,trace) => gemini({apiKey,ledger:db,runId,deadline,runLimit:Number(attempts),trace,limits,pace:rotation})
        : () => async () => { throw new Error('Observation-only run: assessments deferred (max_attempts=0)'); }});
    if(rotation){
      const failed=result.failed>0||result.outcome==='failed'||result.deferred?.reason==='network';
      const failures=failed?Math.min(selected.failure_count+1,7):0;
      const retry_at=failed?new Date(Date.now()+Math.min(3600000,60000*2**(failures-1))).toISOString():result.deferred?.retry_at??new Date(Date.now()+30000).toISOString();
      await db.query("update scout.collection_runs set stats=stats||jsonb_build_object('retry_at',$2::text,'failure_count',$3::int) where id=$1",[runId,retry_at,failures]);
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
    if (acquired) await session.unsafe("select pg_advisory_unlock(hashtextextended('scout:collect-hsa',0))").catch(()=>{});
    session?.release();
    await sql?.end({ timeout: 1 }).catch(() => {});
  }
}
