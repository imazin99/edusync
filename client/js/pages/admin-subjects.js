/**
 * client/js/pages/admin-subjects.js
 *
 * Admin Subject management (spec section 28). List + Create + Edit.
 *
 * REAL API calls only:
 *   GET   /api/subjects?isActive=
 *   GET   /api/doctors, GET /api/tas          (Doctor/TA pickers)
 *   POST  /api/subjects    { name, code, doctorId, taId?, hasSections? }
 *   PATCH /api/subjects/:id { name?, doctorId?, taId?, hasSections?, isActive? }
 *
 * `code` IS SET-ONCE: subjects.controller.js's `update` does not accept a
 * `code` field at all (only name/doctorId/taId/hasSections/isActive) —
 * server/services/SubjectService.js has no code-mutation path. The Code
 * field is shown and required on Create, then hidden entirely on Edit,
 * rather than shown-but-silently-ignored.
 */
import { initAppShell } from '../app-shell.js';
import { apiClient, ApiError } from '../api-client.js';
import { showAlert, clearAlert, setButtonLoading } from '../ui.js';
import { badge, buildTable, buildActions, buildEmptyState, buildSkeletonCard } from '../admin-widgets.js';

let items = [];
let doctors = [];
let tas = [];
let editingId = null;

function messageForError(err, fallback) {
  if (err instanceof ApiError) {
    if (err.status === 0) return 'Could not reach the server. Check your connection and try again.';
    if (err.isMaintenance) return err.message || 'The system is temporarily under maintenance. Please try again shortly.';
    return err.message || fallback;
  }
  return fallback;
}

function doctorName(id) {
  const d = doctors.find((x) => String(x._id) === String(id));
  return d ? d.fullName : '—';
}
function taName(id) {
  if (!id) return '—';
  const t = tas.find((x) => String(x._id) === String(id));
  return t ? t.fullName : '—';
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
  showAlert(alertContainer, messageForError(err, 'Could not load subjects.'), 'error');
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
    c.appendChild(buildEmptyState('No subjects found', 'Try a different filter, or add one.'));
    return;
  }

  const rows = items.map((s) => [
    `${s.name} (${s.code})`,
    doctorName(s.doctorId),
    taName(s.taId),
    s.hasSections ? 'Yes' : 'No',
    badge(s.isActive ? 'Active' : 'Inactive', s.isActive ? 'success' : 'warning'),
    buildActions([{ label: 'Edit', onClick: () => openEdit(s) }]),
  ]);
  c.appendChild(buildTable(['Subject', 'Doctor', 'TA', 'Sections', 'Status', 'Actions'], rows));
}

async function loadList() {
  setListLoading();
  const active = document.getElementById('active-filter').value;
  try {
    // apiClient.get() already unwraps the server's single-key
    // { success, subjects } envelope down to the bare array itself (see
    // client/js/api-client.js's unwrap()) — GET /api/subjects's response
    // (server/controllers/subjects.controller.js: `res.json({ success:
    // true, subjects })`) has exactly that shape, so no further
    // destructuring is needed or correct here (see the Admin Students
    // page fix for the full explanation of this pattern).
    items = await apiClient.get(`/api/subjects?${new URLSearchParams(active ? { isActive: active } : {})}`);
    renderList();
  } catch (err) {
    setListError(err, loadList);
  }
}

function populateSelects() {
  const doctorSelect = document.getElementById('field-doctorId');
  doctorSelect.innerHTML = '';
  for (const d of doctors) {
    const opt = document.createElement('option');
    opt.value = d._id;
    opt.textContent = d.fullName;
    doctorSelect.appendChild(opt);
  }
  const taSelect = document.getElementById('field-taId');
  taSelect.innerHTML = '';
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = 'None';
  taSelect.appendChild(noneOpt);
  for (const t of tas) {
    const opt = document.createElement('option');
    opt.value = t._id;
    opt.textContent = t.fullName;
    taSelect.appendChild(opt);
  }
}

