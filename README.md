# Academic Schedule & Tasks Management System

An academic information management web application for **Level 2 — Medical
Informatics, Beni Suef National University**. It organizes the official
weekly schedule, schedule changes (one-time and permanent), class
cancellations, room/doctor/TA changes, academic tasks and deadlines,
notifications, requests, and administrative history — so important
academic information doesn't get lost in WhatsApp chats.

This is **not** a replacement for WhatsApp. It is the organized source of
truth for schedule and task information.

> **Status: Phase 1 — Foundation.** Only the project skeleton, server
> bootstrap, database connection lifecycle, error handling, and a
> health-check endpoint exist so far. Authentication, data models, the
> schedule engine, tasks, notifications, and the frontend UI are built in
> later phases (see [Implementation Phases](#implementation-phases)).

---

## Tech Stack

- **Frontend:** HTML, CSS, Vanilla JavaScript (no framework)
- **Backend:** Node.js, Express.js
- **Database:** MongoDB with Mongoose
- **Auth:** Secure HTTP-only session cookies, hashed passwords, server-side
  authorization (added in Phase 3)

## Folder Structure

```text
academic-schedule/
│
├── client/                # Frontend pages/components/css/js/assets
│   ├── pages/
│   ├── components/
│   ├── css/
│   ├── js/
│   └── assets/
│
├── server/
│   ├── config/            # env.js, database.js
│   ├── models/            # Mongoose schemas (Phase 2+)
│   ├── routes/            # Express routers
│   ├── controllers/       # Request handlers
│   ├── services/          # Business logic (Phase 2+)
│   ├── middleware/         # Error handling, auth/RBAC (Phase 3+)
│   ├── jobs/               # Background jobs, e.g. deadline sweeper (Phase 6+)
│   ├── utils/              # AppError, asyncHandler, helpers
│   ├── tests/               # node:test suites
│   └── app.js               # Express app + server bootstrap
│
├── uploads/                 # Local dev file storage (production uses
│                             # external/object storage; only metadata/URLs
│                             # are stored in MongoDB)
│
├── .env                     # Local secrets (never committed)
├── .env.example              # Documented environment variables template
├── .gitignore
├── package.json
└── README.md
```

## Installation

```bash
git clone <repo-url> academic-schedule
cd academic-schedule
npm install
cp .env.example .env
# edit .env and set real values, especially SESSION_SECRET and MONGODB_URI
```

## Environment Variables

See `.env.example` for the authoritative list. Currently used:

| Variable        | Purpose                                             | Required in production |
|-----------------|------------------------------------------------------|:-----------------------:|
| `PORT`          | HTTP port the server listens on                      | No (defaults to 3000)  |
| `NODE_ENV`      | `development`, `production`, or `test`               | Recommended             |
| `MONGODB_URI`   | MongoDB connection string                            | Yes                      |
| `SESSION_SECRET`| Secret used to sign session cookies                  | Yes                      |
| `UPLOAD_LIMIT`  | Max request body / upload size (e.g. `10mb`)         | No                       |
| `CORS_ORIGIN`   | Comma-separated list of allowed origins              | Recommended              |

In production, `npm start` will refuse to boot if `MONGODB_URI` or
`SESSION_SECRET` are missing, or if `SESSION_SECRET` is left at its
insecure development default.

## MongoDB Setup

For local development, run a MongoDB instance any way you prefer (local
install, Docker container, or a hosted free-tier cluster such as MongoDB
Atlas) and point `MONGODB_URI` at it, e.g.:

```env
MONGODB_URI=mongodb://127.0.0.1:27017/academic_schedule
```

The application does **not** require MongoDB to be reachable in order to
boot: if the connection fails at startup, the server still starts so that
`/api/health` can report the outage instead of crash-looping. Business
routes added in later phases will depend on a working connection.

### Transactions, sessions, and diagnosing their errors

Task creation/update/removal (`server/services/TaskService.js`), schedule
template/session/change writes (`server/services/ScheduleService.js`), and
request approval (`server/services/RequestService.js`) all use real,
multi-document MongoDB transactions (`server/utils/transaction.js`, via
`mongoose.startSession().withTransaction()`). A write inside one of these
that throws returns the client only the generic `"An unexpected error
occurred"` 500 response — `server/middleware/errorHandler.js` deliberately
never leaks internal error details for a non-operational error, except
into the failed request's response body's `debug.stack` field when
running with the default `NODE_ENV=development`, or into the server
console as an `[unhandled error]` log line. **Always check one of those
two first** for the real exception before assuming where the bug is;
two confirmed causes so far:

- **MongoDB transactions require a replica set or sharded cluster** — a
  default, standalone `mongod` (a plain local install or a plain
  `docker run mongo` with no further setup) does not support them at all,
  and fails with something like `MongoServerError: Transaction numbers
  are only allowed on a replica set member or mongos`. For local
  development, turn a standalone `mongod` into a single-node replica set
  once:

  ```bash
  mongod --replSet rs0 --dbpath <your db path>
  # in a separate shell, once:
  mongosh --eval "rs.initiate()"
  ```

  and point `MONGODB_URI` at it as a replica-set connection string, e.g.
  `mongodb://127.0.0.1:27017/academic_schedule?replicaSet=rs0`. MongoDB
  Atlas's free tier is already a replica set, so no extra setup is needed
  there.

- **A session-bound `Model.create()` call with more than one document
  needs `ordered: true`.** Mongoose (confirmed against the installed
  8.24.4) refuses `Model.create(docsArray, { session })` for more than
  one document unless `{ ordered: true }` is also set — a single
  `ClientSession` can only have one operation in flight at a time, so an
  unordered (parallel) multi-document create sharing that session would
  race against itself. This was the real, confirmed cause of task
  creation failing in practice: `NotificationService.js`'s `dispatch()`
  creates one `NotificationRecipient` document per recipient inside the
  same session as the Task write, and any task/schedule-change/request
  notification with more than one recipient hit exactly this. Fixed by
  passing `ordered: true` alongside `session` there — every other
  session-bound `.create()` call in the codebase was checked and creates
  only a single document per call, so none of them were affected.

## Development Commands

```bash
npm run dev      # start with auto-restart on file changes (node --watch)
npm start        # start normally
npm test         # run the automated test suite (node:test)
npm run seed:dev # create one test account per role (Student/Doctor/TA/
                  # Leader/Admin) against the database MONGODB_URI points
                  # at, so every role's dashboard is reachable through the
                  # normal login page. Safe to re-run — skips any account
                  # that already exists. Refuses to run when
                  # NODE_ENV=production. See
                  # server/scripts/seed-dev-accounts.js for the exact
                  # credentials it prints.
```

## Production Notes

- Set `NODE_ENV=production`.
- Provide a strong, unique `SESSION_SECRET`.
- Serve behind HTTPS so session cookies can be marked `Secure`.
- Point `MONGODB_URI` at a production database with proper access control.
- File uploads should go to external/object storage (e.g. S3-compatible
  storage) in production; MongoDB stores only attachment metadata and
  URLs, never large binary files.
- The app trusts the first reverse-proxy hop (`trust proxy = 1`) for
  correct client IPs, secure cookies, and rate limiting behind a load
  balancer — adjust if your deployment topology differs.
- Startup fails loudly, not silently: `validateEnv()` (`server/config/env.js`)
  throws when `MONGODB_URI`/`SESSION_SECRET` are missing in production, or
  when `SESSION_SECRET` is still the development default — and
  `server/app.js` now exits the process with a non-zero code when that
  happens, so a misconfigured deployment is reported as failed rather than
  left running with nothing actually listening.

## Backup & Restore

This project has no built-in backup tooling — it relies on standard
MongoDB tools against whatever `MONGODB_URI` points at.

**Backup** (run from anywhere with network access to the database; never
commit the output anywhere):

```bash
mongodump --uri="$MONGODB_URI" --out=./backup-$(date +%Y%m%d-%H%M%S)
```

**Restore** (to the same or a different `MONGODB_URI` — double-check the
target before running this against a live database):

```bash
mongorestore --uri="$MONGODB_URI" --drop ./backup-<timestamp>
```

`--drop` replaces existing collections with the backup's contents; omit it
to merge instead. Take a fresh backup immediately before any production
restore, migration, or manual data-cleanup operation. For managed MongoDB
hosting (Atlas and most others), prefer the provider's own point-in-time/
snapshot backup feature when available — it covers the sessions
collection and any in-flight writes more reliably than a point-in-time
`mongodump`.

## Authentication & Roles

Five roles are supported: **Student, Doctor, TA, Leader, Admin**, enforced
server-side via RBAC middleware (`requireAuth`, `requireRole`,
`requirePermission` in `server/middleware/auth.js`) — the frontend never
determines permissions (spec section 69).

- Sessions are HTTP-only, `SameSite=Lax` cookies (`Secure` in production),
  stored in MongoDB via `connect-mongo` (in-memory only in the `test`
  environment, so the automated test suite never needs a live database).
  Session lifetime is rolling/idle-timeout style — see `SESSION_MAX_AGE_MS`
  in `.env.example`.
- Passwords are hashed with bcrypt (`server/utils/password.js`) and never
  returned by the API (only a `hasPassword` boolean).
- **Students** may log in with just their Student Code (no password), or
  with Student Code + password once they've created one
  (`POST /api/auth/password`). They can also remove a set password
  (`DELETE /api/auth/password`) to return to code-only login. There is
  deliberately no "change password" endpoint for students (spec section 11).
- **Doctor / TA / Leader / Admin** accounts are Admin-created and always
  require a username + password.
- A deactivated User account, or a deactivated role-specific profile (e.g.
  a replaced Leader, a deactivated Doctor), is rejected at login **and**
  on every subsequent authenticated request — not just at login time.
- **Maintenance Mode**: when enabled (`SystemSettings.maintenanceMode`),
  every role except Admin is blocked with `503`. The Admin UI to toggle
  this belongs to Phase 4 — Phase 3 only implements the enforcement layer.
- Login and forgot-password are rate-limited more strictly than the rest
  of the API (`server/middleware/rateLimiters.js`).

## API Overview

```http
GET  /api/health

POST   /api/auth/login             { identifier, password? }
POST   /api/auth/logout
GET    /api/auth/me                (requires auth)
POST   /api/auth/forgot-password   { identifier }
POST   /api/auth/password          { password }   (Student only, requires auth)
DELETE /api/auth/password                          (Student only, requires auth)

GET    /api/students               (Admin)
GET    /api/students/:id           (Admin)
POST   /api/students               (Admin)
PATCH  /api/students/:id           (Admin)

GET    /api/doctors | /api/tas     (Admin)  — same shape for both
GET    /api/doctors/:id | /api/tas/:id
POST   /api/doctors | /api/tas
PATCH  /api/doctors/:id | /api/tas/:id

GET    /api/leaders                (Admin)
POST   /api/leaders                (Admin)
PATCH  /api/leaders/:id/active     (Admin)  — deactivate/reactivate (replacement flow)

GET    /api/subjects               (any authenticated role)
POST   /api/subjects | PATCH /api/subjects/:id   (Admin)

GET    /api/rooms                  (any authenticated role)
POST   /api/rooms | PATCH /api/rooms/:id         (Admin)

GET    /api/schedule?startDate&endDate&subjectId  (any authenticated role)
GET    /api/schedule/sessions?date=|startDate&endDate&subjectId  (same as above; date is a single-day shorthand)
GET    /api/schedule/today
GET    /api/schedule/:sessionId
GET    /api/schedule/changes?sessionId=|subjectId=
GET    /api/schedule/templates?subjectId=
POST   /api/schedule/templates                    (Admin — official schedule)
POST   /api/schedule/:sessionId/change             (Doctor/TA/Leader/Admin — one-time)

GET    /api/tasks?subjectId=&status=&createdBy=   (any authenticated role)
GET    /api/tasks/:id
POST   /api/tasks | PATCH /api/tasks/:id | DELETE /api/tasks/:id   (Doctor/TA/Leader/Admin)
POST   /api/tasks/:id/complete | DELETE /api/tasks/:id/complete    (Student)

GET    /api/notifications?unreadOnly=true
PATCH  /api/notifications/:id/read
PATCH  /api/notifications/read-all

POST   /api/requests/group-change   (Student)

GET    /api/admin/requests
PATCH  /api/admin/requests/:id                      { status: APPROVED|REJECTED }
POST   /api/admin/users/:userId/reset-password       { newPassword }
POST   /api/admin/schedule/permanent-change          { sessionId, current, dayOfWeek, effectiveFrom, reason }
POST   /api/admin/notifications/broadcast             { audience: STUDENTS|DOCTORS|TAS|LEADERS|EVERYONE, title, message }
```

`GET /api/health` returns server status, environment, MongoDB connection
state, and uptime; does not require authentication. Every other route
requires an authenticated session and passes through Maintenance Mode
enforcement; role restrictions are noted above and enforced server-side.

Frontend UI is added in a later phase.

## Testing

Automated tests use Node's built-in `node:test` runner with `supertest`.
All 97 tests run without a live MongoDB connection — Phase 2's model tests
use Mongoose's `validateSync()`/schema introspection, and Phase 3's
service/middleware tests inject small in-memory fake models
(`server/tests/helpers/fakeCollection.js`) instead of hitting a real
database. Current coverage:

- **Phase 1:** health endpoint payload shape, standard 404 error shape,
  security headers.
- **Phase 2:** required-field/enum/custom validation and index
  declarations for every model.
- **Phase 3:** password hashing, the full login decision tree (code-only,
  password, invalid credentials, disabled account/profile, non-student
  with no password), Maintenance Mode gating, student password
  create/remove, forgot-password (including anti-enumeration behavior),
  the Admin-reset-password service foundation, `requireAuth` /
  `requireRole` / `requirePermission` middleware, and real HTTP-level
  login rate limiting.

Run with:

```bash
npm test
```

Note: the real MongoDB-backed session store (`connect-mongo`) and a full
end-to-end HTTP login → session cookie → `/api/auth/me` flow are not
exercised by the automated suite (by design — see above), so they should
be spot-checked against a live MongoDB the same way Phase 1's connection
lifecycle was.

Later phases add further business-logic tests per the project's testing
strategy (schedule engine edge cases, task permissions, the notification
actor-exclusion matrix, request approval flows).

## Seed / Demo Data

No seed data exists yet. The real official schedule, room list, and
student/doctor/TA roster are **not** available yet and must never be
invented as production data. When temporary demo data is introduced for
development in later phases, it will be clearly marked as demo data and
easy to remove — never treated as real university data.

## Deployment Considerations

- This app is intended to become PWA-friendly with Web Push (Phase 9);
  push notifications are optional and in-site notifications must always
  work without them.
- No native mobile app is planned for MVP.
- Business logic must remain valid regardless of the exact number of
  students, subjects, rooms, or the specific day off — none of these are
  hard-coded.

## Implementation Phases

1. **Foundation** *(current)* — project structure, Express server, MongoDB
   connection, env config, error handling, health endpoint.
2. **Database** — all Mongoose models, indexes, validation.
3. **Authentication & RBAC** — login (code-only and password), sessions,
   role/permission middleware.
4. **Admin Core** — user/subject/room management, system settings,
   maintenance mode.
5. **Schedule Engine** — templates, sessions, one-time/permanent changes,
   history, conflict warnings.
6. **Tasks** — CRUD, attachments, submission links, deadlines, completion,
   overdue processing.
7. **Notifications** — creation, recipient/actor-exclusion rules, read
   state, broadcasts.
8. **Frontend** — role-specific UI, student experience first.
9. **PWA / Push** — manifest, service worker, Web Push.
10. **Testing & Hardening** — full permission matrix, edge cases, security
    review, mobile/desktop polish.
