begin;
-- Additive conversion. Historical records, source bodies, reports and accounting remain.
drop trigger updated_at on scout.records;
alter table scout.records
 add column canonical_url text,
 add column organizations jsonb not null default '[]',
 add column details jsonb not null default '{}',
 add column overrides jsonb not null default '{}',
 add column provenance jsonb not null default '{}',
 add column completeness jsonb not null default '{"state":"provisional","unknowns":{}}',
 add column relevance jsonb not null default '{"state":"pending"}',
 add column version integer not null default 1,
 add column accepted_version integer,
 add column discovered_at timestamptz not null default clock_timestamp(),
 add column checked_at timestamptz;
update scout.records set canonical_url=event_url,
 organizations=case when organization is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('name',organization,'role','unspecified')) end,
 details=case when kind='event' then jsonb_strip_nulls(jsonb_build_object(
 'start',case when starts_at is not null then jsonb_build_object('value',to_char(starts_at at time zone 'UTC','YYYY-MM-DD'),'precision','day','time',to_char(starts_at at time zone 'UTC','HH24:MI:SS'),'zone','UTC','utc',to_char(starts_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')) end,
 'end',case when ends_at is not null then jsonb_build_object('value',to_char(ends_at at time zone 'UTC','YYYY-MM-DD'),'precision','day','time',to_char(ends_at at time zone 'UTC','HH24:MI:SS'),'zone','UTC','utc',to_char(ends_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')) end,
 'location',location,'registration_url',registration_url,'status',status)) else '{}'::jsonb end,
 relevance=jsonb_build_object('state',case when priority is null then 'pending' else 'assessed' end,'reason','Preserved existing assessment','fields','[]'::jsonb),
 accepted_version=case when priority is not null then 1 end,
 discovered_at=coalesce((select min(collected_at) from scout.evidence e where e.record_id=scout.records.id),updated_at);
-- Copy only accepted final calendar values; leave historical evidence byte-for-byte intact.
update scout.records r set details=r.details||coalesce((select jsonb_object_agg(
 case f.key when 'starts_on' then 'start' else 'end' end,jsonb_build_object('value',f.value->>'value','precision','day'))
 from (select distinct on(x.key) x.key,x.value from scout.evidence e
 cross join lateral jsonb_each(coalesce(e.parsed->'accepted_fields','{}')) x
 where e.record_id=r.id and x.key in ('starts_on','ends_on')
 order by x.key,x.value->>'accepted_at' desc,e.id) f
 where f.value->>'value' ~ '^\d{4}-\d{2}-\d{2}$'
 and (f.key='starts_on' and r.starts_at is null or f.key='ends_on' and r.ends_at is null)),'{}')
 where r.kind='event';
update scout.records r set relevance=relevance||jsonb_build_object('reason',a.reason)
 from (select distinct on(e.record_id) e.record_id,e.parsed#>>'{assessment,reason}' reason
 from scout.evidence e join scout.records r on r.id=e.record_id
 where e.parsed#>>'{assessment,priority_accepted}'='true' and e.parsed#>>'{assessment,priority}'=r.priority
 order by e.record_id,e.parsed#>>'{assessment,accepted_at}' desc) a
 where a.record_id=r.id and a.reason is not null;

create table scout.source_state(
 id uuid primary key default gen_random_uuid(), tracker_id uuid not null references scout.trackers(id),
 identity text not null check(length(identity)<=512), url text not null check(length(url)<=2048),
 native_id text check(length(native_id)<=256), native_ref jsonb not null default '{}' check(octet_length(native_ref::text)<=512),
 observed_hash text, processed_hash text, attempts integer not null default 0 check(attempts between 0 and 3),
 state text not null default 'due' check(state in ('due','running','complete','deferred','parked')),
 reason text check(reason ~ '^[a-z_]{1,48}$'), cursor text check(length(cursor)<=512),
 due_at timestamptz not null default clock_timestamp(), lease_id uuid, lease_until timestamptz,
 checked_at timestamptz, unique(tracker_id,identity)
);
insert into scout.source_state(tracker_id,identity,url) select id,'tracker',url from scout.trackers;
create index source_due on scout.source_state(due_at) where state in ('due','complete','deferred','running');
create table scout.record_sources(
 record_id uuid not null references scout.records(id) on delete cascade,
 url text not null check(length(url)<=2048), tracker_id uuid references scout.trackers(id),
 relationship text not null default 'source', primary key(record_id,url)
);
insert into scout.record_sources(record_id,url,tracker_id)
 select distinct on(record_id,url) record_id,url,tracker_id from scout.evidence where record_id is not null order by record_id,url,collected_at desc;
update scout.records r set provenance=coalesce((select jsonb_object_agg(field,urls) from
 (select jsonb_agg(distinct url) urls from scout.record_sources where record_id=r.id) refs
 cross join lateral unnest(array['title','description','canonical_url']||array(select 'details.'||jsonb_object_keys(r.details))) field
 where refs.urls is not null),'{}');
create table scout.record_identities(identity text primary key check(length(identity)<=1024),record_id uuid not null references scout.records(id) on delete cascade);
insert into scout.record_identities select 'legacy:'||identity_key,id from scout.records where identity_key is not null on conflict do nothing;
create index record_identity_owner on scout.record_identities(record_id);

-- verified_* is remaining project capacity AFTER other consumers, not the public plan ceiling.
-- Scout takes at most half of that verified headroom; own current-window charges are then subtracted.
create table scout.quota_policy(
 id boolean primary key default true check(id), enabled boolean not null default false,
 verified_until timestamptz, verified_rpm integer, verified_rpd integer, verified_tpm integer,
 database_bytes bigint, database_verified_until timestamptz,
 rpm integer not null default 2 check(rpm between 1 and 2),
 rpd integer not null default 250 check(rpd between 1 and 250),
 tpm integer not null default 125000 check(tpm between 1 and 125000),
 cooldown_until timestamptz, uncertain_calls bigint not null default 0, uncertain_tokens bigint not null default 0
);
insert into scout.quota_policy(id) values(true);
update scout.quota_policy set cooldown_until=(select max((stats->>'model_retry_at')::timestamptz) from scout.collection_runs
 where (stats->>'model_retry_at')::timestamptz>clock_timestamp());
-- Conservative carry is explicit; the old ledger is neither rewritten nor reset.
create table scout.quota_reservations(
 id uuid primary key, invocation uuid not null, reserved_at timestamptz not null default clock_timestamp(),
 input_tokens integer not null check(input_tokens>=0), output_tokens integer not null default 0 check(output_tokens>=0),
 state text not null check(state in ('reserved','dispatched','settled','unknown')), reason text check(reason ~ '^[a-z_]{1,48}$')
);
-- Copy active legacy charges only. The original ledger remains untouched.
insert into scout.quota_reservations(id,invocation,reserved_at,input_tokens,state)
 select gen_random_uuid(),r.id,coalesce((a->>'at')::timestamptz,r.started_at),
 least(2147483647,coalesce((a->>'input_tokens')::bigint,(a->>'input_token_limit')::bigint,16000))::integer,'unknown'
 from scout.collection_runs r cross join lateral jsonb_array_elements(coalesce(r.stats->'model_attempts','[]')) a
 where coalesce((a->>'at')::timestamptz,r.started_at)>=least(clock_timestamp()-interval '120 seconds',
 date_trunc('day',clock_timestamp() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles');
create index quota_window on scout.quota_reservations(reserved_at);
create index quota_invocation on scout.quota_reservations(invocation);
create function scout.reserve_model(p_invocation uuid,p_id uuid,p_tokens integer,p_max integer)
returns table(allowed boolean,retry_at timestamptz,mutations integer,sql_statements integer) language plpgsql set search_path='' as $$
declare policy scout.quota_policy; moment timestamptz:=clock_timestamp(); calls integer; daily integer; tokens bigint; turns integer;
begin
 select * into policy from scout.quota_policy where id for update;
 if p_max not between 1 and 2 or p_tokens<0 or p_tokens>16000 then raise exception 'Invalid model bounds'; end if;
 select count(*) filter(where reserved_at>moment-interval '60 seconds' or state in ('reserved','dispatched','unknown') and reserved_at>moment-interval '120 seconds'),
 count(*) filter(where reserved_at>=(date_trunc('day',moment at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles') or state in ('reserved','dispatched','unknown') and reserved_at>moment-interval '120 seconds'),
 coalesce(sum(input_tokens) filter(where reserved_at>moment-interval '60 seconds' or state in ('reserved','dispatched','unknown') and reserved_at>moment-interval '120 seconds'),0),
 count(*) filter(where invocation=p_invocation)
 into calls,daily,tokens,turns from scout.quota_reservations where id<>p_id;
 if not coalesce(policy.enabled and policy.verified_until>moment and policy.database_verified_until>moment
 and policy.database_bytes>=0 and policy.database_bytes<400000000
 and policy.verified_rpm>0 and policy.verified_rpd>0 and policy.verified_tpm>0
 and coalesce(policy.cooldown_until,moment)<=moment
 and calls<least(policy.rpm,policy.verified_rpm/2)
 and daily<least(policy.rpd,policy.verified_rpd/2)
 and tokens+coalesce(p_tokens,16000)<=least(policy.tpm,policy.verified_tpm/2)
 and turns<p_max,false) then
 return query select false,greatest(policy.cooldown_until,case
 when daily>=least(policy.rpd,policy.verified_rpd/2) then
 ((date_trunc('day',moment at time zone 'America/Los_Angeles')+interval '1 day') at time zone 'America/Los_Angeles')
 else moment+interval '120 seconds' end),0,3;return;end if;
 if p_tokens is null then
 insert into scout.quota_reservations(id,invocation,input_tokens,state) values(p_id,p_invocation,16000,'reserved');
 else
 update scout.quota_reservations set input_tokens=p_tokens,reserved_at=moment,state='dispatched'
 where id=p_id and invocation=p_invocation and state='reserved';
 if not found then raise exception 'Reservation unavailable';end if;
 end if;
 return query select true,moment,1,4;
end $$;
revoke all on function scout.reserve_model(uuid,uuid,integer,integer) from public,anon,authenticated;
grant execute on function scout.reserve_model(uuid,uuid,integer,integer) to service_role;
-- At most 32 expired rows per due scheduler wake. Uncertain charges survive as numeric totals.
create function scout.expire_quota() returns table(mutations integer,sql_statements integer) language plpgsql set search_path='' as $$
declare ids uuid[]; calls bigint; tokens bigint; n integer; extra integer:=0;
begin
 perform 1 from scout.quota_policy where id for update;
 select array_agg(q.id),count(*) filter(where state<>'settled'),coalesce(sum(input_tokens) filter(where state<>'settled'),0)
 into ids,calls,tokens from (
  select * from scout.quota_reservations where reserved_at<clock_timestamp()-interval '120 seconds'
  and reserved_at<(date_trunc('day',clock_timestamp() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles')
  order by reserved_at limit 32 for update) q;
 if calls>0 then
  update scout.quota_policy set uncertain_calls=uncertain_calls+calls,uncertain_tokens=uncertain_tokens+tokens where id;
  extra:=1;
 end if;
 delete from scout.quota_reservations where id=any(ids);get diagnostics n=row_count;
 return query select n+extra,4+extra;
end $$;
revoke all on function scout.expire_quota() from public,anon,authenticated;
grant execute on function scout.expire_quota() to service_role;
create table scout.delivery_state(
 record_id uuid primary key references scout.records(id),version integer not null,
 status text not null check(status in ('sending','sent','failed','unknown')), at timestamptz not null default clock_timestamp()
);
insert into scout.delivery_state select id,1,'sent',last_communicated_at from scout.records where last_communicated_at is not null;
do $$ declare name text; begin
 foreach name in array array['source_state','record_sources','record_identities','quota_policy','quota_reservations','delivery_state'] loop
  execute format('alter table scout.%I enable row level security',name);
  execute format('revoke all on scout.%I from public,anon,authenticated,service_role',name);
  execute format('grant select,insert,update,delete on scout.%I to service_role',name);
 end loop;
end $$;
create function scout.date_span(value jsonb) returns daterange language plpgsql immutable set search_path='' as $$
declare first_day date; last_day date; text_value text:=value->>'value'; precision text:=value->>'precision';
begin
  if value is null or value='null'::jsonb then return null; end if;
  if precision='year' and text_value~'^\d{4}$' then
    first_day:=(text_value||'-01-01')::date;last_day:=(text_value||'-12-31')::date;
  elsif precision='month' and text_value~'^\d{4}-\d{2}$' then
    first_day:=(text_value||'-01')::date;last_day:=(first_day+interval '1 month'-interval '1 day')::date;
  elsif precision='day' and text_value~'^\d{4}-\d{2}-\d{2}$' then
    first_day:=text_value::date;last_day:=first_day;
  else raise exception 'Invalid typed date'; end if;
  return daterange(first_day,last_day,'[]');
end $$;
create function scout.finding_span(kind text,details jsonb) returns daterange language sql immutable set search_path='' as $$
  select case when kind='event' then case when details->'start' is not null and details->'start'<>'null'::jsonb
    then daterange(lower(scout.date_span(details->'start')),coalesce(upper(scout.date_span(details->'end')),upper(scout.date_span(details->'start'))),'[)') end
    else scout.date_span(details->case when kind='announcement' then 'published' else 'action_date' end) end
$$;
alter table scout.records add column date_span daterange generated always as(scout.finding_span(kind,details)) stored;
create index records_dates on scout.records using gist(date_span);
create index records_effective_dates on scout.records using gist(scout.date_span(details->'effective'));
create index records_organizations on scout.records using gin(organizations jsonb_path_ops);
create index records_text on scout.records using gin(to_tsvector('simple',title||' '||coalesce(description,'')||' '||organizations::text));
create index records_kind_priority on scout.records(kind,priority,id);
create index records_priority_page on scout.records((case priority when 'high' then 0 when 'normal' then 1 when 'low' then 2 else 3 end),(coalesce(lower(date_span),'infinity'::date)),id);
create index records_date_page on scout.records((coalesce(lower(date_span),'infinity'::date)),id);
create index records_title on scout.records(lower(title));
create index records_canonical on scout.records(canonical_url);
grant execute on function scout.date_span(jsonb),scout.finding_span(text,jsonb) to authenticated,service_role;
grant execute on function scout.access_role() to service_role;

create view scout.finding_reader with(security_barrier=true) as
select r.*,r.relevance->>'reason' as priority_reason,
 coalesce((select jsonb_agg(jsonb_build_object('url',s.url,'tracker_id',s.tracker_id,'relationship',s.relationship) order by s.url)
 from scout.record_sources s where s.record_id=r.id),'[]'::jsonb) sources
from scout.records r where (select scout.access_role()) is not null or current_setting('role',true)='service_role';
revoke all on scout.finding_reader from public,anon,authenticated,service_role;
grant select on scout.finding_reader to authenticated,service_role;
-- One bounded reader contract for the app and future read-only consumers.
create function scout.findings(p_kind text default null,p_priority text default null,p_from date default null,p_to date default null,
  p_organization text default null,p_search text default null,p_meaning text default null,p_after jsonb default null,p_limit integer default 50,p_order text default 'priority',p_id uuid default null)
returns setof scout.finding_reader language plpgsql stable security definer set search_path='' as $$
begin
  if scout.access_role() is null and current_setting('role',true)<>'service_role' then return; end if;
  return query select projection.* from (select r.* from scout.records r
  where (p_kind is null or r.kind=p_kind) and (p_priority is null or coalesce(r.priority,'unassessed')=p_priority)
    and (p_organization is null or r.organizations @> jsonb_build_array(jsonb_build_object('name',p_organization)))
    and (p_id is null or r.id=p_id)
    and (nullif(trim(p_search),'') is null or to_tsvector('simple',r.title||' '||coalesce(r.description,'')||' '||r.organizations::text) @@ plainto_tsquery('simple',p_search))
    and (p_from is null and p_to is null or
      (case when p_meaning='effective' then scout.date_span(r.details->'effective') else r.date_span end) && daterange(p_from,p_to,'[]'))
    and (p_meaning is null or p_meaning in ('primary','effective'))
    and (p_after is null or (case when p_order='date' then 0 else case r.priority when 'high' then 0 when 'normal' then 1 when 'low' then 2 else 3 end end,coalesce(lower(r.date_span),'infinity'::date),r.id)>
      ((p_after->>'rank')::integer,coalesce((p_after->>'day')::date,'infinity'::date),(p_after->>'id')::uuid))
  order by case when p_order='date' then 0 else case r.priority when 'high' then 0 when 'normal' then 1 when 'low' then 2 else 3 end end,coalesce(lower(r.date_span),'infinity'::date),r.id
  limit greatest(1,least(coalesce(p_limit,50),100))) selected
  join scout.finding_reader projection on projection.id=selected.id
  order by case when p_order='date' then 0 else case selected.priority when 'high' then 0 when 'normal' then 1 when 'low' then 2 else 3 end end,
    coalesce(lower(selected.date_span),'infinity'::date),selected.id;
end
$$;
revoke all on function scout.findings(text,text,date,date,text,text,text,jsonb,integer,text,uuid) from public,anon;
grant execute on function scout.findings(text,text,date,date,text,text,text,jsonb,integer,text,uuid) to authenticated,service_role;

create function scout.finding_jobs(p_after uuid default null) returns table(id uuid,tracker_id uuid,title text,url text,stage text,state text,reason text,explanation text,reopen_when text)
language sql stable security definer set search_path='' as $$
 select s.id,s.tracker_id,s.url,s.url,'fetch',s.state,s.reason,s.reason,'Re-fetch after due time'
 from scout.source_state s where s.state in ('deferred','parked') and (p_after is null or s.id>p_after)
 and (select scout.access_role()) is not null order by s.id limit 50
$$;
revoke all on function scout.finding_jobs(uuid) from public,anon;
grant execute on function scout.finding_jobs(uuid) to authenticated,service_role;
-- Retire replay/report APIs, never their historical rows.
drop function scout.run_history(uuid,timestamptz,uuid);
drop function scout.run_detail(uuid);
drop function scout.run_artifact(uuid,text);
drop view scout.source_details;
drop view scout.current_evidence;
revoke all on scout.evidence,scout.collection_runs from authenticated,service_role;
drop view scout.tracker_status;
create view scout.tracker_status with(security_barrier=true) as
select t.*,s.checked_at last_attempt_at,case when s.state='complete' then s.checked_at end last_success_at,
 s.state last_outcome,s.reason last_error,'paused'::text loop_state,
 (select count(*) from scout.source_state q where q.tracker_id=t.id and q.state in ('due','deferred','running')) awaiting_initial,
 (select min(due_at) from scout.source_state q where q.tracker_id=t.id and q.state in ('due','deferred','running')) oldest_awaiting_at,
 (select count(*) from scout.source_state q where q.tracker_id=t.id and q.state='parked') parked,
 (select count(*) from scout.source_state q where q.tracker_id=t.id and q.reason='inaccessible_source') source_problems,
 0::bigint processing_problems
from scout.trackers t left join scout.source_state s on s.tracker_id=t.id and s.identity='tracker'
where (select scout.access_role()) is not null or current_setting('role',true)='service_role';
revoke all on scout.tracker_status from public,anon,authenticated,service_role;
grant select on scout.tracker_status to authenticated,service_role;
commit;
