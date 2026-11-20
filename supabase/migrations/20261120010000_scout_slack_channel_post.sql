begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- Existing rows have an unknown posting history. New findings start pending.
alter table scout.records add column slack_channel_post jsonb default '{"state":"uncertain"}'::jsonb;
alter table scout.records alter column slack_channel_post drop default;
alter table scout.records add constraint records_slack_channel_post check(
 slack_channel_post is null or slack_channel_post='{"state":"uncertain"}'::jsonb or
 coalesce((jsonb_typeof(slack_channel_post)='object' and slack_channel_post->>'state'='posted'
  and jsonb_typeof(slack_channel_post->'ts')='string' and slack_channel_post->>'ts'~'^\d+\.\d+$'
  and slack_channel_post-'state'-'ts'='{}'::jsonb),false)
);

notify pgrst,'reload schema';
commit;
