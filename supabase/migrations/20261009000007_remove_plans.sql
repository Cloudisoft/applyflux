-- ApplyFlux no longer has plans or subscriptions. The only limits are the
-- person's own automation settings (daily limit, concurrency).

-- New-user bootstrap without a subscription row.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id, display_name)
    values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)))
    on conflict do nothing;
  insert into public.candidate_profiles (user_id, email, field_meta)
    values (new.id, new.email, jsonb_build_object('email', jsonb_build_object('source','user','verified', true)))
    on conflict do nothing;
  insert into public.automation_preferences (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;

drop table if exists public.subscriptions;
drop table if exists public.plans;

-- AI generations are no longer metered.
delete from public.usage_ledger where kind = 'ai_generation';
