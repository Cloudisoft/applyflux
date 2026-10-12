-- Where to fill the application when it is not the posting page itself: e.g. Greenhouse jobs shown on a
-- company's own careers site embed the form in a frame the extension cannot reach, so ApplyFlux opens
-- Greenhouse's standalone application page instead.
alter table public.jobs add column if not exists apply_url text;
