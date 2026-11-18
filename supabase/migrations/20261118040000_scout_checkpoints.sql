begin;
set local lock_timeout='5s';
set local statement_timeout='5s';
lock table scout.trackers in access exclusive mode;

-- A checkpoint records committed progress; new sources have no prior check.
-- Preserve every existing checkpoint and finding.
alter table scout.trackers alter column last_successful_check drop default;
create or replace function scout.reset_tracker() returns trigger language plpgsql set search_path='' as $$
begin
 new.enabled=false;
 new.last_checked_at=null;new.last_successful_check=null;
 new.last_error=null;new.failure_count=0;new.lease_id=null;new.lease_until=null;
 return new;
end $$;
notify pgrst,'reload schema';
commit;
