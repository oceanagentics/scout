begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- Renaming the existing index mode does not change its committed progress.
update scout.trackers set collector='web_index' where collector='web';
alter table scout.trackers add constraint tracker_collector_valid
 check(collector in ('web_page','web_index','bluesky_feed'));

create or replace function scout.reset_tracker() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.url is distinct from new.url then new.enabled=false;end if;
 new.last_checked_at=null;new.last_successful_check=null;
 new.last_error=null;new.failure_count=0;new.lease_id=null;new.lease_until=null;
 new.discovery_request_url=null;new.discovery_checked_at=null;new.discovery_fingerprint=null;
 delete from scout.source_items where tracker_id=new.id;
 return new;
end $$;
drop trigger reset_tracker on scout.trackers;
create trigger reset_tracker before update of url,collector on scout.trackers
 for each row when((old.url,old.collector) is distinct from (new.url,new.collector))
 execute function scout.reset_tracker();

update scout.trackers set collector='web_page'
 where id='fa465a3b-c9d3-4810-9efb-cd6ab9dcc49c';

do $$ declare previous scout.trackers%rowtype;begin
 select * into previous from scout.trackers where id='b95f96b1-1252-43f5-93ea-e17cc8704b49';
 if found then
  update scout.trackers set name='Bloomberg — Press Releases',url='https://www.bloomberg.org/press/',collector='web_index'
   where id=previous.id;
  update scout.trackers set enabled=previous.enabled where id=previous.id;
  insert into scout.trackers(name,url,coverage,collector,cadence,enabled)
   select 'Bloomberg — Blog','https://www.bloomberg.org/blog/',previous.coverage,'web_index',previous.cadence,previous.enabled
   where not exists(select 1 from scout.trackers where url='https://www.bloomberg.org/blog/');
 end if;
end $$;

notify pgrst,'reload schema';
commit;
