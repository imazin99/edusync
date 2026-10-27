/**
 * client/js/pages/admin-requests.js
 *
 * Admin Requests page (spec sections 63-66): review Password Reset and
 * Group Change requests submitted by students.
 *
 * REAL API calls only:
 *   GET   /api/admin/requests?type=&status=      -> { requests }
 *   PATCH /api/admin/requests/:id   { status: APPROVED | REJECTED }
 *   POST  /api/admin/users/:userId/reset-password { newPassword }
 *
 * APPROVING A PASSWORD_RESET REQUEST DOES NOT RESET ANY PASSWORD:
 * RequestService.review (server/services/RequestService.js) only ever
 * writes request.status/reviewedBy/reviewedAt, and transactionally
 * updates student.group for a GROUP_CHANGE approval — there is no
 * type-specific side effect for PASSWORD_RESET at all (the model's own
 * comment says so: "empty/omitted for PASSWORD_RESET, which Admin handles
 * manually"). So a Reset Password action (the same endpoint/flow already
 * used on the Students/Doctors/TAs/Leaders pages) is offered alongside
 * Approve/Reject for every PASSWORD_RESET request, using its userId —
 * two separate, explicit actions rather than one button implying the
 * approval alone does the reset.
 *
 * DEFAULT FILTER IS STATUS=PENDING: an Admin opening this page almost
 * always wants the review queue, not the full history; "All statuses" is
 * one click away via the toolbar, matching the same default-to-actionable
 * convention as the Admin Dashboard's own "Pending Requests" stat.
 */
import { initAppShell } from '../app-shell.js';
import { apiClient, ApiError } from '../api-client.js';
import { showAlert, clearAlert, setButtonLoading } from '../ui.js';
import { badge, buildTable, buildActions, buildEmptyState, buildSkeletonCard, formatDateTime } from '../admin-widgets.js';

let items = [];
let resetUserId = null;

const TYPE_LABELS = { PASSWORD_RESET: 'Password Reset', GROUP_CHANGE: 'Group Change' };
const STATUS_VARIANTS = { PENDING: 'warning', APPROVED: 'success', REJECTED: 'danger' };

function messageForError(err, fallback) {
  if (err instanceof ApiError) {
    if (err.status === 0) return 'Could not reach the server. Check your connection and try again.';
    if (err.isMaintenance) return err.message || 'The system is temporarily under maintenance. Please try again shortly.';
    return err.message || fallback;
  }
  return fallback;
}

function detailFor(request) {
  if (request.type === 'GROUP_CHANGE') {
    return `Requested group: ${request.data?.requestedGroup ?? '—'}`;
  }
  return '—';
}

function setListLoading() {
  const c = document.getElementById('list-container');
  c.innerHTML = '';
  c.appendChild(buildSkeletonCard());
}

function setListError(err, onRetry) {
  const c = document.getElementById('list-container');
  const alertContainer = document.getElementById('list-alert');
  c.innerHTML = '';
  clearAlert(alertContainer);
  showAlert(alertContainer, messageForError(err, 'Could not load requests.'), 'error');
  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'btn btn--secondary';
  retryBtn.textContent = 'Retry';
  retryBtn.addEventListener('click', onRetry);
  alertContainer.appendChild(retryBtn);
}

function renderList() {
  clearAlert(document.getElementById('list-alert'));
  const c = document.getElementById('list-container');
  c.innerHTML = '';

  if (items.length === 0) {
    c.appendChild(buildEmptyState('No requests found', 'Try a different filter.'));
    return;
  }

  const rows = items.map((r) => {
    const actions = [];
    if (r.status === 'PENDING') {
      actions.push({ label: 'Approve', variant: 'primary', onClick: () => review(r, 'APPROVED') });
      actions.push({ label: 'Reject', onClick: () => review(r, 'REJECTED') });
    }
    if (r.type === 'PASSWORD_RESET') {
      actions.push({ label: 'Reset Password', onClick: () => openReset(r.userId) });
    }
    return [
      TYPE_LABELS[r.type] || r.type,
      detailFor(r),
      badge(r.status, STATUS_VARIANTS[r.status] || 'warning'),
      formatDateTime(r.createdAt),
      buildActions(actions),
    ];
  });
  c.appendChild(buildTable(['Type', 'Details', 'Status', 'Submitted', 'Actions'], rows));
}

async function loadList() {
  setListLoading();
  const type = document.getElementById('type-filter').value;
  const status = document.getElementById('status-filter').value;
  const params = {};
  if (type) params.type = type;
  if (status) params.status = status;
  try {
    // apiClient.get() already unwraps the server's single-key
    // { success, requests } envelope down to the bare array itself (see
    // client/js/api-client.js's unwrap()) — GET /api/admin/requests's
    // response (server/controllers/admin.controller.js's `listRequests`:
    // `res.json({ success: true, requests })`) has exactly that shape,
    // so no further destructuring is needed or correct here (see the
    // Admin Students page fix for the full explanation of this pattern).
    items = await apiClient.get(`/api/admin/requests?${new URLSearchParams(params)}`);
    renderList();
  } catch (err) {
    setListError(err, loadList);
  }
}

async function review(request, status) {
  try {
    await apiClient.patch(`/api/admin/requests/${request._id}`, { status });
    await loadList();
  } catch (err) {
    const alertContainer = document.getElementById('shell-page-alert');
    if (alertContainer) showAlert(alertContainer, messageForError(err, 'Could not update that request.'), 'error');
  }
}

function openReset(userId) {
  resetUserId = userId;
  document.getElementById('reset-form').reset();
  clearAlert(document.getElementById('reset-form-alert'));
  document.getElementById('reset-modal-backdrop').hidden = false;
  document.getElementById('reset-new-password').focus();
}

function closeReset() {
  document.getElementById('reset-modal-backdrop').hidden = true;
  resetUserId = null;
}

async function handleResetSubmit(event) {
  event.preventDefault();
  const alertContainer = document.getElementById('reset-form-alert');
  clearAlert(alertContainer);
  const newPassword = document.getElementById('reset-new-password').value;
  if (!newPassword || newPassword.length < 8) {
    showAlert(alertContainer, 'Password must be at least 8 characters.', 'error');
    return;
  }
  const submitBtn = document.getElementById('reset-form-submit');
  setButtonLoading(submitBtn, true, 'Resetting…');
  try {
    await apiClient.post(`/api/admin/users/${resetUserId}/reset-password`, { newPassword });
    closeReset();
    const pageAlert = document.getElementById('shell-page-alert');
    if (pageAlert) showAlert(pageAlert, 'Password reset successfully.', 'success');
  } catch (err) {
    setButtonLoading(submitBtn, false);
    showAlert(alertContainer, messageForError(err, 'Could not reset the password.'), 'error');
  }
}

(async function initAdminRequestsPage() {
  const user = await initAppShell({ requiredRole: 'ADMIN' });
  if (!user) return;

  document.getElementById('type-filter')?.addEventListener('change', loadList);
  document.getElementById('status-filter')?.addEventListener('change', loadList);

  document.getElementById('reset-form-cancel')?.addEventListener('click', closeReset);
  document.getElementById('reset-form')?.addEventListener('submit', handleResetSubmit);
  document.getElementById('reset-modal-backdrop')?.addEventListener('click', (ev) => {
    if (ev.target.id === 'reset-modal-backdrop') closeReset();
  });

  await loadList();
})();
