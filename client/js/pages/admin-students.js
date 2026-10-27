/**
 * client/js/pages/admin-students.js
 *
 * Admin Students management (spec sections 11, 122-123). Search/filter
 * list, Create, Edit (incl. deactivate), Reset Password.
 *
 * REAL API calls only:
 *   GET   /api/students?search=&group=&isActive=
 *   POST  /api/students        { studentCode, fullName, group, password? }
 *   PATCH /api/students/:id    { studentCode?, fullName?, group?, isActive? }
 *   POST  /api/admin/users/:userId/reset-password   { newPassword }
 *
 * DEACTIVATE, NOT DELETE: there is no DELETE /api/students/:id route —
 * only PATCH :id with isActive:false (server/routes/students.routes.js
 * only defines GET/GET/POST/PATCH). This matches the "never hard-delete
 * academic records" pattern already established for Leader (spec section
 * 19: "Do not erase historical attribution") — deactivation, not deletion,
 * is this project's one consistent mechanism for retiring a record.
 */
import { initAppShell } from '../app-shell.js';
import { apiClient, ApiError } from '../api-client.js';
import { showAlert, clearAlert, setButtonLoading, setFieldError } from '../ui.js';
import { badge, buildTable, buildActions, buildEmptyState, buildSkeletonCard } from '../admin-widgets.js';

let items = [];
let editingId = null;

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
  showAlert(alertContainer, messageForError(err, 'Could not load students.'), 'error');
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
    c.appendChild(buildEmptyState('No students found', 'Try a different search or filter.'));
    return;
  }

  const rows = items.map((s) => [
    s.studentCode,
    s.fullName,
    s.group,
    badge(s.isActive ? 'Active' : 'Inactive', s.isActive ? 'success' : 'warning'),
    buildActions([
      { label: 'Edit', onClick: () => openEdit(s) },
      { label: 'Reset Password', onClick: () => openReset(s.userId) },
    ]),
  ]);
  c.appendChild(buildTable(['Student Code', 'Full Name', 'Group', 'Status', 'Actions'], rows));
}

async function loadList() {
  setListLoading();
  const search = document.getElementById('search-input').value.trim();
  const group = document.getElementById('group-filter').value;
  const active = document.getElementById('active-filter').value;
  try {
    // apiClient.get() already unwraps the server's { success, students }
    // envelope down to the bare `students` array itself whenever there is
    // exactly one data key (see client/js/api-client.js's `unwrap()`,
    // which `get()` always applies) — GET /api/students's response
    // (server/controllers/students.controller.js: `res.json({ success:
    // true, students })`) has exactly that single-key shape. So this
    // call already resolves to the array; destructuring a `.students`
    // property off of it (the previous `const { students } = ...`) read
    // `undefined` off a plain Array, which made `items` undefined and
    // threw inside renderList()'s `items.length` check — surfacing as
    // "Could not load students" on every load, and leaving every row's
    // `s.userId` never populated (which is what made Reset Password send
    // `/api/admin/users/undefined/reset-password`, rejected by
    // isValidObjectId with "userId is not a valid id" — both reported
    // symptoms traced back to this one line).
    items = await apiClient.get(
      `/api/students?${new URLSearchParams({
        ...(search ? { search } : {}),
        ...(group ? { group } : {}),
        ...(active ? { isActive: active } : {}),
      })}`
    );
    renderList();
  } catch (err) {
    setListError(err, loadList);
  }
}

// ---------------------------------------------------------------------
// Create / Edit modal
// ---------------------------------------------------------------------

function openCreate() {
  editingId = null;
  document.getElementById('item-modal-title').textContent = 'Add Student';
  document.getElementById('item-form-submit').textContent = 'Create';
  document.getElementById('item-form').reset();
  document.getElementById('field-isActive-wrap').hidden = true;
  document.getElementById('field-password-wrap').hidden = false;
  clearAlert(document.getElementById('item-form-alert'));
  document.getElementById('item-modal-backdrop').hidden = false;
  document.getElementById('field-studentCode').focus();
}

function openEdit(student) {
  editingId = student._id;
  document.getElementById('item-modal-title').textContent = 'Edit Student';
  document.getElementById('item-form-submit').textContent = 'Save Changes';
  clearAlert(document.getElementById('item-form-alert'));
  document.getElementById('field-studentCode').value = student.studentCode;
  document.getElementById('field-fullName').value = student.fullName;
  document.getElementById('field-group').value = student.group;
  document.getElementById('field-isActive-wrap').hidden = false;
  document.getElementById('field-isActive').value = String(student.isActive);
  // Password has no update pathway here — StudentService.update accepts
  // no password param at all (only Admin Reset Password, a separate
  // action/endpoint, can change it) — so the field is hidden on edit
  // rather than shown but silently ignored.
  document.getElementById('field-password-wrap').hidden = true;
  document.getElementById('item-modal-backdrop').hidden = false;
  document.getElementById('field-studentCode').focus();
}

function closeModal() {
  document.getElementById('item-modal-backdrop').hidden = true;
  editingId = null;
}

async function handleSubmit(event) {
  event.preventDefault();
  const alertContainer = document.getElementById('item-form-alert');
  clearAlert(alertContainer);

  const studentCode = document.getElementById('field-studentCode').value.trim();
  const fullName = document.getElementById('field-fullName').value.trim();
  const group = document.getElementById('field-group').value;
  const password = document.getElementById('field-password').value;

  if (!studentCode || !fullName) {
    showAlert(alertContainer, 'Student Code and Full Name are required.', 'error');
    return;
  }

  const submitBtn = document.getElementById('item-form-submit');
  setButtonLoading(submitBtn, true, editingId ? 'Saving…' : 'Creating…');
  try {
    if (editingId) {
      const isActive = document.getElementById('field-isActive').value === 'true';
      await apiClient.patch(`/api/students/${editingId}`, { studentCode, fullName, group, isActive });
    } else {
      await apiClient.post('/api/students', { studentCode, fullName, group, password: password || undefined });
    }
    closeModal();
    await loadList();
  } catch (err) {
    setButtonLoading(submitBtn, false);
    showAlert(alertContainer, messageForError(err, 'Could not save the student.'), 'error');
  }
}

// ---------------------------------------------------------------------
// Reset Password modal
// ---------------------------------------------------------------------

let resetUserId = null;

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

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

(async function initAdminStudentsPage() {
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
  document.getElementById('group-filter')?.addEventListener('change', loadList);
  document.getElementById('active-filter')?.addEventListener('change', loadList);

  await loadList();
})();

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
