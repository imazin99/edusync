/**
 * client/js/pages/student-profile.js
 *
 * Student Profile page (spec sections 7-8, 11, 63-66). Shows the
 * student's own account details and handles the two narrow,
 * Student-only account actions the backend actually supports: creating
 * or removing an optional login password, and submitting a group-change
 * request.
 *
 * REAL API calls only:
 *   GET    /api/auth/me                 (already fetched by initAppShell;
 *                                         re-fetched after a mutation)
 *   POST   /api/auth/password           { password }  — create
 *   DELETE /api/auth/password           — remove
 *   POST   /api/requests/group-change   { requestedGroup }
 *
 * WHY THERE IS NO "CHANGE PASSWORD" FORM: spec section 7 is explicit —
 * "Student currently should NOT have a 'Change Password' option inside
 * Profile." This is also exactly what the backend supports: AuthService
 * only exposes createPassword (fails with PASSWORD_ALREADY_SET if one
 * already exists) and removePassword (fails with PASSWORD_NOT_SET if
 * none exists) — there is no "update an existing password" endpoint at
 * all, so a change-password form could never actually be wired to
 * anything real. Create/remove are a DIFFERENT, explicitly supported
 * pair of actions (section 7: "The student can later create a
 * password... can also remove their password and return to code-only
 * login"), and this project's own history already earmarked this exact
 * page for them — see client/js/pages/login.js's file header ("the
 * 'create a password' reminder... belongs on the student
 * dashboard/profile") and student-dashboard.js's renderPasswordReminder,
 * whose reminder text already links here.
 *
 * WHY "FORGOT PASSWORD" IS NOT HERE: POST /api/auth/forgot-password is
 * an UNAUTHENTICATED endpoint (no requireAuth in server/routes/
 * auth.routes.js) for someone who cannot log in at all — it belongs on
 * the Login page, not a page only a signed-in student can reach. Adding
 * it there is out of scope for this phase ("Student Profile Page"); see
 * the phase report.
 *
 * WHY A GROUP-CHANGE REQUEST FORM IS HERE: spec section 8 lists "View
 * profile" and "Request Group change" as adjacent Student features, spec
 * section 65 describes the workflow, and POST /api/requests/group-change
 * is a real, Student-accessible, already-implemented endpoint
 * (server/routes/requests.routes.js) with no frontend route of its own
 * (client/js/nav-config.js has no separate "/student/group-change" entry)
 * — Profile, which already displays the current Group, is the only place
 * this real capability can reasonably live. This NEVER edits the Group
 * field directly; it only creates a pending Request for Admin review,
 * exactly like spec section 65 describes, so it does not violate "Group
 * must not become student-editable".
 *
 * KNOWN, REPORTED LIMITATION (request status): there is no Student-facing
 * GET endpoint for a student's own Request history (server/routes/
 * requests.routes.js exposes only POST /group-change — listing/reviewing
 * requests is Admin-only, server/routes/admin*.routes.js). After
 * submitting a group-change request, this page has no way to show
 * whether it is still pending, approved, or rejected — approving it also
 * dispatches no notification (server/services/RequestService.js's
 * review() only writes the Request and, if approved, the Student's
 * group — it never calls NotificationService). The only observable
 * signal is the Group value itself changing the next time this page (or
 * GET /api/auth/me) is loaded, after an Admin has approved it. This is
 * disclosed in the page's own copy rather than inventing a status
 * tracker the API cannot back.
 *
 * KNOWN, REPORTED LIMITATION (personal task completion): spec section 11
 * lists "Personal task completion information where useful" as a Profile
 * field. As already documented in client/js/task-widgets.js and
 * client/js/pages/student-tasks.js (Tasks page phase), there is no GET
 * endpoint that returns a student's own TaskCompletion rows — only
 * POST/DELETE /api/tasks/:id/complete exist. This page reads the exact
 * same sessionStorage cache student-tasks.js already writes
 * (academic_schedule.task_completions.<userId>, the same "UI
 * convenience, never authoritative" pattern established by
 * auth-state.js) to show a count of tasks marked done THIS BROWSER
 * SESSION — real data the student just generated, clearly labeled as
 * session-local, never presented as a full history.
 *
 * WHY "Account Status" SHOWS ONLY Password status AND Last Login:
 * server/controllers/auth.controller.js's serializeUser() is the
 * complete, exact shape GET /api/auth/me returns — {id, username, role,
 * hasPassword, lastLoginAt, student:{studentCode, fullName, group}}.
 * Although User.isActive and Student.isActive exist in the Mongoose
 * schemas, serializeUser() never includes either, so no "Account active"
 * indicator is shown — displaying one would mean inventing a value the
 * API does not actually return. `username` is omitted from display as
 * its own field since, for a Student, it is always set equal to
 * studentCode (server/models/User.js's own comment) and is already shown
 * as Student Code above — showing it twice would be redundant, not
 * additional information.
 */
