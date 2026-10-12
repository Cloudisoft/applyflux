-- Every account can auto-apply to up to 200 applications a day.
alter table public.automation_preferences alter column daily_limit set default 200;
update public.automation_preferences set daily_limit = 200 where daily_limit <> 200;
