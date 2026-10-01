import { hostedHSA } from '../../../collector/hosted-hsa.js';

Deno.serve(request => hostedHSA(request, { databaseURL: Deno.env.get('SUPABASE_DB_URL') }));
