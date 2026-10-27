/**
 * client/js/pages/admin-changes.js
 *
 * Admin Schedule Change history browser (spec sections 33-37, 43: an
 * immutable, never-updated or hard-deleted audit trail of every one-time
 * and permanent change applied to a class).
 *
 * REAL API calls only:
 *   GET /api/subjects                                 (the subject picker)
 *   GET /api/schedule/changes?subjectId=...            -> { changes }
 *
 * SUBJECT FILTER IS REQUIRED, NOT OPTIONAL: ScheduleService.getChangeHistory
 * throws AppError.badRequest('sessionId or subjectId is required') when
 * neither is supplied — there is no "list every change across every
 * subject" endpoint, for ANY role including Admin
 * (server/services/ReadScopeService.js's getChangeHistoryForActor calls
 * through to the same function with the same requirement once allowed
 * subjects resolve to null/unrestricted for Admin). So this page cannot
 * open with a populated list; it prompts for a subject first, exactly like
 * the Admin dashboard already explains for the deliberately-omitted
 * "Active Schedule Changes" stat.
 *
 * NO NAME FOR `changedBy`: ScheduleChange only stores a raw User
 * ObjectId (server/models/ScheduleChange.js), with no populate/join
 * anywhere in ScheduleService.getChangeHistory. There is no endpoint that
 * resolves an arbitrary User _id back to a display name (GET /api/doctors,
 * /api/tas, /api/students, /api/leaders each return their OWN profile
 * collection, not a generic User lookup), so the actor is shown as their
 * recorded role plus the raw id, rather than guessed at.
 */
import { initAppShell } from '../app-shell.js';
import { apiClient, ApiError } from '../api-client.js';
import { showAlert, clearAlert } from '../ui.js';
import { badge, buildEmptyState, buildSkeletonCard, formatDateTime } from '../admin-widgets.js';

const ROLE_LABELS = { STUDENT: 'Student', DOCTOR: 'Doctor', TA: 'TA', LEADER: 'Leader', ADMIN: 'Admin' };

function messageForError(err, fallback) {
  if (err instanceof ApiError) {
    if (err.status === 0) return 'Could not reach the server. Check your connection and try again.';
    if (err.isMaintenance) return err.message || 'The system is temporarily under maintenance. Please try again shortly.';
    return err.message || fallback;
  }
  return fallback;
}

function diffFields(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const lines = [];
  for (const key of keys) {
    const beforeVal = before ? before[key] : undefined;
    const afterVal = after ? after[key] : undefined;
    if (JSON.stringify(beforeVal) !== JSON.stringify(afterVal)) {
      lines.push(`${key}: ${beforeVal ?? '—'} → ${afterVal ?? '—'}`);
    }
  }
  return lines;
}

function buildChangeCard(change) {
  const card = document.createElement('div');
  card.className = 'card';
  card.style.marginBottom = 'var(--space-3)';

  const header = document.createElement('div');
  header.className = 'class-card__header';
  const title = document.createElement('div');
  title.innerHTML = `<strong>${change.isPermanent ? 'Permanent change' : 'One-time change'}</strong>`;
  const typeBadges = document.createElement('span');
  typeBadges.style.marginLeft = 'var(--space-2)';
  for (const t of change.changeTypes || []) typeBadges.appendChild(badge(t, 'info'));
  title.appendChild(typeBadges);
  header.appendChild(title);
  header.appendChild(badge(formatDateTime(change.createdAt), 'info'));
  card.appendChild(header);

  const meta = document.createElement('p');
  meta.className = 'form-hint';
  meta.textContent = `By ${ROLE_LABELS[change.changedByRole] || change.changedByRole} (user ${change.changedBy})`;
  card.appendChild(meta);

  const diffLines = diffFields(change.before, change.after);
  if (diffLines.length > 0) {
    const list = document.createElement('ul');
    list.style.marginTop = 'var(--space-2)';
    for (const line of diffLines) {
      const li = document.createElement('li');
      li.textContent = line;
      list.appendChild(li);
    }
    card.appendChild(list);
  }

  if (change.reason) {
    const reason = document.createElement('p');
    reason.style.marginTop = 'var(--space-2)';
    reason.innerHTML = `<strong>Reason:</strong> ${change.reason}`;
    card.appendChild(reason);
  }

  return card;
}

function setListLoading() {
  const c = document.getElementById('list-container');
  c.innerHTML = '';
  c.appendChild(buildSkeletonCard());
}

function setListError(err, onRetry) {
  const c = document.getElementById('list-container');
  const alertContainer = document.getElementById('list-alert');
  c.innerHTML = '';
  clearAlert(alertContainer);
  showAlert(alertContainer, messageForError(err, 'Could not load schedule changes.'), 'error');
  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'btn btn--secondary';
  retryBtn.textContent = 'Retry';
  retryBtn.addEventListener('click', onRetry);
  alertContainer.appendChild(retryBtn);
}

function renderPrompt() {
  clearAlert(document.getElementById('list-alert'));
  const c = document.getElementById('list-container');
  c.innerHTML = '';
  c.appendChild(buildEmptyState('Select a subject', 'Choose a subject above to view its schedule change history.'));
}

function renderList(changes) {
  clearAlert(document.getElementById('list-alert'));
  const c = document.getElementById('list-container');
  c.innerHTML = '';
  if (changes.length === 0) {
    c.appendChild(buildEmptyState('No changes found', 'This subject has no recorded schedule changes.'));
    return;
  }
  for (const change of changes) c.appendChild(buildChangeCard(change));
}

async function loadChanges() {
  const subjectId = document.getElementById('subject-filter').value;
  if (!subjectId) {
    renderPrompt();
    return;
  }
  setListLoading();
  try {
    const changes = await apiClient.get(`/api/schedule/changes?${new URLSearchParams({ subjectId })}`);
    renderList(changes);
  } catch (err) {
    setListError(err, loadChanges);
  }
}

async function populateSubjects() {
  const select = document.getElementById('subject-filter');
  try {
    const subjects = await apiClient.get('/api/subjects');
    for (const s of subjects) {
      const opt = document.createElement('option');
      opt.value = s._id;
      opt.textContent = `${s.name} (${s.code})`;
      select.appendChild(opt);
    }
  } catch (err) {
    const alertContainer = document.getElementById('shell-page-alert');
    if (alertContainer) showAlert(alertContainer, messageForError(err, 'Could not load the subject list.'), 'error');
  }
}

(async function initAdminChangesPage() {
  const user = await initAppShell({ requiredRole: 'ADMIN' });
  if (!user) return;

  await populateSubjects();
  document.getElementById('subject-filter')?.addEventListener('change', loadChanges);
  renderPrompt();
})();
