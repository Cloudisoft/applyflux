-- ApplyFlux core schema.
-- Supabase PostgreSQL is the single source of truth for candidate data,
-- queues, applications and usage. All user-owned rows carry user_id and are
-- protected by RLS (see 20261001000002_rls.sql).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.application_state as enum (
    'DISCOVERED','SHORTLISTED','QUEUED','IN_PROGRESS','AWAITING_HUMAN_VERIFICATION','AWAITING_REVIEW',
    'NEEDS_ATTENTION','SUBMITTED','SUBMISSION_UNVERIFIED','FAILED','SKIPPED','INTERVIEW','REJECTED','WITHDRAWN'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.automation_mode as enum ('review','assisted','auto');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.fact_source as enum ('resume','user','ai_suggestion');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Generic updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Plans & subscriptions (limits are data, not code; prices may be null = not published)
-- ---------------------------------------------------------------------------
create table if not exists public.plans (
  id text primary key check (id ~ '^[a-z0-9_-]{2,40}$'),
  name text not null,
  description text,
  price_cents integer check (price_cents is null or price_cents >= 0),
  currency char(3),
  billing_interval text check (billing_interval in ('month','year')),
  monthly_application_limit integer not null check (monthly_application_limit >= 0),
  daily_application_limit integer not null check (daily_application_limit >= 0),
  max_concurrency integer not null default 1 check (max_concurrency between 1 and 5),
  monthly_ai_generations integer not null default 0 check (monthly_ai_generations >= 0),
  auto_mode_allowed boolean not null default false,
  features jsonb not null default '[]'::jsonb,
  is_public boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text check (char_length(display_name) <= 120),
  onboarding_step text not null default 'resume',
  onboarding_completed_at timestamptz,
  timezone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_updated before update on public.profiles for each row execute function public.set_updated_at();

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan_id text not null references public.plans(id),
  status text not null default 'active' check (status in ('active','past_due','canceled')),
  current_period_start timestamptz not null default date_trunc('month', now()),
  current_period_end timestamptz,
  external_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger subscriptions_updated before update on public.subscriptions for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Candidate profile (verified facts kept separate from AI drafts via field_meta / verified flags)
-- ---------------------------------------------------------------------------
create table if not exists public.candidate_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  first_name text, last_name text, email text, phone text,
  city text, region text, country text, postal_code text, address_line1 text,
  linkedin_url text, github_url text, portfolio_url text,
  other_links jsonb not null default '[]'::jsonb,
  headline text, summary text,
  years_experience numeric(4,1) check (years_experience is null or years_experience between 0 and 70),
  experience_level text check (experience_level is null or experience_level in ('entry','mid','senior','lead','executive')),
  skills text[] not null default '{}',
  industries text[] not null default '{}',
  languages jsonb not null default '[]'::jsonb,
  work_authorizations jsonb not null default '[]'::jsonb,
  notice_period text,
  available_from text,
  desired_titles text[] not null default '{}',
  desired_salary_min integer check (desired_salary_min is null or desired_salary_min >= 0),
  desired_salary_max integer check (desired_salary_max is null or desired_salary_max >= 0),
  salary_currency char(3),
  employment_types text[] not null default '{}',
  workplace_types text[] not null default '{}',
  desired_locations text[] not null default '{}',
  willing_to_relocate boolean,
  field_meta jsonb not null default '{}'::jsonb,
  verified_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger candidate_profiles_updated before update on public.candidate_profiles for each row execute function public.set_updated_at();

create table if not exists public.work_experiences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company text not null, title text not null, location text,
  start_date text, end_date text, is_current boolean not null default false,
  description text, achievements text[] not null default '{}',
  source public.fact_source not null default 'user',
  verified boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists work_experiences_user_idx on public.work_experiences(user_id, sort_order);
create trigger work_experiences_updated before update on public.work_experiences for each row execute function public.set_updated_at();

create table if not exists public.educations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  institution text not null, degree text, field_of_study text,
  start_date text, end_date text, grade text,
  source public.fact_source not null default 'user',
  verified boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists educations_user_idx on public.educations(user_id);
create trigger educations_updated before update on public.educations for each row execute function public.set_updated_at();

create table if not exists public.certifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null, issuer text, issued_on text, expires_on text, credential_id text,
  source public.fact_source not null default 'user',
  verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists certifications_user_idx on public.certifications(user_id);
create trigger certifications_updated before update on public.certifications for each row execute function public.set_updated_at();

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null, url text, description text, skills text[] not null default '{}',
  source public.fact_source not null default 'user',
  verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists projects_user_idx on public.projects(user_id);
create trigger projects_updated before update on public.projects for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Documents (resumes & rendered cover letters) with versioning
-- ---------------------------------------------------------------------------
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('resume','cover_letter')),
  title text not null check (char_length(title) between 1 and 200),
  file_name text not null,
  storage_path text not null unique,
  mime_type text not null,
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  sha256 text not null,
  root_document_id uuid references public.documents(id) on delete cascade,
  version integer not null default 1,
  is_default boolean not null default false,
  origin text not null default 'upload' check (origin in ('upload','tailored','generated')),
  parsed_text text,
  parse_status text not null default 'pending' check (parse_status in ('pending','parsed','failed','not_applicable')),
  parse_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists documents_user_idx on public.documents(user_id, kind, created_at desc);
create unique index if not exists documents_one_default_resume on public.documents(user_id) where is_default and kind = 'resume';
create trigger documents_updated before update on public.documents for each row execute function public.set_updated_at();

create table if not exists public.resume_parses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  method text not null check (method in ('heuristic','ai')),
  extracted jsonb not null,
  warnings jsonb not null default '[]'::jsonb,
  applied_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists resume_parses_doc_idx on public.resume_parses(document_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Jobs, sources, matching
-- ---------------------------------------------------------------------------
create table if not exists public.job_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('greenhouse','lever','ashby')),
  identifier text not null check (identifier ~ '^[A-Za-z0-9._-]{1,100}$'),
  name text,
  enabled boolean not null default true,
  last_synced_at timestamptz,
  last_error text,
  last_job_count integer,
  created_at timestamptz not null default now(),
  unique (user_id, kind, identifier)
);

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid references public.job_sources(id) on delete set null,
  origin text not null check (origin in ('source','import','extension')),
  external_id text,
  url text not null,
  url_key text not null check (url_key <> ''),
  fingerprint text not null,
  company text not null,
  title text not null,
  location text,
  workplace_type text check (workplace_type is null or workplace_type in ('remote','hybrid','onsite')),
  employment_type text,
  salary_min integer, salary_max integer, salary_currency char(3),
  description text,
  posted_at timestamptz,
  ats_vendor text,
  liveness text not null default 'unknown' check (liveness in ('active','expired','uncertain','unknown')),
  liveness_reason text,
  liveness_checked_at timestamptz,
  is_bookmarked boolean not null default false,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, url_key)
);
create index if not exists jobs_user_recent_idx on public.jobs(user_id, created_at desc);
create index if not exists jobs_user_fingerprint_idx on public.jobs(user_id, fingerprint);
create trigger jobs_updated before update on public.jobs for each row execute function public.set_updated_at();

