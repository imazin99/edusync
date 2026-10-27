/**
 * client/js/pages/admin-notifications.js
 *
 * Admin Notifications page. The regular list/mark-read behavior is
 * identical to every other role's notifications page (see
 * leader-notifications.js's file header) — this file exists only because
 * initAppShell({ requiredRole }) requires each role to load its own page.
 * Additive on top of that: the Broadcast capability (spec sections 58,
 * 62), which is Admin-only.
 *
 * REAL API calls only:
 *   GET   /api/notifications               (optionally ?unreadOnly=true)
 *   PATCH /api/notifications/:recipientId/read
 *   PATCH /api/notifications/read-all
 *   POST  /api/admin/notifications/broadcast { audience, title, message }
 *
 * BROADCAST ALWAYS INCLUDES ADMIN: NotificationService.computeBroadcastRecipients
 * always includes every active Admin regardless of the chosen audience
 * (confirmed directly against server/services/NotificationService.js), so
 * sending a broadcast here will itself add a new notification to this
 * same list — the form does not optimistically inject anything locally,
 * it simply reloads the list after a successful send.
 */
import { initAppShell } from '../app-shell.js';
import { apiClient, ApiError } from '../api-client.js';
import { showAlert, clearAlert, setButtonLoading } from '../ui.js';
import { buildSkeletonCard } from '../schedule-widgets.js';
import { buildNotificationRow, buildEmptyState } from '../notification-widgets.js';

let allNotifications = [];
let unreadOnly = false;

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
  clearAlert(alertContainer);
  showAlert(alertContainer, messageForError(err, 'Could not load notifications.'), 'error');
  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'btn btn--secondary';
  retryBtn.style.marginLeft = 'var(--space-3)';
  retryBtn.textContent = 'Retry';
  retryBtn.addEventListener('click', onRetry);
  alertContainer.appendChild(retryBtn);
}

function renderToolbar() {
  const unreadCount = allNotifications.filter((n) => !n.readAt).length;
  const summaryEl = document.getElementById('notifications-summary');
  if (summaryEl) {
    summaryEl.textContent = unreadCount > 0 ? `${unreadCount} unread` : 'All caught up';
  }
  const markAllBtn = document.getElementById('notifications-mark-all-read');
  if (markAllBtn) markAllBtn.disabled = unreadCount === 0;
}

function renderList() {
  clearAlert(document.getElementById('notifications-alert'));
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
// Broadcast modal
// ---------------------------------------------------------------------

function openBroadcastModal() {
  document.getElementById('broadcast-form').reset();
  clearAlert(document.getElementById('broadcast-form-alert'));
  document.getElementById('broadcast-modal-backdrop').hidden = false;
  document.getElementById('broadcast-title').focus();
}

function closeBroadcastModal() {
  document.getElementById('broadcast-modal-backdrop').hidden = true;
}

async function handleBroadcastSubmit(event) {
  event.preventDefault();
  const alertContainer = document.getElementById('broadcast-form-alert');
  clearAlert(alertContainer);

  const audience = document.getElementById('broadcast-audience').value;
  const title = document.getElementById('broadcast-title').value.trim();
  const message = document.getElementById('broadcast-message').value.trim();

  if (!title || !message) {
    showAlert(alertContainer, 'Title and Message are required.', 'error');
    return;
  }

  const submitBtn = document.getElementById('broadcast-form-submit');
  setButtonLoading(submitBtn, true, 'Sending…');
  try {
    await apiClient.post('/api/admin/notifications/broadcast', { audience, title, message });
    closeBroadcastModal();
    const pageAlert = document.getElementById('shell-page-alert');
    if (pageAlert) showAlert(pageAlert, 'Broadcast sent.', 'success');
    await loadNotifications();
  } catch (err) {
    setButtonLoading(submitBtn, false);
    showAlert(alertContainer, messageForError(err, 'Could not send the broadcast.'), 'error');
  }
}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

(async function initAdminNotificationsPage() {
  const user = await initAppShell({ requiredRole: 'ADMIN' });
  if (!user) return;

  document.getElementById('notifications-mark-all-read')?.addEventListener('click', markAllRead);
  document.getElementById('notifications-unread-only')?.addEventListener('change', (ev) => {
    unreadOnly = ev.target.checked;
    loadNotifications();
  });

  document.getElementById('broadcast-btn')?.addEventListener('click', openBroadcastModal);
  document.getElementById('broadcast-form-cancel')?.addEventListener('click', closeBroadcastModal);
  document.getElementById('broadcast-form')?.addEventListener('submit', handleBroadcastSubmit);
  document.getElementById('broadcast-modal-backdrop')?.addEventListener('click', (ev) => {
    if (ev.target.id === 'broadcast-modal-backdrop') closeBroadcastModal();
  });

  await loadNotifications();
})();
