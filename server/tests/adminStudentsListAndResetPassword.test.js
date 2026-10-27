/**
 * server/tests/adminStudentsListAndResetPassword.test.js
 *
 * Regression coverage for a confirmed frontend bug, traced and fixed in
 * client/js/pages/admin-students.js (NOT a backend defect — every
 * backend layer involved was already correct and is re-confirmed here,
 * not just re-tested):
 *
 *   Symptom 1: "Could not load students" shown on every load of the
 *   Admin Students page.
 *   Symptom 2: Resetting a student's password returned
 *   "userId is not a valid id".
 *
 * ROOT CAUSE (one defect, both symptoms): admin-students.js's loadList()
 * destructured `const { students } = await apiClient.get(...)`, but
 * client/js/api-client.js's apiClient.get() ALREADY unwraps a single-key
 * `{ success, students }` response envelope down to the bare `students`
 * array itself (see api-client.js's own `unwrap()` — it returns
 * `rest[keys[0]]` whenever exactly one non-`success` key is present).
 * Destructuring a `.students` property off of that array read `undefined`
 * off a plain JS Array, which made `items` undefined, which threw inside
 * renderList()'s `items.length` check — caught and shown as "Could not
 * load students" — and meant every row's `s.userId` was also never
 * populated, so clicking "Reset Password" sent
 * `/api/admin/users/undefined/reset-password`, correctly rejected by the
 * backend's isValidObjectId check with "userId is not a valid id". The
 * fix was the single line `items = await apiClient.get(...)` (no
 * destructuring) — see admin-students.js.
 *
 * Since that defect lives in plain browser JS with no DOM/test harness in
 * this project (only server/tests/*.test.js, node:test against the
 * backend), these tests instead PIN THE EXACT CONTRACT the fixed frontend
 * code now depends on, at the only layer this project tests:
 *
 *   1. GET /api/students's response is a single-key { success, students }
 *      envelope (not wrapped further) — the shape apiClient.get()'s
 *      unwrap() must see to correctly resolve to the bare array. If this
 *      ever changes (e.g. pagination metadata gets added alongside
 *      `students`), the frontend's `items = await apiClient.get(...)`
 *      would need to change too — this test makes that an explicit,
 *      caught regression instead of a silent future break.
 *   2. Each student object in that list carries `userId` — confirmed to
 *      be the real linked User._id, not the Student._id — because that
 *      is exactly the field value admin-students.js's `openReset(s.userId)`
 *      passes through to POST /api/admin/users/:userId/reset-password.
 *   3. End-to-end at the service layer (StudentService + AuthService,
 *      the real Student<->User relationship, fake collections per this
 *      project's established Phase 4 pattern): the userId a listed
 *      student carries is proven to correctly reset THAT student's own
 *      User password, and no one else's — confirming the ID mapping the
 *      frontend relies on is correct, not just superficially present.
 *
 * (The pre-existing server/tests/objectIdValidationHardening.test.js
 * already covers the malformed/missing-id 422 rejection path for this
 * same endpoint; it is not duplicated here.)
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

const { createFakeCollection, createTestFixtureScope } = require('./helpers/fakeCollection');
const { ROLES, STUDENT_GROUP_VALUES } = require('../utils/constants');
const { createStudentService } = require('../services/StudentService');
const { createAuthService } = require('../services/AuthService');
const { comparePassword } = require('../utils/password');

function buildModels() {
  const scope = createTestFixtureScope();
  const c = (prefix) => createFakeCollection(prefix, [], scope);
  return {
    User: c('user'),
    Student: c('student'),
    Doctor: c('doctor'),
    TA: c('ta'),
    Leader: c('leader'),
    Request: c('request'),
    SystemSettings: { getSingleton: async () => ({ maintenanceMode: false, maintenanceMessage: '' }) },
  };
}

const noopAudit = { recordAudit: async () => {} };

// ===========================================================================
// 1 & 2. HTTP-level contract: GET /api/students's exact response envelope,
//    and that each item carries `userId`.
// ===========================================================================

let currentTestUser = null;
const authModule = require('../middleware/auth');
const AppError = require('../utils/AppError');
authModule.requireAuth = (req, res, next) => {
  if (!currentTestUser) return next(AppError.unauthorized('Authentication required'));
  req.user = currentTestUser;
  next();
};
const maintenanceModule = require('../middleware/maintenance');
maintenanceModule.checkMaintenanceMode = (req, res, next) => next();

function setUser(role, id = `u_${role.toLowerCase()}`) {
  currentTestUser = { id, username: id, role };
}

const { errorHandler } = require('../middleware/errorHandler');
function mount(path, router) {
  const app = express();
  app.use(express.json());
  app.use(path, router);
  app.use(errorHandler);
  return app;
}

test('GET /api/students — response is a single-key { success, students } envelope with userId on each item (the exact contract apiClient.get() must unwrap to a bare array for admin-students.js)', async () => {
  const studentService = require('../services/StudentService');
  const original = studentService.list;
  studentService.list = async () => [
    { _id: 'student_1', studentCode: '2201234', fullName: 'Ada Lovelace', group: 'G1', isActive: true, userId: 'user_1' },
  ];
  try {
    setUser('ADMIN');
    const res = await request(mount('/api/students', require('../routes/students.routes'))).get('/api/students');

    assert.strictEqual(res.status, 200);
    // Exactly { success, students } — no third key (e.g. pagination) that
    // would change how apiClient.get()'s unwrap() resolves this payload.
    assert.deepStrictEqual(Object.keys(res.body).sort(), ['students', 'success']);
    assert.strictEqual(res.body.success, true);
    assert.ok(Array.isArray(res.body.students));
    assert.strictEqual(res.body.students.length, 1);
    // The exact field admin-students.js's openReset(s.userId) reads.
    assert.strictEqual(res.body.students[0].userId, 'user_1');
  } finally {
    studentService.list = original;
  }
});

// ===========================================================================
// 3. Service-layer end-to-end: the userId a listed student carries really
//    does reset that student's own User password (Student<->User mapping).
// ===========================================================================

test('A student\'s userId (as returned by StudentService.list, the same field admin-students.js now reads) correctly identifies and resets that exact student\'s own User password via AuthService.adminResetPassword', async () => {
  const models = buildModels();
  const studentService = createStudentService({ models, auditService: noopAudit });
  const authService = createAuthService({ models, auditService: noopAudit });

  // Two students, so the test also proves the right ONE is affected.
  const studentA = await studentService.create({
    actorUser: { id: 'admin_1', role: ROLES.ADMIN },
    studentCode: '2201234',
    fullName: 'Ada Lovelace',
    group: STUDENT_GROUP_VALUES[0],
    password: 'OldPassword123!',
  });
  const studentB = await studentService.create({
    actorUser: { id: 'admin_1', role: ROLES.ADMIN },
    studentCode: '2205678',
    fullName: 'Grace Hopper',
    group: STUDENT_GROUP_VALUES[0],
    password: 'OldPassword123!',
  });

  // Exactly what GET /api/students returns and what admin-students.js
  // now correctly assigns to `items` (no destructuring bug).
  const listed = await studentService.list({});
  const listedA = listed.find((s) => s.studentCode === '2201234');
  assert.ok(listedA, 'seeded student must appear in the list');
  assert.strictEqual(listedA.userId, studentA.userId.toString(), 'listed userId must be the real linked User._id, not the Student._id');
  assert.notStrictEqual(listedA.userId, studentA._id, 'userId must never be confused with the Student document\'s own _id');

  // The exact call admin-students.js's handleResetSubmit makes:
  //   POST /api/admin/users/${resetUserId}/reset-password
  // with resetUserId = listedA.userId.
  await authService.adminResetPassword({
    actorUser: { id: 'admin_1', role: ROLES.ADMIN },
    targetUserId: listedA.userId,
    newPassword: 'BrandNewPassword123!',
  });

  const userA = models.User._docs.find((u) => u._id.toString() === listedA.userId.toString());
  const userB = models.User._docs.find((u) => u._id.toString() === studentB.userId.toString());

  assert.strictEqual(await comparePassword('BrandNewPassword123!', userA.passwordHash), true, "student A's password must now be the new one");
  assert.strictEqual(await comparePassword('OldPassword123!', userA.passwordHash), false, "student A's old password must no longer work");
  assert.strictEqual(await comparePassword('OldPassword123!', userB.passwordHash), true, "student B's password must be untouched");
});

test('AuthService.adminResetPassword rejects a reset attempt for a userId that does not exist (defense-in-depth beyond the route-level isValidObjectId check)', async () => {
  const models = buildModels();
  const authService = createAuthService({ models, auditService: noopAudit });

  await assert.rejects(
    () =>
      authService.adminResetPassword({
        actorUser: { id: 'admin_1', role: ROLES.ADMIN },
        targetUserId: 'user_does_not_exist',
        newPassword: 'BrandNewPassword123!',
      }),
    /not found/i
  );
});
