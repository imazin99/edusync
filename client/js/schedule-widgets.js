/**
 * client/js/schedule-widgets.js
 *
 * Pure rendering helpers for schedule data (spec section 116: "Separate
 * ... Schedule rendering" into its own module). Nothing here calls
 * fetch() or apiClient — it only turns already-fetched ScheduleSession
 * documents (plus small subject/room lookup maps the caller built) into
 * DOM. Kept separate from client/js/pages/student-dashboard.js so the
 * same card-building logic can be reused by the (not-yet-built)
 * /student/schedule and /student/changes pages without copy-pasting it.
 *
 * KNOWN, REPORTED LIMITATION: ScheduleSession.current/original only carry
 * doctorId/taId (ObjectId references) — never a resolvable name. The
 * only endpoints that return a Doctor/TA's fullName (GET /api/doctors,
 * GET /api/tas) are Admin-only (server/routes/doctors.routes.js,
 * tas.routes.js both apply requireRole(ROLES.ADMIN) to the whole
 * router), so a Student has no API available to resolve "which doctor is
 * teaching this class" into a display name. Per the instruction not to
 * invent data standing in for a real API, the Doctor/TA line from spec
 * section 81/83 is deliberately NOT rendered here, rather than showing a
 * raw database id or a fabricated name. See the phase report.
 */

const CLASS_TYPE_LABELS = {
  LECTURE: 'LECTURE',
  SECTION: 'SECTION',
};

const GROUP_LABELS = {
  ALL: 'ALL STUDENTS',
  G1: 'GROUP 1',
  G2: 'GROUP 2',
};

const CHANGE_TYPE_LABELS = {
  TIME_CHANGED: 'TIME CHANGED',
  DAY_CHANGED: 'DAY CHANGED',
  ROOM_CHANGED: 'ROOM CHANGED',
  DOCTOR_CHANGED: 'DOCTOR CHANGED',
  TA_CHANGED: 'TA CHANGED',
  CANCELLED: 'CANCELLED',
  ONLINE: 'ONLINE',
  RESTORED: 'RESTORED',
  OTHER: 'CHANGED',
};

const CHANGED_BY_ROLE_LABELS = {
  DOCTOR: 'Doctor',
  TA: 'TA',
  LEADER: 'Leader',
  ADMIN: 'Admin',
};

const DAY_LABELS_FULL = {
  SATURDAY: 'Saturday',
  SUNDAY: 'Sunday',
  MONDAY: 'Monday',
  TUESDAY: 'Tuesday',
  WEDNESDAY: 'Wednesday',
  THURSDAY: 'Thursday',
};

function el(tag, { className, text, attrs } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  }
  return node;
}

function badge(text, variant) {
  return el('span', { className: `badge${variant ? ` badge--${variant}` : ''}`, text });
}

/** "H204" style room label built only from real building/floor/roomNumber fields — nothing invented. */
export function formatRoomLabel(room) {
  if (!room) return null;
  return [room.building, room.floor ? `Floor ${room.floor}` : null, room.roomNumber]
    .filter(Boolean)
    .join(' · ');
}

export function formatSubjectName(subject) {
  if (!subject) return null;
  return subject.code ? `${subject.name} (${subject.code})` : subject.name;
}

/** Whether a session's current state differs from its original state (spec sections 29/84). */
export function isSessionChanged(session) {
  const { original, current } = session;
  if (!original || !current) return false;
  return (
    original.startTime !== current.startTime ||
    original.endTime !== current.endTime ||
    String(original.roomId || '') !== String(current.roomId || '') ||
    String(original.doctorId || '') !== String(current.doctorId || '') ||
    String(original.taId || '') !== String(current.taId || '') ||
    session.status !== 'ACTIVE' ||
    (current.date && String(current.date) !== String(session.date))
  );
}

function timeRange(state) {
  if (!state || !state.startTime || !state.endTime) return '';
  return `${state.startTime} – ${state.endTime}`;
}

/**
 * Builds one class card (spec section 83) for a session. `lookups`
 * provides `{ subjectsById, roomsById }` the caller already fetched.
 * `studentGroup` (e.g. 'G1') is used only to apply the "own group"
 * visual highlight (spec section 9) — it never filters what's shown.
 */
export function buildClassCard(session, { subjectsById, roomsById, studentGroup, emphasize = false } = {}) {
  const subject = subjectsById.get(String(session.subjectId));
  const room = roomsById.get(String(session.current.roomId));
  const changed = isSessionChanged(session);
  const isOwnGroup = session.group === studentGroup;

  const card = el('div', {
    className: `card class-card${emphasize ? ' class-card--emphasis' : ''}${isOwnGroup ? ' class-card--own-group' : ''}`,
  });

  const title = el('h3', { className: 'class-card__subject', text: formatSubjectName(subject) || 'Unknown subject' });
  card.appendChild(title);

  const badgeRow = el('div', { className: 'class-card__badges' });
  badgeRow.appendChild(badge(CLASS_TYPE_LABELS[session.type] || session.type));
  badgeRow.appendChild(badge(GROUP_LABELS[session.group] || session.group, isOwnGroup ? 'info' : undefined));
  if (session.status === 'CANCELLED') badgeRow.appendChild(badge('CANCELLED', 'danger'));
  if (session.status === 'ONLINE') badgeRow.appendChild(badge('ONLINE', 'info'));
  if (changed) badgeRow.appendChild(badge('CHANGED', 'warning'));
  card.appendChild(badgeRow);

  const timeEl = el('p', { className: 'class-card__time', text: timeRange(session.current) });
  card.appendChild(timeEl);

  if (room) {
    card.appendChild(el('p', { className: 'class-card__room', text: formatRoomLabel(room) }));
  }

  // Doctor/TA intentionally omitted — see the file-level comment: no
  // Student-accessible API resolves doctorId/taId to a display name.

  return card;
}

