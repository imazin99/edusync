/**
 * client/js/pages/ta-tasks.js
 *
 * TA Tasks page. Lists tasks the TA may manage, and lets them Create /
 * Edit / Delete a task for their own subject(s) (spec: "Creating and
 * managing tasks for the doctor's own subject(s)" — the same requirement
 * applies to TA, mirrored from doctor-tasks.js; the logic below is
 * role-agnostic by construction, only this header and the entry point
 * differ from the Doctor version).
 *
 * REAL API calls only:
 *   GET    /api/tasks                (server-side scoped — see below)
 *   GET    /api/subjects             (id -> name/code lookup, AND the
 *                                      Create form's subject choices)
 *   POST   /api/tasks                { title, subjectId, description?,
 *                                       deadline?, submissionLinks? }
 *   PATCH  /api/tasks/:id            { title?, description?, deadline?,
 *                                       submissionLinks? }
 *   DELETE /api/tasks/:id
 *
 * LISTING IS ALREADY SCOPED SERVER-SIDE — NO CLIENT FILTER NEEDED:
 * server/controllers/tasks.controller.js's `list` calls
 * readScope.listTasksForActor (server/services/ReadScopeService.js), which
 * restricts a TA actor to tasks whose Subject.taId matches their own TA
 * profile (resolved server-side from the session, never from anything the
 * client sends). This means GET /api/tasks for a TA already returns
 * exactly "my subject's tasks" with no subjectId filter needed — unlike
 * the Student Tasks page (which is intentionally unrestricted, see
 * ReadScopeService's documented visibility rules).
 *
 * KNOWN, REPORTED LIMITATION (Create form's subject dropdown is NOT
 * narrowed to "my subjects"): unlike the task LIST (which the server
 * scopes automatically, above), there is no client-accessible API that
 * resolves "which Subjects does the logged-in TA assist" ahead of time:
 * GET /api/auth/me's ta profile is `{ fullName }` only
 * (server/controllers/auth.controller.js's serializeUser) — no TA._id is
 * ever returned to the client — and GET /api/tas (which could resolve
 * userId -> TA._id) is Admin-only (server/routes/tas.routes.js). So the
 * dropdown below lists every active subject (the same GET /api/subjects
 * any authenticated role can already see), not just this TA's own. This
 * does NOT weaken security: the actual permission boundary
 * (TaskService.loadSubjectAndAssertManage) still runs server-side on
 * every create/update/delete, exactly as it does for every other write
 * in this codebase ("the frontend never determines permissions" —
 * client/README.md). Picking a subject this TA doesn't assist is
 * rejected with a clear 403, shown in the form's own alert region, never
 * silently allowed. This is the exact same gap already reported for the
 * Doctor Dashboard phase, now confirmed to apply identically to TA.
 * Reported again in this phase's report as the one concrete, minimal
 * capability gap found this phase — not worked around with an invented
 * or partial filter.
 *
 * WHY THERE IS NO ATTACHMENT UPLOAD UI HERE: POST /api/tasks/:id/attachments
 * (server/routes/tasks.routes.js) is a separate, already-existing,
 * TA-accessible endpoint, but it is additive to task creation (a task
 * must exist first) and out of this phase's explicit scope ("Creating and
 * managing tasks" — title/description/deadline/subject/submission link).
 * Reported as a follow-up item, not built speculatively here.
 */
import { initAppShell } from '../app-shell.js';
import { apiClient, ApiError } from '../api-client.js';
import { showAlert, clearAlert, setButtonLoading, setFieldError } from '../ui.js';
import { buildSkeletonCard } from '../schedule-widgets.js';
import { buildManageableTaskCard, buildEmptyState } from '../task-widgets.js';

const FILTERS = ['ALL', 'ACTIVE', 'DUE_SOON', 'OVERDUE'];

let allTasks = [];
let subjectsById = new Map();
let activeSubjects = [];
let activeFilter = 'ALL';
let editingTaskId = null;

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

