/**
 * client/js/pages/admin-settings.js
 *
 * Admin Settings page (spec: system settings). A single form over the
 * singleton SystemSettings document.
 *
 * REAL API calls only:
 *   GET   /api/admin/settings            -> { settings }
 *   PATCH /api/admin/settings            { maintenanceMode?, maintenanceMessage?,
 *                                           currentAcademicTerm?,
 *                                           notificationRetentionDays?, weekOffDay? }
 *
 * ONLY THESE FIVE FIELDS: SettingsService.ALLOWED_FIELDS (confirmed by
 * reading server/services/SettingsService.js in full) is exactly
 * ['maintenanceMode', 'maintenanceMessage', 'currentAcademicTerm',
 * 'notificationRetentionDays', 'weekOffDay'] — `update` throws on any
 * other key in the patch. SystemSettings.otherSettings (a free-form Mixed
 * field on the model) has no matching allow-list entry and is therefore
 * NOT exposed here — a generic key/value editor for it would silently
 * fail against the real PATCH contract, so it is left out and reported as
 * not implemented, rather than built to call an endpoint that would
 * reject it.
 *
 * notificationRetentionDays IS SENT AS A NUMBER: SettingsService.update
 * type-checks this field (`typeof value !== 'number'` is rejected), so
 * the input value is explicitly Number()-converted before the request,
 * not left as the string a text/number input's `.value` naturally is.
 */
import { initAppShell } from '../app-shell.js';
import { apiClient, ApiError } from '../api-client.js';
import { showAlert, clearAlert, setButtonLoading } from '../ui.js';
import { buildSkeletonCard } from '../schedule-widgets.js';

function messageForError(err, fallback) {
  if (err instanceof ApiError) {
    if (err.status === 0) return 'Could not reach the server. Check your connection and try again.';
    if (err.isMaintenance) return err.message || 'The system is temporarily under maintenance. Please try again shortly.';
    return err.message || fallback;
  }
  return fallback;
}

function populateForm(settings) {
  document.getElementById('field-maintenanceMode').checked = !!settings.maintenanceMode;
  document.getElementById('field-maintenanceMessage').value = settings.maintenanceMessage || '';
  document.getElementById('field-currentAcademicTerm').value = settings.currentAcademicTerm || '';
  document.getElementById('field-notificationRetentionDays').value =
    settings.notificationRetentionDays ?? 180;
  document.getElementById('field-weekOffDay').value = settings.weekOffDay || '';
}

async function loadSettings() {
  const form = document.getElementById('settings-form');
  form.hidden = true;
  const container = form.parentElement;
  const skeleton = buildSkeletonCard();
  skeleton.id = 'settings-skeleton';
  container.insertBefore(skeleton, form);
  try {
    // apiClient.get() already unwraps the server's single-key
    // { success, settings } envelope down to the bare settings object
    // itself (see client/js/api-client.js's unwrap()) — GET
    // /api/admin/settings's response (server/controllers/admin.controller.js:
    // `res.status(200).json({ success: true, settings })`) has exactly
    // that shape, so destructuring `.settings` off the result here was
    // reading a property that doesn't exist on the already-unwrapped
    // object, producing `undefined` and throwing inside populateForm()
    // (same pattern as the Admin Students list-load bug).
    const settings = await apiClient.get('/api/admin/settings');
    populateForm(settings);
    form.hidden = false;
  } catch (err) {
    const alertContainer = document.getElementById('settings-alert');
    if (alertContainer) showAlert(alertContainer, messageForError(err, 'Could not load settings.'), 'error');
  } finally {
    document.getElementById('settings-skeleton')?.remove();
  }
}

async function handleSubmit(event) {
  event.preventDefault();
  const alertContainer = document.getElementById('settings-alert');
  clearAlert(alertContainer);

  const retentionRaw = document.getElementById('field-notificationRetentionDays').value;
  const retentionDays = Number(retentionRaw);
  if (!retentionRaw || Number.isNaN(retentionDays) || retentionDays < 1) {
    showAlert(alertContainer, 'Notification retention must be a number of at least 1.', 'error');
    return;
  }

  const payload = {
    maintenanceMode: document.getElementById('field-maintenanceMode').checked,
    maintenanceMessage: document.getElementById('field-maintenanceMessage').value.trim(),
    currentAcademicTerm: document.getElementById('field-currentAcademicTerm').value.trim(),
    notificationRetentionDays: retentionDays,
    weekOffDay: document.getElementById('field-weekOffDay').value || null,
  };

  const submitBtn = document.getElementById('settings-form-submit');
  setButtonLoading(submitBtn, true, 'Saving…');
  try {
    // Same unwrap contract as loadSettings() above: PATCH
    // /api/admin/settings also responds with a single-key
    // { success, settings } envelope, which apiClient.patch() already
    // unwraps to the bare settings object.
    const settings = await apiClient.patch('/api/admin/settings', payload);
    populateForm(settings);
    setButtonLoading(submitBtn, false);
    showAlert(alertContainer, 'Settings saved.', 'success');
  } catch (err) {
    setButtonLoading(submitBtn, false);
    showAlert(alertContainer, messageForError(err, 'Could not save settings.'), 'error');
  }
}

(async function initAdminSettingsPage() {
  const user = await initAppShell({ requiredRole: 'ADMIN' });
  if (!user) return;

  document.getElementById('settings-form')?.addEventListener('submit', handleSubmit);

  await loadSettings();
})();
