// Notifications use the same private production path and durable delivery markers.
const args=process.argv.slice(2);
if(args.length!==1||args[0]!=='--send')throw new Error('Usage after notification approval: npm run notify -- --send');
process.loadEnvFile('.env.local');
if(!process.env.SCOUT_BACKEND_KEY)throw new Error('SCOUT_BACKEND_KEY required');
const response=await fetch('https://vhlfumeyhkeospnemukq.supabase.co/functions/v1/scout-collect-hsa?notify=true',
  {method:'POST',headers:{apikey:process.env.SCOUT_BACKEND_KEY},signal:AbortSignal.timeout(30000)});
if(!response.ok)throw new Error('Notification returned HTTP '+response.status);
console.log(await response.text());
