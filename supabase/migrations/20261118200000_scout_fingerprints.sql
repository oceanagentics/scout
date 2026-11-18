begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

alter table scout.trackers add column discovery_fingerprint text;
alter table scout.source_items add column request_fingerprint text;

create or replace function scout.reset_tracker() returns trigger language plpgsql security definer set search_path='' as $$
begin
 new.enabled=false;new.last_checked_at=null;new.last_successful_check=null;
 new.last_error=null;new.failure_count=0;new.lease_id=null;new.lease_until=null;
 new.discovery_request_url=null;new.discovery_checked_at=null;new.discovery_fingerprint=null;
 delete from scout.source_items where tracker_id=new.id;
 return new;
end $$;

notify pgrst,'reload schema';
commit;
