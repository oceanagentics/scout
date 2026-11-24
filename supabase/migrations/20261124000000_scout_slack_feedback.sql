begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

alter table scout.finding_reviews
 drop constraint finding_reviews_origin_check,
 add constraint finding_reviews_origin_check check(origin in ('reviewer','slack','slack_feedback')),
 alter column priority drop not null,
 drop constraint review_origin_fields,
 add constraint review_origin_fields check(
  (origin='reviewer' and reviewer_id is not null and record_id is not null and priority is not null
   and source_url is null and description is null and slack_url is null
   and slack_author_id is null and slack_author_name is null and slack_posted_at is null)
  or (origin='slack' and reviewer_id is null and record_id is null and priority is not null
   and source_url is not null and source_url ~ '^https?://'
   and nullif(trim(description),'') is not null
   and slack_url is not null and slack_url ~ '^https://oceanagentics[.]slack[.]com/archives/'
   and nullif(trim(slack_author_id),'') is not null
   and nullif(trim(slack_author_name),'') is not null and slack_posted_at is not null
   and notes ~ '[^[:space:]]')
  or (origin='slack_feedback' and reviewer_id is null and source_url is null
   and nullif(trim(description),'') is not null
   and slack_url is not null and slack_url ~ '^https://oceanagentics[.]slack[.]com/archives/'
   and nullif(trim(slack_author_id),'') is not null
   and nullif(trim(slack_author_name),'') is not null and slack_posted_at is not null
   and notes ~ '[^[:space:]]')
 );

-- One current feedback account per message and person; public references keep their existing key.
create unique index finding_reviews_slack_feedback_identity
 on scout.finding_reviews(slack_url,slack_author_id) where origin='slack_feedback';

notify pgrst,'reload schema';
commit;
