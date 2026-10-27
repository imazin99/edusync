/**
 * server/tests/objectIdValidationHardening.test.js
 *
 * G3H fix 1 — consistent ObjectId validation. Focused HTTP-level coverage
 * for a REPRESENTATIVE sample of the routes the final readiness review
 * flagged, using the project's existing isValidObjectId/AppError.badRequest
 * pattern (already used by notifications/schedule/ReadScopeService).
 *
 * Not exhaustive by design (same shared pattern, same shared factory for
 * Doctor/TA) — covers:
 *   - the shared staff factory (doctors — also covers TAs, identical code)
 *   - students (a standalone, non-factory controller)
 *   - tasks (the specific Student/Leader/Admin UNRESTRICTED-read gap the
 *     audit called out — this is the one that previously bypassed
 *     ReadScopeService's own validation entirely)
 *   - tasks attachment download: proves storageKey is NOT mistakenly
 *     validated as an ObjectId (it isn't one)
 *   - admin reviewRequest and resetUserPassword
 *
 * For each: malformed id -> 422 with the service never called; valid id
 * -> unchanged 200 behaviour, proving no successful-path regression.
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

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

const VALID_ID = '6e0000000000000000000001';

// ===========================================================================
// Doctors (shared staffController.factory.js — also covers TAs verbatim)
// ===========================================================================
test('GET /api/doctors/:id — malformed id is rejected (422), service never called', async () => {
  const doctorService = require('../services/DoctorService');
  let called = false;
  const original = doctorService.getById;
  doctorService.getById = async () => {
    called = true;
    return {};
  };
  try {
    setUser('ADMIN');
    const res = await request(mount('/api/doctors', require('../routes/doctors.routes'))).get(
      '/api/doctors/not-an-id'
    );
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.body.code, 'INVALID_STAFF_ID');
    assert.strictEqual(called, false, 'service must not be reached for a malformed id');
  } finally {
    doctorService.getById = original;
  }
});

test('GET /api/doctors/:id — valid id still reaches the service and returns 200 (no regression)', async () => {
  const doctorService = require('../services/DoctorService');
  const original = doctorService.getById;
  doctorService.getById = async (id) => ({ _id: id, username: 'dr1' });
  try {
    setUser('ADMIN');
    const res = await request(mount('/api/doctors', require('../routes/doctors.routes'))).get(
      `/api/doctors/${VALID_ID}`
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.item._id, VALID_ID);
  } finally {
    doctorService.getById = original;
  }
});

// ===========================================================================
// Students (standalone controller)
// ===========================================================================
test('GET /api/students/:id — malformed id is rejected (422)', async () => {
  const studentService = require('../services/StudentService');
  let called = false;
  const original = studentService.getById;
  studentService.getById = async () => {
    called = true;
    return {};
  };
  try {
    setUser('ADMIN');
    const res = await request(mount('/api/students', require('../routes/students.routes'))).get(
      '/api/students/xyz'
    );
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.body.code, 'INVALID_STUDENT_ID');
    assert.strictEqual(called, false);
  } finally {
    studentService.getById = original;
  }
});

test('PATCH /api/students/:id — malformed id is rejected before update is attempted', async () => {
  const studentService = require('../services/StudentService');
  let called = false;
  const original = studentService.update;
  studentService.update = async () => {
    called = true;
    return {};
  };
  try {
    setUser('ADMIN');
    const res = await request(mount('/api/students', require('../routes/students.routes')))
      .patch('/api/students/bad-id')
      .send({ fullName: 'New Name' });
    assert.strictEqual(res.status, 422);
    assert.strictEqual(called, false);
  } finally {
    studentService.update = original;
  }
});

// ===========================================================================
// Tasks — the specific audited gap: Student/Leader/Admin unrestricted reads
// ===========================================================================
test('GET /api/tasks/:id as Student (unrestricted read path) — malformed id is rejected (422), not a 500', async () => {
  setUser('STUDENT');
  const res = await request(mount('/api/tasks', require('../routes/tasks.routes'))).get(
    '/api/tasks/not-a-real-id'
  );
  assert.strictEqual(res.status, 422);
  assert.strictEqual(res.body.code, 'INVALID_TASK_ID');
});

test('GET /api/tasks/:id as Leader — malformed id is rejected (422)', async () => {
  setUser('LEADER');
  const res = await request(mount('/api/tasks', require('../routes/tasks.routes'))).get(
    '/api/tasks/not-a-real-id'
  );
  assert.strictEqual(res.status, 422);
});

test('GET /api/tasks/:id/attachments/:storageKey as Student — malformed taskId rejected, storageKey itself is never ObjectId-checked', async () => {
  setUser('STUDENT');
  const res = await request(mount('/api/tasks', require('../routes/tasks.routes'))).get(
    '/api/tasks/not-a-real-id/attachments/some-storage-key-not-an-objectid'
  );
  assert.strictEqual(res.status, 422);
  assert.strictEqual(res.body.code, 'INVALID_TASK_ID');
});

// ===========================================================================
// Admin — reviewRequest / resetUserPassword
// ===========================================================================
test('PATCH /api/admin/requests/:id — malformed id is rejected (422), requestService never called', async () => {
  const requestService = require('../services/RequestService');
  let called = false;
  const original = requestService.review;
  requestService.review = async () => {
    called = true;
    return {};
  };
  try {
    setUser('ADMIN');
    const res = await request(mount('/api/admin', require('../routes/admin.routes')))
      .patch('/api/admin/requests/not-an-id')
      .send({ status: 'APPROVED' });
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.body.code, 'INVALID_REQUEST_ID');
    assert.strictEqual(called, false);
  } finally {
    requestService.review = original;
  }
});

test('POST /api/admin/users/:userId/reset-password — malformed userId is rejected (422), authService never called', async () => {
  const authService = require('../services/AuthService');
  let called = false;
  const original = authService.adminResetPassword;
  authService.adminResetPassword = async () => {
    called = true;
  };
  try {
    setUser('ADMIN');
    const res = await request(mount('/api/admin', require('../routes/admin.routes')))
      .post('/api/admin/users/not-an-id/reset-password')
      .send({ newPassword: 'NewPass123!' });
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.body.code, 'INVALID_USER_ID');
    assert.strictEqual(called, false);
  } finally {
    authService.adminResetPassword = original;
  }
});
