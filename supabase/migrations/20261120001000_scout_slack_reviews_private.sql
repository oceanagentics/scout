begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

drop policy review_read on scout.finding_reviews;
create policy review_read on scout.finding_reviews for select to authenticated
 using ((select scout.access_role()) is not null and
  (reviewer_id=(select auth.uid()) or (select scout.access_role())='admin'));

notify pgrst,'reload schema';
commit;
