// Shared Supabase client. Every other module imports `supabase` from here,
// so there is exactly one client (and one session) per page.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.79.0/+esm';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,      // stay signed in across page loads / browser restarts
    autoRefreshToken: true,    // silently refresh the short-lived access token
    detectSessionInUrl: true,  // pick up sessions from email-verification / reset links
    // 'implicit' lets verification and reset links work even when opened on a different
    // device or browser than the one that requested them (common for students).
    flowType: 'implicit',
  },
});

// Turns Supabase / Postgres errors into a stable { code, message } shape
// with student-friendly messages.
const FRIENDLY = {
  invalid_credentials: 'Incorrect email or password.',
  email_not_confirmed: 'Please verify your email first — check your inbox for the link.',
  user_already_exists: 'An account with this email already exists. Try logging in.',
  email_exists: 'An account with this email already exists. Try logging in.',
  weak_password: 'Password is too weak. Use at least 8 characters with letters and numbers.',
  over_email_send_rate_limit: 'Too many emails sent. Please wait a few minutes and try again.',
  over_request_rate_limit: 'Too many attempts. Please wait a minute and try again.',
  same_password: 'Your new password must be different from the old one.',
  session_not_found: 'Your session has expired. Please log in again.',
  not_authenticated: 'Please log in to continue.',
  network_error: 'Could not reach the server. Check your internet connection.',
};

export function normalizeError(err) {
  if (!err) return null;
  let code = err.code || err.error_code || 'unknown_error';
  // Postgres errors raised by our RPC functions carry the code in the message.
  if (/^(not_authenticated|invalid_[a-z_]+)$/.test(err.message || '')) code = err.message;
  if (err.name === 'AuthRetryableFetchError' || /Failed to fetch|NetworkError/i.test(err.message || '')) {
    code = 'network_error';
  }
  const message = FRIENDLY[code] || err.hint || err.message || 'Something went wrong. Please try again.';
  return { code, message };
}

export function makeError(code, message) {
  return { code, message };
}
