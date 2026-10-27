/**
 * client/js/pages/doctor-dashboard.js
 *
 * Doctor Dashboard and summary (spec: "Doctor dashboard and summary").
 * Three independent sections, each with its own loading/empty/error
 * state (same convention as student-dashboard.js) so one failing
 * endpoint never blanks the rest of the page:
 *   1. Today's Schedule
 *   2. Tasks
 *   3. Notifications
 *
 * REAL API calls only:
 *   GET /api/schedule/today
 *   GET /api/subjects            (to resolve subjectId -> name)
 *   GET /api/rooms                (to resolve roomId -> building/floor/number)
 *   GET /api/tasks                (already scoped to this Doctor's own tasks server-side)
 *   GET /api/notifications        (already scoped server-side)
 *   PATCH /api/notifications/:id/read
 *   PATCH /api/notifications/read-all
 *
 * ---------------------------------------------------------------------
 * KNOWN, REPORTED LIMITATION — "Today's Schedule" is NOT personalized
 * ---------------------------------------------------------------------
 * The Student dashboard's "Today's Schedule" filters sessions down to the
 * student's own group (session.group === 'ALL' || session.group ===
 * studentGroup). There is no equivalent filter available for a Doctor:
 * filtering to "my own subject(s)" would require knowing this Doctor's
 * own Doctor._id client-side, and no API reachable from an authenticated
 * Doctor session currently exposes it —
 *   - GET /api/auth/me's serializeUser() (server/controllers/
 *     auth.controller.js) returns user.doctor = { fullName } only, no id.
 *   - GET /api/doctors, the only endpoint that resolves userId -> Doctor._id,
 *     is Admin-only (requireRole(ROLES.ADMIN) on the whole router).
 *   - Subject.doctorId references Doctor._id (not User._id), so even the
 *     full GET /api/subjects list cannot be matched back to "mine" without
 *     that id.
 * Rather than guess (e.g. inferring "my subjects" from whichever subjectIds
 * happen to appear in this Doctor's own tasks or schedule-change history —
 * rejected: a subject with zero tasks or zero change history would be
 * silently and incorrectly omitted), this section honestly shows every
 * subject's classes today, exactly like the Full Schedule page, and says so
 * in the page's own copy (see dashboard.html). The server-side permission
 * boundary (ScheduleService.assertCanEditSession) is unaffected by this —
 * it is purely a "what does the dashboard display" limitation, not a
 * security gap.
 *
 * Minimal fix if approved in a future phase: add `id: doctor._id` next to
 * `fullName` in serializeUser()'s `user.doctor` object
 * (server/controllers/auth.controller.js) — additive, no schema change,
 * no behavior change for any other role.
 * ---------------------------------------------------------------------
 */
import { initAppShell } from '../app-shell.js';
import { apiClient } from '../api-client.js';
import { showAlert } from '../ui.js';
import { buildClassCard, buildEmptyState as buildScheduleEmptyState, buildSkeletonCard } from '../schedule-widgets.js';
import { buildTaskRow, buildEmptyState as buildTaskEmptyState } from '../task-widgets.js';
import {
  buildNotificationRow,
  buildEmptyState as buildNotificationEmptyState,
} from '../notification-widgets.js';

const TASK_OVERVIEW_LIMIT = 6;
const NOTIFICATION_OVERVIEW_LIMIT = 6;

function setSectionLoading(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  container.appendChild(buildSkeletonCard());
}

function setSectionError(containerId, message, onRetry) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'alert alert--error';
  const text = document.createElement('span');
  text.textContent = message;
  wrap.appendChild(text);
  if (onRetry) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn--secondary';
    btn.style.marginLeft = 'var(--space-3)';
    btn.textContent = 'Retry';
    btn.addEventListener('click', onRetry);
    wrap.appendChild(btn);
  }
  container.appendChild(wrap);
}

function setSectionContent(containerId, nodes) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  for (const node of nodes) container.appendChild(node);
}

function buildLookupMaps(subjects, rooms) {
  return {
    subjectsById: new Map(subjects.map((s) => [String(s._id), s])),
    roomsById: new Map(rooms.map((r) => [String(r._id), r])),
  };
}

// ---------------------------------------------------------------------
// Today's Schedule (all subjects — see file header)
// ---------------------------------------------------------------------

async function loadToday({ subjectsById, roomsById }) {
  setSectionLoading('today-schedule-section');
  try {
    const sessions = await apiClient.get('/api/schedule/today');
    const sorted = [...sessions].sort((a, b) =>
      (a.current.startTime || '').localeCompare(b.current.startTime || '')
    );

    if (sorted.length === 0) {
      setSectionContent('today-schedule-section', [
        buildScheduleEmptyState('No classes today', 'There are no classes scheduled for today.'),
      ]);
      return;
    }

    setSectionContent(
      'today-schedule-section',
      sorted.map((s) => buildClassCard(s, { subjectsById, roomsById }))
    );
  } catch (err) {
    setSectionError('today-schedule-section', "Could not load today's schedule.", () =>
      loadToday({ subjectsById, roomsById })
    );
  }
}

