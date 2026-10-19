// Retired when the reader migration is deployed. No legacy read or correction route.
Deno.serve(()=>Response.json({error:'This endpoint is retired. Use scout-reader.'},{status:410}));
