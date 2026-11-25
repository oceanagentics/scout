begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

alter table scout.trackers add column search_query text,
 add constraint tracker_search_configuration check(search_query is null or
  (search_query=btrim(search_query) and search_query<>'' and collector='web_index'
   and url is not distinct from 'https://api.tavily.com/search'));
alter table scout.trackers drop constraint trackers_url_method_key;
create unique index trackers_source_key on scout.trackers(url,collector,coalesce(search_query,''));

create or replace function scout.reset_tracker() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if (old.url,old.search_query) is distinct from (new.url,new.search_query) then new.enabled=false;end if;
 new.last_checked_at=null;new.last_successful_check=null;
 new.last_error=null;new.failure_count=0;new.lease_id=null;new.lease_until=null;
 new.discovery_request_url=null;new.discovery_checked_at=null;new.discovery_fingerprint=null;
 delete from scout.source_items where tracker_id=new.id and not ignored;
 return new;
end $$;
drop trigger reset_tracker on scout.trackers;
create trigger reset_tracker before update of url,collector,search_query on scout.trackers
 for each row when((old.url,old.collector,old.search_query) is distinct from (new.url,new.collector,new.search_query))
 execute function scout.reset_tracker();

notify pgrst,'reload schema';
commit;
