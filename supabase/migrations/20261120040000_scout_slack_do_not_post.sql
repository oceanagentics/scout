begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

alter table scout.records drop constraint records_slack_channel_post;
alter table scout.records add constraint records_slack_channel_post check(
 slack_channel_post is null or slack_channel_post in ('{"state":"uncertain"}'::jsonb,'{"state":"do_not_post"}'::jsonb) or
 coalesce((jsonb_typeof(slack_channel_post)='object' and slack_channel_post->>'state'='posted'
  and jsonb_typeof(slack_channel_post->'ts')='string' and slack_channel_post->>'ts'~'^\d+\.\d+$'
  and slack_channel_post-'state'-'ts'='{}'::jsonb),false)
);

notify pgrst,'reload schema';
commit;
