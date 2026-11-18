import {Buffer} from 'node:buffer';

// Numeric counters only. No parameters or results are retained.
export function database(sql,inTransaction=false,metrics={statements:0,mutations:0,submitted_bytes:0,result_bytes:0},deadline){
  const db={
    metrics,
    async query(query,params=[]){
      const bytes=Buffer.byteLength(query)+Buffer.byteLength(JSON.stringify(params));
      if(deadline!=null){
        const remaining=deadline-Date.now();if(remaining<=0)throw Object.assign(new Error('runtime_bound'),{reason:'runtime_bound'});
        await sql.unsafe("select set_config('statement_timeout',$1,true)",[String(Math.max(1,Math.min(5000,remaining)))]);metrics.statements++;
      }
      metrics.statements++;metrics.submitted_bytes+=bytes;
      try{
        const rows=await sql.unsafe(query,params);
        metrics.statements+=Number(rows[0]?.sql_statements??0);
        metrics.result_bytes+=Buffer.byteLength(JSON.stringify(rows));
        metrics.mutations+=/^\s*(insert|update|delete)\b/i.test(query)?Number(rows.count??rows.length):Number(rows[0]?.mutations??0);
        return {rows};
      }catch(error){throw Object.assign(new Error('database_operation'),{reason:'database_operation',code:/^[A-Z0-9]{5}$/.test(error.code??'')?error.code:undefined});}
    },
    async transaction(work,{deadline:ends}={}){
      if(inTransaction)throw new Error('nested_transaction');
      await db.query('begin');
      try{const result=await work(database(sql,true,metrics,ends));await db.query('commit');return result;}
      catch(error){await db.query('rollback');throw error;}
    }
  };
  return db;
}
