// Explicit production pilot or local diagnostic; neither starts recurring work.
import {sourceURL} from './source-url.js';
const args=process.argv.slice(2),tracker=args.find(v=>v.startsWith('--tracker='))?.slice(10),source=args.find(v=>v.startsWith('--source='))?.slice(9);
if(args.length!==3||!args.some(v=>v==='--pilot'||v==='--diagnostic')||!/^[a-f0-9-]{36}$/i.test(tracker??'')||!source)
  throw new Error('Usage: npm run collect:hsa -- --pilot|--diagnostic --tracker=UUID --source=https://...');
if(sourceURL(source)!==source)throw new Error('Public canonical source URL required');
process.loadEnvFile('.env.local');
if(args.includes('--diagnostic')){
  const {diagnoseSource}=await import('../dev/diagnose-source.js');
  console.log(JSON.stringify(await diagnoseSource({tracker,source,env:process.env}),null,2));
}else{
  if(!process.env.SCOUT_BACKEND_KEY)throw new Error('SCOUT_BACKEND_KEY required');
  const url='https://vhlfumeyhkeospnemukq.supabase.co/functions/v1/scout-collect-hsa?'+new URLSearchParams({tracker_id:tracker,source_url:source});
  const response=await fetch(url,{method:'POST',headers:{apikey:process.env.SCOUT_BACKEND_KEY},signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw new Error('Pilot returned HTTP '+response.status);
  console.log(await response.text());
}
