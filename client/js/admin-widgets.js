/**
 * client/js/admin-widgets.js
 *
 * Shared rendering helpers for the Admin Dashboard phase's many list/CRUD
 * pages (Students, Doctors, TAs, Leaders, Subjects, Rooms, Audit Logs,
 * Requests). New, additive module — does not modify any existing page or
 * shared file from a prior phase.
 *
 * Reuses the existing `.table` / `.table-wrap` / `.table-as-cards` CSS
 * (client/css/components.css, already defined but unused by any page
 * until now) rather than inventing a new list layout, and the existing
 * `.modal-backdrop` / `.modal` classes (already wired by the Doctor/TA/
 * Leader phases) for Create/Edit forms.
 *
 * Same "widgets render, pages fetch" rule as schedule-widgets.js/
 * task-widgets.js/notification-widgets.js — nothing here calls apiClient.
 */

export function el(tag, { className, text, attrs } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

export function badge(text, variant) {
  return el('span', { className: `badge${variant ? ` badge--${variant}` : ''}`, text });
}

/**
 * Builds a `.table` inside a `.table-wrap` (becomes stacked cards on
 * mobile via `.table-as-cards` — spec section 99). `columns` is an array
 * of header labels. `rows` is an array of arrays; each cell is either a
 * string (set as textContent) or a Node (appended as-is, e.g. a badge or
 * an actions button group) — same contract as `el()`'s `text` vs manual
 * append split used throughout task-widgets.js/schedule-widgets.js.
 */
export function buildTable(columns, rows) {
  const wrap = el('div', { className: 'table-wrap' });
  const table = el('table', { className: 'table table-as-cards' });

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const col of columns) headRow.appendChild(el('th', { text: col }));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    row.forEach((cell, i) => {
      const td = document.createElement('td');
      // data-label powers the mobile card layout's row labels, matching
      // the header text for that column — same pattern the
      // `.table-as-cards` CSS rule already expects.
      td.setAttribute('data-label', columns[i] || '');
      if (cell instanceof Node) td.appendChild(cell);
      else td.textContent = cell ?? '—';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

export function buildEmptyState(title, message) {
  const wrap = el('div', { className: 'empty-state' });
  wrap.appendChild(el('h3', { text: title }));
  wrap.appendChild(el('p', { text: message }));
  return wrap;
}

export function buildSkeletonCard() {
  const card = el('div', { className: 'card' });
  card.appendChild(el('div', { className: 'skeleton skeleton--line' }));
  card.appendChild(el('div', { className: 'skeleton skeleton--line' }));
  return card;
}

/** Row-level action buttons (Edit, Deactivate, Reset Password, etc.). */
export function buildActions(buttons) {
  const wrap = el('div', { className: 'class-card__actions' });
  for (const { label, variant = 'secondary', onClick, disabled } of buttons) {
    const btn = el('button', { className: `btn btn--${variant}`, text: label });
    btn.type = 'button';
    if (disabled) btn.disabled = true;
    btn.addEventListener('click', onClick);
    wrap.appendChild(btn);
  }
  return wrap;
}

export function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
