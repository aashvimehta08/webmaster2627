-- Newer Supabase projects no longer auto-grant table privileges to API roles.
-- service_role (server-side only, bypasses RLS) needs explicit access for admin
-- tooling and the backend test suite. Browser roles are unaffected.
grant select, insert, update, delete on public.profiles, public.lesson_progress, public.user_stats to service_role;
