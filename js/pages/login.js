// Connects login.html to the auth API. No visual changes beyond status messages.
import { signIn, signUp, signOut, getSession, resetPassword, resendVerification, onAuthChange } from '../auth.js';

const $ = (id) => document.getElementById(id);

function show(el, text, kind = '') {
  el.textContent = text;
  el.className = `formMessage ${kind}`.trim();
}

async function busy(button, fn) {
  button.disabled = true;
  try { return await fn(); } finally { button.disabled = false; }
}

// Only allow redirects back to pages on this site.
function nextPage() {
  const next = new URLSearchParams(window.location.search).get('next');
  return next && next.startsWith('/') && !next.startsWith('//') ? next : 'modules.html';
}

async function renderSignedIn() {
  const { data } = await getSession();
  const panel = $('signedInPanel');
  if (data.user) {
    $('signedInEmail').textContent = data.user.email;
    panel.hidden = false;
  } else {
    panel.hidden = true;
  }
}

// ---- Login ----
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('loginMessage');
  const button = e.submitter || $('loginForm').querySelector('button[type=submit]');
  show(msg, 'Logging in…');
  const email = $('loginEmail').value;
  const { error } = await busy(button, () => signIn({ email, password: $('loginPassword').value }));
  if (error) {
    show(msg, error.message, 'error');
    if (error.code === 'email_not_confirmed') {
      const resend = document.createElement('button');
      resend.type = 'button';
      resend.className = 'linkButton';
      resend.textContent = ' Resend verification email';
      resend.onclick = async () => {
        const r = await resendVerification(email);
        show(msg, r.error ? r.error.message : 'Verification email sent. Check your inbox.', r.error ? 'error' : 'success');
      };
      msg.append(resend);
    }
    return;
  }
  show(msg, 'Logged in! Redirecting…', 'success');
  window.location.href = nextPage();
});

// ---- Forgot password (uses the email typed in the login box) ----
$('forgotPasswordButton').addEventListener('click', async (e) => {
  const msg = $('loginMessage');
  const email = $('loginEmail').value.trim();
  if (!email) {
    show(msg, 'Type your email in the box above, then click "Forgot password?" again.', 'error');
    $('loginEmail').focus();
    return;
  }
  const { error } = await busy(e.currentTarget, () => resetPassword(email));
  show(msg, error ? error.message : 'If an account exists for that email, a password reset link is on its way.',
       error ? 'error' : 'success');
});

// ---- Sign up ----
$('signupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('signupMessage');
  const button = e.submitter || $('signupForm').querySelector('button[type=submit]');
  show(msg, 'Creating your account…');
  const { data, error } = await busy(button, () => signUp({
    displayName: $('signupName').value,
    email: $('signupEmail').value,
    password: $('signupPassword').value,
    confirmPassword: $('signupConfirmPassword').value,
  }));
  if (error) return show(msg, error.message, 'error');
  $('signupForm').reset();
  show(msg, data.needsEmailVerification
    ? 'Almost done! Check your email and click the verification link, then log in above.'
    : 'Account created! You can log in above.', 'success');
});

// ---- Log out ----
$('logoutButton').addEventListener('click', async () => {
  await signOut();
  show($('loginMessage'), 'You have been logged out.', 'success');
});

// ---- Arriving from the email-verification link ----
onAuthChange((event) => {
  if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'INITIAL_SESSION') renderSignedIn();
});
const hashParams = new URLSearchParams(window.location.hash.slice(1));
if (hashParams.get('error')) {
  // e.g. an expired or already-used verification link
  show($('loginMessage'), 'That link is invalid or has expired. Log in, or use "Resend verification email".', 'error');
} else if (new URLSearchParams(window.location.search).get('verified')) {
  show($('loginMessage'), 'Email verified! You are now logged in.', 'success');
}
