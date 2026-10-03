import { verifyAuth } from '@supabase/server/core';
import postgres from 'postgres';
import { collectHSA } from './hsa.js';
import { gemini, MODEL_LIMITS } from './model.js';

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

export async function hostedHSA(request, { databaseURL, apiKey, env, connect = postgres, collect = collectHSA } = {}) {
  const { error } = await verifyAuth(request, { auth: 'secret:default', env });
  if (error) return Response.json({ error: 'Backend secret required' }, { status: 401 });
  if (request.method !== 'POST') return Response.json({ error: 'POST required' }, { status: 405, headers: { Allow: 'POST' } });
  const params = new URL(request.url).searchParams;
  const since = params.get('since') ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const attempts = params.get('max_attempts') ?? String(MODEL_LIMITS.run);
  const sourceId = params.get('source_id');
  const trackerId = params.get('tracker_id');
  const validate = params.get('validate') === 'true';
  const body = request.body?.getReader();
  const empty = !body || (await body.read()).done;
  await body?.cancel();
  if (!empty || [...params.keys()].some(key => !['since','max_attempts','source_id','tracker_id','validate'].includes(key)) || params.getAll('since').length > 1 ||
      params.getAll('validate').length > 1 || (params.has('validate') && (!validate || !trackerId)) ||
      ['source_id','tracker_id'].some(key=>params.getAll(key).length>1 || (params.has(key) && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(params.get(key)))) ||
      params.getAll('max_attempts').length > 1 || !/^(?:[0-9]|10)$/.test(attempts) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(since) || !Number.isFinite(Date.parse(since)) || new Date(since).toISOString().slice(0, 10) !== since) {
    return Response.json({ error: 'Use an empty POST with optional since=YYYY-MM-DD, max_attempts=0..10, tracker_id=UUID and source_id=UUID; validate=true requires an explicit tracker_id' }, { status: 400 });
  }
  if (!databaseURL) return Response.json({ error: 'Collector database unavailable' }, { status: 503 });
  const deadline = Date.now() + 100000;
  let sql, session, acquired=false;
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
    const result=await collect(db,{since:`${since}T00:00:00Z`,deadline,sourceId,trackerId,validate,
      makeModel: Number(attempts) ? runId => gemini({apiKey,ledger:db,runId,deadline,runLimit:Number(attempts)})
        : () => async () => { throw new Error('Observation-only run: assessments deferred (max_attempts=0)'); }});
    return Response.json(result);
  } catch (error) {
    if (error.status === 400) return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ error: 'Hosted collection interrupted; inspect persisted run, pending evidence and quota reservations' }, { status: 500 });
  } finally {
    if (acquired) await session.unsafe("select pg_advisory_unlock(hashtextextended('scout:collect-hsa',0))").catch(()=>{});
    session?.release();
    await sql?.end({ timeout: 1 }).catch(() => {});
  }
}
