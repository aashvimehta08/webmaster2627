# Backend Integration Guide

**For:** the frontend/content team building the BRAINGAINZ.EDU learning pages.
**You need:** HTML and a little JavaScript. No build tools, no frameworks.

---

## 1. How it fits together

```
Your HTML page
   └─ <script type="module">  imports  js/auth.js  and  js/progress.js
                                            │
                                            ▼
                               js/supabase-client.js  (one shared connection)
                                            │  HTTPS
                                            ▼
                Supabase  ── Auth (accounts, passwords, emails, sessions)
                          └─ Postgres (profiles, lesson_progress, user_stats)
                             protected by Row Level Security
```

* **You never send a user id.** The database figures out who is calling from their login session. A student can only ever read or change their own data, even if they tamper with the JavaScript.
* **You define the module and lesson ids.** The backend accepts any id made of letters, digits, `.`, `_`, `:` or `-` (max 64 chars), e.g. `module-1` / `1.1`, `module-1` / `quiz-1.1`. **Pick ids once and never rename them**, because saved progress is keyed by them.
* **Quizzes are lessons too.** Store a quiz as a lesson with its own id (e.g. `quiz-1.1`) and use `saveQuizAttempt()`.

## 2. Using the functions on a page

Every function is `async` and returns `{ data, error }`:

