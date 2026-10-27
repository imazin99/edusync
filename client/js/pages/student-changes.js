/**
 * client/js/pages/student-changes.js
 *
 * Student Changes page (spec sections 8, 33-41, 262-263) — the full
 * chronological schedule-change history, as distinct from the Schedule
 * page's "what's the current timetable" view and the Dashboard's "today's
 * changes" summary. Shows every ScheduleChange record the student is
 * allowed to see (sections 37-41: a change is never destroyed by a later
 * one, so the complete history is shown, not just the latest state).
 *
 * REAL API calls only:
 *   GET /api/subjects                       (id -> name lookup, and the
 *                                             set of subjectIds to query)
 *   GET /api/rooms                          (id -> building/floor/room lookup)
 *   GET /api/schedule/changes?subjectId=X   (one call per subject)
 *
 * WHY ONE CALL PER SUBJECT (not a single parameterless call): reading
 * server/services/ScheduleService.js's getChangeHistory directly shows it
 * REQUIRES either `sessionId` or `subjectId` —
 *   "throw AppError.badRequest('sessionId or subjectId is required')"
 * — calling GET /api/schedule/changes with neither always returns 400,
 * for every role, Student included. This is not a new restriction found
 * in this phase alone: the existing Dashboard page's "Today's Changes"
 * section had the exact same parameterless call and was silently failing
 * on every load (caught and swallowed into an empty-changes fallback) —
 * fixed as part of this phase in client/js/pages/student-dashboard.js,
 * see that file's updated comment.
 *
 * Fetching per distinct subject and merging is not an invented workaround
 * — it mirrors exactly what server/services/ReadScopeService.js's own
 * getChangeHistoryForActor does INTERNALLY for Doctor/TA actors when no
 * filter is supplied (loops `allowed.map((id) => schedule.getChangeHistory(
 * {subjectId: id}))` and flattens + re-sorts). Student is an "unrestricted"
 * role there, so that aggregation is skipped server-side and the caller is
 * expected to supply a filter — this page supplies one subjectId at a
 * time instead, across every subject that exists, and performs the same
 * flatten + re-sort client-side that the server already does for other
 * roles.
 *
 * The raw ScheduleChange record (server/models/ScheduleChange.js) has no
 * `subjectId` field of its own, only `sessionId` — this page attaches the
 * subjectId it queried with onto each returned record before handing it to
 * schedule-widgets.js's buildChangeHistoryRow, which is what that
 * function's header documents as the expected caller contract.
 *
 * SORTING: each individual GET /api/schedule/changes?subjectId=X call
 * already returns that subject's own changes sorted by createdAt
 * descending (ScheduleService.getChangeHistory's subjectId branch). Once
 * results from MULTIPLE subjects are merged into one list, only a
 * client-side re-sort can restore a single consistent newest-first order
 * across subjects — unlike the Notifications page (one single endpoint
 * call already returns one final sorted list), this merge step is
 * unavoidable and is not an invented ordering rule.
 *
 * WHY NO EDITING CONTROLS: students never create, edit, or restore
 * schedule changes (spec section 8 lists only "View schedule changes" /
 * "View change history" for Student; server/routes/schedule.routes.js
 * gates POST /:sessionId/change behind requireRole(DOCTOR, TA, LEADER,
 * ADMIN), and the permanent-change endpoint is Admin-only) — this page is
 * read-only throughout.
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

(async function initStudentChangesPage() {
  const user = await initAppShell({ requiredRole: 'STUDENT' });
  if (!user) return; // initAppShell already redirected (logged out / wrong role / fatal error shown)

  await loadAll();
})();