function taskSortKey(task) {
  const statusRank = { OVERDUE: 0, DUE_SOON: 1, ACTIVE: 2 };
  const rank = statusRank[task.status] ?? 3;
  const deadlineMs = task.deadline ? new Date(task.deadline).getTime() : Infinity;
  return [rank, deadlineMs];
}

// ---------------------------------------------------------------------
// List rendering
// ---------------------------------------------------------------------

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
  return sorted.filter((t) => t.status === filter);
}

function setLoading() {
  const list = document.getElementById('tasks-list');
  if (!list) return;
  list.innerHTML = '';
  for (let i = 0; i < 3; i += 1) list.appendChild(buildSkeletonCard());
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
  text.textContent = messageForError(err, 'Could not load tasks.');
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
  const alertContainer = document.getElementById('tasks-alert');
  if (alertContainer) clearAlert(alertContainer);

  const list = document.getElementById('tasks-list');
  if (!list) return;
  list.innerHTML = '';

  const visible = tasksForFilter(activeFilter);
  if (visible.length === 0) {
    const emptyMessages = {
      ALL: ['No tasks', 'You have not created any tasks yet.'],
      ACTIVE: ['No active tasks', 'There are no active tasks right now.'],
      DUE_SOON: ['Nothing due soon', 'No tasks are due soon.'],
      OVERDUE: ['No overdue tasks', 'Nothing is overdue.'],
    };
    const [title, message] = emptyMessages[activeFilter] || emptyMessages.ALL;
    list.appendChild(buildEmptyState(title, message));
    return;
  }

  for (const task of visible) {
    list.appendChild(
      buildManageableTaskCard(task, {
        subjectsById,
        onEdit: (t) => openModalForEdit(t),
        onDelete: (t, btn) => handleDelete(t, btn),
      })
    );
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

async function handleDelete(task, buttonEl) {
  // Lightweight confirmation — no custom modal/component exists for this
  // in the shared UI kit yet, and this is a destructive action (spec:
  // "managing tasks" implies a real delete, not a silent one).
  if (!window.confirm(`Delete "${task.title}"? This cannot be undone.`)) return;
  buttonEl.disabled = true;
  try {
    await apiClient.delete(`/api/tasks/${task._id}`);
    await loadTasks();
  } catch (err) {
    buttonEl.disabled = false;
    const alertContainer = document.getElementById('tasks-alert');
    if (alertContainer) {
      showAlert(alertContainer, messageForError(err, 'Could not delete that task.'), 'error');
    }
  }
}

// ---------------------------------------------------------------------
// Create / Edit modal
// ---------------------------------------------------------------------

function populateSubjectSelect() {
  const select = document.getElementById('task-subject');
  if (!select) return;
  select.innerHTML = '';
  for (const subject of activeSubjects) {
    const option = document.createElement('option');
    option.value = subject._id;
    option.textContent = subject.code ? `${subject.name} (${subject.code})` : subject.name;
    select.appendChild(option);
  }
}

function toDatetimeLocalValue(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openModalForCreate() {
  editingTaskId = null;
  document.getElementById('task-modal-title').textContent = 'Create Task';
  document.getElementById('task-form-submit').textContent = 'Create Task';
  document.getElementById('task-form').reset();
  populateSubjectSelect();
  clearAlert(document.getElementById('task-form-alert'));
  document.getElementById('task-modal-backdrop').hidden = false;
  document.getElementById('task-title').focus();
}

function openModalForEdit(task) {
  editingTaskId = task._id;
  document.getElementById('task-modal-title').textContent = 'Edit Task';
  document.getElementById('task-form-submit').textContent = 'Save Changes';
  populateSubjectSelect();
  clearAlert(document.getElementById('task-form-alert'));

  document.getElementById('task-title').value = task.title || '';
  document.getElementById('task-subject').value = String(task.subjectId);
  // Subject is fixed on edit — TaskService.update has no subjectId param
  // at all (server/services/TaskService.js: only title, description,
  // deadline, submissionLinks, attachments are accepted), so changing it
  // here would silently do nothing. Disabling makes that honest instead
  // of implying a capability that doesn't exist.
  document.getElementById('task-subject').disabled = true;
  document.getElementById('task-description').value = task.description || '';
  document.getElementById('task-deadline').value = toDatetimeLocalValue(task.deadline);
  const firstLink = (task.submissionLinks || [])[0];
  document.getElementById('task-submission-url').value = firstLink ? firstLink.url : '';
  document.getElementById('task-submission-label').value = firstLink ? firstLink.label || '' : '';

  document.getElementById('task-modal-backdrop').hidden = false;
  document.getElementById('task-title').focus();
}

function closeModal() {
  document.getElementById('task-modal-backdrop').hidden = true;
  document.getElementById('task-subject').disabled = false;
  editingTaskId = null;
}

function readFormPayload() {
  const title = document.getElementById('task-title').value.trim();
  const subjectId = document.getElementById('task-subject').value;
  const description = document.getElementById('task-description').value.trim();
  const deadlineRaw = document.getElementById('task-deadline').value;
  const deadline = deadlineRaw ? new Date(deadlineRaw).toISOString() : null;
  const url = document.getElementById('task-submission-url').value.trim();
  const label = document.getElementById('task-submission-label').value.trim();
  const submissionLinks = url ? [{ url, label }] : [];
  return { title, subjectId, description, deadline, submissionLinks };
}

async function handleSubmit(event) {
  event.preventDefault();
  const alertContainer = document.getElementById('task-form-alert');
  clearAlert(alertContainer);
  const titleInput = document.getElementById('task-title');
  setFieldError(titleInput, '');

  const payload = readFormPayload();
  if (!payload.title) {
    setFieldError(titleInput, 'Title is required.');
    titleInput.focus();
    return;
  }
  if (!editingTaskId && !payload.subjectId) {
    showAlert(alertContainer, 'Select a subject.', 'error');
    return;
  }

  const submitBtn = document.getElementById('task-form-submit');
  setButtonLoading(submitBtn, true, editingTaskId ? 'Saving…' : 'Creating…');
  try {
    if (editingTaskId) {
      await apiClient.patch(`/api/tasks/${editingTaskId}`, {
        title: payload.title,
        description: payload.description,
        deadline: payload.deadline,
        submissionLinks: payload.submissionLinks,
      });
    } else {
      await apiClient.post('/api/tasks', payload);
    }
    closeModal();
    await loadTasks();
  } catch (err) {
    setButtonLoading(submitBtn, false);
    showAlert(
      alertContainer,
      messageForError(err, editingTaskId ? 'Could not save changes.' : 'Could not create the task.'),
      'error'
    );
  }
}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

(async function initTaTasksPage() {
  const user = await initAppShell({ requiredRole: 'TA' });
  if (!user) return; // initAppShell already redirected (logged out / wrong role / fatal error shown)

  let subjects = [];
  try {
    subjects = await apiClient.get('/api/subjects');
  } catch (err) {
    const alertContainer = document.getElementById('shell-page-alert');
    if (alertContainer) {
      showAlert(alertContainer, 'Could not load subject details — task cards may be incomplete.', 'error');
    }
  }
  subjectsById = new Map(subjects.map((s) => [String(s._id), s]));
  activeSubjects = subjects.filter((s) => s.isActive !== false);

  for (const filter of FILTERS) {
    document.getElementById(`filter-tab-${filter}`)?.addEventListener('click', () => {
      activeFilter = filter;
      setFilterTabsState();
      renderList();
    });
  }
  setFilterTabsState();

  document.getElementById('create-task-btn')?.addEventListener('click', openModalForCreate);
  document.getElementById('task-form-cancel')?.addEventListener('click', closeModal);
  document.getElementById('task-form')?.addEventListener('submit', handleSubmit);
  document.getElementById('task-modal-backdrop')?.addEventListener('click', (ev) => {
    if (ev.target.id === 'task-modal-backdrop') closeModal();
  });

  await loadTasks();
})();
