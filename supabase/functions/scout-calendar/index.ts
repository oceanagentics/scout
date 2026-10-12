import {hostedCalendar} from '../../../calendar/hosted.js';
Deno.serve(request=>hostedCalendar(request,{databaseURL:Deno.env.get('SUPABASE_DB_URL'),
  clientId:Deno.env.get('SCOUT_GOOGLE_CLIENT_ID'),clientSecret:Deno.env.get('SCOUT_GOOGLE_CLIENT_SECRET')}));
