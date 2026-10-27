/**
 * client/js/pages/student-tasks.js
 *
 * Student Tasks page (spec sections 8, 10, 45-55, 90-91, 133). Shows every
 * task visible to the student (no subject filter for Student — see
 * ReadScopeService.allowedSubjectIds, which returns `null`/unrestricted for
 * STUDENT, same as LEADER/ADMIN), with the required All/Active/Due
 * Soon/Completed/Overdue filters, and the View / Mark as Done / Open
 * Submission actions spec section 90 lists.
 *
 * Students never create, edit, or delete tasks (spec sections 46-47, 53,
 * 127, 133) — no such controls exist anywhere on this page, matching
 * server/routes/tasks.routes.js, which gates POST/PATCH/DELETE /api/tasks
 * behind requireRole(DOCTOR, TA, LEADER, ADMIN) and never STUDENT.
 *
 * REAL API calls only:
 *   GET    /api/tasks                       (no status filter — see below)
 *   GET    /api/subjects                    (id -> name/code lookup)
 *   POST   /api/tasks/:id/complete
 *   DELETE /api/tasks/:id/complete
 *   GET    /api/tasks/:id/attachments/:key  (plain <a> download, no fetch)
 *
 * WHY GET /api/tasks IS NEVER CALLED WITH A status FILTER: Task.status
 * (server/models/Task.js) is only ever ACTIVE / DUE_SOON / OVERDUE — there
 * is no COMPLETED value in TASK_STATUS_VALUES (spec section 50:
 * "'Completed' is a student's personal completion state", tracked
 * separately in TaskCompletion). All five tabs are therefore computed
 * client-side from one unfiltered fetch, which also lets switching tabs be
 * instant rather than re-fetching per click.
 *
 * KNOWN, REPORTED LIMITATION — INHERITED FROM THE DASHBOARD PHASE, NOW
 * ALSO AFFECTING THIS PAGE'S "Completed" TAB (see task-widgets.js's file
 * header for the original note): there is no GET endpoint that returns a
 * student's own TaskCompletion rows — only POST/DELETE
 * /api/tasks/:id/complete exist. This page therefore cannot know, on
 * load, which tasks were already marked Done in a PAST session (on this
 * device or any other) — doing so would mean guessing or inventing a
 * field the API does not provide. What it does instead: every real
 * Mark-as-Done/Undo click still goes through the real API exactly as
 * before, and the resulting state is cached in sessionStorage (the same
 * "UI convenience, never authoritative" pattern client/js/auth-state.js
 * already established for its own current-user cache) so a reload during
 * THIS browser tab's session doesn't lose what was just clicked. A task
 * completed in an earlier session will show as not-done here until
 * clicked again, which is always safe: TaskService.markDone() is
 * idempotent (returns the existing record rather than erroring).
 */
import { initAppShell } from '../app-shell.js';
import { apiClient, ApiError } from '../api-client.js';
import { showAlert, clearAlert } from '../ui.js';
import { buildSkeletonCard } from '../schedule-widgets.js';
import { buildTaskCard, buildEmptyState } from '../task-widgets.js';

const FILTERS = ['ALL', 'ACTIVE', 'DUE_SOON', 'COMPLETED', 'OVERDUE'];
const FILTER_LABELS = {
  ALL: 'All',
  ACTIVE: 'Active',
  DUE_SOON: 'Due Soon',
  COMPLETED: 'Completed',
  OVERDUE: 'Overdue',
};
const SKELETON_COUNT = 3;

function completionsStorageKey(userId) {
  return `academic_schedule.task_completions.${userId}`;
}

