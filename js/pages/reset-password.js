// Handles the link from the "Reset your password" email.
// Supabase signs the student in with a short-lived recovery session from the URL,
// then they choose a new password here.
import { updatePassword, getSession, onAuthChange } from '../auth.js';

const form = document.getElementById('resetForm');
const msg = document.getElementById('resetMessage');
const button = form.querySelector('button[type=submit]');

function show(text, kind = '') {
  msg.textContent = text;
  msg.className = `formMessage ${kind}`.trim();
}

function ready() {
  button.disabled = false;
  show('Choose a new password.');
}

// Expired / already-used links come back with an error in the URL hash.
const hash = new URLSearchParams(window.location.hash.slice(1));
if (hash.get('error')) {
  show('This reset link is invalid or has expired. Go to the login page and click "Forgot password?" again.', 'error');
} else {
  onAuthChange((event) => { if (event === 'PASSWORD_RECOVERY') ready(); });
  // If the recovery session was already processed (e.g. page refresh), allow the reset.
  setTimeout(async () => {
    if (!button.disabled) return;
    const { data } = await getSession();
    if (data.session) ready();
    else show('This reset link is invalid or has expired. Go to the login page and click "Forgot password?" again.', 'error');
  }, 1500);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  button.disabled = true;
  const { error } = await updatePassword(
    document.getElementById('newPassword').value,
    document.getElementById('confirmNewPassword').value,
  );
  if (error) {
    button.disabled = false;
    return show(error.message, 'error');
  }
  form.reset();
  show('Password updated! Redirecting to your modules…', 'success');
  setTimeout(() => { window.location.href = 'modules.html'; }, 1500);
});
