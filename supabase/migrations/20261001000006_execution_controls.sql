-- Per-application execution controls.
alter table public.applications
  add column if not exists control_signal text check (control_signal in ('pause','stop')),
  -- The person explicitly approved submission of this specific application (Review/Assisted modes).
  add column if not exists submit_approved_at timestamptz,
  add column if not exists last_heartbeat_at timestamptz;
