-- Plan catalogue. ApplyFlux has no published commercial pricing yet, so prices
-- are NULL (the UI shows "Pricing not yet published" rather than an invented
-- price). Limits are data: change them here or with an UPDATE, never in code.

insert into public.plans (id, name, description, price_cents, currency, billing_interval,
  monthly_application_limit, daily_application_limit, max_concurrency, monthly_ai_generations,
  auto_mode_allowed, features, is_public, sort_order)
values
  ('free', 'Starter', 'Build your profile, discover roles and run Review/Assisted applications.',
    null, null, null, 25, 5, 1, 30, false,
    '["Resume parsing & candidate profile","Job discovery from public ATS boards","Review and Assisted modes","Saved answers"]'::jsonb,
    true, 0),
  ('pro', 'Pro', 'Higher limits and authorised Auto Mode on supported platforms.',
    null, null, 'month', 300, 40, 2, 400, true,
    '["Everything in Starter","Auto Mode on supported ATS platforms","Resume & cover letter tailoring","Higher daily limits"]'::jsonb,
    true, 1)
on conflict (id) do nothing;
