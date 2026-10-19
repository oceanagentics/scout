begin;
alter table scout.trackers add column reader_progress text check(octet_length(reader_progress)<=1024);
create or replace function scout.reset_tracker() returns trigger language plpgsql set search_path='' as $$
begin
 new.enabled=false;
 new.next_check_at=clock_timestamp();new.last_checked_at=null;new.last_error=null;
 new.failure_count=0;new.lease_id=null;new.lease_until=null;new.reader_progress=null;
 return new;
end $$;
commit;
