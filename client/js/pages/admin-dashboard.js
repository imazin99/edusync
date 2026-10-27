/**
 * client/js/pages/admin-dashboard.js
 *
 * Admin Dashboard (spec section 21: "Show useful quick statistics" +
 * "Also show: Recent schedule changes, Recent tasks, Recent requests,
 * Recent important activity"). Entirely backed by the existing, already-
 * tested GET /api/admin/dashboard (server/services/AdminDashboardService.js)
 * — no new backend logic needed or added here.
 *
 * REAL API calls only:
 *   GET /api/admin/dashboard
 *   GET /api/subjects   (id -> name lookup for the recent-tasks/changes feeds)
 *
 * WHAT'S DELIBERATELY NOT SHOWN: "Active Schedule Changes" is not a stat
 * card here, because AdminDashboardService's own file header documents it
 * as a flagged, intentional omission — ScheduleChange is an immutable
 * event log with no status field, so there is no schema-grounded
 * definition of "active" for it. The dashboard's own counts object simply
 * doesn't include that key; nothing is hidden client-side, there is
 * nothing to hide.
 */
import { initAppShell } from '../app-shell.js';
import { apiClient } from '../api-client.js';
import { showAlert } from '../ui.js';
import { el, badge, buildEmptyState, buildSkeletonCard, formatDateTime } from '../admin-widgets.js';

const STAT_DEFS = [
  { key: 'students', label: 'Students' },
  { key: 'subjects', label: 'Subjects' },
  { key: 'doctors', label: 'Doctors' },
  { key: 'tas', label: 'TAs' },
  { key: 'activeTasks', label: 'Active Tasks' },
  { key: 'pendingRequests', label: 'Pending Requests' },
];

function renderStats(counts) {
  const grid = document.getElementById('stats-grid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const { key, label } of STAT_DEFS) {
    const card = el('div', { className: 'card stat-card' });
    card.appendChild(el('div', { className: 'stat-card__value', text: String(counts[key] ?? 0) }));
    card.appendChild(el('div', { className: 'stat-card__label', text: label }));
    grid.appendChild(card);
  }
}

function setSection(id, nodes) {
  const container = document.getElementById(id);
  if (!container) return;
  container.innerHTML = '';
  for (const node of nodes) container.appendChild(node);
}

function changeRow(change, subjectsById) {
  const row = el('div', { className: 'task-row' });
  const main = el('div', { className: 'task-row__main' });
  const typeLabel = (change.changeTypes || []).join(', ') || 'Change';
  main.appendChild(el('p', { className: 'task-row__title', text: typeLabel }));
  main.appendChild(
    el('p', {
      className: 'task-row__meta',
      text: `${change.isPermanent ? 'Permanent' : 'One-time'} · by ${change.changedByRole} · ${formatDateTime(change.createdAt)}`,
    })
  );
  row.appendChild(main);
  return row;
}

function taskRow(task, subjectsById) {
  const subject = subjectsById.get(String(task.subjectId));
  const row = el('div', { className: 'task-row' });
  const main = el('div', { className: 'task-row__main' });
  main.appendChild(el('p', { className: 'task-row__title', text: task.title }));
  main.appendChild(
    el('p', {
      className: 'task-row__meta',
      text: [subject ? subject.name : null, formatDateTime(task.createdAt)].filter(Boolean).join(' · '),
    })
  );
  row.appendChild(main);
  const side = el('div', { className: 'task-row__side' });
  side.appendChild(badge(task.status, task.status === 'OVERDUE' ? 'danger' : task.status === 'DUE_SOON' ? 'warning' : 'info'));
  row.appendChild(side);
  return row;
}

function requestRow(request) {
  const row = el('div', { className: 'task-row' });
  const main = el('div', { className: 'task-row__main' });
  main.appendChild(el('p', { className: 'task-row__title', text: request.type }));
  main.appendChild(el('p', { className: 'task-row__meta', text: formatDateTime(request.createdAt) }));
  row.appendChild(main);
  const side = el('div', { className: 'task-row__side' });
  const variant = request.status === 'PENDING' ? 'warning' : request.status === 'APPROVED' ? 'success' : 'danger';
  side.appendChild(badge(request.status, variant));
  row.appendChild(side);
  return row;
}

function activityRow(entry) {
  const row = el('div', { className: 'task-row' });
  const main = el('div', { className: 'task-row__main' });
  main.appendChild(el('p', { className: 'task-row__title', text: entry.action }));
  main.appendChild(
    el('p', { className: 'task-row__meta', text: `${entry.actorRole} · ${entry.entityType} · ${formatDateTime(entry.createdAt)}` })
  );
  row.appendChild(main);
  return row;
}

(async function initAdminDashboard() {
  const user = await initAppShell({ requiredRole: 'ADMIN' });
  if (!user) return;

  const alertContainer = document.getElementById('shell-page-alert');
  for (const id of ['recent-changes-section', 'recent-tasks-section', 'recent-requests-section', 'recent-activity-section']) {
    setSection(id, [buildSkeletonCard()]);
  }

  let subjects = [];
  try {
    subjects = await apiClient.get('/api/subjects');
  } catch (err) {
    // Non-fatal: recent-tasks/changes feeds fall back to showing raw ids.
  }
  const subjectsById = new Map(subjects.map((s) => [String(s._id), s]));

  try {
    // apiClient.get() already unwraps the server's single-key
    // { success, dashboard } envelope down to the bare dashboard object
    // itself (see client/js/api-client.js's unwrap()) — GET
    // /api/admin/dashboard's response (server/controllers/admin.controller.js:
    // `res.status(200).json({ success: true, dashboard })`) has exactly
    // that shape, so destructuring `.dashboard` off the result here was
    // reading a property that doesn't exist on the already-unwrapped
    // object, producing `undefined` and throwing on `dashboard.counts`
    // (same pattern as the Admin Students list-load bug).
    const dashboard = await apiClient.get('/api/admin/dashboard');
    renderStats(dashboard.counts);

    setSection(
      'recent-changes-section',
      dashboard.recent.scheduleChanges.length
        ? dashboard.recent.scheduleChanges.map((c) => changeRow(c, subjectsById))
        : [buildEmptyState('No recent changes', 'No schedule changes have been recorded yet.')]
    );
    setSection(
      'recent-tasks-section',
      dashboard.recent.tasks.length
        ? dashboard.recent.tasks.map((t) => taskRow(t, subjectsById))
        : [buildEmptyState('No recent tasks', 'No tasks have been created yet.')]
    );
    setSection(
      'recent-requests-section',
      dashboard.recent.requests.length
        ? dashboard.recent.requests.map((r) => requestRow(r))
        : [buildEmptyState('No recent requests', 'No requests have been submitted yet.')]
    );
    setSection(
      'recent-activity-section',
      dashboard.recent.activity.length
        ? dashboard.recent.activity.map((a) => activityRow(a))
        : [buildEmptyState('No recent activity', 'No audited actions have been recorded yet.')]
    );
  } catch (err) {
    if (alertContainer) showAlert(alertContainer, 'Could not load the dashboard.', 'error');
  }
})();
