/**
 * client/js/pages/student-dashboard.js
 *
 * Student Dashboard (spec section 81) — the first authenticated page.
 * Priority order, exactly as the spec lists it:
 *   1. Next Class
 *   2. Today's Schedule
 *   3. Today's Changes
 *   4. Tasks
 *   5. Notifications
 *
 * Every section fetches and renders independently (its own loading /
 * empty / error state, per spec section 102) so one failing endpoint
 * never blanks the whole page — e.g. if /api/tasks errors, the schedule
 * sections above it still render normally.
 *
 * REAL API calls only (spec: "Use the existing authenticated session and
 * API contracts... If an API is unavailable, report the limitation
 * instead of inventing a replacement"):
 *   GET /api/schedule/today
 *   GET /api/schedule            (startDate/endDate range — "next class" lookahead)
 *   GET /api/schedule/changes
 *   GET /api/subjects            (to resolve subjectId -> name)
 *   GET /api/rooms               (to resolve roomId -> building/floor/number)
 *   GET /api/tasks
 *   GET /api/notifications
 *   PATCH /api/notifications/:id/read
 *   PATCH /api/notifications/read-all
 *
 * NOT called here, and why: GET /api/doctors and GET /api/tas exist but
 * are Admin-only (server/routes/doctors.routes.js, tas.routes.js), so a
 * Student session cannot use them to resolve a doctorId/taId to a name —
 * see client/js/schedule-widgets.js's file header for the full
 * explanation of what this means for the UI.
 */
import { initAppShell } from '../app-shell.js';
import { apiClient } from '../api-client.js';
import { showAlert } from '../ui.js';
import {
  buildClassCard,
  buildChangeDetailCard,
  buildEmptyState as buildScheduleEmptyState,
  buildSkeletonCard,
  isSessionChanged,
} from '../schedule-widgets.js';
import { buildTaskRow, buildEmptyState as buildTaskEmptyState } from '../task-widgets.js';
import {
  buildNotificationRow,
  buildEmptyState as buildNotificationEmptyState,
} from '../notification-widgets.js';

const LOOKAHEAD_DAYS = 7; // how far forward "Next Class" searches once today has no more classes
const TASK_OVERVIEW_LIMIT = 6;
const NOTIFICATION_OVERVIEW_LIMIT = 6;

function toDateParam(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, n) {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + n);
  return copy;
}

function todayUTC() {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  return now;
}

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

function appliesToStudent(session, studentGroup) {
  return session.group === 'ALL' || session.group === studentGroup;
}

// ---------------------------------------------------------------------
// Next Class
// ---------------------------------------------------------------------

async function loadNextClass({ subjectsById, roomsById, studentGroup }) {
  setSectionLoading('next-class-section');
  try {
    const start = todayUTC();
    const end = addDays(start, LOOKAHEAD_DAYS - 1);
    const sessions = await apiClient.get(
      `/api/schedule?startDate=${toDateParam(start)}&endDate=${toDateParam(end)}`
    );

    const now = new Date();
    const candidates = sessions
      .filter((s) => appliesToStudent(s, studentGroup))
      .filter((s) => s.status !== 'CANCELLED')
      .map((s) => {
        const effectiveDate = s.current.date ? new Date(s.current.date) : new Date(s.date);
        const [h, m] = (s.current.startTime || '00:00').split(':').map(Number);
        const startDateTime = new Date(effectiveDate);
        startDateTime.setUTCHours(h, m, 0, 0);
        return { session: s, startDateTime };
      })
      .filter((c) => c.startDateTime >= now)
      .sort((a, b) => a.startDateTime - b.startDateTime);

    if (candidates.length === 0) {
      setSectionContent('next-class-section', [
        buildScheduleEmptyState(
          'No upcoming classes',
          `No class was found in the next ${LOOKAHEAD_DAYS} days for your group.`
        ),
      ]);
      return;
    }

    const card = buildClassCard(candidates[0].session, {
      subjectsById,
      roomsById,
      studentGroup,
      emphasize: true,
    });
    setSectionContent('next-class-section', [card]);
  } catch (err) {
    setSectionError('next-class-section', 'Could not load your next class.', () =>
      loadNextClass({ subjectsById, roomsById, studentGroup })
    );
  }
}

// ---------------------------------------------------------------------
// Today's Schedule + Today's Changes (share one fetch)
// ---------------------------------------------------------------------

