-- The person's own answers to common screening questions (EEO, 18+, background check,
-- consent acknowledgements, referral source...), reused on every application form.
alter table public.candidate_profiles add column if not exists screening jsonb not null default '{}'::jsonb;

-- Automatic job discovery: jobs found from the web (not a board the person added), and per-user run status.
alter table public.jobs drop constraint if exists jobs_origin_check;
alter table public.jobs add constraint jobs_origin_check check (origin in ('source','import','extension','discovery'));
alter table public.automation_preferences
  add column if not exists auto_discover boolean not null default true,
  add column if not exists last_discovered_at timestamptz,
  add column if not exists last_discovery jsonb;
alter table public.automation_preferences add column if not exists auto_queue boolean not null default true;