function openCreate() {
  editingId = null;
  document.getElementById('item-modal-title').textContent = 'Add Subject';
  document.getElementById('item-form-submit').textContent = 'Create';
  document.getElementById('item-form').reset();
  populateSelects();
  document.getElementById('field-code-wrap').hidden = false;
  document.getElementById('field-code').required = true;
  document.getElementById('field-isActive-wrap').hidden = true;
  clearAlert(document.getElementById('item-form-alert'));
  document.getElementById('item-modal-backdrop').hidden = false;
  document.getElementById('field-name').focus();
}

function openEdit(subject) {
  editingId = subject._id;
  document.getElementById('item-modal-title').textContent = 'Edit Subject';
  document.getElementById('item-form-submit').textContent = 'Save Changes';
  populateSelects();
  document.getElementById('field-name').value = subject.name;
  document.getElementById('field-code-wrap').hidden = true;
  document.getElementById('field-code').required = false;
  document.getElementById('field-doctorId').value = String(subject.doctorId);
  document.getElementById('field-taId').value = subject.taId ? String(subject.taId) : '';
  document.getElementById('field-hasSections').checked = !!subject.hasSections;
  document.getElementById('field-isActive-wrap').hidden = false;
  document.getElementById('field-isActive').value = String(subject.isActive);
  clearAlert(document.getElementById('item-form-alert'));
  document.getElementById('item-modal-backdrop').hidden = false;
  document.getElementById('field-name').focus();
}

function closeModal() {
  document.getElementById('item-modal-backdrop').hidden = true;
  editingId = null;
}

async function handleSubmit(event) {
  event.preventDefault();
  const alertContainer = document.getElementById('item-form-alert');
  clearAlert(alertContainer);

  const name = document.getElementById('field-name').value.trim();
  const doctorId = document.getElementById('field-doctorId').value;
  const taId = document.getElementById('field-taId').value || null;
  const hasSections = document.getElementById('field-hasSections').checked;

  if (!name || !doctorId) {
    showAlert(alertContainer, 'Name and Doctor are required.', 'error');
    return;
  }

  const submitBtn = document.getElementById('item-form-submit');
  setButtonLoading(submitBtn, true, editingId ? 'Saving…' : 'Creating…');
  try {
    if (editingId) {
      const isActive = document.getElementById('field-isActive').value === 'true';
      await apiClient.patch(`/api/subjects/${editingId}`, { name, doctorId, taId, hasSections, isActive });
    } else {
      const code = document.getElementById('field-code').value.trim();
      if (!code) {
        setButtonLoading(submitBtn, false);
        showAlert(alertContainer, 'Code is required.', 'error');
        return;
      }
      await apiClient.post('/api/subjects', { name, code, doctorId, taId, hasSections });
    }
    closeModal();
    await loadList();
  } catch (err) {
    setButtonLoading(submitBtn, false);
    showAlert(alertContainer, messageForError(err, 'Could not save the subject.'), 'error');
  }
}

(async function initAdminSubjectsPage() {
  const user = await initAppShell({ requiredRole: 'ADMIN' });
  if (!user) return;

  try {
    // Same unwrapping rule as loadList() above: GET /api/doctors and
    // GET /api/tas both respond with a single-key { success, items }
    // envelope (server/controllers/staffController.factory.js's shared
    // `list`), which apiClient.get() already unwraps to the bare array —
    // so doctorsRes/tasRes ARE the arrays themselves, not an object with
    // an `.items` property to destructure off of.
    const [doctorsRes, tasRes] = await Promise.all([apiClient.get('/api/doctors'), apiClient.get('/api/tas')]);
    doctors = doctorsRes;
    tas = tasRes;
  } catch (err) {
    const alertContainer = document.getElementById('shell-page-alert');
    if (alertContainer) showAlert(alertContainer, 'Could not load Doctor/TA lists — the Add/Edit form may be incomplete.', 'error');
  }

  document.getElementById('create-btn')?.addEventListener('click', openCreate);
  document.getElementById('item-form-cancel')?.addEventListener('click', closeModal);
  document.getElementById('item-form')?.addEventListener('submit', handleSubmit);
  document.getElementById('item-modal-backdrop')?.addEventListener('click', (ev) => {
    if (ev.target.id === 'item-modal-backdrop') closeModal();
  });

  document.getElementById('active-filter')?.addEventListener('change', loadList);

  await loadList();
})();
