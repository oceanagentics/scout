begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
delete from vault.secrets where name='scout_calendar_feed';
drop function scout.save_calendar_secret(text,text);
drop table scout.calendar_trial;
commit;
