-- =====================================================================
-- BRAINGAINZ.EDU — initial backend schema
--
-- Design:
--   * Supabase Auth (auth.users) is the source of truth for credentials and email.
--   * Every table is protected by Row Level Security: users can only SELECT their own rows.
--   * Clients cannot INSERT/UPDATE/DELETE progress or stats directly. All writes go through
--     the RPC functions below, which take the user id from the verified JWT (auth.uid()),
--     never from a client-supplied parameter.
--   * Module/lesson ids are free-form text so the content team can define them.
-- =====================================================================

-- Helpers live in a schema that is NOT exposed through the Data API.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------

-- Timezone used for "learning day" boundaries (streaks). Change if needed.
create or replace function private.app_today()
returns date
language sql
stable
set search_path = ''
as $$ select (now() at time zone 'America/Denver')::date $$;

-- Returns the caller's user id or raises if the request is not authenticated.
create or replace function private.require_uid()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000', hint = 'Sign in first.';
  end if;
  return v_uid;
end;
$$;

-- Validates content identifiers (module ids, lesson ids, badge ids).
create or replace function private.assert_valid_id(p_value text, p_name text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_value is null or p_value !~ '^[A-Za-z0-9._:-]{1,64}$' then
    raise exception 'invalid_%', p_name using errcode = '22023',
      hint = p_name || ' must be 1-64 characters: letters, digits, . _ : -';
  end if;
end;
$$;

-- Validates an XP amount (caps abuse from a tampered client).
create or replace function private.assert_valid_xp(p_xp integer)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_xp is null or p_xp < 0 or p_xp > 1000 then
    raise exception 'invalid_xp' using errcode = '22023', hint = 'XP must be between 0 and 1000.';
  end if;
end;
$$;

-- Generic updated_at trigger.
create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

-- A. Profiles (no email copy: read it from the auth session to avoid duplicated PII).
create table public.profiles (
  id             uuid primary key references auth.users (id) on delete cascade,
  display_name   text not null
                 check (char_length(display_name) between 1 and 50 and display_name = btrim(display_name)),
  created_at     timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- B. Learning progress: one row per (user, module, lesson).
create table public.lesson_progress (
  id                bigint generated always as identity primary key,
  user_id           uuid not null references auth.users (id) on delete cascade,
  module_id         text not null check (module_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  lesson_id         text not null check (lesson_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  status            text not null default 'in_progress'
                    check (status in ('in_progress', 'completed')),
  progress_percent  smallint not null default 0 check (progress_percent between 0 and 100),
  quiz_score        numeric(7,2) check (quiz_score >= 0),
  quiz_max_score    numeric(7,2) check (quiz_max_score > 0),
  quiz_best_score   numeric(7,2) check (quiz_best_score >= 0),
  quiz_attempts     integer not null default 0 check (quiz_attempts >= 0),
  started_at        timestamptz not null default now(),
  completed_at      timestamptz,
  last_accessed_at  timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint lesson_progress_user_lesson_key unique (user_id, module_id, lesson_id),
  constraint quiz_score_within_max check (quiz_score is null or quiz_max_score is null or quiz_score <= quiz_max_score)
);
-- "Continue learning" lookup.
create index lesson_progress_user_last_accessed_idx
  on public.lesson_progress (user_id, last_accessed_at desc);

-- C. Gamification: one row per user.
create table public.user_stats (
  user_id            uuid primary key references auth.users (id) on delete cascade,
  total_xp           integer not null default 0 check (total_xp >= 0),
  badges             text[] not null default '{}',
  completed_modules  text[] not null default '{}',
  current_streak     integer not null default 0 check (current_streak >= 0),
  longest_streak     integer not null default 0 check (longest_streak >= 0),
  last_activity_date date,
  updated_at         timestamptz not null default now()
);

create trigger profiles_set_updated_at        before update on public.profiles
  for each row execute function private.set_updated_at();
create trigger lesson_progress_set_updated_at before update on public.lesson_progress
  for each row execute function private.set_updated_at();
create trigger user_stats_set_updated_at      before update on public.user_stats
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------
-- Row Level Security + privileges
-- ---------------------------------------------------------------------
alter table public.profiles        enable row level security;
alter table public.lesson_progress enable row level security;
alter table public.user_stats      enable row level security;

-- Supabase grants broad table privileges by default; lock them down explicitly.
revoke all on public.profiles, public.lesson_progress, public.user_stats from anon, authenticated;
grant select on public.profiles, public.lesson_progress, public.user_stats to authenticated;
grant update (display_name) on public.profiles to authenticated;   -- only this column

create policy "Users read own profile" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "Users update own profile" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "Users read own progress" on public.lesson_progress
  for select to authenticated using (user_id = (select auth.uid()));

create policy "Users read own stats" on public.user_stats
  for select to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------
-- New-user trigger: create profile + stats rows when someone signs up.
-- ---------------------------------------------------------------------
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(new.raw_user_meta_data ->> 'display_name', ''));
begin
  if v_name = '' then v_name := 'Student'; end if;
  v_name := btrim(left(v_name, 50));

  insert into public.profiles (id, display_name) values (new.id, v_name);
  insert into public.user_stats (user_id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- Records learning activity: last_active_at + daily streak.
create or replace function private.record_activity(p_uid uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := private.app_today();
begin
  update public.profiles set last_active_at = now() where id = p_uid;

  update public.user_stats s set
    current_streak = x.new_streak,
    longest_streak = greatest(s.longest_streak, x.new_streak),
    last_activity_date = v_today
  from (
    select case
             when last_activity_date = v_today     then current_streak
             when last_activity_date = v_today - 1 then current_streak + 1
             else 1
           end as new_streak
    from public.user_stats where user_id = p_uid
  ) x
  where s.user_id = p_uid
    and s.last_activity_date is distinct from v_today;
end;
$$;

-- Awards XP to a user (internal only).
create or replace function private.add_xp(p_uid uuid, p_xp integer)
returns integer
language sql
security definer
set search_path = ''
as $$
  update public.user_stats set total_xp = total_xp + p_xp
  where user_id = p_uid
  returning total_xp;
$$;

revoke all on all functions in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Public RPC API (called from js/progress.js via supabase.rpc)
-- ---------------------------------------------------------------------

-- Opening a lesson / updating how far through it the student is.
-- Upserts a single row; never downgrades a completed lesson or lowers progress.
create or replace function public.save_progress(
  p_module_id text,
  p_lesson_id text,
  p_progress_percent integer default null
)
returns public.lesson_progress
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_row public.lesson_progress;
begin
  perform private.assert_valid_id(p_module_id, 'module_id');
  perform private.assert_valid_id(p_lesson_id, 'lesson_id');
  if p_progress_percent is not null and (p_progress_percent < 0 or p_progress_percent > 100) then
    raise exception 'invalid_progress_percent' using errcode = '22023', hint = 'Must be 0-100.';
  end if;

  insert into public.lesson_progress as lp (user_id, module_id, lesson_id, progress_percent)
  values (v_uid, p_module_id, p_lesson_id, coalesce(p_progress_percent, 0))
  on conflict (user_id, module_id, lesson_id) do update set
    last_accessed_at = now(),
    progress_percent = greatest(lp.progress_percent, coalesce(p_progress_percent, lp.progress_percent))
  returning * into v_row;

  perform private.record_activity(v_uid);
  return v_row;
end;
$$;

-- Marks a lesson complete. XP is awarded only the first time.
create or replace function public.complete_lesson(
  p_module_id text,
  p_lesson_id text,
  p_xp integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_row public.lesson_progress;
  v_first boolean;
  v_total integer;
begin
  perform private.assert_valid_id(p_module_id, 'module_id');
  perform private.assert_valid_id(p_lesson_id, 'lesson_id');
  perform private.assert_valid_xp(p_xp);

  insert into public.lesson_progress as lp
    (user_id, module_id, lesson_id, status, progress_percent, completed_at)
  values (v_uid, p_module_id, p_lesson_id, 'completed', 100, now())
  on conflict (user_id, module_id, lesson_id) do update set
    status = 'completed',
    progress_percent = 100,
    completed_at = coalesce(lp.completed_at, now()),
    last_accessed_at = now()
  returning * into v_row;

  -- now() is fixed per transaction, so this is true only if THIS call completed it.
  v_first := v_row.completed_at = now();
  if v_first and p_xp > 0 then
    v_total := private.add_xp(v_uid, p_xp);
  else
    select total_xp into v_total from public.user_stats where user_id = v_uid;
  end if;

  perform private.record_activity(v_uid);
  return jsonb_build_object(
    'progress', to_jsonb(v_row),
    'first_completion', v_first,
    'xp_awarded', case when v_first then p_xp else 0 end,
    'total_xp', v_total
  );
end;
$$;

-- Records one quiz attempt. If p_passed, the quiz lesson is marked complete
-- and XP is awarded on the first pass only.
create or replace function public.record_quiz_attempt(
  p_module_id text,
  p_lesson_id text,
  p_score numeric,
  p_max_score numeric,
  p_passed boolean default false,
  p_xp integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_row public.lesson_progress;
  v_first boolean := false;
  v_total integer;
begin
  perform private.assert_valid_id(p_module_id, 'module_id');
  perform private.assert_valid_id(p_lesson_id, 'lesson_id');
  perform private.assert_valid_xp(p_xp);
  if p_max_score is null or p_max_score <= 0 or p_max_score > 10000
     or p_score is null or p_score < 0 or p_score > p_max_score then
    raise exception 'invalid_score' using errcode = '22023',
      hint = 'Score must be between 0 and max_score (max_score 1-10000).';
  end if;
  p_passed := coalesce(p_passed, false);

  insert into public.lesson_progress as lp
    (user_id, module_id, lesson_id, status, progress_percent, completed_at,
     quiz_score, quiz_max_score, quiz_best_score, quiz_attempts)
  values
    (v_uid, p_module_id, p_lesson_id,
     case when p_passed then 'completed' else 'in_progress' end,
     case when p_passed then 100 else 0 end,
     case when p_passed then now() end,
     p_score, p_max_score, p_score, 1)
  on conflict (user_id, module_id, lesson_id) do update set
    quiz_score      = p_score,
    quiz_max_score  = p_max_score,
    quiz_best_score = greatest(coalesce(lp.quiz_best_score, 0), p_score),
    quiz_attempts   = lp.quiz_attempts + 1,
    status          = case when p_passed then 'completed' else lp.status end,
    progress_percent = case when p_passed then 100 else lp.progress_percent end,
    completed_at    = case when p_passed then coalesce(lp.completed_at, now()) else lp.completed_at end,
    last_accessed_at = now()
  returning * into v_row;

  v_first := p_passed and v_row.completed_at = now();
  if v_first and p_xp > 0 then
    v_total := private.add_xp(v_uid, p_xp);
  else
    select total_xp into v_total from public.user_stats where user_id = v_uid;
  end if;

  perform private.record_activity(v_uid);
  return jsonb_build_object(
    'progress', to_jsonb(v_row),
    'first_completion', v_first,
    'xp_awarded', case when v_first then p_xp else 0 end,
    'total_xp', v_total
  );
end;
$$;

-- Marks a whole module complete (the frontend decides when, since it owns the
-- module structure). XP is awarded only the first time.
create or replace function public.complete_module(
  p_module_id text,
  p_xp integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_first boolean;
  v_total integer;
begin
  perform private.assert_valid_id(p_module_id, 'module_id');
  perform private.assert_valid_xp(p_xp);

  update public.user_stats
     set completed_modules = array_append(completed_modules, p_module_id),
         total_xp = total_xp + p_xp
   where user_id = v_uid and not (p_module_id = any (completed_modules));
  v_first := found;

  select total_xp into v_total from public.user_stats where user_id = v_uid;
  perform private.record_activity(v_uid);
  return jsonb_build_object(
    'first_completion', v_first,
    'xp_awarded', case when v_first then p_xp else 0 end,
    'total_xp', v_total
  );
end;
$$;

-- Awards a badge (idempotent).
create or replace function public.award_badge(p_badge_id text)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_badges text[];
begin
  perform private.assert_valid_id(p_badge_id, 'badge_id');
  update public.user_stats
     set badges = array_append(badges, p_badge_id)
   where user_id = v_uid and not (p_badge_id = any (badges));
  select badges into v_badges from public.user_stats where user_id = v_uid;
  return v_badges;
end;
$$;

-- Updates last_active_at (called after sign-in). Does not affect streaks.
create or replace function public.touch_last_active()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles set last_active_at = now() where id = private.require_uid();
end;
$$;

-- One-call dashboard summary. Runs as the caller, so RLS applies.
create or replace function public.get_user_statistics()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_today date := private.app_today();
  v_result jsonb;
begin
  select jsonb_build_object(
    'display_name',       p.display_name,
    'member_since',       p.created_at,
    'total_xp',           s.total_xp,
    'badges',             to_jsonb(s.badges),
    'completed_modules',  to_jsonb(s.completed_modules),
    'current_streak',     case when s.last_activity_date >= v_today - 1 then s.current_streak else 0 end,
    'longest_streak',     s.longest_streak,
    'lessons_completed',  (select count(*) from public.lesson_progress where user_id = v_uid and status = 'completed'),
    'lessons_in_progress',(select count(*) from public.lesson_progress where user_id = v_uid and status = 'in_progress'),
    'quizzes_attempted',  (select count(*) from public.lesson_progress where user_id = v_uid and quiz_attempts > 0),
    'last_accessed',      (select jsonb_build_object('module_id', module_id, 'lesson_id', lesson_id,
                                                     'status', status, 'last_accessed_at', last_accessed_at)
                             from public.lesson_progress where user_id = v_uid
                             order by last_accessed_at desc limit 1)
  )
  into v_result
  from public.profiles p
  join public.user_stats s on s.user_id = p.id
  where p.id = v_uid;

  return v_result;
end;
$$;

-- Permanently deletes the caller's account and (via ON DELETE CASCADE) all their data.
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from auth.users where id = private.require_uid();
end;
$$;

-- Only signed-in users may call the API functions.
revoke execute on function
  public.save_progress(text, text, integer),
  public.complete_lesson(text, text, integer),
  public.record_quiz_attempt(text, text, numeric, numeric, boolean, integer),
  public.complete_module(text, integer),
  public.award_badge(text),
  public.touch_last_active(),
  public.get_user_statistics(),
  public.delete_my_account()
from public, anon;

grant execute on function
  public.save_progress(text, text, integer),
  public.complete_lesson(text, text, integer),
  public.record_quiz_attempt(text, text, numeric, numeric, boolean, integer),
  public.complete_module(text, integer),
  public.award_badge(text),
  public.touch_last_active(),
  public.get_user_statistics(),
  public.delete_my_account()
to authenticated;

-- get_user_statistics is SECURITY INVOKER and calls private helpers.
grant usage on schema private to authenticated;
grant execute on function private.require_uid(), private.app_today() to authenticated;