create table if not exists public.job_matches (
  job_id uuid primary key references public.jobs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  score integer not null check (score between 0 and 100),
  breakdown jsonb not null,
  profile_version integer not null,
  computed_at timestamptz not null default now()
);
create index if not exists job_matches_user_score_idx on public.job_matches(user_id, score desc);

create table if not exists public.saved_searches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  query jsonb not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Cover letters, tailoring, saved answers
-- ---------------------------------------------------------------------------
create table if not exists public.cover_letters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  title text not null,
  body text not null check (char_length(body) <= 20000),
  length text not null default 'concise' check (length in ('concise','detailed')),
  status text not null default 'draft' check (status in ('draft','approved')),
  generated boolean not null default false,
  document_id uuid references public.documents(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cover_letters_user_idx on public.cover_letters(user_id, created_at desc);
create trigger cover_letters_updated before update on public.cover_letters for each row execute function public.set_updated_at();

create table if not exists public.resume_tailorings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  analysis jsonb not null,
  tailored jsonb,
  output_document_id uuid references public.documents(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.saved_answers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  question text not null,
  question_key text not null,
  category text not null,
  answer text not null check (char_length(answer) <= 5000),
  is_sensitive boolean not null default false,
  approved boolean not null default false,
  source text not null default 'user' check (source in ('user','ai_draft','extension')),
  usage_count integer not null default 0,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, question_key)
);
create trigger saved_answers_updated before update on public.saved_answers for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Automation
-- ---------------------------------------------------------------------------
create table if not exists public.automation_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  mode public.automation_mode not null default 'review',
  daily_limit integer not null default 10 check (daily_limit between 1 and 200),
  max_concurrency integer not null default 1 check (max_concurrency between 1 and 5),
  min_match_score integer not null default 50 check (min_match_score between 0 and 100),
  excluded_companies text[] not null default '{}',
  excluded_keywords text[] not null default '{}',
  require_sponsorship_friendly boolean not null default false,
  notify_browser boolean not null default false,
  default_resume_id uuid references public.documents(id) on delete set null,
  cover_letter_policy text not null default 'when_requested' check (cover_letter_policy in ('never','when_requested','always')),
  auto_submit_consent_at timestamptz,
  auto_submit_consent_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger automation_preferences_updated before update on public.automation_preferences for each row execute function public.set_updated_at();

