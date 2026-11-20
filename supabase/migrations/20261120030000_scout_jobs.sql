begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- Enable the http extension before using this RPC; keep its read-only token in Vault.
create function scout.jobs() returns jsonb
 language plpgsql stable security definer set search_path=''
 set http.curlopt_timeout_ms='4000' set http.curlopt_connecttimeout_ms='1000' as $$
declare token text;response record;inventory jsonb;
begin
 if scout.access_role() is null then
  raise exception 'Scout sign-in required' using errcode='42501';
 end if;
 select decrypted_secret into token from vault.decrypted_secrets where name='scout_functions_read_key';
 if token is null then raise exception 'Function inventory access is not configured';end if;
 begin
  select * into response from extensions.http(('GET',
   'https://api.supabase.com/v1/projects/vhlfumeyhkeospnemukq/functions',
   array[extensions.http_header('Authorization','Bearer '||token)],null,null)::extensions.http_request);
  if response.status is distinct from 200 then raise exception 'Function inventory unavailable';end if;
  inventory:=response.content::jsonb;
  if jsonb_typeof(inventory) is distinct from 'array' then raise exception 'Invalid function inventory';end if;
 exception when others then raise exception 'Function inventory unavailable';
 end;
 return jsonb_build_object(
  'functions',(select coalesce(jsonb_agg(jsonb_build_object('name',f->>'slug','status',f->>'status',
    'version',f->'version','updated_at',f->'updated_at') order by f->>'slug'),'[]'::jsonb)
   from jsonb_array_elements(inventory) f where f->>'slug' like 'scout-%'),
  'cron',(select coalesce(jsonb_agg(to_jsonb(j) order by j.name,j.job_id),'[]'::jsonb) from (
   select c.jobid as job_id,c.jobname as name,c.schedule,c.active as enabled,
    d.status,d.start_time as started_at,d.end_time as finished_at,d.return_message as message
   from cron.job c left join lateral (
    select r.status,r.start_time,r.end_time,r.return_message from cron.job_run_details r
    where r.jobid=c.jobid order by r.start_time desc nulls last,r.runid desc limit 1
   ) d on true
  ) j)
 );
end $$;
revoke all on function scout.jobs() from public,anon,authenticated,service_role;
grant execute on function scout.jobs() to authenticated;
drop function scout.cron();

notify pgrst,'reload schema';
commit;
