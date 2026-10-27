/**
 * client/js/pages/student-notifications.js
 *
 * Student Notifications page (spec sections 56-61, 92). Shows every
 * notification addressed to the authenticated student (schedule-change
 * and task-related alike — see server/services/NotificationService.js's
 * listForUser(), which scopes strictly to NotificationRecipient rows for
 * req.user.id; there is no cross-user leakage to guard against here), with
 * Mark as Read / Mark All as Read (spec section 92's two required buttons).
 *
 * REAL API calls only:
 *   GET   /api/notifications               (optionally ?unreadOnly=true)
 *   PATCH /api/notifications/:recipientId/read
 *   PATCH /api/notifications/read-all
 *
 * EXACT RESPONSE SHAPE (server/services/NotificationService.js#listForUser,
 * confirmed by reading the service directly — not guessed): GET
 * /api/notifications returns an ARRAY of
 *   { recipientId, readAt, notification: { _id, type, category, title,
 *     message, createdBy, relatedType, relatedId, createdAt } }
 * — a nested shape, not a flat notification object. `readAt` (on the
 * recipient row) is the authoritative read/unread flag; `PATCH .../read`
 * takes the RECIPIENT id (req.params.id is looked up as a
 * NotificationRecipient, not a Notification) — the id this page passes is
 * always `item.recipientId`, never `item.notification._id`.
 *
 * SORTING: the service already returns recipients sorted by
 * `NotificationRecipient.createdAt` descending (newest first). This page
 * preserves that order as received rather than re-sorting client-side, so
 * it stays correct against "the existing API contract" rather than an
 * invented ordering rule.
 *
 * WHY NO SESSIONSTORAGE WORKAROUND (unlike student-tasks.js's completion
 * cache): unlike a student's task completion, read/unread state here IS
 * fully authoritative and persisted server-side on every load (`readAt` on
 * NotificationRecipient, returned directly by GET /api/notifications) — a
 * client-side cache would only risk drifting from the real source of
 * truth, so none is used. Every Mark as Read / Mark All as Read click goes
 * straight to the real API, then the list is re-fetched from it.
 *
 * NOTIFICATION CATEGORY NUANCE (documented, not worked around): Admin
 * broadcasts are dispatched with category:'SCHEDULE' as a placeholder
 * (NotificationService.js has no generic/announcement category in the
 * schema) but type/relatedType:'BROADCAST'. The category badge below is
 * therefore driven by the real `category` field as the primary signal
 * (matching the schema's only two real categories, SCHEDULE/TASK), while
 * the related-type label (from notification-widgets.js) still distinctly
 * shows "Announcement" for a BROADCAST item — so a broadcast is never
 * indistinguishable from an ordinary schedule-change notification, even
 * though both carry category:'SCHEDULE'.
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

(async function initStudentNotificationsPage() {
  const user = await initAppShell({ requiredRole: 'STUDENT' });
  if (!user) return; // initAppShell already redirected (logged out / wrong role / fatal error shown)

  document.getElementById('notifications-mark-all-read')?.addEventListener('click', markAllRead);
  document.getElementById('notifications-unread-only')?.addEventListener('change', (ev) => {
    unreadOnly = ev.target.checked;
    loadNotifications();
  });

  await loadNotifications();
})();
