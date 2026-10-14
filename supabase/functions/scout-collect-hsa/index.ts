import {hostedHSA} from '../../../collector/hosted-hsa.js';
Deno.serve(request=>hostedHSA(request,{databaseURL:Deno.env.get('SUPABASE_DB_URL'),apiKey:Deno.env.get('SCOUT_GEMINI_API_KEY'),
  openaiApiKey:Deno.env.get('SCOUT_OPENAI_API_KEY'),tavilyApiKey:Deno.env.get('SCOUT_TAVILY_API_KEY'),
  webhook:Deno.env.get('SCOUT_SLACK_WEBHOOK_URL')}));
