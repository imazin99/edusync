/**
 * client/js/pages/doctor-history.js
 *
 * Doctor History page — DIRECTLY RELATED FIX, discovered during the
 * TA/Leader History investigation: nav-config.js's "DOCTOR" entry
 * labeled "History" pointed at /pages/doctor/history.html, which also
 * did not exist, 404'ing identically to the three originally-reported
 * pages. Fixed here for consistency rather than left broken next to the
 * now-working TA/Leader equivalents. See the bug-fix report for the full
 * root-cause trace.
 *
 * Shows the full chronological record of schedule changes for subjects
 * this Doctor is assigned to (Subject.doctorId) — read-only, matching
 * student-changes.js's "nothing here can be edited" page, which this
 * file deliberately mirrors (and which ta-history.js, its exact TA
 * counterpart, also mirrors).
 *
 * REAL API calls only:
 *   GET /api/subjects                       (id -> name lookup, and the
 *                                             set of subjectIds to query)
 *   GET /api/rooms                          (id -> building/floor/room lookup)
 *   GET /api/schedule/changes?subjectId=X   (one call per subject)
 *
 * WHY ONE CALL PER SUBJECT, SAME AS STUDENT'S/TA'S PAGE: GET
 * /api/schedule/changes always requires either sessionId or subjectId
 * (ScheduleService.getChangeHistory throws 400 with neither, for every
 * role — see student-changes.js's file header for the full explanation),
 * so this loops over every subject the same way.
 *
 * NO SPECIAL DOCTOR-ONLY SCOPING CODE NEEDED HERE: server/services/
 * ReadScopeService.js's getChangeHistoryForActor already restricts a
 * Doctor actor to subjects where Subject.doctorId matches them —
 * calling GET /api/schedule/changes?subjectId=X for a subject this
 * Doctor does NOT own silently returns [] (never an error, never leaks
 * whether changes exist), so looping over every subject in the system
 * (exactly like the unrestricted Student/Leader pages do) produces the
 * CORRECT, already-scoped result for Doctor too, with zero client-side
 * filtering logic.
 *
 * WHY NO EDITING CONTROLS: this page only ever lists history — a
 * Doctor's one-time schedule changes are made from the Full Schedule
 * page's existing "Propose Change" action (doctor-full-schedule.js), not
 * from here, matching the Student/Admin Changes pages' precedent of
 * being read-only.
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

(async function initDoctorHistoryPage() {
  const user = await initAppShell({ requiredRole: 'DOCTOR' });
  if (!user) return; // initAppShell already redirected (logged out / wrong role / fatal error shown)

  await loadAll();
})();
