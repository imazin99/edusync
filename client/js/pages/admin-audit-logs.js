/**
 * client/js/pages/admin-audit-logs.js
 *
 * Admin Audit Logs page (spec section 68): a read-only, immutable record
 * of administrative/system actions. No Create/Edit/Delete UI exists here
 * by design — AuditLog is never written to by anything except the
 * backend's own services, and server/services/AuditService.js exports
 * only `list` (confirmed by reading it in full) — there is no write path
 * to expose.
 *
 * REAL API calls only:
 *   GET /api/admin/audit-logs?actorId=&action=&entityType=&entityId= -> { auditLogs }
 *
 * NO PAGINATION OR DATE-RANGE FILTER: AuditService.list filters only on
 * the four fields matching the schema's own indexes (actorId, action,
 * entityType, entityId) — no date range, no limit/offset — matching the
 * existing convention of every list endpoint in this codebase returning
 * its full filtered array. Filters are plain substring-free exact-match
 * text inputs for the same reason: the backend does a direct equality
 * match, not a search.
 */
import { initAppShell } from '../app-shell.js';
import { apiClient, ApiError } from '../api-client.js';
import { showAlert, clearAlert } from '../ui.js';
import { buildTable, buildEmptyState, buildSkeletonCard, formatDateTime } from '../admin-widgets.js';

function messageForError(err, fallback) {
  if (err instanceof ApiError) {
    if (err.status === 0) return 'Could not reach the server. Check your connection and try again.';
    if (err.isMaintenance) return err.message || 'The system is temporarily under maintenance. Please try again shortly.';
    return err.message || fallback;
  }
  return fallback;
}

function summarizeChange(entry) {
  if (!entry.before && !entry.after) return '—';
  const keys = new Set([...Object.keys(entry.before || {}), ...Object.keys(entry.after || {})]);
  const changed = [...keys].filter((k) => JSON.stringify(entry.before?.[k]) !== JSON.stringify(entry.after?.[k]));
  return changed.length ? changed.join(', ') : '—';
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
  showAlert(alertContainer, messageForError(err, 'Could not load audit logs.'), 'error');
  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'btn btn--secondary';
  retryBtn.textContent = 'Retry';
  retryBtn.addEventListener('click', onRetry);
  alertContainer.appendChild(retryBtn);
}

function renderList(auditLogs) {
  clearAlert(document.getElementById('list-alert'));
  const c = document.getElementById('list-container');
  c.innerHTML = '';
  if (auditLogs.length === 0) {
    c.appendChild(buildEmptyState('No audit log entries found', 'Try different filters, or clear them.'));
    return;
  }
  const rows = auditLogs.map((entry) => [
    formatDateTime(entry.createdAt),
    `${entry.actorRole} (${entry.actorId})`,
    entry.action,
    `${entry.entityType} (${entry.entityId})`,
    summarizeChange(entry),
  ]);
  c.appendChild(buildTable(['When', 'Actor', 'Action', 'Entity', 'Changed fields'], rows));
}

async function loadList() {
  setListLoading();
  const params = {};
  const action = document.getElementById('action-filter').value.trim();
  const entityType = document.getElementById('entityType-filter').value.trim();
  const actorId = document.getElementById('actorId-filter').value.trim();
  const entityId = document.getElementById('entityId-filter').value.trim();
  if (action) params.action = action;
  if (entityType) params.entityType = entityType;
  if (actorId) params.actorId = actorId;
  if (entityId) params.entityId = entityId;
  try {
    // apiClient.get() already unwraps the server's single-key
    // { success, auditLogs } envelope down to the bare array itself (see
    // client/js/api-client.js's unwrap()) — GET /api/admin/audit-logs's
    // response (server/controllers/admin.controller.js's `listAuditLogs`:
    // `res.json({ success: true, auditLogs })`) has exactly that shape,
    // so no further destructuring is needed or correct here (see the
    // Admin Students page fix for the full explanation of this pattern).
    const auditLogs = await apiClient.get(`/api/admin/audit-logs?${new URLSearchParams(params)}`);
    renderList(auditLogs);
  } catch (err) {
    setListError(err, loadList);
  }
}

function clearFilters() {
  document.getElementById('action-filter').value = '';
  document.getElementById('entityType-filter').value = '';
  document.getElementById('actorId-filter').value = '';
  document.getElementById('entityId-filter').value = '';
  loadList();
}

(async function initAdminAuditLogsPage() {
  const user = await initAppShell({ requiredRole: 'ADMIN' });
  if (!user) return;

  document.getElementById('apply-filters-btn')?.addEventListener('click', loadList);
  document.getElementById('clear-filters-btn')?.addEventListener('click', clearFilters);

  await loadList();
})();
