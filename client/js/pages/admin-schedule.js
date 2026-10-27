/**
 * client/js/pages/admin-schedule.js
 *
 * Admin Schedule management (spec sections 22-44, 75-77). Two linked
 * capabilities on one page:
 *   1. The weekly session grid (identical week-nav/day-tab logic to
 *      leader-schedule.js / doctor-full-schedule.js — sessions are
 *      materialized from Templates, never created directly).
 *   2. "New Recurring Class" — creates a ScheduleTemplate (POST
 *      /api/schedule/templates), which is how the OFFICIAL weekly
 *      schedule itself is built; sessions for any date range are derived
 *      from templates lazily (server/services/ScheduleService.js's
 *      materializeSessionForDate), so there is no separate "create a
 *      session" action anywhere in this API.
 *
 * Each session's Change modal offers BOTH change types, since Admin is
 * the only role with both:
 *   - One-time: POST /api/schedule/:sessionId/change, isPermanent:false
 *     — the exact same endpoint/shape Doctor/TA/Leader already use.
 *   - Permanent: POST /api/admin/schedule/permanent-change — Admin-only
 *     (server/routes/admin.routes.js is gated requireRole(ROLES.ADMIN)
 *     for its whole router), matching this phase's explicit instruction
 *     to keep permanent changes Admin-restricted. ScheduleService.applyChange
 *     requires `effectiveFrom` for a permanent change (throws 400
 *     otherwise), so that field only appears when Permanent is selected.
 *
 * REAL API calls only:
 *   GET  /api/schedule?startDate=...&endDate=...
 *   GET  /api/subjects / GET /api/rooms / GET /api/doctors / GET /api/tas
 *   POST /api/schedule/templates   { subjectId, type, group, dayOfWeek,
 *                                     startTime, endTime, roomId, doctorId,
 *                                     taId?, effectiveFrom? }
 *   POST /api/schedule/:sessionId/change       (one-time)
 *   POST /api/admin/schedule/permanent-change  (permanent)
 *
 * NO TEMPLATE LIST/EDIT UI: GET /api/schedule/templates exists and could
 * list existing templates, but there is no PATCH/delete endpoint for a
 * template at all (server/routes/schedule.routes.js only defines GET and
 * POST on /templates) — a template, once created, is changed only by a
 * permanent schedule change against one of its materialized sessions
 * (which internally supersedes the old template with a new one — see
 * ScheduleService.applyChange's effectiveFrom handling). A template
 * browser/editor screen was out of scope for this reason: there is
 * nothing beyond "create" to build a UI for.
 */
import { initAppShell } from '../app-shell.js';
import { apiClient, ApiError } from '../api-client.js';
import { showAlert, clearAlert, setButtonLoading } from '../ui.js';
import { buildManageableClassCard, buildEmptyState, buildSkeletonCard } from '../schedule-widgets.js';

const DAY_ORDER = ['SATURDAY', 'SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY'];
const DAY_LABELS = {
  SATURDAY: 'Saturday', SUNDAY: 'Sunday', MONDAY: 'Monday',
  TUESDAY: 'Tuesday', WEDNESDAY: 'Wednesday', THURSDAY: 'Thursday',
};
const DAYS_IN_WEEK = DAY_ORDER.length;
// Week-navigation step is always 7 real calendar days, never DAYS_IN_WEEK
// (6 displayed columns, Friday excluded) — see student-schedule.js's
// matching comment for the full bug explanation (weekday drift on
// previous/next navigation).
const DAYS_IN_CALENDAR_WEEK = 7;
const SKELETON_COUNT = 3;

