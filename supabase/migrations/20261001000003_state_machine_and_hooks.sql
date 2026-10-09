-- Application state-transition validation (mirrors packages/shared/src/states.ts;
-- a test asserts both tables are identical).

create or replace function public.application_transition_allowed(from_s public.application_state, to_s public.application_state)
returns boolean language sql immutable as $$
  select case from_s
    when 'DISCOVERED' then to_s in ('SHORTLISTED','QUEUED','SKIPPED')
    when 'SHORTLISTED' then to_s in ('DISCOVERED','QUEUED','SKIPPED')
    when 'QUEUED' then to_s in ('SHORTLISTED','IN_PROGRESS','SKIPPED')
    when 'IN_PROGRESS' then to_s in ('QUEUED','AWAITING_HUMAN_VERIFICATION','AWAITING_REVIEW','NEEDS_ATTENTION','SUBMITTED','SUBMISSION_UNVERIFIED','FAILED','SKIPPED')
    when 'AWAITING_HUMAN_VERIFICATION' then to_s in ('IN_PROGRESS','NEEDS_ATTENTION','FAILED','SKIPPED')
    when 'AWAITING_REVIEW' then to_s in ('IN_PROGRESS','SUBMITTED','SUBMISSION_UNVERIFIED','NEEDS_ATTENTION','SKIPPED')
    when 'NEEDS_ATTENTION' then to_s in ('QUEUED','IN_PROGRESS','SUBMITTED','SUBMISSION_UNVERIFIED','FAILED','SKIPPED')
    when 'SUBMITTED' then to_s in ('INTERVIEW','REJECTED','WITHDRAWN')
    when 'SUBMISSION_UNVERIFIED' then to_s in ('SUBMITTED','NEEDS_ATTENTION','INTERVIEW','REJECTED','WITHDRAWN')
    when 'FAILED' then to_s in ('QUEUED','SKIPPED')
    when 'SKIPPED' then to_s in ('SHORTLISTED','QUEUED')
    when 'INTERVIEW' then to_s in ('REJECTED','WITHDRAWN')
    else false
  end;
$$;

create or replace function public.enforce_application_transition() returns trigger
language plpgsql as $$
begin
  if new.state is distinct from old.state then
    if not public.application_transition_allowed(old.state, new.state) then
      raise exception 'invalid application state transition % -> %', old.state, new.state
        using errcode = 'check_violation', hint = 'INVALID_TRANSITION';
    end if;
    -- Once a submit was attempted, the application can never be re-queued automatically.
    if new.state = 'QUEUED' and old.submit_attempted_at is not null then
      raise exception 'application % already attempted submission; refusing to re-queue', old.id
        using errcode = 'check_violation', hint = 'INVALID_TRANSITION';
    end if;
    new.state_changed_at = now();
  end if;
  return new;
end $$;

drop trigger if exists applications_transition on public.applications;
create trigger applications_transition before update of state on public.applications
  for each row execute function public.enforce_application_transition();

-- user_id and job_id are immutable on applications.
create or replace function public.forbid_owner_change() returns trigger language plpgsql as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'user_id is immutable' using errcode = 'check_violation';
  end if;
  return new;
end $$;
do $$
declare t text;
begin
  foreach t in array array['applications','jobs','documents','candidate_profiles','work_experiences','educations',
                           'certifications','projects','cover_letters','saved_answers','notifications'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_owner_immutable', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.forbid_owner_change()', t || '_owner_immutable', t);
  end loop;
end $$;

-- New-user bootstrap: profile shell, default automation prefs, default plan.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare default_plan text;
begin
  select id into default_plan from public.plans where id = 'free';
  insert into public.profiles (user_id, display_name)
    values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)))
    on conflict do nothing;
  insert into public.candidate_profiles (user_id, email, field_meta)
    values (new.id, new.email, jsonb_build_object('email', jsonb_build_object('source','user','verified', true)))
    on conflict do nothing;
  insert into public.automation_preferences (user_id) values (new.id) on conflict do nothing;
  if default_plan is not null then
    insert into public.subscriptions (user_id, plan_id) values (new.id, default_plan) on conflict do nothing;
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
