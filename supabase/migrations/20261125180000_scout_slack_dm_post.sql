begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- Historical and manually added findings must not replay into the dev DM.
-- Collection explicitly makes newly created, lower-scored findings pending.
alter table scout.records add column slack_dm_post jsonb default '{"state":"do_not_post"}'::jsonb;
alter table scout.records add constraint records_slack_dm_post check(
 slack_dm_post is null or slack_dm_post in ('{"state":"uncertain"}'::jsonb,'{"state":"do_not_post"}'::jsonb) or
 coalesce((jsonb_typeof(slack_dm_post)='object' and slack_dm_post->>'state'='posted'
  and jsonb_typeof(slack_dm_post->'ts')='string' and slack_dm_post->>'ts'~'^\d+\.\d+$'
  and slack_dm_post-'state'-'ts'='{}'::jsonb),false)
);

notify pgrst,'reload schema';
commit;
