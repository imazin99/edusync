/**
 * client/js/pages/leader-dashboard.js
 *
 * Leader Dashboard and summary. Three independent sections, each with its
 * own loading/empty/error state (same convention as student-dashboard.js
 * and doctor-dashboard.js) so one failing endpoint never blanks the rest
 * of the page:
 *   1. Today's Schedule
 *   2. Tasks
 *   3. Notifications
 *
 * REAL API calls only:
 *   GET /api/schedule/today
 *   GET /api/subjects            (to resolve subjectId -> name)
 *   GET /api/rooms                (to resolve roomId -> building/floor/number)
 *   GET /api/tasks
 *   GET /api/notifications
 *   PATCH /api/notifications/:id/read
 *   PATCH /api/notifications/read-all
 *
 * WHY THIS HAS NONE OF THE DOCTOR/TA "NOT PERSONALIZED" CAVEAT: a Leader
 * is not tied to a subject at all (unlike Doctor/TA, whose Doctor._id /
 * TA._id gap was reported in those phases). Server-side:
 *   - server/services/ReadScopeService.js's allowedSubjectIds returns
 *     null (unrestricted) for LEADER, exactly like ADMIN — so GET
 *     /api/tasks already returns every task, not a subject-scoped subset.
 *   - server/services/ScheduleService.js's assertCanEditSession and
 *     server/services/TaskService.js's loadSubjectAndAssertManage both
 *     short-circuit `if (actorUser.role === ROLES.ADMIN || actorUser.role
 *     === ROLES.LEADER) return;` — a Leader may propose a one-time change
 *     or manage a task for ANY subject, with no ownership check at all.
 * So "Today's Schedule" here is not an approximation of a personalized
 * view — it is the correct, complete view for this role, same as the
 * Doctor/TA Full Schedule pages, just without needing a caveat.
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
// Today's Schedule (genuinely all subjects — see file header)
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
// Tasks overview (unrestricted — every task, see file header)
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
      setSectionContent('tasks-section', [buildTaskEmptyState('No tasks', 'There are no tasks right now.')]);
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

(async function initLeaderDashboard() {
  const user = await initAppShell({ requiredRole: 'LEADER' });
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
