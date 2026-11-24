// End-to-end backend tests against a REAL Supabase project.
//   npm install && npm run test:backend
// Needs SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY in .env.
// The secret key is used ONLY here, to create/delete throwaway confirmed test users.
// All behaviour under test runs through the public key exactly like the browser does.

import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const URL = process.env.SUPABASE_URL;
const PUBLIC_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !PUBLIC_KEY || !SECRET_KEY) {
  console.error('Set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY in .env');
  process.exit(1);
}

const admin = createClient(URL, SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

// A "browser": a public-key client with its own storage (like one browser profile).
function browser(storage = new Map()) {
  return createClient(URL, PUBLIC_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: false,
      storage: {
        getItem: (k) => storage.get(k) ?? null,
        setItem: (k, v) => storage.set(k, v),
        removeItem: (k) => storage.delete(k),
      },
    },
  });
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✖ ${name}\n      ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function ok({ data, error }, what) {
  if (error) throw new Error(`${what}: ${error.code || ''} ${error.message}`);
  return data;
}

const run = randomUUID().slice(0, 8);
const PASSWORD = `Test-${randomUUID()}-9a`;
// Signup + reset tests send real emails. Set TEST_EMAIL_BASE=you@gmail.com to receive
// them via plus-addressing (you+test-signup-xxxx@gmail.com); avoids bounces.
const [baseUser, baseDomain] = (process.env.TEST_EMAIL_BASE || 'braingainz-test@example.com').split('@');
const testEmail = (tag) => `${baseUser}+${tag}-${run}@${baseDomain}`.toLowerCase();
const emailA = testEmail('a');
const emailB = testEmail('b');
const emailSignup = testEmail('signup');
const createdIds = [];

async function makeConfirmedUser(email, displayName) {
  const data = ok(await admin.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true, user_metadata: { display_name: displayName },
  }), 'createUser');
  createdIds.push(data.user.id);
  return data.user;
}

