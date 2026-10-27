/**
 * client/js/pages/doctor-full-schedule.js
 *
 * Doctor Full Schedule page — Doctor Dashboard phase (spec: "Ability to
 * view the all-subjects schedule where specified" + "One-time schedule
 * changes only, respecting existing permissions").
 *
 * REAL API calls only:
 *   GET  /api/schedule?startDate=...&endDate=...   (same contract the
 *     Student Schedule page already uses)
 *   GET  /api/subjects / GET /api/rooms             (id -> name lookups)
 *   POST /api/schedule/:sessionId/change            { current, reason }
 *
 * WHY THIS SHOWS EVERY SUBJECT, NOT JUST "MY OWN": this is intentionally
 * the all-subjects view (see client/js/nav-config.js's "Full Schedule"
 * nav entry, distinct from "Schedule"). GET /api/schedule itself applies
 * no role/subject filtering at all (server/controllers/
 * schedule.controller.js's getRange calls scheduleService directly, with
 * no ReadScopeService involved — unlike GET /api/tasks or GET
 * /api/schedule/changes, which ARE auto-scoped for Doctor/TA, see
 * doctor-tasks.js's file header), so an unfiltered fetch here is correct,
 * not a limitation.
 *
 * KNOWN, REPORTED LIMITATION — THE SEPARATE "Schedule" (my own subject's
 * classes only) PAGE IS NOT BUILT THIS PHASE: nav-config.js pre-plans a
 * second "Schedule" route, distinct from this "Full Schedule" page,
 * matching spec's "Doctor's own weekly schedule" requirement. Building it
 * correctly requires filtering sessions to subjects where
 * Subject.doctorId equals the logged-in Doctor's own Doctor._id — and no
 * client-accessible API in this project ever returns that id: GET
 * /api/auth/me's doctor profile is `{ fullName }` only
 * (server/controllers/auth.controller.js's serializeUser), and GET
 * /api/doctors (the only endpoint that could resolve userId -> Doctor._id)
 * is Admin-only (server/routes/doctors.routes.js). Building "my schedule"
 * without that id would mean either showing the exact same unfiltered
 * list as this page under a misleading "my own" label, or guessing at a
 * filter — both rejected per this phase's "do not invent business rules"
 * instruction. Reported in the phase report, with the minimal suggested
 * backend addition (one extra field on serializeUser's existing `doctor`
 * object, no schema change), rather than built around here.
 *
 * PERMISSION MODEL FOR "Propose Change": every session's card gets a
 * Propose Change button, regardless of subject — this widget (and this
 * page) cannot locally know which subjects the Doctor owns (same root
 * cause as above). The real boundary is 100% server-side
 * (ScheduleService.assertCanEditSession, already enforced before this
 * phase) — attempting to change a session for a subject this Doctor does
 * not teach is rejected with "You can only edit schedule for your own
 * subject" (403), shown in the modal's own alert region. This matches
 * "the frontend never determines permissions" (client/README.md),
 * exactly as doctor-tasks.js's Create Task subject dropdown does for the
 * same reason.
 */
import { initAppShell } from '../app-shell.js';
import { apiClient, ApiError } from '../api-client.js';
import { showAlert, clearAlert, setButtonLoading } from '../ui.js';
import { buildManageableClassCard, buildEmptyState, buildSkeletonCard } from '../schedule-widgets.js';

const DAY_ORDER = ['SATURDAY', 'SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY'];
const DAY_LABELS = {
  SATURDAY: 'Saturday',
  SUNDAY: 'Sunday',
  MONDAY: 'Monday',
  TUESDAY: 'Tuesday',
  WEDNESDAY: 'Wednesday',
  THURSDAY: 'Thursday',
};
const DAYS_IN_WEEK = DAY_ORDER.length;
// Week-navigation step is always 7 real calendar days, never DAYS_IN_WEEK
// (6 displayed columns, Friday excluded) — see student-schedule.js's
// matching comment for the full bug explanation (weekday drift on
// previous/next navigation).
const DAYS_IN_CALENDAR_WEEK = 7;
const SKELETON_COUNT = 3;

