-- Expose compact unresolved questions through the existing pending-items reader.
create or replace function scout.finding_jobs(p_after uuid default null) returns table(id uuid,tracker_id uuid,title text,url text,stage text,state text,reason text,explanation text,reopen_when text)
language sql stable security definer set search_path='' as $$
 select s.id,s.tracker_id,s.url,s.url,
 case when s.research ? 'decision' then 'research' else 'fetch' end,s.state,s.reason,
 case when s.reason='research_decision_invalid' then 'The research judgment was missing or invalid; review is needed.'
 when s.research ? 'decision' then concat_ws(' ',
   case when s.research->>'improvement'='exhausted' then 'Research needs review.' else 'Research is pending.' end,
   (select string_agg(r->>'question','; ' order by n) from jsonb_array_elements(s.research->'supports') with ordinality a(r,n)),
   nullif(s.research->>'note',''),
   case when s.reason='research_source_missing' then 'No useful linked source is known.' end)
 else s.reason end,
 case when s.research ? 'decision' then 'Reconsider explicitly or check again when source content changes.' else 'Re-fetch after due time' end
 from scout.source_state s where s.state in ('deferred','parked') and (p_after is null or s.id>p_after)
 and (select scout.access_role()) is not null order by s.id limit 50
$$;
