// Manual invocation of the same hosted reader; no alternate collection pipeline.
const args=process.argv.slice(2),tracker=args.find(a=>a.startsWith('--tracker='))?.slice(10),diagnostic=args.includes('--diagnostic');
if(args.some(a=>a!=='--diagnostic'&&!a.startsWith('--tracker='))||args.length!==Number(!!tracker)+Number(diagnostic)||diagnostic&&!tracker)
  throw new Error('Usage: npm run reader -- [--tracker=UUID] [--diagnostic]');
process.loadEnvFile('.env.local');
if(diagnostic){
  const {diagnoseTracker}=await import('./diagnose-tracker.js');
  console.log(JSON.stringify(await diagnoseTracker({tracker,env:process.env}),null,2));
}else{
  if(!process.env.SCOUT_BACKEND_KEY)throw new Error('SCOUT_BACKEND_KEY required');
  const query=tracker?'?'+new URLSearchParams({tracker_id:tracker}):'';
  const response=await fetch('https://vhlfumeyhkeospnemukq.supabase.co/functions/v1/scout-reader'+query,
    {method:'POST',headers:{apikey:process.env.SCOUT_BACKEND_KEY},signal:AbortSignal.timeout(125000)});
  if(!response.ok)throw new Error('Reader returned HTTP '+response.status);
  console.log(await response.text());
}