function dateOnly(d) { const c = new Date(d); c.setUTCHours(0, 0, 0, 0); return c; }
function addDays(d, n) { const c = new Date(d); c.setUTCDate(c.getUTCDate() + n); return c; }
function toDateParam(d) { return d.toISOString().slice(0, 10); }
function startOfAcademicWeek(date) {
  const d = dateOnly(date);
  const daysSinceSaturday = (d.getUTCDay() - 6 + 7) % 7;
  return addDays(d, -daysSinceSaturday);
}
function formatDateLabel(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function formatWeekRangeLabel(start, end) {
  const sameMonth = start.getUTCMonth() === end.getUTCMonth() && start.getUTCFullYear() === end.getUTCFullYear();
  const startLabel = formatDateLabel(start);
  const endLabel = sameMonth
    ? end.toLocaleDateString('en-US', { day: 'numeric', timeZone: 'UTC' })
    : formatDateLabel(end);
  return `${startLabel} – ${endLabel}, ${end.getUTCFullYear()}`;
}
function messageForError(err, fallback) {
  if (err instanceof ApiError) {
    if (err.status === 0) return 'Could not reach the server. Check your connection and try again.';
    if (err.isMaintenance) return err.message || 'The system is temporarily under maintenance. Please try again shortly.';
    return err.message || fallback;
  }
  return fallback;
}

let weekStart = startOfAcademicWeek(new Date());
let activeDayIndex = 0;
let subjectsById = new Map();
let roomsById = new Map();
let rooms = [];
let doctors = [];
let tas = [];

function weekDates() { return Array.from({ length: DAYS_IN_WEEK }, (_, i) => addDays(weekStart, i)); }

function resetActiveDayForWeek() {
  const today = dateOnly(new Date());
  const diffDays = Math.round((today.getTime() - weekStart.getTime()) / 86400000);
  activeDayIndex = diffDays >= 0 && diffDays < DAYS_IN_WEEK ? diffDays : 0;
}

function renderWeekLabel() {
  const label = document.getElementById('week-range-label');
  if (!label) return;
  label.textContent = formatWeekRangeLabel(weekStart, addDays(weekStart, DAYS_IN_WEEK - 1));
}

function renderDayTabs() {
  const container = document.getElementById('day-tabs');
  if (!container) return;
  container.innerHTML = '';
  weekDates().forEach((date, index) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.id = `day-tab-${index}`;
    tab.className = 'day-tab';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `schedule-day-${index}`);
    tab.setAttribute('aria-label', `${DAY_LABELS[DAY_ORDER[index]]}, ${formatDateLabel(date)}`);
    tab.textContent = `${DAY_LABELS[DAY_ORDER[index]].slice(0, 3)} ${date.getUTCDate()}`;
    tab.addEventListener('click', () => { activeDayIndex = index; applyActiveDayVisibility(); });
    container.appendChild(tab);
  });
  applyActiveDayVisibility();
}

function applyActiveDayVisibility() {
  for (let i = 0; i < DAYS_IN_WEEK; i += 1) {
    const tab = document.getElementById(`day-tab-${i}`);
    const column = document.getElementById(`schedule-day-${i}`);
    const active = i === activeDayIndex;
    if (tab) { tab.classList.toggle('day-tab--active', active); tab.setAttribute('aria-selected', String(active)); }
    if (column) column.classList.toggle('schedule-day-column--active', active);
  }
}

function setLoadingGrid() {
  const grid = document.getElementById('schedule-week-grid');
  if (!grid) return;
  grid.innerHTML = '';
  for (let i = 0; i < SKELETON_COUNT; i += 1) grid.appendChild(buildSkeletonCard());
}

function setGridError(err, onRetry) {
  const grid = document.getElementById('schedule-week-grid');
  const alertContainer = document.getElementById('schedule-alert');
  if (grid) grid.innerHTML = '';
  if (!alertContainer) return;
  clearAlert(alertContainer);
  showAlert(alertContainer, messageForError(err, 'Could not load the schedule.'), 'error');
  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'btn btn--secondary';
  retryBtn.style.marginLeft = 'var(--space-3)';
  retryBtn.textContent = 'Retry';
  retryBtn.addEventListener('click', onRetry);
  alertContainer.appendChild(retryBtn);
}

function groupByDay(sessions) {
  const map = new Map();
  weekDates().forEach((date) => map.set(toDateParam(date), []));
  for (const session of sessions) {
    const key = toDateParam(dateOnly(session.date));
    if (map.has(key)) map.get(key).push(session);
  }
  for (const list of map.values()) list.sort((a, b) => (a.current.startTime || '').localeCompare(b.current.startTime || ''));
  return map;
}

