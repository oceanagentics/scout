// Each explicit request can send the same eligible finding again.
const args=process.argv.slice(2),kind=args.find(a=>a.startsWith('--kind='))?.slice(7);
if(args.length!==2||!args.includes('--send')||!['morning','weekly'].includes(kind))throw new Error('Usage: npm run notify -- --send --kind=morning|weekly');
process.loadEnvFile('.env.local');
if(!process.env.SCOUT_BACKEND_KEY)throw new Error('SCOUT_BACKEND_KEY required');
const response=await fetch('https://vhlfumeyhkeospnemukq.supabase.co/functions/v1/scout-notify?kind='+kind,
  {method:'POST',headers:{apikey:process.env.SCOUT_BACKEND_KEY},signal:AbortSignal.timeout(125000)});
if(!response.ok)throw new Error('Notification returned HTTP '+response.status);
console.log(await response.text());