async function loadToday({ subjectsById, roomsById, studentGroup }) {
  setSectionLoading('today-schedule-section');
  setSectionLoading('today-changes-section');
  try {
    const sessions = await apiClient.get('/api/schedule/today');
    const applicable = sessions
      .filter((s) => appliesToStudent(s, studentGroup))
      .sort((a, b) => (a.current.startTime || '').localeCompare(b.current.startTime || ''));

    if (applicable.length === 0) {
      setSectionContent('today-schedule-section', [
        buildScheduleEmptyState('No classes today', 'There are no classes scheduled for today in your group.'),
      ]);
    } else {
      setSectionContent(
        'today-schedule-section',
        applicable.map((s) => buildClassCard(s, { subjectsById, roomsById, studentGroup }))
      );
    }

    await loadTodayChanges(applicable, { subjectsById, roomsById });
  } catch (err) {
    const retry = () => loadToday({ subjectsById, roomsById, studentGroup });
    setSectionError('today-schedule-section', "Could not load today's schedule.", retry);
    setSectionError('today-changes-section', "Could not load today's changes.", retry);
  }
}

async function loadTodayChanges(todaySessions, { subjectsById, roomsById }) {
  const changedSessions = todaySessions.filter(isSessionChanged);

  if (changedSessions.length === 0) {
    setSectionContent('today-changes-section', [
      buildScheduleEmptyState('No changes today', "Today's schedule matches the official timetable."),
    ]);
    return;
  }

  try {
    // BUG FIX (Student Changes phase): GET /api/schedule/changes REQUIRES
    // either a sessionId or a subjectId query param — calling it with
    // neither throws a 400 server-side (server/services/ScheduleService.js's
    // getChangeHistory: "throw AppError.badRequest('sessionId or subjectId
    // is required')"). The previous parameterless call here always failed
    // and silently fell into the catch block below, so "who changed it /
    // why" never actually rendered. Fetching per distinct subject among
    // today's changed sessions (bounded, typically 1-3 subjects) mirrors
    // exactly what server/services/ReadScopeService.js's own
    // getChangeHistoryForActor does internally for Doctor/TA actors with
    // no filter supplied — not an invented workaround, the same
    // aggregation the backend already performs, just run client-side since
    // the unrestricted/Student codepath expects the caller to supply one.
    const subjectIds = [...new Set(changedSessions.map((s) => String(s.subjectId)))];
    const perSubject = await Promise.all(
      subjectIds.map((id) => apiClient.get(`/api/schedule/changes?subjectId=${id}`))
    );
    const changes = perSubject.flat();
    const changesBySessionId = new Map();
    for (const change of changes) {
      const key = String(change.sessionId);
      if (!changesBySessionId.has(key)) changesBySessionId.set(key, []);
      changesBySessionId.get(key).push(change);
    }
    setSectionContent(
      'today-changes-section',
      changedSessions.map((s) => buildChangeDetailCard(s, { subjectsById, roomsById, changesBySessionId }))
    );
  } catch (err) {
    // The sessions themselves already loaded fine (current != original is
    // known for certain) — only the "who changed it / why" enrichment
    // failed, so render the comparison cards with an empty changes map
    // rather than hiding known-changed classes entirely.
    setSectionContent(
      'today-changes-section',
      changedSessions.map((s) =>
        buildChangeDetailCard(s, { subjectsById, roomsById, changesBySessionId: new Map() })
      )
    );
  }
}

// ---------------------------------------------------------------------
// Tasks overview
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
// Password reminder (spec section 7: "If a student has no password,
// periodically show a security reminder encouraging them to create
// one.") The actual password-creation form belongs to the Profile page
// (POST/DELETE /api/auth/password are Student-only endpoints — spec
// section 11 lists "Password status" as a Profile field) — that page is
// not part of this phase, so the reminder links there; like every other
// not-yet-built destination in this project, that link 404s until its
// own phase builds the page (see client/README.md's existing note on
// this for the dashboard links themselves).
// ---------------------------------------------------------------------

function renderPasswordReminder(user) {
  const container = document.getElementById('password-reminder');
  if (!container) return;
  if (user.hasPassword) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = '';
  showAlert(
    container,
    'Your account has no password set — you are signing in with your Student Code only. Set a password from your Profile page to secure your account.',
    'info'
  );
}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

(async function initStudentDashboard() {
  const user = await initAppShell({ requiredRole: 'STUDENT' });
  if (!user) return; // initAppShell already redirected (logged out / wrong role / fatal error shown)

  const studentGroup = user.student ? user.student.group : null;
  renderPasswordReminder(user);

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
    loadNextClass({ subjectsById, roomsById, studentGroup }),
    loadToday({ subjectsById, roomsById, studentGroup }),
    loadTasks({ subjectsById }),
    loadNotifications(),
  ]);
})();
