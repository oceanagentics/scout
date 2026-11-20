begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

alter table scout.source_items add column ignored boolean not null default false,
 add constraint source_items_ignored_not_pending check(not ignored or not pending);

create or replace function scout.reset_tracker() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.url is distinct from new.url then new.enabled=false;end if;
 new.last_checked_at=null;new.last_successful_check=null;
 new.last_error=null;new.failure_count=0;new.lease_id=null;new.lease_until=null;
 new.discovery_request_url=null;new.discovery_checked_at=null;new.discovery_fingerprint=null;
 delete from scout.source_items where tracker_id=new.id and not ignored;
 return new;
end $$;

commit;