try {
  console.log(`\nBackend tests against ${URL} (run ${run})\n`);

  // ---------- 1-2. Registration ----------
  console.log('Registration');
  let signupUserId;
  await test('1. signUp creates an account (unconfirmed, email verification required)', async () => {
    const data = ok(await browser().auth.signUp({
      email: emailSignup, password: PASSWORD, options: { data: { display_name: '  Signup Tester  ' } },
    }), 'signUp');
    assert(data.user?.id, 'no user returned');
    assert(!data.session, 'session returned — email confirmation appears to be DISABLED in Supabase Auth settings');
    signupUserId = data.user.id;
    createdIds.push(signupUserId);
  });
  await test('2. new user appears in auth.users with profile + stats rows (trigger)', async () => {
    const { user } = ok(await admin.auth.admin.getUserById(signupUserId), 'getUserById');
    assert(user.email === emailSignup, 'email mismatch');
    const profile = ok(await admin.from('profiles').select('*').eq('id', signupUserId).single(), 'profile');
    assert(profile.display_name === 'Signup Tester', `display_name not trimmed: "${profile.display_name}"`);
    ok(await admin.from('user_stats').select('*').eq('user_id', signupUserId).single(), 'user_stats');
  });
  await test('   unverified account cannot log in', async () => {
    const { error } = await browser().auth.signInWithPassword({ email: emailSignup, password: PASSWORD });
    assert(error?.code === 'email_not_confirmed', `expected email_not_confirmed, got ${error?.code}`);
  });

  const userA = await makeConfirmedUser(emailA, 'Student A');
  const userB = await makeConfirmedUser(emailB, 'Student B');

  // ---------- 3-7. Login / logout / sessions ----------
  console.log('Authentication');
  const storageA = new Map();
  const a = browser(storageA);
  await test('3. valid login succeeds', async () => {
    const data = ok(await a.auth.signInWithPassword({ email: emailA, password: PASSWORD }), 'signIn');
    assert(data.session?.access_token, 'no session');
  });
  await test('5. invalid login is rejected with invalid_credentials', async () => {
    const { error } = await browser().auth.signInWithPassword({ email: emailA, password: 'wrong-password-1' });
    assert(error?.code === 'invalid_credentials', `got ${error?.code}`);
  });
  await test('7. session persists across a "page refresh" (new client, same storage)', async () => {
    const refreshed = browser(storageA);
    const { user } = ok(await refreshed.auth.getUser(), 'getUser');
    assert(user.id === userA.id, 'session not restored');
  });
  await test('6. password recovery email request is accepted', async () => {
    ok(await browser().auth.resetPasswordForEmail(emailA, { redirectTo: 'http://localhost:3000/reset-password.html' }),
      'resetPasswordForEmail');
  });

  // ---------- 8-10. Progress persistence (the Student A workflow) ----------
  console.log('Progress persistence');
  await test('8. complete two lessons and start a third', async () => {
    ok(await a.rpc('save_progress', { p_module_id: 'module-1', p_lesson_id: '1.1' }), 'save 1.1');
    const r1 = ok(await a.rpc('complete_lesson', { p_module_id: 'module-1', p_lesson_id: '1.1', p_xp: 50 }), 'complete 1.1');
    assert(r1.first_completion && r1.xp_awarded === 50 && r1.total_xp === 50, `bad result ${JSON.stringify(r1)}`);
    const q = ok(await a.rpc('record_quiz_attempt', {
      p_module_id: 'module-1', p_lesson_id: 'quiz-1.1', p_score: 3, p_max_score: 5, p_passed: false, p_xp: 25,
    }), 'quiz fail');
    assert(q.xp_awarded === 0 && q.progress.quiz_attempts === 1, 'failed quiz should not award XP');
    const q2 = ok(await a.rpc('record_quiz_attempt', {
      p_module_id: 'module-1', p_lesson_id: 'quiz-1.1', p_score: 4, p_max_score: 5, p_passed: true, p_xp: 25,
    }), 'quiz pass');
    assert(q2.xp_awarded === 25 && q2.progress.quiz_attempts === 2 && Number(q2.progress.quiz_best_score) === 4,
      `bad quiz result ${JSON.stringify(q2)}`);
    await new Promise((r) => setTimeout(r, 50));
    ok(await a.rpc('save_progress', { p_module_id: 'module-1', p_lesson_id: '1.3', p_progress_percent: 40 }), 'save 1.3');
  });
  await test('   revisiting a lesson updates the same row (no duplicates) and never lowers progress', async () => {
    ok(await a.rpc('save_progress', { p_module_id: 'module-1', p_lesson_id: '1.1', p_progress_percent: 10 }), 'revisit');
    const r = ok(await a.rpc('complete_lesson', { p_module_id: 'module-1', p_lesson_id: '1.1', p_xp: 50 }), 'recomplete');
    assert(!r.first_completion && r.xp_awarded === 0 && r.total_xp === 75, `XP double-awarded: ${JSON.stringify(r)}`);
    const rows = ok(await a.from('lesson_progress').select('*').eq('lesson_id', '1.1'), 'select');
    assert(rows.length === 1, `expected 1 row, got ${rows.length}`);
    assert(rows[0].status === 'completed' && rows[0].progress_percent === 100, 'completed lesson was downgraded');
    // Leave 1.3 as the most recently accessed lesson again.
    await new Promise((r) => setTimeout(r, 50));
    ok(await a.rpc('save_progress', { p_module_id: 'module-1', p_lesson_id: '1.3' }), 'reopen 1.3');
  });
  await test('9. progress survives a refresh (new client, same storage)', async () => {
    const rows = ok(await browser(storageA).from('lesson_progress').select('lesson_id, status'), 'select');
    assert(rows.length === 3, `expected 3 rows, got ${rows.length}`);
  });
  await test('10. a different browser sees the same progress + Continue Learning target', async () => {
    const other = browser();
    ok(await other.auth.signInWithPassword({ email: emailA, password: PASSWORD }), 'signIn other browser');
    const rows = ok(await other.from('lesson_progress').select('*'), 'select');
    assert(rows.filter((r) => r.status === 'completed').length === 2, 'expected 2 completed');
    const last = ok(await other.from('lesson_progress').select('module_id, lesson_id, progress_percent')
      .order('last_accessed_at', { ascending: false }).limit(1).single(), 'last accessed');
    assert(last.lesson_id === '1.3' && last.progress_percent === 40, `wrong last lesson ${JSON.stringify(last)}`);
    const stats = ok(await other.rpc('get_user_statistics'), 'stats');
    assert(stats.total_xp === 75 && stats.lessons_completed === 2 && stats.lessons_in_progress === 1
      && stats.current_streak === 1 && stats.last_accessed.lesson_id === '1.3', `bad stats ${JSON.stringify(stats)}`);
    await other.auth.signOut({ scope: 'local' });   // matches signOut() in js/auth.js
  });
  await test('   modules and badges are awarded once', async () => {
    const m1 = ok(await a.rpc('complete_module', { p_module_id: 'module-1', p_xp: 100 }), 'module');
    const m2 = ok(await a.rpc('complete_module', { p_module_id: 'module-1', p_xp: 100 }), 'module again');
    assert(m1.first_completion && !m2.first_completion && m2.total_xp === 175, 'module XP wrong');
    ok(await a.rpc('award_badge', { p_badge_id: 'first-lesson' }), 'badge');
    const badges = ok(await a.rpc('award_badge', { p_badge_id: 'first-lesson' }), 'badge again');
    assert(badges.length === 1, 'duplicate badge');
  });
  await test('   invalid input is rejected (bad ids, XP over cap, score over max)', async () => {
    const bad = [
      await a.rpc('save_progress', { p_module_id: "x'; drop table--", p_lesson_id: '1' }),
      await a.rpc('complete_lesson', { p_module_id: 'm', p_lesson_id: 'l', p_xp: 999999 }),
      await a.rpc('record_quiz_attempt', { p_module_id: 'm', p_lesson_id: 'q', p_score: 9, p_max_score: 5 }),
      await a.rpc('save_progress', { p_module_id: 'm', p_lesson_id: 'l', p_progress_percent: 150 }),
    ];
    bad.forEach((r, i) => assert(r.error, `case ${i} was accepted`));
  });

  // ---------- 11-12. User isolation / RLS ----------
  console.log('User isolation (RLS)');
  const b = browser();
  ok(await b.auth.signInWithPassword({ email: emailB, password: PASSWORD }), 'signIn B');
  await test('11. user B sees none of user A\'s progress, profile or stats', async () => {
    const p = ok(await b.from('lesson_progress').select('*'), 'progress');
    const p2 = ok(await b.from('lesson_progress').select('*').eq('user_id', userA.id), 'progress by A id');
    const prof = ok(await b.from('profiles').select('*'), 'profiles');
    const st = ok(await b.from('user_stats').select('*'), 'stats');
    assert(p.length === 0 && p2.length === 0, 'B can read A progress!');
    assert(prof.length === 1 && prof[0].id === userB.id, 'B can read other profiles!');
    assert(st.length === 1 && st[0].user_id === userB.id, 'B can read other stats!');
  });
  await test('12a. user B cannot write to user A\'s rows', async () => {
    const upd = await b.from('profiles').update({ display_name: 'hacked' }).eq('id', userA.id).select();
    assert(!upd.error ? upd.data.length === 0 : true, 'B updated A profile!');
    const ins = await b.from('lesson_progress').insert({ user_id: userA.id, module_id: 'm', lesson_id: 'l' });
    assert(ins.error, 'B inserted progress for A!');
    const xp = await b.from('user_stats').update({ total_xp: 999999 }).eq('user_id', userB.id).select();
    assert(xp.error || xp.data.length === 0, 'B set own XP directly (should require RPC)!');
    const del = await b.from('lesson_progress').delete().eq('user_id', userA.id).select();
    assert(del.error || del.data.length === 0, 'B deleted A progress!');
    const aProfile = ok(await admin.from('profiles').select('display_name').eq('id', userA.id).single(), 'check');
    assert(aProfile.display_name === 'Student A', 'A profile was modified!');
  });
  await test('12b. RPC writes always apply to the caller, never another user', async () => {
    ok(await b.rpc('save_progress', { p_module_id: 'module-2', p_lesson_id: '2.1' }), 'B save');
    const aRows = ok(await admin.from('lesson_progress').select('lesson_id').eq('user_id', userA.id), 'A rows');
    assert(!aRows.some((r) => r.lesson_id === '2.1'), 'B write landed on A!');
  });
  await test('12c. signed-out (anonymous) requests get no data and cannot call RPCs', async () => {
    const anon = browser();
    const sel = await anon.from('lesson_progress').select('*');
    assert(sel.error || sel.data.length === 0, 'anonymous read returned data!');
    const r = await anon.rpc('save_progress', { p_module_id: 'm', p_lesson_id: 'l' });
    assert(r.error, 'anonymous RPC succeeded!');
    const s = await anon.rpc('get_user_statistics');
    assert(s.error, 'anonymous stats succeeded!');
  });
  await test('   user can change only their own display name', async () => {
    const r = ok(await b.from('profiles').update({ display_name: 'Student B2' }).eq('id', userB.id).select(), 'rename');
    assert(r.length === 1 && r[0].display_name === 'Student B2', 'rename failed');
  });

  // ---------- 4. Logout ----------
  console.log('Logout');
  await test('4. signOut clears the session and revokes it on the server', async () => {
    const { data: before } = await a.auth.getSession();
    const refreshToken = before.session.refresh_token;
    ok(await a.auth.signOut({ scope: 'local' }), 'signOut');
    const { data } = await a.auth.getSession();
    assert(!data.session, 'session still present');
    const r = await a.rpc('get_user_statistics');
    assert(r.error, 'RPC still works after logout');
    // A stolen refresh token must not be reusable after logout.
    const reuse = await browser().auth.refreshSession({ refresh_token: refreshToken });
    assert(reuse.error, 'refresh token still valid after logout!');
  });

  // ---------- Account deletion ----------
  console.log('Account deletion');
  await test('   delete_my_account removes the user and all their data', async () => {
    ok(await b.rpc('delete_my_account'), 'delete');
    const rows = ok(await admin.from('lesson_progress').select('id').eq('user_id', userB.id), 'progress');
    const prof = ok(await admin.from('profiles').select('id').eq('id', userB.id), 'profile');
    assert(rows.length === 0 && prof.length === 0, 'data not cascaded');
    const { error } = await admin.auth.admin.getUserById(userB.id);
    assert(error, 'auth user still exists');
  });
} finally {
  for (const id of createdIds) await admin.auth.admin.deleteUser(id).catch(() => {});
  console.log(`\n${passed} passed, ${failed} failed (test users cleaned up)\n`);
  process.exit(failed ? 1 : 0);
}
