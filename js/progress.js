// Learning-progress API for the frontend.
// All functions require a signed-in student and return { data, error }.
// The user id is NEVER passed from here: the database takes it from the
// verified session (auth.uid()), and RLS blocks access to anyone else's rows.
import { supabase, normalizeError } from './supabase-client.js';

const PROGRESS_COLUMNS =
  'module_id, lesson_id, status, progress_percent, quiz_score, quiz_max_score, ' +
  'quiz_best_score, quiz_attempts, started_at, completed_at, last_accessed_at';

async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  return { data: error ? null : data, error: normalizeError(error) };
}

/**
 * Record that the student opened a lesson (and optionally how far they got).
 * Call when a lesson page loads. Creates the row on first visit, otherwise
 * updates last_accessed_at. Never lowers progress or un-completes a lesson.
 */
export function saveProgress(moduleId, lessonId, { progressPercent } = {}) {
  return rpc('save_progress', {
    p_module_id: moduleId,
    p_lesson_id: lessonId,
    p_progress_percent: progressPercent == null ? null : Math.round(progressPercent),
  });
}

/**
 * Mark a lesson complete. `xp` (0–1000) is awarded only the first time.
 * data: { progress, first_completion, xp_awarded, total_xp }
 */
export function updateLessonCompletion(moduleId, lessonId, { xp = 0 } = {}) {
  return rpc('complete_lesson', { p_module_id: moduleId, p_lesson_id: lessonId, p_xp: xp });
}

/**
 * Record a quiz attempt. Increments attempts, keeps the best score.
 * If `passed`, the quiz counts as completed and `xp` is awarded on the first pass.
 * data: { progress, first_completion, xp_awarded, total_xp }
 */
export function saveQuizAttempt(moduleId, lessonId, { score, maxScore, passed = false, xp = 0 }) {
  return rpc('record_quiz_attempt', {
    p_module_id: moduleId,
    p_lesson_id: lessonId,
    p_score: score,
    p_max_score: maxScore,
    p_passed: passed,
    p_xp: xp,
  });
}

/**
 * All saved progress rows for the student, optionally filtered to one module.
 * data: array of rows (see docs/BACKEND_INTEGRATION.md). Lessons never opened have no row.
 */
export async function getProgress(moduleId) {
  let query = supabase.from('lesson_progress').select(PROGRESS_COLUMNS).order('module_id').order('lesson_id');
  if (moduleId) query = query.eq('module_id', moduleId);
  const { data, error } = await query;
  return { data: error ? null : data, error: normalizeError(error) };
}

/**
 * Same as getProgress(), but keyed for easy lookups:
 * data: { "module-1": { "1.1": row, "1.2": row }, ... }
 */
export async function getProgressMap(moduleId) {
  const { data, error } = await getProgress(moduleId);
  if (error) return { data: null, error };
  const map = {};
  for (const row of data) (map[row.module_id] ??= {})[row.lesson_id] = row;
  return { data: map, error: null };
}

/**
 * The lesson the student most recently opened — use for "Continue Learning".
 * data: row, or null if they haven't started anything yet.
 */
export async function getLastAccessedLesson() {
  const { data, error } = await supabase
    .from('lesson_progress')
    .select(PROGRESS_COLUMNS)
    .order('last_accessed_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return { data: error ? null : data, error: normalizeError(error) };
}

/**
 * Dashboard summary in one request:
 * { display_name, member_since, total_xp, badges, completed_modules, current_streak,
 *   longest_streak, lessons_completed, lessons_in_progress, quizzes_attempted, last_accessed }
 */
export function getUserStatistics() {
  return rpc('get_user_statistics');
}

/** Mark a whole module complete (frontend decides when). XP awarded once. */
export function completeModule(moduleId, { xp = 0 } = {}) {
  return rpc('complete_module', { p_module_id: moduleId, p_xp: xp });
}

/** Award a badge by id (idempotent). data: the student's full badge array. */
export function awardBadge(badgeId) {
  return rpc('award_badge', { p_badge_id: badgeId });
}

/**
 * Batches frequent progress updates (e.g. scroll position) into at most one
 * request every `intervalMs`, and flushes when the tab is hidden or closed.
 *
 *   const tracker = createProgressTracker('module-1', '1.1');
 *   tracker.update(40);   // call as often as you like
 *   tracker.stop();       // when leaving the lesson inside a single-page view
 */
export function createProgressTracker(moduleId, lessonId, { intervalMs = 15000 } = {}) {
  let pending = null;   // highest unsent percent
  let sent = -1;        // highest percent already saved
  let timer = null;

  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (pending == null || pending <= sent) return Promise.resolve();
    const value = pending;
    pending = null;
    sent = value;
    return saveProgress(moduleId, lessonId, { progressPercent: value });
  };

  const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', flush);

  return {
    update(percent) {
      const p = Math.max(0, Math.min(100, Math.round(percent)));
      if (p <= sent || (pending != null && p <= pending)) return;
      pending = p;
      if (!timer) timer = setTimeout(flush, intervalMs);
    },
    flush,
    stop() {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
      return flush();
    },
  };
}