function dateOnly(d) {
  const copy = new Date(d);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}
function addDays(d, n) {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + n);
  return copy;
}
function toDateParam(d) {
  return d.toISOString().slice(0, 10);
}
function startOfAcademicWeek(date) {
  const d = dateOnly(date);
  const jsDay = d.getUTCDay();
  const daysSinceSaturday = (jsDay - 6 + 7) % 7;
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
    if (err.isMaintenance) {
      return err.message || 'The system is temporarily under maintenance. Please try again shortly.';
    }
    return err.message || fallback;
  }
  return fallback;
}

// ---------------------------------------------------------------------
// Page state
// ---------------------------------------------------------------------

let weekStart = startOfAcademicWeek(new Date());
let activeDayIndex = 0;
let subjectsById = new Map();
let roomsById = new Map();
let rooms = [];
let sessionsById = new Map();

function weekDates() {
  return Array.from({ length: DAYS_IN_WEEK }, (_, i) => addDays(weekStart, i));
}

function resetActiveDayForWeek() {
  const today = dateOnly(new Date());
  const diffDays = Math.round((today.getTime() - weekStart.getTime()) / 86400000);
  activeDayIndex = diffDays >= 0 && diffDays < DAYS_IN_WEEK ? diffDays : 0;
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------

function renderWeekLabel() {
  const label = document.getElementById('week-range-label');
  if (!label) return;
  const end = addDays(weekStart, DAYS_IN_WEEK - 1);
  label.textContent = formatWeekRangeLabel(weekStart, end);
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
    tab.addEventListener('click', () => {
      activeDayIndex = index;
      applyActiveDayVisibility();
    });
    container.appendChild(tab);
  });
  applyActiveDayVisibility();
}

function applyActiveDayVisibility() {
  for (let i = 0; i < DAYS_IN_WEEK; i += 1) {
    const tab = document.getElementById(`day-tab-${i}`);
    const column = document.getElementById(`schedule-day-${i}`);
    const active = i === activeDayIndex;
    if (tab) {
      tab.classList.toggle('day-tab--active', active);
      tab.setAttribute('aria-selected', String(active));
    }
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
  alertContainer.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'alert alert--error';
  wrap.setAttribute('role', 'alert');
  const label = document.createElement('strong');
  label.className = 'alert__label';
  label.textContent = 'Error: ';
  const text = document.createElement('span');
  text.textContent = messageForError(err, 'Could not load the schedule.');
  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'btn btn--secondary';
  retryBtn.style.marginLeft = 'var(--space-3)';
  retryBtn.textContent = 'Retry';
  retryBtn.addEventListener('click', onRetry);
  wrap.append(label, text, retryBtn);
  alertContainer.appendChild(wrap);
}

function groupByDay(sessions) {
  const map = new Map();
  weekDates().forEach((date) => map.set(toDateParam(date), []));
  for (const session of sessions) {
    const key = toDateParam(dateOnly(session.date));
    if (map.has(key)) map.get(key).push(session);
  }
  for (const list of map.values()) {
    list.sort((a, b) => (a.current.startTime || '').localeCompare(b.current.startTime || ''));
  }
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
      sessionsById.set(String(session._id), session);
      const card = buildManageableClassCard(session, {
        subjectsById,
        roomsById,
        onProposeChange: (s) => openChangeModal(s),
      });
      body.appendChild(card);
    }
  }
  column.appendChild(body);
  return column;
}

function renderWeek(sessions) {
  const alertContainer = document.getElementById('schedule-alert');
  if (alertContainer) clearAlert(alertContainer);

  const grid = document.getElementById('schedule-week-grid');
  if (!grid) return;
  grid.innerHTML = '';

  if (sessions.length === 0) {
    grid.appendChild(buildEmptyState('No classes this week', 'There are no classes scheduled for the selected week.'));
    return;
  }

  const grouped = groupByDay(sessions);
  weekDates().forEach((date, index) => {
    const dayName = DAY_ORDER[index];
    const daySessions = grouped.get(toDateParam(date)) || [];
    grid.appendChild(buildDayColumn({ date, dayName, sessions: daySessions, index }));
  });
  applyActiveDayVisibility();
}

