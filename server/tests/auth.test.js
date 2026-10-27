/**
 * Phase 3 tests: authentication business logic, RBAC middleware, password
 * hashing, and login rate limiting.
 *
 * Like Phase 1/2, these are designed to run WITHOUT a live MongoDB
 * connection: AuthService/AuditService/auth middleware are all built as
 * factories specifically so tests can inject small in-memory fake models
 * (see helpers/fakeCollection.js) instead of hitting a real database.
 * This exercises the actual business logic (password rules, the
 * code-only-vs-password login decision tree, profile-active checks,
 * maintenance-mode gating, RBAC) with real assertions — it does not
 * merely check schema shape the way Phase 2's tests did.
 *
 * The one thing NOT exercised here is the real MongoDB-backed session
 * store (connect-mongo) — session.js deliberately falls back to
 * express-session's in-memory MemoryStore when NODE_ENV=test (see
 * config/session.js), so the HTTP-level rate-limit test below can run
 * through a real Express app without needing a live database. Full
 * end-to-end verification against a live MongoDB (login -> session
 * cookie -> /api/auth/me) should be done by the person running this on
 * their own machine, the same way Phase 1's connection lifecycle was.
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

const { createFakeCollection, createTestFixtureScope } = require('./helpers/fakeCollection');
const { hashPassword, comparePassword } = require('../utils/password');
const { createAuditService } = require('../services/AuditService');
const { createAuthService } = require('../services/AuthService');
const { createAuthMiddleware } = require('../middleware/auth');
const { createMaintenanceMiddleware } = require('../middleware/maintenance');
const { createAuthController } = require('../controllers/auth.controller');
const AppError = require('../utils/AppError');
const { ROLES } = require('../utils/constants');

// ---------------------------------------------------------------------------
// Test fixture builder
// ---------------------------------------------------------------------------

function buildFixture({
  users = [],
  students = [],
  doctors = [],
  tas = [],
  leaders = [],
  requests = [],
  maintenanceMode = false,
  maintenanceMessage = '',
} = {}) {
  const scope = createTestFixtureScope();
  const models = {
    User: createFakeCollection('user', users, scope),
    Student: createFakeCollection('student', students, scope),
    Doctor: createFakeCollection('doctor', doctors, scope),
    TA: createFakeCollection('ta', tas, scope),
    Leader: createFakeCollection('leader', leaders, scope),
    Request: createFakeCollection('request', requests, scope),
    SystemSettings: {
      getSingleton: async () => ({ maintenanceMode, maintenanceMessage }),
    },
  };

  const auditCalls = [];
  const spyAuditService = {
    recordAudit: async (payload) => {
      auditCalls.push(payload);
    },
  };

  const authService = createAuthService({ models, auditService: spyAuditService });
  const authMiddleware = createAuthMiddleware({ models, authService });
  const maintenanceMiddleware = createMaintenanceMiddleware({ models });
  const authController = createAuthController({ models, authService });

  return {
    models,
    auditCalls,
    authService,
    authMiddleware,
    maintenanceMiddleware,
    authController,
  };
}

// Minimal fake Express `res` that records what was sent, and a fake
// `req.session` supporting the regenerate/save/destroy callback style
// express-session uses, so controller functions can be invoked directly.
function makeFakeRes() {
  return {
    statusCode: null,
    body: null,
    cookiesCleared: [],
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    clearCookie(name) {
      this.cookiesCleared.push(name);
      return this;
    },
  };
}

function makeFakeSession(initial = {}) {
  return {
    ...initial,
    regenerate(cb) {
      cb(null);
    },
    save(cb) {
      cb(null);
    },
    destroy(cb) {
      cb(null);
    },
  };
}

// Controller functions are wrapped in asyncHandler, whose Express-style
// contract is fire-and-forget: it does NOT return the inner promise (real
// Express never awaits middleware either — it relies on res.json()/next()
// being called asynchronously later). So `await controllerFn(req, res, next)`
// alone would resolve before the controller's actual async work finishes.
// This helper waits for whichever happens first: res.json() being called,
// or next() being called with an error.
function callController(controllerFn, req) {
  const res = makeFakeRes();
  return new Promise((resolve, reject) => {
    const originalJson = res.json.bind(res);
    res.json = (payload) => {
      originalJson(payload);
      resolve({ res, err: undefined });
      return res;
    };
    Promise.resolve(controllerFn(req, res, (err) => resolve({ res, err }))).catch((err) =>
      resolve({ res, err })
    );
  });
}

// Runs an Express-style middleware function directly and resolves once
// next() (or an error passed to next()) has been observed.
function runMiddleware(middleware, req, res = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const next = (err) => {
      if (settled) return;
      settled = true;
      resolve({ err });
    };
    Promise.resolve(middleware(req, res, next)).catch((err) => {
      if (!settled) {
        settled = true;
        resolve({ err });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

test('hashPassword produces a bcrypt hash, never the plaintext', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.notStrictEqual(hash, 'correct horse battery staple');
  assert.ok(hash.startsWith('$2'), 'expected a bcrypt-style hash prefix');
});

test('comparePassword returns true for a matching password and false otherwise', async () => {
  const hash = await hashPassword('my-secret-pw');
  assert.strictEqual(await comparePassword('my-secret-pw', hash), true);
  assert.strictEqual(await comparePassword('wrong-pw', hash), false);
});

test('comparePassword returns false (not an exception) for a null/undefined hash', async () => {
  assert.strictEqual(await comparePassword('anything', null), false);
  assert.strictEqual(await comparePassword('anything', undefined), false);
});

// ---------------------------------------------------------------------------
// AuthService.login — student code-only
// ---------------------------------------------------------------------------

test('login succeeds for a student with no password using code alone', async () => {
  const { authService, auditCalls } = buildFixture({
    users: [{ username: '2201234', role: ROLES.STUDENT, isActive: true, passwordHash: null }],
    students: [
      { userId: 'user_1', studentCode: '2201234', fullName: 'Test Student', group: 'G1', isActive: true },
    ],
  });

  const user = await authService.login({ identifier: '2201234' });
  assert.strictEqual(user.username, '2201234');
  assert.ok(user.lastLoginAt instanceof Date);
  assert.ok(auditCalls.some((c) => c.action === 'LOGIN_SUCCESS'));
});

test('login succeeds for a code-only student even if an (irrelevant) password is supplied', async () => {
  const { authService } = buildFixture({
    users: [{ username: '2201234', role: ROLES.STUDENT, isActive: true, passwordHash: null }],
    students: [
      { userId: 'user_1', studentCode: '2201234', fullName: 'Test Student', group: 'G1', isActive: true },
    ],
  });

  const user = await authService.login({ identifier: '2201234', password: 'whatever' });
  assert.strictEqual(user.username, '2201234');
});

// ---------------------------------------------------------------------------
// AuthService.login — password-based
// ---------------------------------------------------------------------------

test('login succeeds for a student with a password using the correct password', async () => {
  const hash = await hashPassword('s3cret-pw');
  const { authService } = buildFixture({
    users: [{ username: '2201234', role: ROLES.STUDENT, isActive: true, passwordHash: hash }],
    students: [
      { userId: 'user_1', studentCode: '2201234', fullName: 'Test Student', group: 'G1', isActive: true },
    ],
  });

  const user = await authService.login({ identifier: '2201234', password: 's3cret-pw' });
  assert.strictEqual(user.username, '2201234');
});

test('login succeeds for Doctor/TA/Leader/Admin with username + correct password', async () => {
  const hash = await hashPassword('admin-pw');
  const { authService } = buildFixture({
    users: [{ username: 'mazen', role: ROLES.ADMIN, isActive: true, passwordHash: hash }],
  });

  const user = await authService.login({ identifier: 'mazen', password: 'admin-pw' });
  assert.strictEqual(user.role, ROLES.ADMIN);
});

test('login rejects wrong password with a generic INVALID_CREDENTIALS error', async () => {
  const hash = await hashPassword('correct-pw');
  const { authService } = buildFixture({
    users: [{ username: '2201234', role: ROLES.STUDENT, isActive: true, passwordHash: hash }],
    students: [
      { userId: 'user_1', studentCode: '2201234', fullName: 'Test Student', group: 'G1', isActive: true },
    ],
  });

  await assert.rejects(
    () => authService.login({ identifier: '2201234', password: 'wrong-pw' }),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.strictEqual(err.statusCode, 401);
      assert.strictEqual(err.code, 'INVALID_CREDENTIALS');
      return true;
    }
  );
});

test('login rejects an unknown identifier with the SAME generic error as a wrong password', async () => {
  const { authService } = buildFixture({ users: [] });

  await assert.rejects(
    () => authService.login({ identifier: 'does-not-exist', password: 'x' }),
    (err) => {
      assert.strictEqual(err.statusCode, 401);
      assert.strictEqual(err.code, 'INVALID_CREDENTIALS');
      assert.strictEqual(err.message, 'Invalid credentials');
      return true;
    }
  );
});

test('login rejects a disabled User account', async () => {
  const { authService } = buildFixture({
    users: [{ username: '2201234', role: ROLES.STUDENT, isActive: false, passwordHash: null }],
    students: [{ userId: 'user_1', studentCode: '2201234', fullName: 'Test', group: 'G1', isActive: true }],
  });

  await assert.rejects(
    () => authService.login({ identifier: '2201234' }),
    (err) => {
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(err.code, 'ACCOUNT_DISABLED');
      return true;
    }
  );
});

test('login rejects when the role-specific profile is inactive (e.g. a replaced Leader)', async () => {
  const hash = await hashPassword('pw');
  const { authService } = buildFixture({
    users: [{ username: 'leader_f', role: ROLES.LEADER, isActive: true, passwordHash: hash }],
    leaders: [{ userId: 'user_1', slot: 'FEMALE', isActive: false, linkedStudentId: 'student_x' }],
  });

  await assert.rejects(
    () => authService.login({ identifier: 'leader_f', password: 'pw' }),
    (err) => {
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(err.code, 'ACCOUNT_DISABLED');
      return true;
    }
  );
});

test('login rejects a non-student account that has no password set (data-integrity guard)', async () => {
  const { authService } = buildFixture({
    users: [{ username: 'some_doctor', role: ROLES.DOCTOR, isActive: true, passwordHash: null }],
    doctors: [{ userId: 'user_1', fullName: 'Dr. Test', isActive: true }],
  });

  await assert.rejects(
    () => authService.login({ identifier: 'some_doctor', password: 'anything' }),
    (err) => {
      assert.strictEqual(err.statusCode, 401);
      assert.strictEqual(err.code, 'INVALID_CREDENTIALS');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// AuthService.login — Maintenance Mode
// ---------------------------------------------------------------------------

test('login is blocked for non-Admin roles while Maintenance Mode is on', async () => {
  const { authService } = buildFixture({
    users: [{ username: '2201234', role: ROLES.STUDENT, isActive: true, passwordHash: null }],
    students: [{ userId: 'user_1', studentCode: '2201234', fullName: 'Test', group: 'G1', isActive: true }],
    maintenanceMode: true,
    maintenanceMessage: 'Down for upgrades.',
  });

  await assert.rejects(
    () => authService.login({ identifier: '2201234' }),
    (err) => {
      assert.strictEqual(err.statusCode, 503);
      assert.strictEqual(err.code, 'MAINTENANCE');
      assert.strictEqual(err.message, 'Down for upgrades.');
      return true;
    }
  );
});

test('login still succeeds for Admin while Maintenance Mode is on', async () => {
  const hash = await hashPassword('admin-pw');
  const { authService } = buildFixture({
    users: [{ username: 'mazen', role: ROLES.ADMIN, isActive: true, passwordHash: hash }],
    maintenanceMode: true,
  });

  const user = await authService.login({ identifier: 'mazen', password: 'admin-pw' });
  assert.strictEqual(user.role, ROLES.ADMIN);
});

// ---------------------------------------------------------------------------
// AuthService — student password create/remove
// ---------------------------------------------------------------------------

test('createPassword sets a hashed password for a code-only student', async () => {
  const { authService, models } = buildFixture({
    users: [{ username: '2201234', role: ROLES.STUDENT, isActive: true, passwordHash: null }],
  });

  await authService.createPassword({ userId: 'user_1', password: 'brand-new-pw' });
  const stored = models.User._docs.find((u) => u._id === 'user_1');
  assert.ok(stored.passwordHash);
  assert.notStrictEqual(stored.passwordHash, 'brand-new-pw');
  assert.strictEqual(await comparePassword('brand-new-pw', stored.passwordHash), true);
});

test('createPassword rejects a password shorter than the minimum length', async () => {
  const { authService } = buildFixture({
    users: [{ username: '2201234', role: ROLES.STUDENT, isActive: true, passwordHash: null }],
  });

  await assert.rejects(
    () => authService.createPassword({ userId: 'user_1', password: 'short' }),
    (err) => {
      assert.strictEqual(err.statusCode, 422);
      assert.strictEqual(err.code, 'WEAK_PASSWORD');
      return true;
    }
  );
});

test('createPassword rejects when a password is already set', async () => {
  const hash = await hashPassword('existing-pw');
  const { authService } = buildFixture({
    users: [{ username: '2201234', role: ROLES.STUDENT, isActive: true, passwordHash: hash }],
  });

  await assert.rejects(
    () => authService.createPassword({ userId: 'user_1', password: 'another-password' }),
    (err) => {
      assert.strictEqual(err.statusCode, 409);
      assert.strictEqual(err.code, 'PASSWORD_ALREADY_SET');
      return true;
    }
  );
});

test('createPassword rejects for a non-student account', async () => {
  const { authService } = buildFixture({
    users: [{ username: 'some_doctor', role: ROLES.DOCTOR, isActive: true, passwordHash: null }],
  });

  await assert.rejects(
    () => authService.createPassword({ userId: 'user_1', password: 'a-fine-password' }),
    (err) => {
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(err.code, 'NOT_A_STUDENT');
      return true;
    }
  );
});

test('removePassword clears passwordHash, returning to code-only login', async () => {
  const hash = await hashPassword('existing-pw');
  const { authService, models } = buildFixture({
    users: [{ username: '2201234', role: ROLES.STUDENT, isActive: true, passwordHash: hash }],
  });

  await authService.removePassword({ userId: 'user_1' });
  const stored = models.User._docs.find((u) => u._id === 'user_1');
  assert.strictEqual(stored.passwordHash, null);
});

test('removePassword rejects when no password is currently set', async () => {
  const { authService } = buildFixture({
    users: [{ username: '2201234', role: ROLES.STUDENT, isActive: true, passwordHash: null }],
  });

  await assert.rejects(
    () => authService.removePassword({ userId: 'user_1' }),
    (err) => {
      assert.strictEqual(err.statusCode, 409);
      assert.strictEqual(err.code, 'PASSWORD_NOT_SET');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// AuthService — forgot password
// ---------------------------------------------------------------------------

test('requestPasswordReset creates a PASSWORD_RESET request for a matching identifier', async () => {
  const { authService, models, auditCalls } = buildFixture({
    users: [{ username: '2201234', role: ROLES.STUDENT, isActive: true, passwordHash: null }],
  });

  const result = await authService.requestPasswordReset({ identifier: '2201234' });
  assert.strictEqual(result.requested, true);
  assert.strictEqual(models.Request._docs.length, 1);
  assert.strictEqual(models.Request._docs[0].type, 'PASSWORD_RESET');
  assert.ok(auditCalls.some((c) => c.action === 'PASSWORD_RESET_REQUESTED'));
});

test('requestPasswordReset does NOT create a request for an unknown identifier (anti-enumeration)', async () => {
  const { authService, models, auditCalls } = buildFixture({ users: [] });

  const result = await authService.requestPasswordReset({ identifier: 'nobody-by-this-name' });
  assert.strictEqual(result.requested, true); // still generically "successful"
  assert.strictEqual(models.Request._docs.length, 0);
  assert.strictEqual(auditCalls.length, 0);
});

// ---------------------------------------------------------------------------
// AuthService — admin reset password (foundation only, no route yet)
// ---------------------------------------------------------------------------

test('adminResetPassword rejects a non-Admin actor', async () => {
  const { authService } = buildFixture({
    users: [{ username: '2201234', role: ROLES.STUDENT, isActive: true, passwordHash: null }],
  });

  await assert.rejects(
    () =>
      authService.adminResetPassword({
        actorUser: { role: ROLES.DOCTOR },
        targetUserId: 'user_1',
        newPassword: 'new-password-1',
      }),
    (err) => {
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(err.code, 'ADMIN_ONLY');
      return true;
    }
  );
});

test('adminResetPassword lets Admin set a new hashed password for any user', async () => {
  const { authService, models, auditCalls } = buildFixture({
    users: [{ username: '2201234', role: ROLES.STUDENT, isActive: true, passwordHash: null }],
  });

  await authService.adminResetPassword({
    actorUser: { id: 'admin_1', role: ROLES.ADMIN },
    targetUserId: 'user_1',
    newPassword: 'reset-by-admin-1',
  });

  const stored = models.User._docs.find((u) => u._id === 'user_1');
  assert.ok(stored.passwordHash);
  assert.strictEqual(await comparePassword('reset-by-admin-1', stored.passwordHash), true);
  assert.ok(
    auditCalls.some((c) => c.action === 'PASSWORD_RESET_BY_ADMIN' && c.actorId === 'admin_1')
  );
});

// ---------------------------------------------------------------------------
// Regression tests: GET /api/auth/me and POST /api/auth/login must report
// hasPassword correctly (bug: /me's query was missing
// .select('+passwordHash'), so hasPassword could never be true no matter
// what was actually in the database — fixed in auth.controller.js).
// These specifically exercise the CONTROLLER layer (not just AuthService),
// since the bug was in the controller's own database query, not in
// AuthService or in pure response-serialization logic.
// ---------------------------------------------------------------------------

test('GET /api/auth/me reports hasPassword: true after a password has been created', async () => {
  const hash = await hashPassword('a-real-password-1');
  const { authController } = buildFixture({
    users: [{ username: '2201234', role: ROLES.STUDENT, isActive: true, passwordHash: hash }],
    students: [
      { userId: 'user_1', studentCode: '2201234', fullName: 'Test Student', group: 'G1', isActive: true },
    ],
  });

  const req = { user: { id: 'user_1', username: '2201234', role: ROLES.STUDENT } };
  const { res, err } = await callController(authController.me, req);

  assert.strictEqual(err, undefined);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.user.hasPassword, true);
  assert.strictEqual(JSON.stringify(res.body).includes(hash), false, 'must never leak the hash itself');
});

test('GET /api/auth/me reports hasPassword: false when no password is set', async () => {
  const { authController } = buildFixture({
    users: [{ username: '2201234', role: ROLES.STUDENT, isActive: true, passwordHash: null }],
    students: [
      { userId: 'user_1', studentCode: '2201234', fullName: 'Test Student', group: 'G1', isActive: true },
    ],
  });

  const req = { user: { id: 'user_1', username: '2201234', role: ROLES.STUDENT } };
  const { res, err } = await callController(authController.me, req);

  assert.strictEqual(err, undefined);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.user.hasPassword, false);
});

test('End-to-end: createPassword then GET /api/auth/me reports hasPassword: true (the exact reported bug scenario)', async () => {
  const { authService, authController } = buildFixture({
    users: [{ username: '2201234', role: ROLES.STUDENT, isActive: true, passwordHash: null }],
    students: [
      { userId: 'user_1', studentCode: '2201234', fullName: 'Test Student', group: 'G1', isActive: true },
    ],
  });

  // Reproduces the reported sequence: create a password via the service
  // (what POST /api/auth/password does), then call the /me controller.
  await authService.createPassword({ userId: 'user_1', password: 'brand-new-pw-1' });

  const req = { user: { id: 'user_1', username: '2201234', role: ROLES.STUDENT } };
  const { res, err } = await callController(authController.me, req);

  assert.strictEqual(err, undefined);
  assert.strictEqual(res.body.user.hasPassword, true);
});

test('POST /api/auth/login reports hasPassword: true for a user with a password', async () => {
  const hash = await hashPassword('a-real-password-1');
  const { authController } = buildFixture({
    users: [{ username: '2201234', role: ROLES.STUDENT, isActive: true, passwordHash: hash }],
    students: [
      { userId: 'user_1', studentCode: '2201234', fullName: 'Test Student', group: 'G1', isActive: true },
    ],
  });

  const req = {
    body: { identifier: '2201234', password: 'a-real-password-1' },
    session: makeFakeSession(),
  };
  const { res, err } = await callController(authController.login, req);

  assert.strictEqual(err, undefined);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.user.hasPassword, true);
});

test('POST /api/auth/login reports hasPassword: false for a code-only student', async () => {
  const { authController } = buildFixture({
    users: [{ username: '2201234', role: ROLES.STUDENT, isActive: true, passwordHash: null }],
    students: [
      { userId: 'user_1', studentCode: '2201234', fullName: 'Test Student', group: 'G1', isActive: true },
    ],
  });

  const req = { body: { identifier: '2201234' }, session: makeFakeSession() };
  const { res, err } = await callController(authController.login, req);

  assert.strictEqual(err, undefined);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.user.hasPassword, false);
});

test('serializeUser never includes the raw passwordHash field, only the boolean', async () => {
  const hash = await hashPassword('a-real-password-1');
  const { authController } = buildFixture();
  const fakeUser = { _id: 'user_1', username: 'x', role: ROLES.ADMIN, passwordHash: hash, lastLoginAt: null };

  const serialized = authController.serializeUser(fakeUser, null, 'admin');
  assert.strictEqual(serialized.hasPassword, true);
  assert.strictEqual('passwordHash' in serialized, false);
});



test('requireRole calls next() with no error when the role matches', () => {
  const { authMiddleware } = buildFixture();
  const req = { user: { id: 'u1', role: ROLES.ADMIN } };
  let called = false;
  authMiddleware.requireRole(ROLES.ADMIN)(req, {}, (err) => {
    called = true;
    assert.strictEqual(err, undefined);
  });
  assert.ok(called);
});

test('requireRole forbids a mismatched role', () => {
  const { authMiddleware } = buildFixture();
  const req = { user: { id: 'u1', role: ROLES.STUDENT } };
  let receivedErr;
  authMiddleware.requireRole(ROLES.ADMIN)(req, {}, (err) => {
    receivedErr = err;
  });
  assert.ok(receivedErr instanceof AppError);
  assert.strictEqual(receivedErr.statusCode, 403);
});

test('requireRole rejects when req.user is missing entirely', () => {
  const { authMiddleware } = buildFixture();
  let receivedErr;
  authMiddleware.requireRole(ROLES.ADMIN)({}, {}, (err) => {
    receivedErr = err;
  });
  assert.ok(receivedErr instanceof AppError);
  assert.strictEqual(receivedErr.statusCode, 401);
});

// ---------------------------------------------------------------------------
// RBAC middleware — requirePermission
// ---------------------------------------------------------------------------

test('requirePermission allows when the predicate resolves true', async () => {
  const { authMiddleware } = buildFixture();
  const req = { user: { id: 'u1', role: ROLES.DOCTOR } };
  const { err } = await runMiddleware(authMiddleware.requirePermission(async () => true), req);
  assert.strictEqual(err, undefined);
});

test('requirePermission forbids when the predicate resolves false', async () => {
  const { authMiddleware } = buildFixture();
  const req = { user: { id: 'u1', role: ROLES.DOCTOR } };
  const { err } = await runMiddleware(authMiddleware.requirePermission(async () => false), req);
  assert.ok(err instanceof AppError);
  assert.strictEqual(err.statusCode, 403);
});

test('requirePermission rejects unauthenticated requests without calling the predicate', async () => {
  const { authMiddleware } = buildFixture();
  let predicateCalled = false;
  const { err } = await runMiddleware(
    authMiddleware.requirePermission(async () => {
      predicateCalled = true;
      return true;
    }),
    {}
  );
  assert.ok(err instanceof AppError);
  assert.strictEqual(err.statusCode, 401);
  assert.strictEqual(predicateCalled, false);
});

// ---------------------------------------------------------------------------
// RBAC middleware — requireAuth
// ---------------------------------------------------------------------------

test('requireAuth rejects when there is no session', async () => {
  const { authMiddleware } = buildFixture();
  const req = {};
  const { err } = await runMiddleware(authMiddleware.requireAuth, req);
  assert.ok(err instanceof AppError);
  assert.strictEqual(err.statusCode, 401);
});

test('requireAuth rejects when the session references a user that no longer exists', async () => {
  const { authMiddleware } = buildFixture({ users: [] });
  const req = { session: { userId: 'ghost_user', destroy: (cb) => cb && cb() } };
  const { err } = await runMiddleware(authMiddleware.requireAuth, req);
  assert.ok(err instanceof AppError);
  assert.strictEqual(err.code, 'SESSION_INVALID');
});

test('requireAuth rejects a disabled user even with a technically valid session', async () => {
  const { authMiddleware } = buildFixture({
    users: [{ username: '2201234', role: ROLES.STUDENT, isActive: false, passwordHash: null }],
  });
  const req = { session: { userId: 'user_1', destroy: (cb) => cb && cb() } };
  const { err } = await runMiddleware(authMiddleware.requireAuth, req);
  assert.strictEqual(err.code, 'SESSION_INVALID');
});

test('requireAuth rejects when the role-specific profile has been deactivated', async () => {
  const { authMiddleware } = buildFixture({
    users: [{ username: '2201234', role: ROLES.STUDENT, isActive: true, passwordHash: null }],
    students: [
      { userId: 'user_1', studentCode: '2201234', fullName: 'Test', group: 'G1', isActive: false },
    ],
  });
  const req = { session: { userId: 'user_1', destroy: (cb) => cb && cb() } };
  const { err } = await runMiddleware(authMiddleware.requireAuth, req);
  assert.strictEqual(err.code, 'SESSION_INVALID');
});

test('requireAuth populates req.user and calls next() cleanly for a valid, active session', async () => {
  const { authMiddleware } = buildFixture({
    users: [{ username: '2201234', role: ROLES.STUDENT, isActive: true, passwordHash: null }],
    students: [
      { userId: 'user_1', studentCode: '2201234', fullName: 'Test', group: 'G1', isActive: true },
    ],
  });
  const req = { session: { userId: 'user_1' } };
  const { err } = await runMiddleware(authMiddleware.requireAuth, req);
  assert.strictEqual(err, undefined);
  assert.strictEqual(req.user.role, ROLES.STUDENT);
  assert.strictEqual(req.user.username, '2201234');
});

// ---------------------------------------------------------------------------
// Maintenance Mode middleware
// ---------------------------------------------------------------------------

test('checkMaintenanceMode allows everyone through when maintenance is off', async () => {
  const { maintenanceMiddleware } = buildFixture({ maintenanceMode: false });
  const req = { user: { role: ROLES.STUDENT } };
  const { err } = await runMiddleware(maintenanceMiddleware.checkMaintenanceMode, req);
  assert.strictEqual(err, undefined);
});

test('checkMaintenanceMode blocks a non-Admin with 503 when maintenance is on', async () => {
  const { maintenanceMiddleware } = buildFixture({
    maintenanceMode: true,
    maintenanceMessage: 'Back soon.',
  });
  const req = { user: { role: ROLES.STUDENT } };
  const { err } = await runMiddleware(maintenanceMiddleware.checkMaintenanceMode, req);
  assert.ok(err instanceof AppError);
  assert.strictEqual(err.statusCode, 503);
  assert.strictEqual(err.message, 'Back soon.');
});

test('checkMaintenanceMode still allows Admin through when maintenance is on', async () => {
  const { maintenanceMiddleware } = buildFixture({ maintenanceMode: true });
  const req = { user: { role: ROLES.ADMIN } };
  const { err } = await runMiddleware(maintenanceMiddleware.checkMaintenanceMode, req);
  assert.strictEqual(err, undefined);
});

test('checkMaintenanceMode treats a missing req.user as non-Admin', async () => {
  const { maintenanceMiddleware } = buildFixture({ maintenanceMode: true });
  const { err } = await runMiddleware(maintenanceMiddleware.checkMaintenanceMode, {});
  assert.ok(err instanceof AppError);
  assert.strictEqual(err.statusCode, 503);
});

// ---------------------------------------------------------------------------
// Login rate limiting (real HTTP, real limiter, no database needed)
// ---------------------------------------------------------------------------

test('authLimiter returns 429 with the standard error shape after too many attempts', async () => {
  const { authLimiter } = require('../middleware/rateLimiters');

  const testApp = express();
  testApp.use(authLimiter);
  testApp.get('/probe', (req, res) => res.json({ success: true }));

  const agent = request(testApp);
  let lastRes;
  for (let i = 0; i < 11; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    lastRes = await agent.get('/probe');
  }

  assert.strictEqual(lastRes.status, 429);
  assert.strictEqual(lastRes.body.success, false);
  assert.strictEqual(lastRes.body.code, 'RATE_LIMITED');
});