/**
 * Builds the "Changed Class Details" comparison block (spec section 84):
 * current vs. originally, plus who changed it and why, when that
 * information is available from the matching ScheduleChange record(s).
 */
export function buildChangeDetailCard(session, { subjectsById, roomsById, changesBySessionId } = {}) {
  const subject = subjectsById.get(String(session.subjectId));
  const originalRoom = roomsById.get(String(session.original.roomId));
  const currentRoom = roomsById.get(String(session.current.roomId));
  const relatedChanges = (changesBySessionId.get(String(session._id)) || []).sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  const latestChange = relatedChanges[0];

  const card = el('div', { className: 'card change-card' });
  card.appendChild(
    el('h3', { className: 'change-card__title', text: `${formatSubjectName(subject) || 'Unknown subject'} — Changed` })
  );

  if (latestChange) {
    // BUG FIX (Student Changes phase): ScheduleChange.changeTypes is an
    // ARRAY (server/models/ScheduleChange.js — one change event can touch
    // several aspects at once, e.g. day+time+room together, spec section
    // 34's "combined changes"). This previously read a non-existent
    // singular `latestChange.changeType`, which was always undefined
    // against the real API response and rendered an empty badge.
    for (const type of latestChange.changeTypes || []) {
      card.appendChild(badge(CHANGE_TYPE_LABELS[type] || type, 'warning'));
    }
    if (latestChange.isPermanent) card.appendChild(badge('PERMANENT CHANGE', 'danger'));
    else card.appendChild(badge('ONE-TIME CHANGE', 'info'));
  }

  const grid = el('div', { className: 'change-card__grid' });

  const currentCol = el('div', { className: 'change-card__col' });
  currentCol.appendChild(el('p', { className: 'change-card__col-label', text: 'Current' }));
  currentCol.appendChild(el('p', { text: timeRange(session.current) }));
  if (currentRoom) currentCol.appendChild(el('p', { text: formatRoomLabel(currentRoom) }));
  grid.appendChild(currentCol);

  const originalCol = el('div', { className: 'change-card__col' });
  originalCol.appendChild(el('p', { className: 'change-card__col-label', text: 'Originally' }));
  originalCol.appendChild(el('p', { text: timeRange(session.original) }));
  if (originalRoom) originalCol.appendChild(el('p', { text: formatRoomLabel(originalRoom) }));
  grid.appendChild(originalCol);

  card.appendChild(grid);

  if (latestChange) {
    const metaRow = el('p', {
      className: 'change-card__meta',
      text: `Changed by: ${CHANGED_BY_ROLE_LABELS[latestChange.changedByRole] || latestChange.changedByRole}`,
    });
    card.appendChild(metaRow);
    if (latestChange.reason) {
      card.appendChild(el('p', { className: 'change-card__meta', text: `Reason: ${latestChange.reason}` }));
    }
  }

  return card;
}

