// Backend/local tooling only. Never imported by the browser bundle.
export function managementDatabase(token, send = fetch) {
  return { async query(query, params = []) {
    if (!token) throw new Error('Shared Supabase budget access is required');
    const sql=query.replace(/\$(\d+)\b/g,(_,index)=>{
      const value=params[Number(index)-1];
      if (value===null) return 'null';
      if (value===undefined) throw new Error('Missing SQL parameter');
      return `'${(typeof value==='object'?JSON.stringify(value):String(value)).replaceAll("'","''")}'`;
    });
    const response=await send('https://api.supabase.com/v1/projects/vhlfumeyhkeospnemukq/database/query',{
      method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({query:sql}),signal:AbortSignal.timeout(15000)});
    if (!response.ok) {
      const text=await response.text();
      throw new Error(text.includes('Model quota reached')?'Model quota reached':`Shared Scout database returned HTTP ${response.status}`);
    }
    return {rows:await response.json()};
  }};
}
