/**
 * client/js/task-widgets.js
 *
 * Pure rendering helpers for Task cards (spec section 116: "Separate ...
 * Task rendering"; spec section 90: Task UI). Nothing here calls fetch() —
 * callers (client/js/pages/student-dashboard.js, student-tasks.js) fetch
 * tasks and pass them in, along with a subjectsById lookup map.
 * `buildTaskRow` is the Dashboard's compact overview row; `buildTaskCard`
 * (added for the dedicated /student/tasks page this file's header used to
 * describe as "not-yet-built") is the full card with View / Mark as Done /
 * Open Submission and an expandable attachments/links/description panel.
 *
 * KNOWN, REPORTED LIMITATION (creator name): task.createdBy is a User
 * ObjectId. There is no Student-accessible API that resolves an
 * arbitrary User id (or Doctor/TA id) to a display name — the same gap
 * documented in schedule-widgets.js for doctorId/taId. Spec section 54
 * gives three acceptable attribution formats, one of which is role-only
 * ("Created by TA" / "Created by Leader"); that is the form used here,
 * driven by the real `creatorRole` field, rather than inventing a name
 * for `createdBy`.
 *
 * KNOWN, REPORTED LIMITATION (per-student completion state): there is no
 * GET endpoint that returns a student's TaskCompletion rows (only
 * POST/DELETE /api/tasks/:id/complete exist — server/routes/tasks.routes.js).
 * Server/TaskService.markDone() is idempotent (returns the existing
 * record rather than erroring) and unmarkDone() is a safe no-op if
 * nothing exists, so the buttons are always safe to show, but neither this
 * widget nor the page that uses it can know whether a task was ALREADY
 * marked done in a previous session — doing so would mean guessing. The
 * Tasks page (student-tasks.js) tracks completion only for what happens
 * in its own browser session; see that file's header and the phase report.
 */

const CREATOR_ROLE_LABELS = {
  DOCTOR: 'Doctor',
  TA: 'TA',
  LEADER: 'Leader',
  ADMIN: 'Admin',
};

const STATUS_LABELS = {
  ACTIVE: 'Active',
  DUE_SOON: 'Due Soon',
  OVERDUE: 'Overdue',
};

const STATUS_VARIANTS = {
  ACTIVE: 'info',
  DUE_SOON: 'warning',
  OVERDUE: 'danger',
};