function formatChangeDate(value) {
  if (!value) return null;
  return new Date(value).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatChangeTimestamp(value) {
  if (!value) return '';
  return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * Builds one row for the dedicated Student Changes / change-history page
 * (spec section 8: "View change history"; section 33: ScheduleChange
 * model; section 37: "the history must preserve the complete before/after
 * state"). `change` is one raw ScheduleChange record from
 * GET /api/schedule/changes, augmented by the caller with a `subjectId`
 * string — see client/js/pages/student-changes.js's file header for why
 * the caller (not this function) attaches it: the raw record itself only
 * carries `sessionId`, never `subjectId`, and the caller already knows
 * which subject it queried for.
 *
 * Only `changeTypes` actually present on the record are rendered as
 * detail lines — nothing is inferred or invented for a type not present.
 * DOCTOR_CHANGED/TA_CHANGED intentionally show no before/after NAME (this
 * file's top-of-file "KNOWN, REPORTED LIMITATION": no Student-accessible
 * API resolves a doctorId/taId to a display name) — just that a change of
 * that kind occurred, which is still real, API-sourced information.
 */
export function buildChangeHistoryRow(change, { subjectsById, roomsById } = {}) {
  const subject = subjectsById.get(String(change.subjectId));
  const before = change.before || {};
  const after = change.after || {};
  const changeTypes = change.changeTypes || [];

  const row = el('div', { className: 'card change-history-row' });

  const header = el('div', { className: 'change-history-row__header' });
  header.appendChild(
    el('h3', { className: 'change-history-row__subject', text: formatSubjectName(subject) || 'Unknown subject' })
  );
  const badgeRow = el('div', { className: 'change-history-row__badges' });
  for (const type of changeTypes) {
    badgeRow.appendChild(badge(CHANGE_TYPE_LABELS[type] || type, 'warning'));
  }
  badgeRow.appendChild(badge(change.isPermanent ? 'PERMANENT' : 'ONE-TIME', change.isPermanent ? 'danger' : 'info'));
  header.appendChild(badgeRow);
  row.appendChild(header);

  const details = el('div', { className: 'change-history-row__details' });

  if (changeTypes.includes('TIME_CHANGED')) {
    details.appendChild(
      el('p', { text: `Time: ${timeRange(before) || '—'} → ${timeRange(after) || '—'}` })
    );
  }
  if (changeTypes.includes('DAY_CHANGED')) {
    if (after.dayOfWeek) {
      // Permanent dayOfWeek change — session.current has no dayOfWeek
      // field at all (it's a ScheduleTemplate-level concept), so there is
      // no "before" value to show here, only the new recurring day.
      details.appendChild(
        el('p', { text: `Day of week changed to ${DAY_LABELS_FULL[after.dayOfWeek] || after.dayOfWeek}` })
      );
    } else {
      details.appendChild(
        el('p', { text: `Date: ${formatChangeDate(before.date) || '—'} → ${formatChangeDate(after.date) || '—'}` })
      );
    }
  }
  if (changeTypes.includes('ROOM_CHANGED')) {
    const beforeRoom = formatRoomLabel(roomsById.get(String(before.roomId))) || 'Unknown room';
    const afterRoom = formatRoomLabel(roomsById.get(String(after.roomId))) || 'Unknown room';
    details.appendChild(el('p', { text: `Room: ${beforeRoom} → ${afterRoom}` }));
  }
  if (changeTypes.includes('DOCTOR_CHANGED')) {
    details.appendChild(el('p', { text: 'Doctor changed' }));
  }
  if (changeTypes.includes('TA_CHANGED')) {
    details.appendChild(el('p', { text: 'TA changed' }));
  }
  if (changeTypes.includes('CANCELLED')) {
    details.appendChild(el('p', { text: 'Status: Cancelled' }));
  }
  if (changeTypes.includes('ONLINE')) {
    details.appendChild(el('p', { text: 'Status: Moved online' }));
  }
  if (changeTypes.includes('RESTORED')) {
    details.appendChild(el('p', { text: 'Status: Restored to active' }));
  }
  row.appendChild(details);

  row.appendChild(
    el('p', {
      className: 'change-history-row__meta',
      text: `Changed by ${CHANGED_BY_ROLE_LABELS[change.changedByRole] || change.changedByRole} · ${formatChangeTimestamp(change.createdAt)}`,
    })
  );
  row.appendChild(
    el('p', {
      className: 'change-history-row__reason',
      text: change.reason ? `Reason: ${change.reason}` : 'No reason provided.',
    })
  );

  return row;
}

export function buildEmptyState(title, message) {
  const wrap = el('div', { className: 'empty-state' });
  wrap.appendChild(el('h3', { text: title }));
  wrap.appendChild(el('p', { text: message }));
  return wrap;
}

/**
 * Builds a class card with an added "Propose Change" action, for a
 * one-time-change-capable role (Doctor/TA/Leader/Admin —
 * server/routes/schedule.routes.js gates POST /:sessionId/change behind
 * requireRole(DOCTOR, TA, LEADER, ADMIN)). Wraps buildClassCard (above)
 * unchanged rather than duplicating its markup, so Doctor/Student class
 * cards look and behave identically apart from this one added action.
 *
 * Exactly like buildManageableTaskCard in task-widgets.js, this widget
 * never checks locally whether the actor owns this session's subject —
 * it can't (see doctor-full-schedule.js's file header) — every click
 * still goes through the real API, which is the actual permission
 * boundary (ScheduleService.assertCanEditSession); an unauthorized
 * attempt surfaces its 403 as a normal error, same as any other failed
 * request.
 */
export function buildManageableClassCard(session, { subjectsById, roomsById, emphasize = false, onProposeChange } = {}) {
  const card = buildClassCard(session, { subjectsById, roomsById, emphasize });
  const actions = el('div', { className: 'class-card__actions' });
  const proposeBtn = el('button', { className: 'btn btn--secondary', text: 'Propose Change' });
  proposeBtn.type = 'button';
  proposeBtn.addEventListener('click', () => onProposeChange && onProposeChange(session));
  actions.appendChild(proposeBtn);
  card.appendChild(actions);
  return card;
}

export function buildSkeletonCard() {
  const card = el('div', { className: 'card' });
  const line1 = el('div', { className: 'skeleton' });
  line1.style.height = '20px';
  line1.style.marginBottom = '8px';
  const line2 = el('div', { className: 'skeleton' });
  line2.style.height = '14px';
  line2.style.width = '60%';
  card.appendChild(line1);
  card.appendChild(line2);
  return card;
}