* `error` is `null` on success.
* On failure, `error` is `{ code, message }`. `message` is already student-friendly, so you can show it directly. `code` is for your `if` checks (see [Error codes](#7-error-codes)).

```html
<script type="module">
  import { requireAuth } from './js/auth.js';
  import { saveProgress } from './js/progress.js';

  const user = await requireAuth();          // sends logged-out visitors to login.html
  if (user) await saveProgress('module-1', '1.1');
</script>
```

> Paths: from a page in the site root use `./js/...`. From a page inside a folder (e.g. `lessons/1-1.html`) use `../js/...`.

---

## 3. Authentication — `js/auth.js`

`login.html` and `reset-password.html` are already wired up. You only need these functions if you build other pages (a header with a Log out button, a profile page, etc.).

### `signUp({ email, password, confirmPassword, displayName })`
Creates an account and emails a verification link. The student can't log in until they click it.

| | |
|---|---|
| Parameters | `email` (string), `password` (8–72 chars, at least one letter and one number), `confirmPassword` (must match), `displayName` (1–50 chars) |
| Returns | `data: { needsEmailVerification: true }` |
| Errors | `invalid_email`, `invalid_display_name`, `weak_password`, `password_mismatch`, `over_email_send_rate_limit` |
| Auth required | No |

For privacy, signing up with an email that's already registered looks like a success (Supabase doesn't reveal which emails have accounts). That person gets no new account.

```js
const { data, error } = await signUp({ email, password, confirmPassword, displayName });
if (error) showError(error.message);
else showMessage('Check your email to verify your account!');
```

### `signIn({ email, password })`
| | |
|---|---|
| Returns | `data: { user, session }`. The session is saved automatically and survives reloads and browser restarts. |
| Errors | `invalid_credentials` (wrong email or password), `email_not_confirmed` (offer `resendVerification(email)`), `over_request_rate_limit` |
| Auth required | No |

### `signOut({ everywhere }?)`
Ends the session on this device, and the server revokes it. Other devices stay logged in. Pass `{ everywhere: true }` for a "Log out of all devices" button. Returns `{ data: null, error }`.

```js
document.getElementById('logout').onclick = async () => {
  await signOut();
  window.location.href = 'home.html';
};
```

### `getSession()`
A fast local check (no network). Use it for UI decisions such as showing "LOGIN" or "LOG OUT" in the header.

Returns `data: { session, user }`. Both are `null` when logged out. `user.email` holds the email.

```js
const { data } = await getSession();
loginButton.textContent = data.user ? 'LOG OUT' : 'LOGIN';
```

### `getUser()`
Like `getSession()`, but asks the server, so it also detects deleted or expired accounts. Returns `data: { user }`.

### `requireAuth(loginPage = 'login.html')`
Put this at the top of every page that needs an account. It returns the user, or redirects to the login page and returns `null`. After login, the student is sent back to the page they came from.

### `resetPassword(email)`
Sends a "reset your password" email. The link opens `reset-password.html`, which is already built. Always returns `data: { sent: true }` for valid emails, to avoid revealing which emails have accounts.

### Also available
| Function | Purpose |
|---|---|
| `updatePassword(newPassword, confirmPassword)` | Change the password while logged in (used by `reset-password.html`) |
| `resendVerification(email)` | Re-send the verification email |
| `onAuthChange((event, session) => …)` | React to `SIGNED_IN` / `SIGNED_OUT` etc. Returns an unsubscribe function |
| `getProfile()` | `data: { id, email, display_name, created_at, last_active_at }` |
| `updateDisplayName(name)` | Rename (1–50 chars) |
| `deleteAccount()` | Permanently deletes the account and all progress. Ask for confirmation first! |

---

## 4. Learning progress — `js/progress.js`

All of these require a logged-in student. If nobody is logged in, they return `error.code === 'not_authenticated'`.

### `saveProgress(moduleId, lessonId, { progressPercent }?)`
**Call when a lesson page opens.** The first call creates the record. Later calls update "last accessed" and, if given, `progressPercent` (0–100).

It never lowers progress and never un-completes a lesson, so it's safe to call every time.

* **Returns:** `data`: the lesson's progress row (see [Tables](#6-database-tables)).
* **Errors:** `invalid_module_id`, `invalid_lesson_id`, `invalid_progress_percent`.

```js
await saveProgress('module-1', '1.3');                       // opened lesson
await saveProgress('module-1', '1.3', { progressPercent: 50 }); // halfway
```

For frequent updates such as scroll position, use the tracker instead. It sends at most one request every 15 s, plus one when the tab is closed:

```js
import { createProgressTracker } from './js/progress.js';
const tracker = createProgressTracker('module-1', '1.3');
window.addEventListener('scroll', () => {
  const pct = (scrollY + innerHeight) / document.body.scrollHeight * 100;
  tracker.update(pct);
});
```

### `updateLessonCompletion(moduleId, lessonId, { xp }?)`
Marks a lesson complete. `xp` (0–1000, default 0) is awarded **only the first time**, so repeat clicks can't farm XP.

* **Returns:** `data: { progress, first_completion, xp_awarded, total_xp }`.

```js
const { data, error } = await updateLessonCompletion('module-1', '1.3', { xp: 50 });
if (!error && data.first_completion) showToast(`+${data.xp_awarded} XP!`);
```

### `saveQuizAttempt(moduleId, lessonId, { score, maxScore, passed, xp })`
Records one quiz attempt:

* Increments `quiz_attempts`, stores the latest score and keeps `quiz_best_score`.
* If `passed` is true, the quiz counts as completed, and `xp` is awarded on the first pass only.
* **You decide** what score counts as passing.
* **Returns:** same shape as `updateLessonCompletion`.
* **Errors:** `invalid_score` (score < 0, score > maxScore, or maxScore out of 1–10000).

```js
const score = 4, maxScore = 5;
await saveQuizAttempt('module-1', 'quiz-1.1', { score, maxScore, passed: score / maxScore >= 0.8, xp: 25 });
```

### `getProgress(moduleId?)`
All of the student's progress rows, or one module's. **Lessons never opened have no row**, so treat a missing row as "NOT STARTED".

### `getProgressMap(moduleId?)`
Same data, keyed for easy lookups: `data["module-1"]["1.1"]`. This is the easiest way to fill in `modules.html`:

```js
const { data: progress } = await getProgressMap();
function statusText(moduleId, lessonId) {
  const row = progress?.[moduleId]?.[lessonId];
  if (!row) return 'NOT STARTED';
  if (row.quiz_attempts > 0) {
    const pct = Math.round(row.quiz_best_score / row.quiz_max_score * 100);
    return `${row.quiz_best_score}/${row.quiz_max_score} (${pct}%)` + (row.status === 'completed' ? '' : ' - TRY AGAIN');
  }
  return row.status === 'completed' ? '100% - COMPLETE' : `${row.progress_percent}% - IN PROGRESS`;
}
```

### `getLastAccessedLesson()`
Returns the most recently opened lesson for a **Continue Learning** button: `data: { module_id, lesson_id, status, progress_percent, … }`, or `null` if the student hasn't started anything.

This works across devices because it reads from the database.

```js
const { data: last } = await getLastAccessedLesson();
if (last) continueBtn.onclick = () => location.href = lessonUrl(last.module_id, last.lesson_id); // your mapping
```

### `getUserStatistics()`
Returns everything a dashboard needs in **one request**:

```json
{
  "display_name": "Alex", "member_since": "2026-11-22T…",
  "total_xp": 175, "badges": ["first-lesson"], "completed_modules": ["module-1"],
  "current_streak": 3, "longest_streak": 5,
  "lessons_completed": 2, "lessons_in_progress": 1, "quizzes_attempted": 1,
  "last_accessed": { "module_id": "module-1", "lesson_id": "1.3", "status": "in_progress", "last_accessed_at": "…" }
}
```

`current_streak` counts consecutive days with learning activity (opening, completing or quizzing), using Denver time. It reads `0` once a day is missed.

### `completeModule(moduleId, { xp }?)` and `awardBadge(badgeId)`
The backend doesn't know which lessons belong to which module; that's your content. So **you** call `completeModule('module-1', { xp: 100 })` once you've confirmed every lesson in it is complete. XP is given once.

`awardBadge('first-lesson')` is idempotent and returns the full badge array. Badge ids follow the same rules as lesson ids.

---

## 5. Recommended usage (and what not to do)

| Moment | Call |
|---|---|
| Any page needing an account | `requireAuth()` |
| Lesson page loads | `saveProgress(m, l)` (once) |
| Student finishes a reading | `updateLessonCompletion(m, l, { xp })` |
| Quiz submitted | `saveQuizAttempt(m, l, {...})` |
| Modules page loads | `getProgressMap()` (one request for everything) |
| Dashboard / header XP | `getUserStatistics()` |

* ❌ Don't call `saveProgress` on every scroll event. Use `createProgressTracker`.
* ❌ Don't store progress in `localStorage`. It won't follow the student to another device.
* ❌ Don't insert `display_name` or other user text with `innerHTML`. Use `textContent`.

## 6. Database tables

You read these through the functions above. Direct writes are blocked; all changes go through the functions.

### `profiles`: one row per student
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | = the Supabase Auth user id |
| `display_name` | text | 1–50 chars. The only column students can edit |
| `created_at` | timestamptz | account creation |
| `last_active_at` | timestamptz | updated on login and on learning activity |
| `updated_at` | timestamptz | automatic |

Email is **not** copied here. Read it from `getSession().data.user.email`.

### `lesson_progress`: one row per student per lesson (unique on `user_id, module_id, lesson_id`)
| Column | Type | Notes |
|---|---|---|
| `module_id`, `lesson_id` | text | your ids |
| `status` | text | `in_progress` or `completed` |
| `progress_percent` | 0–100 | only goes up |
| `quiz_score` / `quiz_max_score` | numeric | latest attempt (null if not a quiz) |
| `quiz_best_score` | numeric | best attempt |
| `quiz_attempts` | integer | |
| `started_at`, `completed_at`, `last_accessed_at`, `updated_at` | timestamptz | |

### `user_stats`: one row per student
| Column | Type | Notes |
|---|---|---|
| `total_xp` | integer | |
| `badges` | text[] | badge ids |
| `completed_modules` | text[] | module ids |
| `current_streak`, `longest_streak` | integer | days |
| `last_activity_date` | date | |

> **"CASH" on the modules page:** the backend tracks `total_xp`. If CASH is meant to be the same number, display `total_xp`. If the game shop needs a separate spendable currency, tell the backend team; it needs a server-side "spend" function so students can't give themselves money.

## 7. Error codes

| code | Meaning |
|---|---|
| `not_authenticated` | Not logged in or session expired → send to `login.html` |
| `invalid_credentials` | Wrong email/password |
| `email_not_confirmed` | Hasn't clicked the verification link |
| `invalid_email`, `weak_password`, `password_mismatch`, `invalid_display_name` | Form validation |
| `invalid_module_id`, `invalid_lesson_id`, `invalid_badge_id` | Bad id format |
| `invalid_xp`, `invalid_score`, `invalid_progress_percent` | Out-of-range numbers |
| `over_email_send_rate_limit`, `over_request_rate_limit` | Too many attempts; wait and retry |
| `network_error` | Offline / server unreachable |

## 8. Testing locally

```bash
cp .env.example .env      # ask the backend team for the two public values
npm install
npm run dev               # http://localhost:3000/login.html
```

Pages must be served over `http://`. Opening the HTML file directly (`file://`) won't work, because ES modules require a server.

## 9. Known limitation

Quiz grading and XP amounts come from the browser, so a technically skilled student could submit a fake score **for their own account**. They can't affect anyone else's data, and XP is capped at 1000 per action and awarded once per lesson. Making scores tamper-proof would mean moving quiz answers and grading to the server; ask the backend team if that's needed.