create table if not exists public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null check (status in ('running','paused','stopped','completed')),
  mode public.automation_mode not null,
  started_at timestamptz not null default now(),
  paused_at timestamptz,
  ended_at timestamptz,
  updated_at timestamptz not null default now()
);
-- At most one live run per user.
create unique index if not exists automation_runs_one_live on public.automation_runs(user_id) where status in ('running','paused');
create trigger automation_runs_updated before update on public.automation_runs for each row execute function public.set_updated_at();

create table if not exists public.extension_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Chrome',
  token_hash text not null unique,
  extension_version text,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index if not exists extension_connections_user_idx on public.extension_connections(user_id);

create table if not exists public.extension_pairing_codes (
  code_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  attempts integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  state public.application_state not null default 'DISCOVERED',
  mode public.automation_mode,
  run_id uuid references public.automation_runs(id) on delete set null,
  idempotency_key text not null,
  priority integer not null default 0,
  resume_document_id uuid references public.documents(id) on delete set null,
  cover_letter_id uuid references public.cover_letters(id) on delete set null,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3,
  verification_challenges integer not null default 0,
  lease_connection_id uuid references public.extension_connections(id) on delete set null,
  lease_expires_at timestamptz,
  current_step text,
  progress integer not null default 0 check (progress between 0 and 100),
  adapter text,
  step_state jsonb,
  fields jsonb,
  intervention jsonb,
  last_error jsonb,
  submit_attempted_at timestamptz,
  submitted_at timestamptz,
  submission_evidence jsonb,
  quota_reserved boolean not null default false,
  notes text,
  state_changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, job_id),
  unique (user_id, idempotency_key),
  -- A "submitted" row must carry evidence or a user attestation recorded in submission_evidence.
  constraint submitted_requires_evidence check (state not in ('SUBMITTED') or submission_evidence is not null)
);
create index if not exists applications_user_state_idx on public.applications(user_id, state, priority desc, created_at);
create index if not exists applications_lease_idx on public.applications(lease_expires_at) where state in ('IN_PROGRESS');
create trigger applications_updated before update on public.applications for each row execute function public.set_updated_at();

create table if not exists public.application_events (
  id bigint generated always as identity primary key,
  application_id uuid not null references public.applications(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  from_state public.application_state,
  to_state public.application_state,
  actor text not null check (actor in ('user','extension','system')),
  message text,
  data jsonb,
  created_at timestamptz not null default now()
);
create index if not exists application_events_app_idx on public.application_events(application_id, id);
create index if not exists application_events_user_idx on public.application_events(user_id, id desc);

-- ---------------------------------------------------------------------------
-- Usage, notifications, audit
-- ---------------------------------------------------------------------------
create table if not exists public.usage_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('application','ai_generation')),
  -- For applications: the application id. For AI: a client idempotency key. Unique per kind => no double counting.
  ref text not null,
  quantity integer not null default 1 check (quantity > 0),
  created_at timestamptz not null default now(),
  unique (user_id, kind, ref)
);
create index if not exists usage_ledger_period_idx on public.usage_ledger(user_id, kind, created_at);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  application_id uuid references public.applications(id) on delete cascade,
  severity text not null default 'info' check (severity in ('info','success','warning','danger')),
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications(user_id, created_at desc);

create table if not exists public.audit_events (
  id bigint generated always as identity primary key,
  -- set null: the audit trail survives account deletion without identifying the person.
  user_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_events_user_idx on public.audit_events(user_id, id desc);
