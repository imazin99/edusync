/**
 * client/js/pages/doctor-notifications.js
 *
 * Doctor Notifications page — Doctor Dashboard phase. Identical in
 * behavior to client/js/pages/student-notifications.js: the backend's
 * notification contract (server/services/NotificationService.js) is not
 * role-specific at all — listForUser/markRead/markAllRead scope strictly
 * to the calling session's own user id, for any role. There is no
 * Doctor-specific notification logic to add; this file exists only
 * because initAppShell({ requiredRole }) requires each role to load its
 * own page (so a Doctor session is never shown a page built for, and
 * redirecting as, a Student).
 *
 * REAL API calls only (same three as the Student page):
 *   GET   /api/notifications               (optionally ?unreadOnly=true)
 *   PATCH /api/notifications/:recipientId/read
 *   PATCH /api/notifications/read-all
 */
import { initAppShell } from '../app-shell.js';
import { apiClient, ApiError } from '../api-client.js';
import { showAlert, clearAlert } from '../ui.js';
import { buildSkeletonCard } from '../schedule-widgets.js';
import { buildNotificationRow, buildEmptyState } from '../notification-widgets.js';

let allNotifications = [];
let unreadOnly = false;

function messageForError(err) {
  if (err instanceof ApiError) {
    if (err.status === 0) return 'Could not reach the server. Check your connection and try again.';
    if (err.isMaintenance) {
      return err.message || 'The system is temporarily under maintenance. Please try again shortly.';
    }
    return err.message || 'Could not load notifications.';
  }
  return 'Could not load notifications.';
}

function setLoading() {
  const list = document.getElementById('notifications-list');
  if (!list) return;
  list.innerHTML = '';
  for (let i = 0; i < 3; i += 1) list.appendChild(buildSkeletonCard());
}

function setError(err, onRetry) {
  const list = document.getElementById('notifications-list');
  const alertContainer = document.getElementById('notifications-alert');
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

function renderToolbar() {
  const unreadCount = allNotifications.filter((n) => !n.readAt).length;
  const summaryEl = document.getElementById('notifications-summary');
  if (summaryEl) {
    summaryEl.textContent = unreadCount > 0 ? `${unreadCount} unread` : 'All caught up';
  }
  const markAllBtn = document.getElementById('notifications-mark-all-read');
  if (markAllBtn) {
    markAllBtn.disabled = unreadCount === 0;
  }
}

function renderList() {
  const alertContainer = document.getElementById('notifications-alert');
  if (alertContainer) clearAlert(alertContainer);

  const list = document.getElementById('notifications-list');
  if (!list) return;
  list.innerHTML = '';

  if (allNotifications.length === 0) {
    list.appendChild(
      unreadOnly
        ? buildEmptyState('No unread notifications', "You're all caught up.")
        : buildEmptyState('No notifications', "You don't have any notifications yet.")
    );
    return;
  }

  for (const item of allNotifications) {
    list.appendChild(buildNotificationRow(item, { onMarkRead: (recipientId) => markOneRead(recipientId) }));
  }
}

async function loadNotifications() {
  setLoading();
  try {
    const query = unreadOnly ? '/api/notifications?unreadOnly=true' : '/api/notifications';
    allNotifications = await apiClient.get(query);
    renderToolbar();
    renderList();
  } catch (err) {
    setError(err, () => loadNotifications());
  }
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

(async function initDoctorNotificationsPage() {
  const user = await initAppShell({ requiredRole: 'DOCTOR' });
  if (!user) return; // initAppShell already redirected (logged out / wrong role / fatal error shown)

  document.getElementById('notifications-mark-all-read')?.addEventListener('click', markAllRead);
  document.getElementById('notifications-unread-only')?.addEventListener('change', (ev) => {
    unreadOnly = ev.target.checked;
    loadNotifications();
  });

  await loadNotifications();
})();
