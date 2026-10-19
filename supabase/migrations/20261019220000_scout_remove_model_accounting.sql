begin;
drop function scout.reserve_provider(uuid,uuid,text,timestamptz);
drop function scout.settle_provider(uuid,integer,integer,text,text,timestamptz,numeric);
drop function scout.expire_quota();
drop table scout.quota_reservations;
commit;