function buildDayColumn({ date, dayName, sessions, index }) {
  const column = document.createElement('div');
  column.className = 'schedule-day-column';
  column.id = `schedule-day-${index}`;
  column.setAttribute('role', 'tabpanel');
  column.setAttribute('aria-labelledby', `day-tab-${index}`);

  const header = document.createElement('div');
  header.className = 'schedule-day-column__header';
  const nameEl = document.createElement('span');
  nameEl.className = 'schedule-day-column__name';
  nameEl.textContent = DAY_LABELS[dayName];
  const dateEl = document.createElement('span');
  dateEl.className = 'schedule-day-column__date';
  dateEl.textContent = formatDateLabel(date);
  header.append(nameEl, dateEl);
  column.appendChild(header);

  const body = document.createElement('div');
  body.className = 'schedule-day-column__body';
  if (sessions.length === 0) {
    body.appendChild(buildEmptyState('No classes', 'No classes are scheduled for this day.'));
  } else {
    for (const session of sessions) {
      body.appendChild(
        buildManageableClassCard(session, { subjectsById, roomsById, onProposeChange: (s) => openChangeModal(s) })
      );
    }
  }
  column.appendChild(body);
  return column;
}

function renderWeek(sessions) {
  clearAlert(document.getElementById('schedule-alert'));
  const grid = document.getElementById('schedule-week-grid');
  if (!grid) return;
  grid.innerHTML = '';
  if (sessions.length === 0) {
    grid.appendChild(buildEmptyState('No classes this week', 'There are no classes scheduled for the selected week.'));
    return;
  }
  const grouped = groupByDay(sessions);
  weekDates().forEach((date, index) => {
    grid.appendChild(buildDayColumn({ date, dayName: DAY_ORDER[index], sessions: grouped.get(toDateParam(date)) || [], index }));
  });
  applyActiveDayVisibility();
}

async function loadWeek() {
  renderWeekLabel();
  renderDayTabs();
  setLoadingGrid();
  try {
    const sessions = await apiClient.get(
      `/api/schedule?startDate=${toDateParam(weekStart)}&endDate=${toDateParam(addDays(weekStart, DAYS_IN_WEEK - 1))}`
    );
    renderWeek(sessions);
  } catch (err) {
    setGridError(err, loadWeek);
  }
}

function goToPreviousWeek() { weekStart = addDays(weekStart, -DAYS_IN_CALENDAR_WEEK); resetActiveDayForWeek(); loadWeek(); }
function goToNextWeek() { weekStart = addDays(weekStart, DAYS_IN_CALENDAR_WEEK); resetActiveDayForWeek(); loadWeek(); }
function goToThisWeek() { weekStart = startOfAcademicWeek(new Date()); resetActiveDayForWeek(); loadWeek(); }

// ---------------------------------------------------------------------
// Change modal (one-time or permanent)
// ---------------------------------------------------------------------

function populateRoomSelect(selectId) {
  const select = document.getElementById(selectId);
  select.innerHTML = '';
  for (const room of rooms) {
    const option = document.createElement('option');
    option.value = room._id;
    option.textContent = [room.building, room.roomNumber].filter(Boolean).join(' · ') || room._id;
    select.appendChild(option);
  }
}

function applyChangeTypeVisibility() {
  const isPermanent = document.getElementById('change-type').value === 'PERMANENT';
  document.getElementById('change-dayOfWeek-wrap').hidden = !isPermanent;
  document.getElementById('change-effectiveFrom-wrap').hidden = !isPermanent;
  document.getElementById('change-form-submit').textContent = isPermanent ? 'Submit Permanent Change' : 'Submit Change';
}

function openChangeModal(session) {
  populateRoomSelect('change-room');
  clearAlert(document.getElementById('change-form-alert'));
  document.getElementById('change-type').value = 'ONE_TIME';
  document.getElementById('change-session-id').value = session._id;
  document.getElementById('change-start-time').value = session.current.startTime || '';
  document.getElementById('change-end-time').value = session.current.endTime || '';
  if (session.current.roomId) document.getElementById('change-room').value = String(session.current.roomId);
  document.getElementById('change-status').value = session.status || 'ACTIVE';
  document.getElementById('change-reason').value = '';
  document.getElementById('change-effectiveFrom').value = '';
  applyChangeTypeVisibility();
  document.getElementById('change-modal-backdrop').hidden = false;
  document.getElementById('change-start-time').focus();
}

