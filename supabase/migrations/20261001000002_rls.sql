-- Row Level Security.
--
-- Model: the browser talks to Supabase directly only for Auth and Realtime
-- (and optionally reads). Every write that matters goes through the ApplyFlux
-- API, which connects with a privileged role and scopes each query to the
-- authenticated user. RLS is the second line of defence: even with the anon
-- key, a user can only ever see their own rows, and can only write to tables
-- where self-service editing is safe.

alter table public.plans enable row level security;
alter table public.profiles enable row level security;
alter table public.subscriptions enable row level security;
alter table public.candidate_profiles enable row level security;
alter table public.work_experiences enable row level security;
alter table public.educations enable row level security;
alter table public.certifications enable row level security;
alter table public.projects enable row level security;
alter table public.documents enable row level security;
alter table public.resume_parses enable row level security;
alter table public.job_sources enable row level security;
alter table public.jobs enable row level security;
alter table public.job_matches enable row level security;
alter table public.saved_searches enable row level security;
alter table public.cover_letters enable row level security;
alter table public.resume_tailorings enable row level security;
alter table public.saved_answers enable row level security;
alter table public.automation_preferences enable row level security;
alter table public.automation_runs enable row level security;
alter table public.extension_connections enable row level security;
alter table public.extension_pairing_codes enable row level security;
alter table public.applications enable row level security;
alter table public.application_events enable row level security;
alter table public.usage_ledger enable row level security;
alter table public.notifications enable row level security;
alter table public.audit_events enable row level security;

-- Plans are public catalogue data.
create policy plans_read on public.plans for select to anon, authenticated using (is_public);

-- Read-own on every user table.
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','subscriptions','candidate_profiles','work_experiences','educations','certifications','projects',
    'documents','resume_parses','job_sources','jobs','job_matches','saved_searches','cover_letters',
    'resume_tailorings','saved_answers','automation_preferences','automation_runs','applications',
    'application_events','usage_ledger','notifications','audit_events'
  ] loop
    execute format('create policy %I on public.%I for select to authenticated using (user_id = (select auth.uid()))', t || '_select_own', t);
  end loop;
end $$;

-- Self-service write on profile-type data that has no integrity or billing impact.
do $$
declare t text;
begin
  foreach t in array array[
    'candidate_profiles','work_experiences','educations','certifications','projects',
    'saved_searches','cover_letters','saved_answers'
  ] loop
    execute format('create policy %I on public.%I for insert to authenticated with check (user_id = (select auth.uid()))', t || '_insert_own', t);
    execute format('create policy %I on public.%I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t || '_update_own', t);
    execute format('create policy %I on public.%I for delete to authenticated using (user_id = (select auth.uid()))', t || '_delete_own', t);
  end loop;
end $$;

-- Notifications: a user may mark their own as read.
create policy notifications_update_own on public.notifications for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy profiles_update_own on public.profiles for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Deliberately NO client write policies on: applications, application_events,
-- automation_runs, automation_preferences (consent must be recorded server-side),
-- subscriptions, usage_ledger, documents, extension_connections,
-- extension_pairing_codes (no select either: hashes never leave the server), audit_events.

-- extension_connections: users can list their connections but never read token hashes.
revoke select on public.extension_connections from authenticated, anon;
grant select (id, user_id, name, extension_version, created_at, last_seen_at, expires_at, revoked_at)
  on public.extension_connections to authenticated;
create policy extension_connections_select_own on public.extension_connections for select to authenticated
  using (user_id = (select auth.uid()));

-- Realtime: stream queue and notification changes to the owner (RLS applies to Realtime).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.applications, public.application_events, public.notifications, public.automation_runs;
  end if;
end $$;