// ---------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------

async function loadWeek() {
  renderWeekLabel();
  renderDayTabs();
  setLoadingGrid();
  try {
    const start = weekStart;
    const end = addDays(weekStart, DAYS_IN_WEEK - 1);
    const sessions = await apiClient.get(`/api/schedule?startDate=${toDateParam(start)}&endDate=${toDateParam(end)}`);
    renderWeek(sessions);
  } catch (err) {
    setGridError(err, () => loadWeek());
  }
}

function goToPreviousWeek() {
  weekStart = addDays(weekStart, -DAYS_IN_CALENDAR_WEEK);
  resetActiveDayForWeek();
  loadWeek();
}
function goToNextWeek() {
  weekStart = addDays(weekStart, DAYS_IN_CALENDAR_WEEK);
  resetActiveDayForWeek();
  loadWeek();
}
function goToThisWeek() {
  weekStart = startOfAcademicWeek(new Date());
  resetActiveDayForWeek();
  loadWeek();
}

// ---------------------------------------------------------------------
// Propose Change modal
// ---------------------------------------------------------------------

function populateRoomSelect() {
  const select = document.getElementById('change-room');
  if (!select) return;
  select.innerHTML = '';
  for (const room of rooms) {
    const option = document.createElement('option');
    option.value = room._id;
    option.textContent = [room.building, room.roomNumber].filter(Boolean).join(' · ') || room._id;
    select.appendChild(option);
  }
}

function openChangeModal(session) {
  populateRoomSelect();
  clearAlert(document.getElementById('change-form-alert'));
  document.getElementById('change-session-id').value = session._id;
  document.getElementById('change-start-time').value = session.current.startTime || '';
  document.getElementById('change-end-time').value = session.current.endTime || '';
  if (session.current.roomId) document.getElementById('change-room').value = String(session.current.roomId);
  document.getElementById('change-status').value = session.status || 'ACTIVE';
  document.getElementById('change-reason').value = '';
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

  const submitBtn = document.getElementById('change-form-submit');
  setButtonLoading(submitBtn, true, 'Submitting…');
  try {
    await apiClient.post(`/api/schedule/${sessionId}/change`, {
      current: { startTime, endTime, roomId, status },
      reason,
    });
    closeChangeModal();
    await loadWeek();
  } catch (err) {
    setButtonLoading(submitBtn, false);
    showAlert(alertContainer, messageForError(err, 'Could not submit the change.'), 'error');
  }
}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

(async function initDoctorFullSchedulePage() {
  const user = await initAppShell({ requiredRole: 'DOCTOR' });
  if (!user) return; // initAppShell already redirected (logged out / wrong role / fatal error shown)

  let subjects = [];
  try {
    [subjects, rooms] = await Promise.all([apiClient.get('/api/subjects'), apiClient.get('/api/rooms')]);
  } catch (err) {
    const alertContainer = document.getElementById('shell-page-alert');
    if (alertContainer) {
      showAlert(alertContainer, 'Could not load subject/room details — schedule cards may be incomplete.', 'error');
    }
  }
  subjectsById = new Map(subjects.map((s) => [String(s._id), s]));
  roomsById = new Map(rooms.map((r) => [String(r._id), r]));

  document.getElementById('week-prev')?.addEventListener('click', goToPreviousWeek);
  document.getElementById('week-next')?.addEventListener('click', goToNextWeek);
  document.getElementById('week-today')?.addEventListener('click', goToThisWeek);

  document.getElementById('change-form-cancel')?.addEventListener('click', closeChangeModal);
  document.getElementById('change-form')?.addEventListener('submit', handleChangeSubmit);
  document.getElementById('change-modal-backdrop')?.addEventListener('click', (ev) => {
    if (ev.target.id === 'change-modal-backdrop') closeChangeModal();
  });

  resetActiveDayForWeek();
  await loadWeek();
})();
