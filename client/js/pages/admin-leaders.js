/**
 * client/js/pages/admin-leaders.js
 *
 * Admin Leader management (spec sections 17, 19, 94). List + Add + Reset
 * Password + Activate/Deactivate (replacement flow: deactivate the
 * current slot occupant, then add a new Leader for the same slot —
 * exactly what LeaderService.create/setActive already implement
 * server-side; this page is a thin client over that, no new rule here).
 *
 * REAL API calls only:
 *   GET   /api/leaders?isActive=                -> { leaders }
 *   POST  /api/leaders    { slot, linkedStudentId, username, password }
 *   PATCH /api/leaders/:id/active                { isActive }
 *   POST  /api/admin/users/:userId/reset-password { newPassword }
 *
 * NO EDIT FORM: LeaderService has no `update` beyond `setActive`
 * (server/services/LeaderService.js exports exactly { list, getById,
 * create, setActive } — no field-level update at all, unlike Doctor/TA's
 * fullName edit). Activate/Deactivate is the only state change available
 * after creation, so that is the only action offered here besides Reset
 * Password — not a narrower UI choice, a narrower API.
 *
 * NO STUDENT-PICKER: linkedStudentId is entered as a raw id (see
 * leaders.html's modal comment) — there is no searchable-combobox
 * component in this codebase yet to look up a Student by name. Reported
 * as a UX gap in the phase report, not invented around here.
 */
import { initAppShell } from '../app-shell.js';
import { apiClient, ApiError } from '../api-client.js';
import { showAlert, clearAlert, setButtonLoading } from '../ui.js';
import { badge, buildTable, buildActions, buildEmptyState, buildSkeletonCard } from '../admin-widgets.js';

let items = [];
let resetUserId = null;

function messageForError(err, fallback) {
  if (err instanceof ApiError) {
    if (err.status === 0) return 'Could not reach the server. Check your connection and try again.';
    if (err.isMaintenance) return err.message || 'The system is temporarily under maintenance. Please try again shortly.';
    return err.message || fallback;
  }
  return fallback;
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
  showAlert(alertContainer, messageForError(err, 'Could not load leaders.'), 'error');
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
    c.appendChild(buildEmptyState('No leaders found', 'Try a different filter, or add one.'));
    return;
  }

  const rows = items.map((leader) => [
    leader.slot === 'MALE' ? 'Male' : 'Female',
    badge(leader.isActive ? 'Active' : 'Inactive', leader.isActive ? 'success' : 'warning'),
    buildActions([
      {
        label: leader.isActive ? 'Deactivate' : 'Activate',
        onClick: () => toggleActive(leader),
      },
      { label: 'Reset Password', onClick: () => openReset(leader.userId) },
    ]),
  ]);
  c.appendChild(buildTable(['Slot', 'Status', 'Actions'], rows));
}

async function loadList() {
  setListLoading();
  const active = document.getElementById('active-filter').value;
  try {
    // apiClient.get() already unwraps the server's single-key
    // { success, leaders } envelope down to the bare array itself (see
    // client/js/api-client.js's unwrap()) — GET /api/leaders's response
    // (server/controllers/leaders.controller.js: `res.json({ success:
    // true, leaders })`) has exactly that shape, so no further
    // destructuring is needed or correct here (see the Admin Students
    // page fix for the full explanation of this pattern).
    items = await apiClient.get(`/api/leaders?${new URLSearchParams(active ? { isActive: active } : {})}`);
    renderList();
  } catch (err) {
    setListError(err, loadList);
  }
}

async function toggleActive(leader) {
  try {
    await apiClient.patch(`/api/leaders/${leader._id}/active`, { isActive: !leader.isActive });
    await loadList();
  } catch (err) {
    const alertContainer = document.getElementById('shell-page-alert');
    if (alertContainer) showAlert(alertContainer, messageForError(err, 'Could not update that leader.'), 'error');
  }
}

function openCreate() {
  document.getElementById('item-form').reset();
  clearAlert(document.getElementById('item-form-alert'));
  document.getElementById('item-modal-backdrop').hidden = false;
  document.getElementById('field-slot').focus();
}

function closeModal() {
  document.getElementById('item-modal-backdrop').hidden = true;
}

async function handleSubmit(event) {
  event.preventDefault();
  const alertContainer = document.getElementById('item-form-alert');
  clearAlert(alertContainer);

  const slot = document.getElementById('field-slot').value;
  const linkedStudentId = document.getElementById('field-linkedStudentId').value.trim();
  const username = document.getElementById('field-username').value.trim();
  const password = document.getElementById('field-password').value;

  if (!linkedStudentId || !username || !password) {
    showAlert(alertContainer, 'Linked Student, Username and Password are required.', 'error');
    return;
  }

  const submitBtn = document.getElementById('item-form-submit');
  setButtonLoading(submitBtn, true, 'Creating…');
  try {
    await apiClient.post('/api/leaders', { slot, linkedStudentId, username, password });
    closeModal();
    await loadList();
  } catch (err) {
    setButtonLoading(submitBtn, false);
    showAlert(alertContainer, messageForError(err, 'Could not create the leader.'), 'error');
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

(async function initAdminLeadersPage() {
  const user = await initAppShell({ requiredRole: 'ADMIN' });
  if (!user) return;

  document.getElementById('create-btn')?.addEventListener('click', openCreate);
  document.getElementById('item-form-cancel')?.addEventListener('click', closeModal);
  document.getElementById('item-form')?.addEventListener('submit', handleSubmit);
  document.getElementById('item-modal-backdrop')?.addEventListener('click', (ev) => {
    if (ev.target.id === 'item-modal-backdrop') closeModal();
  });

  document.getElementById('reset-form-cancel')?.addEventListener('click', closeReset);
  document.getElementById('reset-form')?.addEventListener('submit', handleResetSubmit);
  document.getElementById('reset-modal-backdrop')?.addEventListener('click', (ev) => {
    if (ev.target.id === 'reset-modal-backdrop') closeReset();
  });

  document.getElementById('active-filter')?.addEventListener('change', loadList);

  await loadList();
})();