// ---------------------------------------------------------------------
// Tasks overview (server-scoped to this Doctor's own subject(s) already —
// see server/services/ReadScopeService.js's listTasksForActor)
// ---------------------------------------------------------------------

function taskSortKey(task) {
  const statusRank = { OVERDUE: 0, DUE_SOON: 1, ACTIVE: 2 };
  const rank = statusRank[task.status] ?? 3;
  const deadlineMs = task.deadline ? new Date(task.deadline).getTime() : Infinity;
  return [rank, deadlineMs];
}

async function loadTasks({ subjectsById }) {
  setSectionLoading('tasks-section');
  try {
    const tasks = await apiClient.get('/api/tasks');

    if (tasks.length === 0) {
      setSectionContent('tasks-section', [
        buildTaskEmptyState('No tasks', 'You have not created any tasks yet.'),
      ]);
      updateTaskSummary(tasks);
      return;
    }

    const sorted = [...tasks].sort((a, b) => {
      const [rankA, deadlineA] = taskSortKey(a);
      const [rankB, deadlineB] = taskSortKey(b);
      return rankA !== rankB ? rankA - rankB : deadlineA - deadlineB;
    });

    setSectionContent(
      'tasks-section',
      sorted.slice(0, TASK_OVERVIEW_LIMIT).map((t) => buildTaskRow(t, { subjectsById }))
    );
    updateTaskSummary(tasks);
  } catch (err) {
    setSectionError('tasks-section', 'Could not load tasks.', () => loadTasks({ subjectsById }));
  }
}

function updateTaskSummary(tasks) {
  const summaryEl = document.getElementById('tasks-summary');
  if (!summaryEl) return;
  const dueSoon = tasks.filter((t) => t.status === 'DUE_SOON').length;
  const overdue = tasks.filter((t) => t.status === 'OVERDUE').length;
  const active = tasks.filter((t) => t.status === 'ACTIVE').length;
  summaryEl.textContent = `${active} active · ${dueSoon} due soon · ${overdue} overdue`;
}

// ---------------------------------------------------------------------
// Notifications overview
// ---------------------------------------------------------------------

async function loadNotifications() {
  setSectionLoading('notifications-section');
  try {
    const notifications = await apiClient.get('/api/notifications');
    renderNotifications(notifications);
  } catch (err) {
    setSectionError('notifications-section', 'Could not load notifications.', loadNotifications);
  }
}

function renderNotifications(notifications) {
  const unreadCount = notifications.filter((n) => !n.readAt).length;
  const summaryEl = document.getElementById('notifications-summary');
  if (summaryEl) {
    summaryEl.textContent = unreadCount > 0 ? `${unreadCount} unread` : 'All caught up';
  }

  const markAllBtn = document.getElementById('notifications-mark-all-read');
  if (markAllBtn) {
    markAllBtn.disabled = unreadCount === 0;
  }

  if (notifications.length === 0) {
    setSectionContent('notifications-section', [
      buildNotificationEmptyState('No notifications', "You don't have any notifications yet."),
    ]);
    return;
  }

  const visible = notifications.slice(0, NOTIFICATION_OVERVIEW_LIMIT);
  setSectionContent(
    'notifications-section',
    visible.map((item) =>
      buildNotificationRow(item, {
        onMarkRead: (recipientId) => markOneRead(recipientId),
      })
    )
  );
}

async function markOneRead(recipientId) {
  try {
    await apiClient.patch(`/api/notifications/${recipientId}/read`);
    await loadNotifications();
  } catch (err) {
    const container = document.getElementById('shell-page-alert');
    if (container) showAlert(container, 'Could not mark that notification as read.', 'error');
  }
}

async function markAllRead() {
  const btn = document.getElementById('notifications-mark-all-read');
  if (btn) btn.disabled = true;
  try {
    await apiClient.patch('/api/notifications/read-all');
    await loadNotifications();
  } catch (err) {
    const container = document.getElementById('shell-page-alert');
    if (container) showAlert(container, 'Could not mark all notifications as read.', 'error');
    if (btn) btn.disabled = false;
  }
}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

(async function initDoctorDashboard() {
  const user = await initAppShell({ requiredRole: 'DOCTOR' });
  if (!user) return; // initAppShell already redirected (logged out / wrong role / fatal error shown)

  document.getElementById('notifications-mark-all-read')?.addEventListener('click', markAllRead);

  let subjects = [];
  let rooms = [];
  try {
    [subjects, rooms] = await Promise.all([apiClient.get('/api/subjects'), apiClient.get('/api/rooms')]);
  } catch (err) {
    // Subject/room names won't resolve, but the rest of the dashboard
    // (tasks, notifications) is still useful — degrade gracefully rather
    // than blanking the whole page over a lookup failure.
    const alertContainer = document.getElementById('shell-page-alert');
    if (alertContainer) {
      showAlert(alertContainer, 'Could not load subject/room details — schedule cards may be incomplete.', 'error');
    }
  }
  const { subjectsById, roomsById } = buildLookupMaps(subjects, rooms);

  await Promise.all([
    loadToday({ subjectsById, roomsById }),
    loadTasks({ subjectsById }),
    loadNotifications(),
  ]);
})();