function closeChangeModal() {
  document.getElementById('change-modal-backdrop').hidden = true;
}

async function handleChangeSubmit(event) {
  event.preventDefault();
  const alertContainer = document.getElementById('change-form-alert');
  clearAlert(alertContainer);

  const isPermanent = document.getElementById('change-type').value === 'PERMANENT';
  const sessionId = document.getElementById('change-session-id').value;
  const startTime = document.getElementById('change-start-time').value;
  const endTime = document.getElementById('change-end-time').value;
  const roomId = document.getElementById('change-room').value;
  const status = document.getElementById('change-status').value;
  const reason = document.getElementById('change-reason').value.trim();

  if (!startTime || !endTime) {
    showAlert(alertContainer, 'Start and end time are required.', 'error');
    return;
  }
  if (isPermanent && !document.getElementById('change-effectiveFrom').value) {
    showAlert(alertContainer, 'Effective From is required for a permanent change.', 'error');
    return;
  }

  const submitBtn = document.getElementById('change-form-submit');
  setButtonLoading(submitBtn, true, 'Submitting…');
  try {
    if (isPermanent) {
      await apiClient.post('/api/admin/schedule/permanent-change', {
        sessionId,
        current: { startTime, endTime, roomId, status },
        dayOfWeek: document.getElementById('change-dayOfWeek').value,
        reason,
        effectiveFrom: document.getElementById('change-effectiveFrom').value,
      });
    } else {
      await apiClient.post(`/api/schedule/${sessionId}/change`, { current: { startTime, endTime, roomId, status }, reason });
    }
    closeChangeModal();
    await loadWeek();
  } catch (err) {
    setButtonLoading(submitBtn, false);
    showAlert(alertContainer, messageForError(err, 'Could not submit the change.'), 'error');
  }
}

// ---------------------------------------------------------------------
// New Recurring Class (Template) modal
// ---------------------------------------------------------------------

function populateSelectOptions(selectId, list, { includeNone = false } = {}) {
  const select = document.getElementById(selectId);
  select.innerHTML = '';
  if (includeNone) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'None';
    select.appendChild(opt);
  }
  for (const item of list) {
    const opt = document.createElement('option');
    opt.value = item._id;
    opt.textContent = item.name ? (item.code ? `${item.name} (${item.code})` : item.name) : item.fullName || [item.building, item.roomNumber].filter(Boolean).join(' · ');
    select.appendChild(opt);
  }
}

function openTemplateModal() {
  document.getElementById('template-form').reset();
  clearAlert(document.getElementById('template-form-alert'));
  populateSelectOptions('tpl-subjectId', [...subjectsById.values()]);
  populateSelectOptions('tpl-roomId', rooms);
  populateSelectOptions('tpl-doctorId', doctors);
  populateSelectOptions('tpl-taId', tas, { includeNone: true });
  document.getElementById('template-modal-backdrop').hidden = false;
  document.getElementById('tpl-subjectId').focus();
}

function closeTemplateModal() {
  document.getElementById('template-modal-backdrop').hidden = true;
}

