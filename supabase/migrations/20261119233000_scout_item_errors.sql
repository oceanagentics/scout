begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
alter table scout.source_items add column last_error text check(last_error ~ '^[a-z_]{1,48}$');
commit;