function readCompletedSet(userId) {
  try {
    const raw = sessionStorage.getItem(completionsStorageKey(userId));
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function writeCompletedSet(userId, set) {
  try {
    sessionStorage.setItem(completionsStorageKey(userId), JSON.stringify([...set]));
  } catch {
    // sessionStorage can throw in locked-down/private-browsing contexts —
    // this cache is a convenience, never required (see file header).
  }
}

function messageForError(err) {
  if (err instanceof ApiError) {
    if (err.status === 0) return 'Could not reach the server. Check your connection and try again.';
    if (err.isMaintenance) {
      return err.message || 'The system is temporarily under maintenance. Please try again shortly.';
    }
    return err.message || 'Could not load tasks.';
  }
  return 'Could not load tasks.';
}

function taskSortKey(task) {
  const statusRank = { OVERDUE: 0, DUE_SOON: 1, ACTIVE: 2 };
  const rank = statusRank[task.status] ?? 3;
  const deadlineMs = task.deadline ? new Date(task.deadline).getTime() : Infinity;
  return [rank, deadlineMs];
}

// ---------------------------------------------------------------------
// Page state
// ---------------------------------------------------------------------

let allTasks = [];
let subjectsById = new Map();
let completedTaskIds = new Set();
let currentUserId = null;
let activeFilter = 'ALL';

function setFilterTabsState() {
  for (const filter of FILTERS) {
    const tab = document.getElementById(`filter-tab-${filter}`);
    if (!tab) continue;
    const active = filter === activeFilter;
    tab.classList.toggle('filter-tab--active', active);
    tab.setAttribute('aria-selected', String(active));
  }
}

function tasksForFilter(filter) {
  const sorted = [...allTasks].sort((a, b) => {
    const [rankA, deadlineA] = taskSortKey(a);
    const [rankB, deadlineB] = taskSortKey(b);
    return rankA !== rankB ? rankA - rankB : deadlineA - deadlineB;
  });
  if (filter === 'ALL') return sorted;
  if (filter === 'COMPLETED') return sorted.filter((t) => completedTaskIds.has(String(t._id)));
  return sorted.filter((t) => t.status === filter);
}

function setLoading() {
  const list = document.getElementById('tasks-list');
  if (!list) return;
  list.innerHTML = '';
  for (let i = 0; i < SKELETON_COUNT; i += 1) list.appendChild(buildSkeletonCard());
}

function setError(err, onRetry) {
  const list = document.getElementById('tasks-list');
  const alertContainer = document.getElementById('tasks-alert');
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

async function handleToggleComplete(task, buttonEl) {
  const taskId = String(task._id);
  const isCompleted = completedTaskIds.has(taskId);
  buttonEl.disabled = true;
  try {
    if (isCompleted) {
      await apiClient.delete(`/api/tasks/${taskId}/complete`);
      completedTaskIds.delete(taskId);
    } else {
      await apiClient.post(`/api/tasks/${taskId}/complete`);
      completedTaskIds.add(taskId);
    }
    writeCompletedSet(currentUserId, completedTaskIds);
    renderList();
  } catch (err) {
    buttonEl.disabled = false;
    const alertContainer = document.getElementById('tasks-alert');
    if (alertContainer) {
      showAlert(
        alertContainer,
        isCompleted ? 'Could not undo that task — please try again.' : 'Could not mark that task as done — please try again.',
        'error'
      );
    }
  }
}

function renderList() {
  const alertContainer = document.getElementById('tasks-alert');
  if (alertContainer) clearAlert(alertContainer);

  const list = document.getElementById('tasks-list');
  if (!list) return;
  list.innerHTML = '';

  const visible = tasksForFilter(activeFilter);
  if (visible.length === 0) {
    const emptyMessages = {
      ALL: ['No tasks', 'There are no tasks right now.'],
      ACTIVE: ['No active tasks', 'There are no active tasks right now.'],
      DUE_SOON: ['Nothing due soon', 'No tasks are due soon.'],
      COMPLETED: ['Nothing completed yet', 'Tasks you mark as done will show up here.'],
      OVERDUE: ['No overdue tasks', "You're all caught up — nothing overdue."],
    };
    const [title, message] = emptyMessages[activeFilter] || emptyMessages.ALL;
    list.appendChild(buildEmptyState(title, message));
    return;
  }

  for (const task of visible) {
    const card = buildTaskCard(task, {
      subjectsById,
      isCompleted: completedTaskIds.has(String(task._id)),
      onToggleComplete: handleToggleComplete,
    });
    list.appendChild(card);
  }
}

async function loadTasks() {
  setLoading();
  try {
    allTasks = await apiClient.get('/api/tasks');
    renderList();
  } catch (err) {
    setError(err, () => loadTasks());
  }
}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

(async function initStudentTasksPage() {
  const user = await initAppShell({ requiredRole: 'STUDENT' });
  if (!user) return; // initAppShell already redirected (logged out / wrong role / fatal error shown)

  currentUserId = user.id;
  completedTaskIds = readCompletedSet(currentUserId);

  let subjects = [];
  try {
    subjects = await apiClient.get('/api/subjects');
  } catch (err) {
    // Subject names won't resolve, but the task list itself (title,
    // deadline, status, attachments, links) is still useful — degrade
    // gracefully rather than blanking the whole page, matching the
    // Dashboard's and Schedule page's existing behavior for this failure.
    const alertContainer = document.getElementById('shell-page-alert');
    if (alertContainer) {
      showAlert(alertContainer, 'Could not load subject details — task cards may be incomplete.', 'error');
    }
  }
  subjectsById = new Map(subjects.map((s) => [String(s._id), s]));

  for (const filter of FILTERS) {
    document.getElementById(`filter-tab-${filter}`)?.addEventListener('click', () => {
      activeFilter = filter;
      setFilterTabsState();
      renderList();
    });
  }
  setFilterTabsState();

  await loadTasks();
})();
