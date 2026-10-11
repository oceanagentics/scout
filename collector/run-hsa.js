// Explicit, bounded pilot through the deployed production entrypoint. No local source cache.
import {sourceURL} from './hsa.js';
const args=process.argv.slice(2),tracker=args.find(v=>v.startsWith('--tracker='))?.slice(10),source=args.find(v=>v.startsWith('--source='))?.slice(9);
if(args.length!==3||!args.includes('--pilot')||!/^[a-f0-9-]{36}$/i.test(tracker??'')||!source)
  throw new Error('Usage after release approval: npm run collect:hsa -- --pilot --tracker=UUID --source=https://...');
if(sourceURL(source)!==source)throw new Error('Public canonical source URL required');
process.loadEnvFile('.env.local');
if(!process.env.SCOUT_BACKEND_KEY)throw new Error('SCOUT_BACKEND_KEY required');
const url='https://vhlfumeyhkeospnemukq.supabase.co/functions/v1/scout-collect-hsa?'+new URLSearchParams({tracker_id:tracker,source_url:source});
const response=await fetch(url,{method:'POST',headers:{apikey:process.env.SCOUT_BACKEND_KEY},signal:AbortSignal.timeout(120000)});
if(!response.ok)throw new Error('Pilot returned HTTP '+response.status);
console.log(await response.text());