async function handleTemplateSubmit(event) {
  event.preventDefault();
  const alertContainer = document.getElementById('template-form-alert');
  clearAlert(alertContainer);

  const payload = {
    subjectId: document.getElementById('tpl-subjectId').value,
    type: document.getElementById('tpl-type').value,
    group: document.getElementById('tpl-group').value,
    dayOfWeek: document.getElementById('tpl-dayOfWeek').value,
    startTime: document.getElementById('tpl-startTime').value,
    endTime: document.getElementById('tpl-endTime').value,
    roomId: document.getElementById('tpl-roomId').value,
    doctorId: document.getElementById('tpl-doctorId').value,
    taId: document.getElementById('tpl-taId').value || undefined,
    effectiveFrom: document.getElementById('tpl-effectiveFrom').value || undefined,
  };
  if (!payload.subjectId || !payload.roomId || !payload.doctorId || !payload.startTime || !payload.endTime) {
    showAlert(alertContainer, 'Subject, Room, Doctor, Start time and End time are required.', 'error');
    return;
  }

  const submitBtn = document.getElementById('template-form-submit');
  setButtonLoading(submitBtn, true, 'Creating…');
  try {
    await apiClient.post('/api/schedule/templates', payload);
    closeTemplateModal();
    await loadWeek();
  } catch (err) {
    setButtonLoading(submitBtn, false);
    showAlert(alertContainer, messageForError(err, 'Could not create the recurring class.'), 'error');
  }
}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

(async function initAdminSchedulePage() {
  const user = await initAppShell({ requiredRole: 'ADMIN' });
  if (!user) return;

  let subjects = [];
  try {
    // apiClient.get() already unwraps each of these single-key envelopes
    // down to the bare array itself (see client/js/api-client.js's
    // unwrap()): GET /api/subjects -> { success, subjects }, GET
    // /api/rooms -> { success, rooms }, and GET /api/doctors / GET
    // /api/tas -> { success, items } (server/controllers/
    // staffController.factory.js's shared `list`). So all four of
    // subjectsRes/roomsRes/doctorsRes/tasRes ARE the arrays themselves —
    // reading a further `.items` off doctorsRes/tasRes was reading a
    // property that doesn't exist on an already-unwrapped array,
    // producing `undefined`. That `undefined` was then passed as the
    // list to populateSelectOptions('tpl-doctorId'/'tpl-taId', ...)
    // inside openTemplateModal(), whose `for (const item of list)` threw
    // synchronously on the very next click of "New Recurring Class" —
    // before the modal's `hidden` flag was ever cleared, and with the
    // click handler itself uncaught, so nothing visible happened at all
    // (confirmed root cause of the "New Recurring Class does nothing"
    // report; same unwrap-vs-destructure pattern as the Admin Students
    // list-load bug).
    const [subjectsRes, roomsRes, doctorsRes, tasRes] = await Promise.all([
      apiClient.get('/api/subjects'),
      apiClient.get('/api/rooms'),
      apiClient.get('/api/doctors'),
      apiClient.get('/api/tas'),
    ]);
    subjects = subjectsRes;
    rooms = roomsRes;
    doctors = doctorsRes;
    tas = tasRes;
  } catch (err) {
    const alertContainer = document.getElementById('shell-page-alert');
    if (alertContainer) showAlert(alertContainer, 'Could not load Subjects/Rooms/Doctors/TAs — some forms may be incomplete.', 'error');
  }
  subjectsById = new Map(subjects.map((s) => [String(s._id), s]));
  roomsById = new Map(rooms.map((r) => [String(r._id), r]));

  document.getElementById('week-prev')?.addEventListener('click', goToPreviousWeek);
  document.getElementById('week-next')?.addEventListener('click', goToNextWeek);
  document.getElementById('week-today')?.addEventListener('click', goToThisWeek);

  document.getElementById('change-type')?.addEventListener('change', applyChangeTypeVisibility);
  document.getElementById('change-form-cancel')?.addEventListener('click', closeChangeModal);
  document.getElementById('change-form')?.addEventListener('submit', handleChangeSubmit);
  document.getElementById('change-modal-backdrop')?.addEventListener('click', (ev) => {
    if (ev.target.id === 'change-modal-backdrop') closeChangeModal();
  });

  document.getElementById('create-template-btn')?.addEventListener('click', openTemplateModal);
  document.getElementById('template-form-cancel')?.addEventListener('click', closeTemplateModal);
  document.getElementById('template-form')?.addEventListener('submit', handleTemplateSubmit);
  document.getElementById('template-modal-backdrop')?.addEventListener('click', (ev) => {
    if (ev.target.id === 'template-modal-backdrop') closeTemplateModal();
  });

  resetActiveDayForWeek();
  await loadWeek();
})();