import { initAppShell } from '../app-shell.js';
import { authState } from '../auth-state.js';
import { apiClient, ApiError } from '../api-client.js';
import { showAlert, clearAlert, setButtonLoading, setFieldError } from '../ui.js';

const MIN_PASSWORD_LENGTH = 8; // matches server/services/AuthService.js's MIN_PASSWORD_LENGTH — client-side check only; the server remains authoritative.
const GROUP_LABELS = { G1: 'Group 1', G2: 'Group 2' };

let currentUser = null;

function completionsStorageKey(userId) {
  return `academic_schedule.task_completions.${userId}`;
}

function readCompletedCount(userId) {
  try {
    const raw = sessionStorage.getItem(completionsStorageKey(userId));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

function formatLastLogin(value) {
  if (!value) return 'No previous login recorded';
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function detailRow(term, description) {
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  if (description instanceof Node) dd.appendChild(description);
  else dd.textContent = description;
  return [dt, dd];
}

function badge(text, variant) {
  const span = document.createElement('span');
  span.className = `badge${variant ? ` badge--${variant}` : ''}`;
  span.textContent = text;
  return span;
}

function messageForError(err, fallback) {
  if (err instanceof ApiError) {
    if (err.status === 0) return 'Could not reach the server. Check your connection and try again.';
    if (err.isMaintenance) {
      return err.message || 'The system is temporarily under maintenance. Please try again shortly.';
    }
    return err.message || fallback;
  }
  return fallback;
}

// ---------------------------------------------------------------------
// Account details / status (read-only)
// ---------------------------------------------------------------------

function renderAccountDetails(user) {
  const list = document.getElementById('profile-details-list');
  if (!list) return;
  list.innerHTML = '';
  const student = user.student || {};
  list.append(...detailRow('Full Name', student.fullName || '—'));
  list.append(...detailRow('Student Code', student.studentCode || '—'));
  list.append(...detailRow('Group', GROUP_LABELS[student.group] || student.group || '—'));
}

function renderAccountStatus(user) {
  const list = document.getElementById('profile-status-list');
  if (!list) return;
  list.innerHTML = '';
  list.append(
    ...detailRow(
      'Password status',
      badge(user.hasPassword ? 'Password set' : 'No password set', user.hasPassword ? 'success' : 'warning')
    )
  );
  list.append(...detailRow('Last login', formatLastLogin(user.lastLoginAt)));
}

// ---------------------------------------------------------------------
// Password create / remove
// ---------------------------------------------------------------------

function renderPasswordSection(user) {
  const container = document.getElementById('password-section-content');
  const alertContainer = document.getElementById('password-alert');
  if (!container) return;
  clearAlert(alertContainer);
  container.innerHTML = '';

  if (user.hasPassword) {
    const p = document.createElement('p');
    p.className = 'form-hint';
    p.textContent = 'A password is set for this account. You can remove it to return to Student Code-only login.';
    container.appendChild(p);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn btn--secondary';
    removeBtn.textContent = 'Remove Password';
    removeBtn.addEventListener('click', () => handleRemovePassword(removeBtn));
    container.appendChild(removeBtn);
    return;
  }

  const p = document.createElement('p');
  p.className = 'form-hint';
  p.textContent = 'Your account has no password set — you sign in with your Student Code only. Set a password below to add an extra way to sign in.';
  container.appendChild(p);

  const form = document.createElement('form');
  form.id = 'create-password-form';
  form.noValidate = true;

  const field = document.createElement('div');
  field.className = 'form-field';
  const label = document.createElement('label');
  label.className = 'form-label';
  label.htmlFor = 'new-password';
  label.textContent = 'New password';
  const input = document.createElement('input');
  input.className = 'form-input';
  input.type = 'password';
  input.id = 'new-password';
  input.name = 'password';
  input.autocomplete = 'new-password';
  const hint = document.createElement('p');
  hint.className = 'form-hint';
  hint.id = 'new-password-hint';
  hint.textContent = `At least ${MIN_PASSWORD_LENGTH} characters.`;
  input.setAttribute('aria-describedby', 'new-password-hint');
  field.append(label, input, hint);
  form.appendChild(field);

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'btn btn--primary';
  submitBtn.textContent = 'Create Password';
  form.appendChild(submitBtn);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    handleCreatePassword(input, submitBtn);
  });

  container.appendChild(form);
}

async function handleCreatePassword(input, submitBtn) {
  const alertContainer = document.getElementById('password-alert');
  clearAlert(alertContainer);
  setFieldError(input, '');

  const password = input.value;
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    setFieldError(input, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    input.focus();
    return;
  }

  setButtonLoading(submitBtn, true, 'Creating…');
  try {
    await apiClient.post('/api/auth/password', { password });
    const refreshed = await authState.fetchCurrentUser();
    currentUser = refreshed;
    renderAccountStatus(refreshed);
    renderPasswordSection(refreshed);
    showAlert(document.getElementById('password-alert'), 'Password created.', 'success');
  } catch (err) {
    setButtonLoading(submitBtn, false);
    showAlert(alertContainer, messageForError(err, 'Could not create a password — please try again.'), 'error');
  }
}

async function handleRemovePassword(removeBtn) {
  const alertContainer = document.getElementById('password-alert');
  clearAlert(alertContainer);
  setButtonLoading(removeBtn, true, 'Removing…');
  try {
    await apiClient.delete('/api/auth/password');
    const refreshed = await authState.fetchCurrentUser();
    currentUser = refreshed;
    renderAccountStatus(refreshed);
    renderPasswordSection(refreshed);
    showAlert(document.getElementById('password-alert'), 'Password removed. You can now sign in with your Student Code only.', 'success');
  } catch (err) {
    setButtonLoading(removeBtn, false);
    showAlert(alertContainer, messageForError(err, 'Could not remove the password — please try again.'), 'error');
  }
}

// ---------------------------------------------------------------------
// Group change request
// ---------------------------------------------------------------------

function wireGroupChangeForm() {
  const form = document.getElementById('group-change-form');
  const select = document.getElementById('requested-group');
  const submitBtn = document.getElementById('group-change-submit');
  const alertContainer = document.getElementById('group-change-alert');
  if (!form) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearAlert(alertContainer);
    setButtonLoading(submitBtn, true, 'Submitting…');
    try {
      await apiClient.post('/api/requests/group-change', { requestedGroup: select.value });
      showAlert(
        alertContainer,
        'Your group change request has been submitted for Admin review.',
        'success'
      );
    } catch (err) {
      showAlert(alertContainer, messageForError(err, 'Could not submit the request — please try again.'), 'error');
    } finally {
      setButtonLoading(submitBtn, false);
    }
  });
}

// ---------------------------------------------------------------------
// Task completion (session-local only — see file header)
// ---------------------------------------------------------------------

function renderTaskCompletionSummary(user) {
  const el = document.getElementById('task-completion-summary');
  if (!el) return;
  const count = readCompletedCount(user.id);
  el.innerHTML = '';
  const text = document.createElement('span');
  text.textContent =
    count > 0
      ? `You've marked ${count} task${count === 1 ? '' : 's'} as done in this browser session. `
      : "No tasks marked done in this browser session yet. ";
  const link = document.createElement('a');
  link.href = '/pages/student/tasks.html';
  link.textContent = 'View Tasks';
  el.append(text, link);
}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

(async function initStudentProfilePage() {
  const user = await initAppShell({ requiredRole: 'STUDENT' });
  if (!user) return; // initAppShell already redirected (logged out / wrong role / fatal error shown)

  currentUser = user;
  renderAccountDetails(user);
  renderAccountStatus(user);
  renderPasswordSection(user);
  renderTaskCompletionSummary(user);
  wireGroupChangeForm();
})();
