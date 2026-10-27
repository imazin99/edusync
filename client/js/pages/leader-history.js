/**
 * client/js/pages/leader-history.js
 *
 * Leader History page (spec: schedule-change history — nav-config.js's
 * "LEADER" entry labeled "History", previously 404'ing because no page
 * existed at /pages/leader/history.html; see the bug-fix report for the
 * full root-cause trace). Shows the full chronological record of
 * schedule changes across every subject — read-only, matching
 * student-changes.js's "nothing here can be edited" page, which this
 * file deliberately mirrors.
 *
 * REAL API calls only:
 *   GET /api/subjects                       (id -> name lookup, and the
 *                                             set of subjectIds to query)
 *   GET /api/rooms                          (id -> building/floor/room lookup)
 *   GET /api/schedule/changes?subjectId=X   (one call per subject)
 *
 * WHY ONE CALL PER SUBJECT: GET /api/schedule/changes always requires
 * either sessionId or subjectId (ScheduleService.getChangeHistory throws
 * 400 with neither, for every role — see student-changes.js's file
 * header for the full explanation). LEADER is unrestricted in
 * server/services/ReadScopeService.js (allowedSubjectIds returns null,
 * same as STUDENT and ADMIN), so looping over every subject in the
 * system and merging is the same, already-established pattern Student's
 * page uses — not a Leader-specific workaround.
 *
 * WHY NO EDITING CONTROLS: this page only ever lists history — a
 * Leader's one-time schedule changes are made from the Schedule page's
 * existing "Propose Change" action (leader-schedule.js), not from here,
 * matching the Student/Admin Changes pages' precedent of being read-only.
 */
import { initAppShell } from '../app-shell.js';
import { apiClient, ApiError } from '../api-client.js';
import { showAlert, clearAlert } from '../ui.js';
import { buildSkeletonCard, buildEmptyState, buildChangeHistoryRow } from '../schedule-widgets.js';

const SKELETON_COUNT = 3;

let subjectsById = new Map();
let roomsById = new Map();
let allChanges = [];

function messageForError(err) {
  if (err instanceof ApiError) {
    if (err.status === 0) return 'Could not reach the server. Check your connection and try again.';
    if (err.isMaintenance) {
      return err.message || 'The system is temporarily under maintenance. Please try again shortly.';
    }
    return err.message || 'Could not load the change history.';
  }
  return 'Could not load the change history.';
}

function setLoading() {
  const list = document.getElementById('changes-list');
  if (!list) return;
  list.innerHTML = '';
  for (let i = 0; i < SKELETON_COUNT; i += 1) list.appendChild(buildSkeletonCard());
}

function setError(err, onRetry) {
  const list = document.getElementById('changes-list');
  const alertContainer = document.getElementById('changes-alert');
  if (list) list.innerHTML = '';
  if (!alertContainer) return;
  alertContainer.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'alert alert--error';
  wrap.setAttribute('role', 'alert');
  const label = document.createElement('strong');
  label.className = 'alert__label';
  label.textContent = 'Error: ';
  const text = document.createElement('span');
  text.textContent = messageForError(err);
  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'btn btn--secondary';
  retryBtn.style.marginLeft = 'var(--space-3)';
  retryBtn.textContent = 'Retry';
  retryBtn.addEventListener('click', onRetry);
  wrap.append(label, text, retryBtn);
  alertContainer.appendChild(wrap);
}

function renderList() {
  const alertContainer = document.getElementById('changes-alert');
  if (alertContainer) clearAlert(alertContainer);

  const list = document.getElementById('changes-list');
  if (!list) return;
  list.innerHTML = '';

  if (allChanges.length === 0) {
    list.appendChild(buildEmptyState('No schedule changes', 'There have been no schedule changes yet.'));
    return;
  }

  for (const change of allChanges) {
    list.appendChild(buildChangeHistoryRow(change, { subjectsById, roomsById }));
  }
}

async function loadAll() {
  setLoading();
  try {
    const [subjects, rooms] = await Promise.all([apiClient.get('/api/subjects'), apiClient.get('/api/rooms')]);
    subjectsById = new Map(subjects.map((s) => [String(s._id), s]));
    roomsById = new Map(rooms.map((r) => [String(r._id), r]));

    const subjectIds = [...subjectsById.keys()];
    if (subjectIds.length === 0) {
      allChanges = [];
      renderList();
      return;
    }

    const perSubject = await Promise.all(
      subjectIds.map((id) => apiClient.get(`/api/schedule/changes?subjectId=${id}`))
    );
    allChanges = perSubject
      .flatMap((changes, index) => changes.map((change) => ({ ...change, subjectId: subjectIds[index] })))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    renderList();
  } catch (err) {
    setError(err, () => loadAll());
  }
}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

(async function initLeaderHistoryPage() {
  const user = await initAppShell({ requiredRole: 'LEADER' });
  if (!user) return; // initAppShell already redirected (logged out / wrong role / fatal error shown)

  await loadAll();
})();
