/**
 * client/js/nav-config.js
 *
 * Role-aware navigation FOUNDATION (frontend phase, step 7). This is data
 * + a tiny renderer, not a page — no page in this phase is authenticated,
 * so nothing calls renderNav() yet. Later phases' pages (student/doctor/
 * ta/leader/admin dashboards etc.) import this so every page's nav stays
 * consistent and in one place, rather than copy-pasted per page.
 *
 * Routes are exactly spec section 80's per-role list — nothing added,
 * nothing guessed. Each target is a real static HTML page path (see the
 * phase report for why these are .html paths rather than the spec's
 * extension-less notation, e.g. "/student/dashboard").
 *
 * A route here existing in this list does NOT mean its page is built yet
 * — building those pages is explicitly later-phase work. This file only
 * describes where each role's nav SHOULD eventually point.
 */
export const NAV_BY_ROLE = {
  STUDENT: [
    { label: 'Dashboard', href: '/pages/student/dashboard.html' },
    { label: 'Schedule', href: '/pages/student/schedule.html' },
    { label: 'Changes', href: '/pages/student/changes.html' },
    { label: 'Tasks', href: '/pages/student/tasks.html' },
    { label: 'Notifications', href: '/pages/student/notifications.html' },
    { label: 'Profile', href: '/pages/student/profile.html' },
  ],
  DOCTOR: [
    { label: 'Dashboard', href: '/pages/doctor/dashboard.html' },
    // NOTE (bug fix, 2026-10): this list used to also have a separate
    // "Schedule" entry pointing at /pages/doctor/schedule.html. That page
    // was never built — see doctor-full-schedule.js's file header for the
    // documented reason (a "my own subject only" view can't be built
    // without a backend change to expose this Doctor's own Doctor._id,
    // which no existing endpoint returns to a Doctor-role caller) — so the
    // link 404'd. "Full Schedule" below already covers the spec's "view
    // the schedule" requirement with a real, working page, so the dead
    // duplicate entry was removed rather than left broken or pointed at a
    // page that doesn't actually implement what its label promised.
    { label: 'Full Schedule', href: '/pages/doctor/full-schedule.html' },
    { label: 'Tasks', href: '/pages/doctor/tasks.html' },
    { label: 'Notifications', href: '/pages/doctor/notifications.html' },
    { label: 'History', href: '/pages/doctor/history.html' },
    { label: 'Profile', href: '/pages/doctor/profile.html' },
  ],
  TA: [
    { label: 'Dashboard', href: '/pages/ta/dashboard.html' },
    // NOTE (bug fix, 2026-10): see the identical DOCTOR comment above —
    // the separate "Schedule" (my own subject only) page was never built
    // for TA either, for the same reason (ta-full-schedule.js's file
    // header). The dead entry was removed; "Full Schedule" is the real,
    // working page.
    { label: 'Full Schedule', href: '/pages/ta/full-schedule.html' },
    { label: 'Tasks', href: '/pages/ta/tasks.html' },
    { label: 'Notifications', href: '/pages/ta/notifications.html' },
    { label: 'History', href: '/pages/ta/history.html' },
    { label: 'Profile', href: '/pages/ta/profile.html' },
  ],
  LEADER: [
    { label: 'Dashboard', href: '/pages/leader/dashboard.html' },
    { label: 'Schedule', href: '/pages/leader/schedule.html' },
    { label: 'Tasks', href: '/pages/leader/tasks.html' },
    { label: 'Notifications', href: '/pages/leader/notifications.html' },
    { label: 'History', href: '/pages/leader/history.html' },
    { label: 'Profile', href: '/pages/leader/profile.html' },
  ],
  ADMIN: [
    { label: 'Dashboard', href: '/pages/admin/dashboard.html' },
    { label: 'Students', href: '/pages/admin/students.html' },
    { label: 'Doctors', href: '/pages/admin/doctors.html' },
    { label: 'TAs', href: '/pages/admin/tas.html' },
    { label: 'Leaders', href: '/pages/admin/leaders.html' },
    { label: 'Subjects', href: '/pages/admin/subjects.html' },
    { label: 'Rooms', href: '/pages/admin/rooms.html' },
    { label: 'Schedule', href: '/pages/admin/schedule.html' },
    { label: 'Changes', href: '/pages/admin/changes.html' },
    { label: 'Tasks', href: '/pages/admin/tasks.html' },
    { label: 'Notifications', href: '/pages/admin/notifications.html' },
    { label: 'Requests', href: '/pages/admin/requests.html' },
    { label: 'Audit Logs', href: '/pages/admin/audit-logs.html' },
    { label: 'Settings', href: '/pages/admin/settings.html' },
  ],
};

/**
 * Renders a simple nav list into `container` for the given role. Marks
 * the link matching `currentPath` with aria-current="page" and a
 * `.nav-link--active` class (css/components.css). Not called by any
 * page yet in this phase — provided ready for the pages that need it.
 */
export function renderNav(container, role, currentPath = window.location.pathname) {
  const items = NAV_BY_ROLE[role] || [];
  container.innerHTML = '';
  const list = document.createElement('ul');
  list.className = 'nav-list';
  for (const item of items) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = item.href;
    a.textContent = item.label;
    a.className = 'nav-link';
    if (item.href === currentPath) {
      a.classList.add('nav-link--active');
      a.setAttribute('aria-current', 'page');
    }
    li.appendChild(a);
    list.appendChild(li);
  }
  container.appendChild(list);
}
