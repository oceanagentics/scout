import { hostedHSA } from '../../../collector/hosted-hsa.js';

Deno.serve(request => hostedHSA(request, { databaseURL: Deno.env.get('SUPABASE_DB_URL'), apiKey: Deno.env.get('SCOUT_GEMINI_API_KEY'),
  limits: Object.fromEntries([['minute','SCOUT_MODEL_RPM'],['tokens','SCOUT_MODEL_TPM'],['day','SCOUT_MODEL_RPD'],['run','SCOUT_MODEL_TURN_ATTEMPTS']]
    .flatMap(([key,name])=>Deno.env.get(name)===undefined?[]:[[key,Number(Deno.env.get(name))]])) }));
