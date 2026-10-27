/**
 * client/js/pages/admin-rooms.js
 *
 * Admin Room management (spec section 27). List + Create + toggle status.
 *
 * REAL API calls only:
 *   GET   /api/rooms?isActive=
 *   POST  /api/rooms    { building, floor, roomNumber }
 *   PATCH /api/rooms/:id { isActive }
 *
 * `building`/`floor`/`roomNumber` ARE SET-ONCE: RoomService.update
 * (server/controllers/rooms.controller.js) accepts only `isActive` — there
 * is no backend path to edit a room's physical-location fields after
 * creation, only to deactivate/reactivate it. Edit here is therefore just
 * a status toggle, not a form, matching that real capability exactly.
 */
import { initAppShell } from '../app-shell.js';
import { apiClient, ApiError } from '../api-client.js';
import { showAlert, clearAlert, setButtonLoading } from '../ui.js';
import { badge, buildTable, buildActions, buildEmptyState, buildSkeletonCard } from '../admin-widgets.js';

let items = [];

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
  showAlert(alertContainer, messageForError(err, 'Could not load rooms.'), 'error');
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
    c.appendChild(buildEmptyState('No rooms found', 'Try a different filter, or add one.'));
    return;
  }

  const rows = items.map((r) => [
    r.building,
    r.floor,
    r.roomNumber,
    badge(r.isActive ? 'Active' : 'Inactive', r.isActive ? 'success' : 'warning'),
    buildActions([{ label: r.isActive ? 'Deactivate' : 'Activate', onClick: () => toggleActive(r) }]),
  ]);
  c.appendChild(buildTable(['Building', 'Floor', 'Room Number', 'Status', 'Actions'], rows));
}

async function loadList() {
  setListLoading();
  const active = document.getElementById('active-filter').value;
  try {
    // apiClient.get() already unwraps the server's single-key
    // { success, rooms } envelope down to the bare array itself (see
    // client/js/api-client.js's unwrap()) — GET /api/rooms's response
    // (server/controllers/rooms.controller.js: `res.json({ success: true,
    // rooms })`) has exactly that shape, so no further destructuring is
    // needed or correct here (see the Admin Students page fix for the
    // full explanation of this pattern).
    items = await apiClient.get(`/api/rooms?${new URLSearchParams(active ? { isActive: active } : {})}`);
    renderList();
  } catch (err) {
    setListError(err, loadList);
  }
}

async function toggleActive(room) {
  try {
    await apiClient.patch(`/api/rooms/${room._id}`, { isActive: !room.isActive });
    await loadList();
  } catch (err) {
    const alertContainer = document.getElementById('shell-page-alert');
    if (alertContainer) showAlert(alertContainer, messageForError(err, 'Could not update that room.'), 'error');
  }
}

function openCreate() {
  document.getElementById('item-form').reset();
  clearAlert(document.getElementById('item-form-alert'));
  document.getElementById('item-modal-backdrop').hidden = false;
  document.getElementById('field-building').focus();
}

function closeModal() {
  document.getElementById('item-modal-backdrop').hidden = true;
}

async function handleSubmit(event) {
  event.preventDefault();
  const alertContainer = document.getElementById('item-form-alert');
  clearAlert(alertContainer);

  const building = document.getElementById('field-building').value.trim();
  const floor = document.getElementById('field-floor').value.trim();
  const roomNumber = document.getElementById('field-roomNumber').value.trim();

  if (!building || !floor || !roomNumber) {
    showAlert(alertContainer, 'Building, Floor and Room Number are required.', 'error');
    return;
  }

  const submitBtn = document.getElementById('item-form-submit');
  setButtonLoading(submitBtn, true, 'Creating…');
  try {
    await apiClient.post('/api/rooms', { building, floor, roomNumber });
    closeModal();
    await loadList();
  } catch (err) {
    setButtonLoading(submitBtn, false);
    showAlert(alertContainer, messageForError(err, 'Could not create the room.'), 'error');
  }
}

(async function initAdminRoomsPage() {
  const user = await initAppShell({ requiredRole: 'ADMIN' });
  if (!user) return;

  document.getElementById('create-btn')?.addEventListener('click', openCreate);
  document.getElementById('item-form-cancel')?.addEventListener('click', closeModal);
  document.getElementById('item-form')?.addEventListener('submit', handleSubmit);
  document.getElementById('item-modal-backdrop')?.addEventListener('click', (ev) => {
    if (ev.target.id === 'item-modal-backdrop') closeModal();
  });

  document.getElementById('active-filter')?.addEventListener('change', loadList);

  await loadList();
})();
