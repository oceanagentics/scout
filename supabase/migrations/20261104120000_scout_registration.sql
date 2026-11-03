begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

alter table scout.records add column registration text
 check(registration is null or registration~'^https?://[^[:space:]]+$');

-- Existing records kept registration links only as sources; promote the first link that names registration.
update scout.records r set registration=(
 select s from unnest(r.sources) with ordinality as links(s,n)
 where s~'^https?://[^[:space:]]+$' and s~*'regist' order by n limit 1)
where r.type='event';

notify pgrst,'reload schema';
commit;
