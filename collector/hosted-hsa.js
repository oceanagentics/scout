import { verifyAuth } from '@supabase/server/core';
import postgres from 'postgres';
import { collectHSA } from './hsa.js';

// One outer transaction keeps the lock, records, and run outcome on one connection.
// The collector's per-record transactions become savepoints inside it.
function database(sql) {
  return {
    async query(query, params = []) {
      try {
        return { rows: await sql.unsafe(query, params) };
      } catch (error) {
        throw new Error(`Collector database operation failed${/^[A-Z0-9_]{1,40}$/.test(error.code ?? '') ? ` (${error.code})` : ''}`);
      }
    },
    transaction: work => sql.savepoint(tx => work(database(tx))),
  };
}

export async function hostedHSA(request, { databaseURL, env, connect = postgres, collect = collectHSA } = {}) {
  const { error } = await verifyAuth(request, { auth: 'secret:default', env });
  if (error) return Response.json({ error: 'Backend secret required' }, { status: 401 });
  if (request.method !== 'POST') return Response.json({ error: 'POST required' }, { status: 405, headers: { Allow: 'POST' } });
  const params = new URL(request.url).searchParams;
  const since = params.get('since') ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const body = request.body?.getReader();
  const empty = !body || (await body.read()).done;
  await body?.cancel();
  if (!empty || [...params.keys()].some(key => key !== 'since') || params.getAll('since').length > 1 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(since) || !Number.isFinite(Date.parse(since)) || new Date(since).toISOString().slice(0, 10) !== since) {
    return Response.json({ error: 'Use an empty POST with optional ?since=YYYY-MM-DD' }, { status: 400 });
  }
  if (!databaseURL) return Response.json({ error: 'Collector database unavailable' }, { status: 503 });
  const deadline = Date.now() + 100000;
  let sql;
  try {
    sql = connect(databaseURL, { max: 1, prepare: false, connect_timeout: 5, fetch_types: false,
      types: { json: { to: 114, from: [114, 3802], parse: JSON.parse,
        serialize: value => typeof value === 'string' ? value : JSON.stringify(value) } },
      connection: { application_name: 'scout-collect-hsa', statement_timeout: 5000 } });
    return await sql.begin(async tx => {
      const [lock] = await tx.unsafe("select pg_try_advisory_xact_lock(hashtextextended('scout:collect-hsa',0)) as acquired");
      if (!lock.acquired) return Response.json({ error: 'HSA collection already running' }, { status: 409 });
      const result = await collect(database(tx), { since: `${since}T00:00:00Z`, deadline });
      return Response.json(result);
    });
  } catch {
    return Response.json({ error: 'Hosted collection failed; database transaction rolled back' }, { status: 500 });
  } finally {
    await sql?.end({ timeout: 1 }).catch(() => {});
  }
}
