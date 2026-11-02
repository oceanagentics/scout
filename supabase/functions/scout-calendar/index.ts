import {hostedCalendar} from '../../../calendar/hosted.js';
Deno.serve(request=>hostedCalendar(request,{databaseURL:Deno.env.get('SUPABASE_DB_URL')}));