function el(tag, { className, text, attrs } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function badge(text, variant) {
  return el('span', { className: `badge${variant ? ` badge--${variant}` : ''}`, text });
}

export function formatDeadline(deadline) {
  if (!deadline) return 'No deadline';
  const d = new Date(deadline);
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Builds a compact task row for the dashboard's Tasks overview (spec
 * section 81 item 4). The full task card with View/Mark as Done/Open
 * Submission/Attachments (spec section 90) belongs to the not-yet-built
 * /student/tasks page — this is deliberately a lighter-weight summary,
 * since the dashboard's job is "here's what's going on", not full task
 * management.
 */
export function buildTaskRow(task, { subjectsById } = {}) {
  const subject = subjectsById.get(String(task.subjectId));

  const row = el('div', { className: 'task-row' });

  const main = el('div', { className: 'task-row__main' });
  main.appendChild(el('p', { className: 'task-row__title', text: task.title }));
  const metaBits = [
    subject ? (subject.code ? `${subject.name} (${subject.code})` : subject.name) : null,
    `Created by ${CREATOR_ROLE_LABELS[task.creatorRole] || task.creatorRole}`,
  ].filter(Boolean);
  main.appendChild(el('p', { className: 'task-row__meta', text: metaBits.join(' · ') }));
  main.appendChild(
    el('p', { className: 'task-row__meta', text: `Deadline: ${formatDeadline(task.deadline)}` })
  );
  row.appendChild(main);

  const side = el('div', { className: 'task-row__side' });
  side.appendChild(badge(STATUS_LABELS[task.status] || task.status, STATUS_VARIANTS[task.status]));
  row.appendChild(side);

  return row;
}

export function buildEmptyState(title, message) {
  const wrap = el('div', { className: 'empty-state' });
  wrap.appendChild(el('h3', { text: title }));
  wrap.appendChild(el('p', { text: message }));
  return wrap;
}

/** "PDF", "DOCX", etc. from a real filename — never invented, just formatted. */
function fileExtensionLabel(filename) {
  const match = /\.([a-zA-Z0-9]+)$/.exec(filename || '');
  return match ? match[1].toUpperCase() : 'FILE';
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Builds the full Task card for the dedicated /student/tasks page (spec
 * section 90), as this file's header already anticipated. The compact
 * `buildTaskRow` above remains the Dashboard's lighter-weight summary —
 * this is the richer card with View / Mark as Done / Open Submission and
 * an expandable attachments/submission-links/description panel.
 *
 * `isCompleted` is supplied by the caller (client/js/pages/student-tasks.js)
 * rather than looked up here — see that file's header for why: there is no
 * API that returns a student's own TaskCompletion rows, so completion can
 * only ever reflect what this page itself has tracked.
 *
 * Buttons never do their own fetch()ing — `onToggleComplete` is called
 * with the task id and lets the page own the real API call, matching this
 * project's existing "widgets render, pages fetch" split
 * (see schedule-widgets.js's own file header for the same rule).
 */
export function buildTaskCard(task, { subjectsById, isCompleted = false, onToggleComplete } = {}) {
  const subject = subjectsById.get(String(task.subjectId));
  const attachments = task.attachments || [];
  const submissionLinks = task.submissionLinks || [];

  const card = el('div', { className: 'card task-card' });

  const header = el('div', { className: 'task-card__header' });
  header.appendChild(el('h3', { className: 'task-card__title', text: task.title }));
  const badgeRow = el('div', { className: 'task-card__badges' });
  badgeRow.appendChild(badge(STATUS_LABELS[task.status] || task.status, STATUS_VARIANTS[task.status]));
  if (isCompleted) badgeRow.appendChild(badge('COMPLETED', 'success'));
  header.appendChild(badgeRow);
  card.appendChild(header);

  const metaBits = [
    subject ? (subject.code ? `${subject.name} (${subject.code})` : subject.name) : null,
    `Created by ${CREATOR_ROLE_LABELS[task.creatorRole] || task.creatorRole}`,
  ].filter(Boolean);
  card.appendChild(el('p', { className: 'task-card__meta', text: metaBits.join(' · ') }));
  card.appendChild(
    el('p', { className: 'task-card__meta', text: `Deadline: ${formatDeadline(task.deadline)}` })
  );

  if (attachments.length > 0) {
    const attachmentsLine = el('p', {
      className: 'task-card__meta',
      text: `Attachments: ${attachments.map((a) => fileExtensionLabel(a.filename)).join(', ')}`,
    });
    card.appendChild(attachmentsLine);
  }

  // ---- Expandable details (description, full attachment/link lists) ----
  const details = el('div', { className: 'task-card__details' });
  details.hidden = true;

  details.appendChild(
    el('p', { className: 'task-card__description', text: task.description || 'No description provided.' })
  );

  if (attachments.length > 0) {
    details.appendChild(el('p', { className: 'task-card__section-label', text: 'Attachments' }));
    const list = el('ul', { className: 'task-card__attachment-list' });
    for (const attachment of attachments) {
      const li = document.createElement('li');
      const link = document.createElement('a');
      link.href = `/api/tasks/${task._id}/attachments/${attachment.storageKey}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = `${attachment.filename} (${fileExtensionLabel(attachment.filename)}${
        Number.isFinite(attachment.size) ? `, ${formatFileSize(attachment.size)}` : ''
      })`;
      li.appendChild(link);
      list.appendChild(li);
    }
    details.appendChild(list);
  }

  if (submissionLinks.length > 0) {
    details.appendChild(el('p', { className: 'task-card__section-label', text: 'Submission Links' }));
    const list = el('ul', { className: 'task-card__link-list' });
    for (const link of submissionLinks) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = link.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = link.label || link.url;
      li.appendChild(a);
      list.appendChild(li);
    }
    details.appendChild(list);
  }

  card.appendChild(details);

  // ---- Actions ----
  const actions = el('div', { className: 'task-card__actions' });

  const viewBtn = el('button', { className: 'btn btn--secondary', text: 'View' });
  viewBtn.type = 'button';
  viewBtn.setAttribute('aria-expanded', 'false');
  viewBtn.addEventListener('click', () => {
    const expanded = !details.hidden;
    details.hidden = expanded;
    viewBtn.setAttribute('aria-expanded', String(!expanded));
    viewBtn.textContent = expanded ? 'View' : 'Hide';
  });
  actions.appendChild(viewBtn);

  const completeBtn = el('button', {
    className: `btn ${isCompleted ? 'btn--secondary' : 'btn--primary'}`,
    text: isCompleted ? 'Undo' : 'Mark as Done',
  });
  completeBtn.type = 'button';
  completeBtn.addEventListener('click', () => onToggleComplete && onToggleComplete(task, completeBtn));
  actions.appendChild(completeBtn);

  // Spec section 90's example card shows a single "Open Submission"
  // button — reproduced directly for the common single-link case. With
  // several links (spec section 49 explicitly allows multiple), a single
  // button can't disambiguate which one to open, so it instead reveals
  // the details panel's full labeled list rather than guessing.
  if (submissionLinks.length === 1) {
    const openLink = document.createElement('a');
    openLink.className = 'btn btn--secondary';
    openLink.href = submissionLinks[0].url;
    openLink.target = '_blank';
    openLink.rel = 'noopener noreferrer';
    openLink.textContent = 'Open Submission';
    actions.appendChild(openLink);
  } else if (submissionLinks.length > 1) {
    const openBtn = el('button', { className: 'btn btn--secondary', text: 'Open Submission' });
    openBtn.type = 'button';
    openBtn.addEventListener('click', () => {
      details.hidden = false;
      viewBtn.setAttribute('aria-expanded', 'true');
      viewBtn.textContent = 'Hide';
    });
    actions.appendChild(openBtn);
  }

  card.appendChild(actions);

  return card;
}

/**
 * Builds the MANAGE version of a Task card, for a creator-capable role
 * (Doctor/TA/Leader/Admin — spec sections 46-47: create/edit/delete own
 * subject's tasks). Reuses the exact same header/meta/details layout and
 * class names as buildTaskCard above (so Doctor/Student task cards look
 * and behave consistently), but swaps the Student-only "Mark as
 * Done"/"Open Submission" actions for Edit/Delete — actions that route
 * tasks.routes.js gates behind requireRole(DOCTOR, TA, LEADER, ADMIN) and
 * never STUDENT, so buildTaskCard (above) intentionally never gained
 * these buttons.
 *
 * Ownership of a given task's subject is NOT checked here — this widget
 * never calls apiClient itself (same "widgets render, pages fetch" rule
 * as every other function in this file) and has no reliable way to know
 * locally whether the current actor owns a given subject (see
 * doctor-tasks.js's file header for why). Every Edit/Delete click still
 * goes through the real API, which is the actual, authoritative
 * permission boundary (TaskService.loadSubjectAndAssertManage) — a 403
 * is surfaced as a normal error by the caller, exactly like any other
 * failed request, rather than being silently prevented client-side.
 */
export function buildManageableTaskCard(task, { subjectsById, onEdit, onDelete } = {}) {
  const subject = subjectsById.get(String(task.subjectId));
  const attachments = task.attachments || [];
  const submissionLinks = task.submissionLinks || [];

  const card = el('div', { className: 'card task-card' });

  const header = el('div', { className: 'task-card__header' });
  header.appendChild(el('h3', { className: 'task-card__title', text: task.title }));
  const badgeRow = el('div', { className: 'task-card__badges' });
  badgeRow.appendChild(badge(STATUS_LABELS[task.status] || task.status, STATUS_VARIANTS[task.status]));
  header.appendChild(badgeRow);
  card.appendChild(header);

  const metaBits = [
    subject ? (subject.code ? `${subject.name} (${subject.code})` : subject.name) : null,
    `Created by ${CREATOR_ROLE_LABELS[task.creatorRole] || task.creatorRole}`,
  ].filter(Boolean);
  card.appendChild(el('p', { className: 'task-card__meta', text: metaBits.join(' · ') }));
  card.appendChild(
    el('p', { className: 'task-card__meta', text: `Deadline: ${formatDeadline(task.deadline)}` })
  );

  if (attachments.length > 0) {
    card.appendChild(
      el('p', {
        className: 'task-card__meta',
        text: `Attachments: ${attachments.map((a) => fileExtensionLabel(a.filename)).join(', ')}`,
      })
    );
  }

  // ---- Expandable details (description, full attachment/link lists) ----
  const details = el('div', { className: 'task-card__details' });
  details.hidden = true;

  details.appendChild(
    el('p', { className: 'task-card__description', text: task.description || 'No description provided.' })
  );

  if (attachments.length > 0) {
    details.appendChild(el('p', { className: 'task-card__section-label', text: 'Attachments' }));
    const list = el('ul', { className: 'task-card__attachment-list' });
    for (const attachment of attachments) {
      const li = document.createElement('li');
      const link = document.createElement('a');
      link.href = `/api/tasks/${task._id}/attachments/${attachment.storageKey}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = `${attachment.filename} (${fileExtensionLabel(attachment.filename)}${
        Number.isFinite(attachment.size) ? `, ${formatFileSize(attachment.size)}` : ''
      })`;
      li.appendChild(link);
      list.appendChild(li);
    }
    details.appendChild(list);
  }

  if (submissionLinks.length > 0) {
    details.appendChild(el('p', { className: 'task-card__section-label', text: 'Submission Links' }));
    const list = el('ul', { className: 'task-card__link-list' });
    for (const link of submissionLinks) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = link.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = link.label || link.url;
      li.appendChild(a);
      list.appendChild(li);
    }
    details.appendChild(list);
  }

  card.appendChild(details);

  // ---- Actions ----
  const actions = el('div', { className: 'task-card__actions' });

  const viewBtn = el('button', { className: 'btn btn--secondary', text: 'View' });
  viewBtn.type = 'button';
  viewBtn.setAttribute('aria-expanded', 'false');
  viewBtn.addEventListener('click', () => {
    const expanded = !details.hidden;
    details.hidden = expanded;
    viewBtn.setAttribute('aria-expanded', String(!expanded));
    viewBtn.textContent = expanded ? 'View' : 'Hide';
  });
  actions.appendChild(viewBtn);

  const editBtn = el('button', { className: 'btn btn--secondary', text: 'Edit' });
  editBtn.type = 'button';
  editBtn.addEventListener('click', () => onEdit && onEdit(task));
  actions.appendChild(editBtn);

  const deleteBtn = el('button', { className: 'btn btn--secondary', text: 'Delete' });
  deleteBtn.type = 'button';
  deleteBtn.addEventListener('click', () => onDelete && onDelete(task, deleteBtn));
  actions.appendChild(deleteBtn);

  card.appendChild(actions);

  return card;
}
