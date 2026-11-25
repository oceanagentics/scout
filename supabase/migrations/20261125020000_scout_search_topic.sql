begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

alter table scout.trackers add column search_topic text not null default 'news'
 check(search_topic in ('news','general'));

create or replace function scout.reset_tracker() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if (old.url,old.search_query,old.search_topic) is distinct from (new.url,new.search_query,new.search_topic) then new.enabled=false;end if;
 new.last_checked_at=null;new.last_successful_check=null;
 new.last_error=null;new.failure_count=0;new.lease_id=null;new.lease_until=null;
 new.discovery_request_url=null;new.discovery_checked_at=null;new.discovery_fingerprint=null;
 delete from scout.source_items where tracker_id=new.id and not ignored;
 return new;
end $$;
drop trigger reset_tracker on scout.trackers;
create trigger reset_tracker before update of url,collector,search_query,search_topic on scout.trackers
 for each row when((old.url,old.collector,old.search_query,old.search_topic) is distinct from (new.url,new.collector,new.search_query,new.search_topic))
 execute function scout.reset_tracker();

notify pgrst,'reload schema';
commit;
