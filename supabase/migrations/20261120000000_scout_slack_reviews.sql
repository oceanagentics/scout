begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

alter table scout.finding_reviews drop constraint finding_reviews_pkey;
alter table scout.finding_reviews
 add column id uuid not null default gen_random_uuid(),
 add column origin text not null default 'reviewer' check(origin in ('reviewer','slack')),
 add column source_url text,
 add column description text check(char_length(description)<=280),
 add column slack_url text,
 add column slack_author_id text,
 add column slack_author_name text,
 add column slack_posted_at timestamptz,
 alter column reviewer_id drop not null,
 alter column record_id drop not null,
 add primary key(id),
 add unique(reviewer_id,record_id),
 add unique(slack_url,source_url),
 add constraint review_origin_fields check(
  (origin='reviewer' and reviewer_id is not null and record_id is not null
   and source_url is null and description is null and slack_url is null
   and slack_author_id is null and slack_author_name is null and slack_posted_at is null)
  or (origin='slack' and reviewer_id is null and record_id is null
   and source_url is not null and source_url ~ '^https?://'
   and nullif(trim(description),'') is not null
   and slack_url is not null and slack_url ~ '^https://oceanagentics\.slack\.com/archives/'
   and nullif(trim(slack_author_id),'') is not null
   and nullif(trim(slack_author_name),'') is not null and slack_posted_at is not null
   and notes ~ '[^[:space:]]')
 );

drop policy review_read on scout.finding_reviews;
create policy review_read on scout.finding_reviews for select to authenticated
 using ((select scout.access_role()) is not null and
  (origin='slack' or reviewer_id=(select auth.uid()) or (select scout.access_role())='admin'));

notify pgrst,'reload schema';
commit;
