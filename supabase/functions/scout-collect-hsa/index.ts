import { hostedHSA } from '../../../collector/hosted-hsa.js';

Deno.serve(request => hostedHSA(request, { databaseURL: Deno.env.get('SUPABASE_DB_URL'), apiKey: Deno.env.get('SCOUT_GEMINI_API_KEY') }));
