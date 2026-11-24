// Authentication API for the frontend.
// Every function returns { data, error }. `error` is null on success, otherwise
// { code, message } where `message` is safe to show to students.
import { supabase, normalizeError, makeError } from './supabase-client.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

// Absolute URL of a page on this site (works locally and on Vercel).
function pageUrl(path) {
  return new URL(path, window.location.origin + '/').toString();
}

function validatePassword(password, confirmPassword) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    return makeError('weak_password', `Password must be at least ${MIN_PASSWORD} characters.`);
  }
  if (password.length > 72) return makeError('weak_password', 'Password must be 72 characters or fewer.');
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return makeError('weak_password', 'Password must include at least one letter and one number.');
  }
  if (confirmPassword !== undefined && password !== confirmPassword) {
    return makeError('password_mismatch', 'Passwords do not match.');
  }
  return null;
}

/**
 * Create an account. Supabase emails a verification link; the student must click
 * it before they can log in.
 * @returns {{ data: { needsEmailVerification: boolean } | null, error }}
 */
export async function signUp({ email, password, confirmPassword, displayName }) {
  email = (email || '').trim().toLowerCase();
  displayName = (displayName || '').trim();

  if (!EMAIL_RE.test(email)) return { data: null, error: makeError('invalid_email', 'Enter a valid email address.') };
  if (displayName.length < 1 || displayName.length > 50) {
    return { data: null, error: makeError('invalid_display_name', 'Display name must be 1–50 characters.') };
  }
  const pwError = validatePassword(password, confirmPassword);
  if (pwError) return { data: null, error: pwError };

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { display_name: displayName },
      emailRedirectTo: pageUrl('login.html?verified=1'),
    },
  });
  if (error) return { data: null, error: normalizeError(error) };

  // With email confirmation on, no session is returned until the link is clicked.
  // (For privacy, Supabase returns the same response if the email is already registered.)
  return { data: { needsEmailVerification: !data.session }, error: null };
}

/** Log in with email + password. Session persists across reloads automatically. */
export async function signIn({ email, password }) {
  email = (email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { data: null, error: makeError('invalid_email', 'Enter a valid email address.') };
  if (!password) return { data: null, error: makeError('missing_password', 'Enter your password.') };

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { data: null, error: normalizeError(error) };

  supabase.rpc('touch_last_active').then(() => {}, () => {}); // best-effort, non-blocking
  return { data: { user: data.user, session: data.session }, error: null };
}

/**
 * Log out. By default only this device/browser is signed out (its session is revoked
 * on the server). Pass { everywhere: true } to sign out on all devices.
 */
export async function signOut({ everywhere = false } = {}) {
  const { error } = await supabase.auth.signOut({ scope: everywhere ? 'global' : 'local' });
  // A missing/expired session still means the user is signed out locally.
  if (error && error.name !== 'AuthSessionMissingError') return { data: null, error: normalizeError(error) };
  return { data: null, error: null };
}

/**
 * Current session from local storage (fast, no network). Use for UI decisions
 * like showing "Log in" vs "Log out". Returns { data: { session, user } }.
 */
export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) return { data: { session: null, user: null }, error: normalizeError(error) };
  return { data: { session: data.session, user: data.session?.user ?? null }, error: null };
}

/** Verified current user (checks with the server). Use before sensitive actions. */
export async function getUser() {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return { data: { user: null }, error: error ? normalizeError(error) : null };
  return { data: { user: data.user }, error: null };
}

/**
 * Page guard: redirects to the login page if nobody is signed in.
 * Call at the top of any page that requires an account. (This is a UX guard;
 * the real protection is Row Level Security in the database.)
 * @returns the user, or null (after starting the redirect)
 */
export async function requireAuth(loginPage = 'login.html') {
  const { data } = await getUser();
  if (!data.user) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.replace(`${loginPage}?next=${next}`);
    return null;
  }
  return data.user;
}

/** Send a password-reset email. Always reports success to avoid revealing which emails exist. */
export async function resetPassword(email) {
  email = (email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { data: null, error: makeError('invalid_email', 'Enter a valid email address.') };
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: pageUrl('reset-password.html'),
  });
  if (error && error.code !== 'user_not_found') return { data: null, error: normalizeError(error) };
  return { data: { sent: true }, error: null };
}

/** Set a new password. Used on reset-password.html after clicking the email link. */
export async function updatePassword(newPassword, confirmPassword) {
  const pwError = validatePassword(newPassword, confirmPassword);
  if (pwError) return { data: null, error: pwError };
  const { data, error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) return { data: null, error: normalizeError(error) };
  return { data: { user: data.user }, error: null };
}

/** Re-send the verification email for an unconfirmed account. */
export async function resendVerification(email) {
  email = (email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { data: null, error: makeError('invalid_email', 'Enter a valid email address.') };
  const { error } = await supabase.auth.resend({
    type: 'signup',
    email,
    options: { emailRedirectTo: pageUrl('login.html?verified=1') },
  });
  return { data: error ? null : { sent: true }, error: normalizeError(error) };
}

/**
 * Subscribe to auth changes. Events: 'SIGNED_IN', 'SIGNED_OUT', 'TOKEN_REFRESHED',
 * 'USER_UPDATED', 'PASSWORD_RECOVERY', 'INITIAL_SESSION'.
 * @returns a function that unsubscribes.
 */
export function onAuthChange(callback) {
  const { data } = supabase.auth.onAuthStateChange((event, session) => callback(event, session));
  return () => data.subscription.unsubscribe();
}

/** The signed-in student's profile row: { id, display_name, created_at, last_active_at }. */
export async function getProfile() {
  const { data: { user } } = await getSession();
  if (!user) return { data: null, error: makeError('not_authenticated', 'Please log in to continue.') };
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, created_at, last_active_at')
    .eq('id', user.id)
    .single();
  return { data: error ? null : { ...data, email: user.email }, error: normalizeError(error) };
}

/** Change display name (1–50 characters). */
export async function updateDisplayName(displayName) {
  displayName = (displayName || '').trim();
  if (displayName.length < 1 || displayName.length > 50) {
    return { data: null, error: makeError('invalid_display_name', 'Display name must be 1–50 characters.') };
  }
  const { data: { user } } = await getSession();
  if (!user) return { data: null, error: makeError('not_authenticated', 'Please log in to continue.') };
  const { data, error } = await supabase
    .from('profiles')
    .update({ display_name: displayName })
    .eq('id', user.id)
    .select('id, display_name')
    .single();
  return { data: error ? null : data, error: normalizeError(error) };
}

/** Permanently delete the signed-in account and all its progress. */
export async function deleteAccount() {
  const { error } = await supabase.rpc('delete_my_account');
  if (error) return { data: null, error: normalizeError(error) };
  await supabase.auth.signOut({ scope: 'local' });
  return { data: { deleted: true }, error: null };
}
