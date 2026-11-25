// Manual invocation of the same hosted reader; no alternate collection pipeline.
import {OPENAI_MODELS} from '../reader/models/openai.js';
const args=process.argv.slice(2),tracker=args.find(a=>a.startsWith('--tracker='))?.slice(10),diagnostic=args.includes('--diagnostic'),
  provider=args.find(a=>a.startsWith('--provider='))?.slice(11),model=args.find(a=>a.startsWith('--model='))?.slice(8);
if(args.some(a=>a!=='--diagnostic'&&!a.startsWith('--tracker=')&&!a.startsWith('--provider=')&&!a.startsWith('--model='))||
  args.length!==Number(!!tracker)+Number(diagnostic)+Number(!!provider)+Number(!!model)||diagnostic&&!tracker||
  provider&&(!diagnostic||!['gemini','openai'].includes(provider))||
  model&&(!diagnostic||provider==='gemini'||!Object.hasOwn(OPENAI_MODELS,model)))
  throw new Error('Usage: npm run reader -- [--tracker=UUID] [--diagnostic [--provider=gemini|openai] [--model='+Object.keys(OPENAI_MODELS).join('|')+']]');
process.loadEnvFile('.env.local');
if(diagnostic){
  const {diagnoseTracker}=await import('./diagnose-tracker.js');
  console.log(JSON.stringify(await diagnoseTracker({tracker,provider,model,env:process.env}),null,2));
}else{
  if(!process.env.SCOUT_BACKEND_KEY)throw new Error('SCOUT_BACKEND_KEY required');
  const query=tracker?'?'+new URLSearchParams({tracker_id:tracker}):'';
  const response=await fetch('https://vhlfumeyhkeospnemukq.supabase.co/functions/v1/scout-reader'+query,
    {method:'POST',headers:{apikey:process.env.SCOUT_BACKEND_KEY},signal:AbortSignal.timeout(150000)});
  if(!response.ok)throw new Error('Reader returned HTTP '+response.status);
  console.log(await response.text());
}
