-- Daily cron for educ-bounced-threads-router.
-- Runs at 22:00 UTC = 06:00 Philippine time (UTC+8), matching the other daily
-- *-sync jobs on this project. Requires pg_cron + pg_net (already enabled here).
--
-- Replace <PROJECT_REF> and <PUSH_SHARED_SECRET> before running. The token is the
-- SAME PUSH_SHARED_SECRET the drafter project already uses (reused, not new); the
-- deployed value is embedded in the existing renew-gmail-watch-daily cron URL.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'educ-bounced-threads-router-daily',
  '0 22 * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/educ-bounced-threads-router?token=<PUSH_SHARED_SECRET>',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);

-- To inspect or remove later:
--   select * from cron.job where jobname = 'educ-bounced-threads-router-daily';
--   select cron.unschedule('educ-bounced-threads-router-daily');
