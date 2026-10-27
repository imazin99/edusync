/**
 * client/js/pages/student-schedule.js
 *
 * Student Schedule page (spec sections 8, 9, 22-23, 29, 81-84). Shows the
 * student's weekly schedule, one academic week (Saturday -> Thursday, spec
 * section 22) at a time, with previous/next/this-week navigation and a
 * day-by-day view for mobile.
 *
 * REAL API call only (spec: reuse existing contracts, never invent one):
 *   GET /api/schedule?startDate=...&endDate=...   (same contract already
 *     used by the Student Dashboard's "Next Class" lookahead — see
 *     client/js/pages/student-dashboard.js)
 *   GET /api/subjects / GET /api/rooms             (id -> name/room lookups)
 *
 * GROUP VISIBILITY — documented interpretation: the Student Dashboard's
 * "Today" sections intentionally filter sessions down to what applies to
 * the logged-in student (group ALL or their own group) — a reasonable
 * narrowing for a "what's relevant to me right now" summary. This
 * dedicated Schedule page instead follows spec section 9 literally
 * ("Students can see both groups where applicable... Example: SECTION
 * Group 1 and SECTION Group 2") and shows every session returned by the
 * API for the viewed week, both sections included, with the student's own
 * group given the existing visual highlight (schedule-widgets.js's
 * `isOwnGroup` styling, unchanged). This matches the backend itself: the
 * schedule API applies no group/role-based filtering at all
 * (server/controllers/schedule.controller.js's getRange has no such
 * logic) — group filtering is purely a frontend display choice, and the
 * dashboard's choice and this page's choice are two different, equally
 * valid answers to "what's useful to show here".
 *
 * ORIGINAL vs CURRENT DATE — a session is placed in the day column
 * matching its ORIGINAL date (the identity date the API query itself is
 * keyed by — see ScheduleService.getSessionsForRange's doc comment: every
 * returned session's original `date` falls inside [startDate, endDate]).
 * If a one-time DAY_CHANGED change later moved the session to a different
 * calendar date (session.current.date), that is surfaced as a small
 * "Moved to <date>" note appended under the reused class card, rather
 * than silently displaying the new date/time with no explanation of which
 * day it's filed under. This keeps the shared buildClassCard() helper
 * (used identically by the Dashboard) completely unchanged.
 *
 * KNOWN LIMITATION (inherited, not introduced here — see
 * schedule-widgets.js's own file header for the full explanation): a
 * Student session cannot resolve a doctorId/taId to a display name (GET
 * /api/doctors and GET /api/tas are Admin-only), so the Doctor/TA line
 * from spec section 83's example card is not rendered, exactly as on the
 * Dashboard.
 */
import { initAppShell } from '../app-shell.js';
import { apiClient, ApiError } from '../api-client.js';
import { showAlert, clearAlert } from '../ui.js';
import { buildClassCard, buildEmptyState, buildSkeletonCard } from '../schedule-widgets.js';

const DAY_ORDER = ['SATURDAY', 'SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY'];
const DAY_LABELS = {
  SATURDAY: 'Saturday',
  SUNDAY: 'Sunday',
  MONDAY: 'Monday',
  TUESDAY: 'Tuesday',
  WEDNESDAY: 'Wednesday',
  THURSDAY: 'Thursday',
};
const DAYS_IN_WEEK = DAY_ORDER.length; // 6 — the academic week is Saturday -> Thursday (spec section 22)
// A WEEK-NAVIGATION STEP IS ALWAYS 7 REAL CALENDAR DAYS, never DAYS_IN_WEEK
// (6, the number of columns actually *displayed* since Friday is off).
// Bug fix (2026-10): goToPreviousWeek/goToNextWeek used to step by
// DAYS_IN_WEEK (6), which moves `weekStart` 6 days instead of a true
// 7-day week — e.g. Saturday - 6 days = the following Sunday, not the
// prior Saturday. Each navigation therefore shifted `weekStart` one
// weekday further off its Saturday anchor, and because the displayed
// day-column headers are positional labels (DAY_ORDER[index]) rather
// than derived from each column's actual date, a session kept its
// correct real calendar date but appeared to "move" to a different
// weekday column every time the user navigated — compounding with each
// click, exactly as reported. Session dates themselves were never wrong
// (ScheduleService.getSessionsForRange matches each day in the requested
// range against the template's real dayOfWeek independently of the
// window's alignment) — this was a pure client-side display bug.
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

/**
 * The most recent Saturday on/before `date` (UTC date-only). The academic
 * week off-day is "somewhere in the middle" and configurable per spec
 * section 22 — nothing here assumes which day that is; a day simply shows
 * "No classes" like any other day with none, official-off-day or not.
 */
function startOfAcademicWeek(date) {
  const d = dateOnly(date);
  const jsDay = d.getUTCDay(); // 0=Sunday .. 6=Saturday
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

function messageForError(err) {
  if (err instanceof ApiError) {
    if (err.status === 0) return 'Could not reach the server. Check your connection and try again.';
    if (err.isMaintenance) {
      return err.message || 'The system is temporarily under maintenance. Please try again shortly.';
    }
    return err.message || 'Could not load the schedule.';
  }
  return 'Could not load the schedule.';
}

// ---------------------------------------------------------------------
// Page state
// ---------------------------------------------------------------------

let weekStart = startOfAcademicWeek(new Date());
let activeDayIndex = 0;
let subjectsById = new Map();
let roomsById = new Map();
let studentGroup = null;

function weekDates() {
  return Array.from({ length: DAYS_IN_WEEK }, (_, i) => addDays(weekStart, i));
}

/** Keeps the active day tab pointing at "today" when the newly selected week contains it, else defaults to the first day. */
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
  text.textContent = messageForError(err);
  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'btn btn--secondary';
  retryBtn.style.marginLeft = 'var(--space-3)';
  retryBtn.textContent = 'Retry';
  retryBtn.addEventListener('click', onRetry);
  wrap.append(label, text, retryBtn);
  alertContainer.appendChild(wrap);
}

/** Groups sessions by their ORIGINAL (identity) date — see file header for why. */
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

/** Appends a small "Moved to <date>" note when a DAY_CHANGED change moved this session off its original date. */
function annotateMovedDate(cardEl, session) {
  if (!session.current.date) return;
  const movedDate = dateOnly(session.current.date);
  const originalDate = dateOnly(session.date);
  if (movedDate.getTime() === originalDate.getTime()) return;
  const note = document.createElement('p');
  note.className = 'class-card__room';
  note.textContent = `Moved to ${formatDateLabel(movedDate)}`;
  cardEl.appendChild(note);
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
      const card = buildClassCard(session, { subjectsById, roomsById, studentGroup });
      annotateMovedDate(card, session);
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
    grid.appendChild(
      buildEmptyState('No classes this week', 'There are no classes scheduled for the selected week.')
    );
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
// Entry point
// ---------------------------------------------------------------------

(async function initStudentSchedulePage() {
  const user = await initAppShell({ requiredRole: 'STUDENT' });
  if (!user) return; // initAppShell already redirected (logged out / wrong role / fatal error shown)

  studentGroup = user.student ? user.student.group : null;

  let subjects = [];
  let rooms = [];
  try {
    [subjects, rooms] = await Promise.all([apiClient.get('/api/subjects'), apiClient.get('/api/rooms')]);
  } catch (err) {
    // Subject/room names won't resolve, but the schedule itself (times,
    // badges, groups) is still useful — degrade gracefully rather than
    // blanking the whole page over a lookup failure, matching the
    // Dashboard's existing behavior for the same failure.
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

  resetActiveDayForWeek();
  await loadWeek();
})();
