/**
 * client/js/notification-widgets.js
 *
 * Pure rendering helpers for notifications (spec section 116: "Separate
 * ... Notifications"; spec section 92: Notification Page fields — unread/
 * read state, date/time, category, related entity, read state, Mark as
 * Read / Mark All as Read). The caller (student-dashboard.js) fetches
 * from GET /api/notifications and passes the results in; this module
 * only builds DOM and reports which "mark as read" button was clicked
 * via a callback, so it never calls apiClient itself.
 */

const CATEGORY_LABELS = {
  SCHEDULE: 'Schedule',
  TASK: 'Task',
};

const RELATED_TYPE_LABELS = {
  SCHEDULE_SESSION: 'Class',
  TASK: 'Task',
  REQUEST: 'Request',
  BROADCAST: 'Announcement',
  OTHER: 'Other',
};

/**
 * Page-level link for a notification's related entity (spec section 60:
 * "Deep-link to affected schedule/task"). The notification payload only
 * ever carries a raw relatedId (ObjectId) with no resolvable title/date,
 * so this links to the relevant PAGE rather than the specific item —
 * an honest, page-level version of the spec's deep-link idea rather than
 * an invented item-level jump the API can't actually support. REQUEST/
 * BROADCAST/OTHER have no matching Student-facing page in this phase, so
 * no link is shown for those.
 */
const RELATED_TYPE_LINKS = {
  SCHEDULE_SESSION: { href: '/pages/student/schedule.html', label: 'View Schedule' },
  TASK: { href: '/pages/student/tasks.html', label: 'View Tasks' },
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

export function formatTimestamp(value) {
  if (!value) return '';
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Builds one notification row. `item` is the shape GET /api/notifications
 * returns: { recipientId, readAt, notification: { title, message,
 * category, relatedType, createdAt, ... } }. `onMarkRead(recipientId)` is
 * called when the user clicks "Mark as Read" — the caller owns the
 * actual apiClient.patch(...) call and re-render.
 */
export function buildNotificationRow(item, { onMarkRead } = {}) {
  const { notification } = item;
  const isUnread = !item.readAt;

  const row = el('div', { className: `notification-row${isUnread ? ' notification-row--unread' : ''}` });

  const main = el('div', { className: 'notification-row__main' });
  main.appendChild(el('p', { className: 'notification-row__title', text: notification.title }));
  main.appendChild(el('p', { className: 'notification-row__message', text: notification.message }));

  const metaRow = el('div', { className: 'notification-row__meta' });
  metaRow.appendChild(badge(CATEGORY_LABELS[notification.category] || notification.category));
  if (notification.relatedType) {
    metaRow.appendChild(
      el('span', { className: 'notification-row__related', text: RELATED_TYPE_LABELS[notification.relatedType] || notification.relatedType })
    );
  }
  metaRow.appendChild(el('span', { className: 'notification-row__time', text: formatTimestamp(notification.createdAt) }));
  main.appendChild(metaRow);

  const link = notification.relatedType && RELATED_TYPE_LINKS[notification.relatedType];
  if (link) {
    const a = el('a', { className: 'notification-row__link', text: link.label, attrs: { href: link.href } });
    main.appendChild(a);
  }

  row.appendChild(main);

  if (isUnread) {
    const btn = el('button', {
      className: 'btn btn--secondary notification-row__mark-read',
      text: 'Mark as Read',
      attrs: { type: 'button' },
    });
    btn.addEventListener('click', () => onMarkRead(item.recipientId));
    row.appendChild(btn);
  } else {
    row.appendChild(badge('Read'));
  }

  return row;
}

export function buildEmptyState(title, message) {
  const wrap = el('div', { className: 'empty-state' });
  wrap.appendChild(el('h3', { text: title }));
  wrap.appendChild(el('p', { text: message }));
  return wrap;
}
