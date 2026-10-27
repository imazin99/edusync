/**
 * client/js/pages/admin-staff.js
 *
 * Shared Admin Doctor/TA management page — one script backs both
 * admin/doctors.html and admin/tas.html, since server/controllers/
 * staffController.factory.js already gives Doctor and TA management an
 * IDENTICAL shape server-side (list/getOne/create/update, { items } —
 * see its own comment: "Shared controller logic for Doctor and TA
 * management (identical shape)"). Duplicating this file per role would
 * just be two copies of the same logic with a different URL segment —
 * this instead reads which resource to manage from the page's own
 * `data-resource`/`data-label` attributes (set once in each HTML file).
 *
 * REAL API calls only (resource is 'doctors' or 'tas'):
 *   GET   /api/{resource}?search=&isActive=        -> { items }
 *   POST  /api/{resource}       { username, fullName, password }
 *   PATCH /api/{resource}/:id   { fullName, isActive }
 *   POST  /api/admin/users/:userId/reset-password   { newPassword }
 *
 * KNOWN, REPORTED LIMITATION (no Username column): StaffService.list/
 * getById (server/services/StaffService.js) query the Doctor/TA PROFILE
 * model only (fullName, isActive, userId) — username lives on the
 * separate User model, and there is no join/populate anywhere in that
 * service. So the table below cannot show each Doctor/TA's login
 * username, and the Create form (which DOES set a username) has no
 * matching "view/edit username" capability afterward. Reset Password
 * still works regardless, since it only needs userId (present on every
 * list row). Not worked around with a second, unapproved API call per
 * row — reported as the one concrete gap in this phase's report.
 *
 * DEACTIVATE, NOT DELETE: no DELETE route exists for either resource
 * (server/routes/doctors.routes.js, tas.routes.js only define GET/GET/
 * POST/PATCH) — same "deactivate, never hard-delete" convention as
 * Students and Leaders.
 */
import { initAppShell } from '../app-shell.js';
import { apiClient, ApiError } from '../api-client.js';
import { showAlert, clearAlert, setButtonLoading } from '../ui.js';
import { badge, buildTable, buildActions, buildEmptyState, buildSkeletonCard } from '../admin-widgets.js';

const resource = document.body.dataset.resource; // 'doctors' | 'tas'
const label = document.body.dataset.label; // 'Doctor' | 'TA'

let items = [];
let editingId = null;
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
  showAlert(alertContainer, messageForError(err, `Could not load ${label.toLowerCase()}s.`), 'error');
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
    c.appendChild(buildEmptyState(`No ${label.toLowerCase()}s found`, 'Try a different search or filter.'));
    return;
  }

  const rows = items.map((item) => [
    item.fullName,
    badge(item.isActive ? 'Active' : 'Inactive', item.isActive ? 'success' : 'warning'),
    buildActions([
      { label: 'Edit', onClick: () => openEdit(item) },
      { label: 'Reset Password', onClick: () => openReset(item.userId) },
    ]),
  ]);
  c.appendChild(buildTable(['Full Name', 'Status', 'Actions'], rows));
}

async function loadList() {
  setListLoading();
  const search = document.getElementById('search-input').value.trim();
  const active = document.getElementById('active-filter').value;
  try {
    // apiClient.get() already unwraps the server's single-key
    // { success, items } envelope down to the bare array itself (see
    // client/js/api-client.js's unwrap()) — GET /api/doctors and
    // GET /api/tas's response (server/controllers/staffController.factory.js's
    // shared `list`: `res.status(200).json({ success: true, items })`)
    // has exactly that shape, so destructuring `.items` off the result
    // here was reading a property that doesn't exist on the already-
    // unwrapped array, producing `undefined` and throwing inside
    // renderList()'s `items.length` check (same pattern as the Admin
    // Students list-load bug — confirmed independently for both the
    // doctors and tas resources, since this one file backs both pages).
    items = await apiClient.get(
      `/api/${resource}?${new URLSearchParams({
        ...(search ? { search } : {}),
        ...(active ? { isActive: active } : {}),
      })}`
    );
    renderList();
  } catch (err) {
    setListError(err, loadList);
  }
}

function openCreate() {
  editingId = null;
  document.getElementById('item-modal-title').textContent = `Add ${label}`;
  document.getElementById('item-form-submit').textContent = 'Create';
  document.getElementById('item-form').reset();
  document.getElementById('field-username-wrap').hidden = false;
  document.getElementById('field-password-wrap').hidden = false;
  document.getElementById('field-isActive-wrap').hidden = true;
  clearAlert(document.getElementById('item-form-alert'));
  document.getElementById('item-modal-backdrop').hidden = false;
  document.getElementById('field-fullName').focus();
}

function openEdit(item) {
  editingId = item._id;
  document.getElementById('item-modal-title').textContent = `Edit ${label}`;
  document.getElementById('item-form-submit').textContent = 'Save Changes';
  clearAlert(document.getElementById('item-form-alert'));
  document.getElementById('field-fullName').value = item.fullName;
  // Username/password have no update pathway here — StaffService.update
  // (server/services/StaffService.js) only accepts fullName/isActive —
  // so both fields are hidden on edit rather than shown but silently
  // ignored. See this file's header for the Username display gap too.
  document.getElementById('field-username-wrap').hidden = true;
  document.getElementById('field-password-wrap').hidden = true;
  document.getElementById('field-isActive-wrap').hidden = false;
  document.getElementById('field-isActive').value = String(item.isActive);
  document.getElementById('item-modal-backdrop').hidden = false;
  document.getElementById('field-fullName').focus();
}

function closeModal() {
  document.getElementById('item-modal-backdrop').hidden = true;
  editingId = null;
}

async function handleSubmit(event) {
  event.preventDefault();
  const alertContainer = document.getElementById('item-form-alert');
  clearAlert(alertContainer);

  const fullName = document.getElementById('field-fullName').value.trim();
  if (!fullName) {
    showAlert(alertContainer, 'Full Name is required.', 'error');
    return;
  }

  const submitBtn = document.getElementById('item-form-submit');
  setButtonLoading(submitBtn, true, editingId ? 'Saving…' : 'Creating…');
  try {
    if (editingId) {
      const isActive = document.getElementById('field-isActive').value === 'true';
      await apiClient.patch(`/api/${resource}/${editingId}`, { fullName, isActive });
    } else {
      const username = document.getElementById('field-username').value.trim();
      const password = document.getElementById('field-password').value;
      if (!username || !password) {
        setButtonLoading(submitBtn, false);
        showAlert(alertContainer, 'Username and password are required.', 'error');
        return;
      }
      await apiClient.post(`/api/${resource}`, { username, fullName, password });
    }
    closeModal();
    await loadList();
  } catch (err) {
    setButtonLoading(submitBtn, false);
    showAlert(alertContainer, messageForError(err, `Could not save the ${label.toLowerCase()}.`), 'error');
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

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

(async function initAdminStaffPage() {
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

  document.getElementById('search-input')?.addEventListener('input', debounce(loadList, 300));
  document.getElementById('active-filter')?.addEventListener('change', loadList);

  await loadList();
})();
