/**
 * Tests for scripts/importStudents.js — Phase H hardening.
 *
 * Covers:
 *   - ROSTER integrity (count, exclusions)
 *   - Standalone path: success, field values, audit
 *   - Standalone path: Student.create fails → compensating User.deleteOne
 *   - Standalone path: Student.create fails AND deleteOne fails → CompensationError
 *   - Standalone path: User.create fails → error propagates, no compensation
 *   - Transaction path: success → both docs created, audit logged
 *   - Transaction path: Student.create fails → fake rollback, no orphan, no audit
 *   - Audit: written only on full success (never on any failure path)
 *
 * All tests use the in-memory fake-collection harness — no live MongoDB
 * connection is required.
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert');

const { createFakeCollection, createTestFixtureScope } = require('./helpers/fakeCollection');
const { createFakeTransactionRunner }                  = require('./helpers/fakeTransaction');

const {
  ROSTER,
  EXCLUDED_CODES,
  createStudentRecord,
} = require('../../scripts/importStudents');

// ── helpers ──────────────────────────────────────────────────────────────────

/** Minimal audit spy — records calls, never throws */
function makeAuditSpy() {
  const calls = [];
  return {
    calls,
    recordAudit: async (entry) => { calls.push({ ...entry }); },
  };
}

/** Minimal actorUser for all tests */
const ACTOR = { id: 'admin_1', role: 'ADMIN' };

/** One roster entry used by most single-student tests */
const ENTRY = { studentCode: '250100003', fullName: 'يوسف اشرف عبدالرازق ابراهيم' };

/**
 * Build a fresh pair of empty fake User + Student collections.
 * Returns { User, Student, scope } — all sharing the same ID scope so
 * IDs are predictable and do not clash across collections.
 */
function freshCollections() {
  const scope = createTestFixtureScope();
  const User    = createFakeCollection('user',    [], scope);
  const Student = createFakeCollection('student', [], scope);
  return { User, Student, scope };
}

// ── ROSTER integrity ──────────────────────────────────────────────────────────

test('ROSTER has exactly 57 entries', () => {
  assert.strictEqual(ROSTER.length, 57, `Expected 57, got ${ROSTER.length}`);
});

test('every ROSTER entry is a two-element array [code, name]', () => {
  for (const entry of ROSTER) {
    assert.ok(Array.isArray(entry),                 `entry is not an array: ${JSON.stringify(entry)}`);
    assert.strictEqual(entry.length, 2,             `entry length !== 2: ${JSON.stringify(entry)}`);
    assert.ok(typeof entry[0] === 'string' && entry[0].length > 0, `code empty: ${entry[0]}`);
    assert.ok(typeof entry[1] === 'string' && entry[1].length > 0, `name empty: ${entry[1]}`);
  }
});

test('ROSTER codes are unique', () => {
  const codes = ROSTER.map(([code]) => code);
  const unique = new Set(codes);
  assert.strictEqual(unique.size, codes.length, 'Duplicate codes found in ROSTER');
});

test('excluded code 230100206 is not in ROSTER', () => {
  const codes = new Set(ROSTER.map(([code]) => code));
  assert.ok(!codes.has('230100206'), '230100206 must be excluded from ROSTER');
});

test('excluded code 240100646 is not in ROSTER', () => {
  const codes = new Set(ROSTER.map(([code]) => code));
  assert.ok(!codes.has('240100646'), '240100646 must be excluded from ROSTER');
});

test('EXCLUDED_CODES contains exactly the two permanently excluded codes', () => {
  assert.deepStrictEqual(
    [...EXCLUDED_CODES].sort(),
    ['230100206', '240100646'],
  );
});

// ── Standalone path — success ─────────────────────────────────────────────────

test('standalone: creates User and Student docs on success', async () => {
  const { User, Student } = freshCollections();
  const audit = makeAuditSpy();

  await createStudentRecord({
    ...ENTRY,
    actorUser: ACTOR,
    models: { User, Student },
    auditService: audit,
    runInTransaction: null,
  });

  assert.strictEqual(User._docs.length,    1, 'Expected 1 User');
  assert.strictEqual(Student._docs.length, 1, 'Expected 1 Student');
});

test('standalone: User doc has correct field values', async () => {
  const { User, Student } = freshCollections();
  const audit = makeAuditSpy();

  await createStudentRecord({
    ...ENTRY,
    actorUser: ACTOR,
    models: { User, Student },
    auditService: audit,
    runInTransaction: null,
  });

  const user = User._docs[0];
  assert.strictEqual(user.username,     ENTRY.studentCode);
  assert.strictEqual(user.passwordHash, null,      'passwordHash must be null (no password)');
  assert.strictEqual(user.role,         'STUDENT');
  assert.strictEqual(user.isActive,     true);
});

test('standalone: Student doc has correct field values', async () => {
  const { User, Student } = freshCollections();
  const audit = makeAuditSpy();

  await createStudentRecord({
    ...ENTRY,
    actorUser: ACTOR,
    models: { User, Student },
    auditService: audit,
    runInTransaction: null,
  });

  const student = Student._docs[0];
  assert.strictEqual(student.studentCode, ENTRY.studentCode);
  assert.strictEqual(student.fullName,    ENTRY.fullName);
  assert.strictEqual(student.group,       'UNASSIGNED', 'group must be UNASSIGNED');
  assert.strictEqual(student.isActive,    true);
  assert.ok(student.userId,              'userId must be set');
  // userId must link to the created User
  assert.strictEqual(String(student.userId), String(User._docs[0]._id));
});

test('standalone: returns the created Student document', async () => {
  const { User, Student } = freshCollections();
  const audit = makeAuditSpy();

  const result = await createStudentRecord({
    ...ENTRY,
    actorUser: ACTOR,
    models: { User, Student },
    auditService: audit,
    runInTransaction: null,
  });

  assert.strictEqual(result.studentCode, ENTRY.studentCode);
  assert.strictEqual(result.group,       'UNASSIGNED');
});

// ── Standalone path — audit behaviour ────────────────────────────────────────

test('standalone: records exactly one STUDENT_CREATED audit entry on success', async () => {
  const { User, Student } = freshCollections();
  const audit = makeAuditSpy();

  await createStudentRecord({
    ...ENTRY,
    actorUser: ACTOR,
    models: { User, Student },
    auditService: audit,
    runInTransaction: null,
  });

  assert.strictEqual(audit.calls.length, 1,                 'Expected exactly 1 audit call');
  assert.strictEqual(audit.calls[0].action, 'STUDENT_CREATED');
  assert.strictEqual(audit.calls[0].actorId,   ACTOR.id);
  assert.strictEqual(audit.calls[0].actorRole, ACTOR.role);
  assert.strictEqual(audit.calls[0].after.group, 'UNASSIGNED');
});

// ── Standalone path — Student.create fails, compensation succeeds ─────────────

test('standalone: Student.create fail → compensating User.deleteOne runs', async () => {
  const { User, Student } = freshCollections();
  const audit = makeAuditSpy();

  // Patch Student.create to always throw
  const originalCreate = Student.create.bind(Student);
  Student.create = async () => { throw new Error('Simulated Student.create failure'); };

  await assert.rejects(
    () => createStudentRecord({
      ...ENTRY,
      actorUser: ACTOR,
      models: { User, Student },
      auditService: audit,
      runInTransaction: null,
    }),
    /Simulated Student\.create failure/,
  );

  // User must have been compensated (deleted)
  assert.strictEqual(User._docs.length,    0, 'Orphaned User must have been deleted');
  assert.strictEqual(Student._docs.length, 0, 'Student was never persisted');

  Student.create = originalCreate; // restore
});

test('standalone: Student.create fail → original error is re-thrown (not a CompensationError)', async () => {
  const { User, Student } = freshCollections();
  const audit = makeAuditSpy();

  const originalCreate = Student.create.bind(Student);
  Student.create = async () => { throw new Error('OriginalStudentError'); };

  await assert.rejects(
    () => createStudentRecord({
      ...ENTRY,
      actorUser: ACTOR,
      models: { User, Student },
      auditService: audit,
      runInTransaction: null,
    }),
    (err) => {
      // Must be the original error, not wrapped
      assert.match(err.message, /OriginalStudentError/);
      // Must NOT have orphanedUserId (that only appears on CompensationError)
      assert.strictEqual(err.orphanedUserId, undefined);
      return true;
    },
  );

  Student.create = originalCreate;
});

test('standalone: Student.create fail → no audit entry written', async () => {
  const { User, Student } = freshCollections();
  const audit = makeAuditSpy();

  const originalCreate = Student.create.bind(Student);
  Student.create = async () => { throw new Error('Student fail'); };

  await assert.rejects(
    () => createStudentRecord({
      ...ENTRY,
      actorUser: ACTOR,
      models: { User, Student },
      auditService: audit,
      runInTransaction: null,
    }),
  );

  assert.strictEqual(audit.calls.length, 0, 'No audit entry must be written on failure');

  Student.create = originalCreate;
});

// ── Standalone path — compensation itself fails ───────────────────────────────

test('standalone: Student.create fail AND deleteOne returns 0 → error propagates, User absent is fine', async () => {
  // Edge case: Student.create throws but deleteOne says it deleted nothing
  // (e.g. the User was already gone — extremely unlikely but handled).
  // The script treats deletedCount=0 the same as a clean rollback and
  // re-throws the original error with no orphanedUserId, because there is
  // nothing to clean up.
  const { User, Student } = freshCollections();
  const audit = makeAuditSpy();

  const originalStudentCreate = Student.create.bind(Student);
  Student.create = async () => { throw new Error('StudentFail'); };

  // Override deleteOne to report it deleted nothing
  const originalDeleteOne = User.deleteOne.bind(User);
  User.deleteOne = async () => ({ deletedCount: 0 });

  await assert.rejects(
    () => createStudentRecord({
      ...ENTRY,
      actorUser: ACTOR,
      models: { User, Student },
      auditService: audit,
      runInTransaction: null,
    }),
    (err) => {
      assert.match(err.message, /StudentFail/);
      assert.strictEqual(err.orphanedUserId, undefined, 'deletedCount=0 branch must not set orphanedUserId');
      return true;
    },
  );

  Student.create = originalStudentCreate;
  User.deleteOne = originalDeleteOne;
});

test('standalone: Student.create fail AND deleteOne throws → CompensationError with orphanedUserId', async () => {
  const { User, Student } = freshCollections();
  const audit = makeAuditSpy();

  const originalStudentCreate = Student.create.bind(Student);
  Student.create = async () => { throw new Error('StudentFail'); };

  const originalDeleteOne = User.deleteOne.bind(User);
  User.deleteOne = async () => { throw new Error('DeleteFail'); };

  await assert.rejects(
    () => createStudentRecord({
      ...ENTRY,
      actorUser: ACTOR,
      models: { User, Student },
      auditService: audit,
      runInTransaction: null,
    }),
    (err) => {
      assert.ok(err.orphanedUserId,                          'CompensationError must carry orphanedUserId');
      assert.match(err.message, /manual cleanup/i,           'message must mention manual cleanup');
      assert.ok(err.originalError,                           'CompensationError must carry originalError');
      assert.match(err.originalError.message, /StudentFail/, 'originalError must be the Student.create error');
      return true;
    },
  );

  // User is still in _docs (compensation failed — orphan)
  assert.strictEqual(User._docs.length, 1, 'User must remain in DB when compensation failed');

  Student.create = originalStudentCreate;
  User.deleteOne = originalDeleteOne;
});

test('standalone: CompensationError message contains mongosh cleanup command', async () => {
  const { User, Student } = freshCollections();

  const originalStudentCreate = Student.create.bind(Student);
  Student.create = async () => { throw new Error('fail'); };

  const originalDeleteOne = User.deleteOne.bind(User);
  User.deleteOne = async () => { throw new Error('DeleteFail'); };

  await assert.rejects(
    () => createStudentRecord({
      ...ENTRY,
      actorUser: ACTOR,
      models: { User, Student },
      auditService: makeAuditSpy(),
      runInTransaction: null,
    }),
    (err) => {
      // Must contain a mongosh deleteOne command referencing the orphaned _id
      assert.match(err.message, /db\.users\.deleteOne/);
      assert.match(err.message, new RegExp(String(User._docs[0]._id)));
      return true;
    },
  );

  Student.create = originalStudentCreate;
  User.deleteOne = originalDeleteOne;
});

// ── Standalone path — User.create fails ──────────────────────────────────────

test('standalone: User.create fail → error propagates immediately, no compensation attempted', async () => {
  const { User, Student } = freshCollections();
  const audit = makeAuditSpy();

  const originalUserCreate = User.create.bind(User);
  User.create = async () => { throw new Error('UserCreateFail'); };

  // Track whether deleteOne is called
  let deleteOneCalled = false;
  const originalDeleteOne = User.deleteOne.bind(User);
  User.deleteOne = async (...args) => { deleteOneCalled = true; return originalDeleteOne(...args); };

  await assert.rejects(
    () => createStudentRecord({
      ...ENTRY,
      actorUser: ACTOR,
      models: { User, Student },
      auditService: audit,
      runInTransaction: null,
    }),
    /UserCreateFail/,
  );

  assert.ok(!deleteOneCalled, 'deleteOne must not be called when User.create itself failed');
  assert.strictEqual(Student._docs.length, 0, 'No Student must be created');
  assert.strictEqual(audit.calls.length, 0,   'No audit entry on User.create failure');

  User.create   = originalUserCreate;
  User.deleteOne = originalDeleteOne;
});

// ── Transaction path — success ────────────────────────────────────────────────

test('transaction path: creates User and Student on success', async () => {
  const { User, Student } = freshCollections();
  const audit             = makeAuditSpy();
  const runInTransaction  = createFakeTransactionRunner({ User, Student });

  await createStudentRecord({
    ...ENTRY,
    actorUser: ACTOR,
    models: { User, Student },
    auditService: audit,
    runInTransaction,
  });

  assert.strictEqual(User._docs.length,    1, 'Expected 1 User');
  assert.strictEqual(Student._docs.length, 1, 'Expected 1 Student');
});

test('transaction path: User doc has correct field values', async () => {
  const { User, Student } = freshCollections();
  const audit             = makeAuditSpy();
  const runInTransaction  = createFakeTransactionRunner({ User, Student });

  await createStudentRecord({
    ...ENTRY,
    actorUser: ACTOR,
    models: { User, Student },
    auditService: audit,
    runInTransaction,
  });

  const user = User._docs[0];
  assert.strictEqual(user.username,     ENTRY.studentCode);
  assert.strictEqual(user.passwordHash, null,      'passwordHash must be null');
  assert.strictEqual(user.role,         'STUDENT');
  assert.strictEqual(user.isActive,     true);
});

test('transaction path: Student doc has correct field values and group=UNASSIGNED', async () => {
  const { User, Student } = freshCollections();
  const audit             = makeAuditSpy();
  const runInTransaction  = createFakeTransactionRunner({ User, Student });

  await createStudentRecord({
    ...ENTRY,
    actorUser: ACTOR,
    models: { User, Student },
    auditService: audit,
    runInTransaction,
  });

  const student = Student._docs[0];
  assert.strictEqual(student.studentCode, ENTRY.studentCode);
  assert.strictEqual(student.fullName,    ENTRY.fullName);
  assert.strictEqual(student.group,       'UNASSIGNED');
  assert.strictEqual(student.isActive,    true);
  assert.strictEqual(String(student.userId), String(User._docs[0]._id));
});

test('transaction path: records exactly one STUDENT_CREATED audit entry', async () => {
  const { User, Student } = freshCollections();
  const audit             = makeAuditSpy();
  const runInTransaction  = createFakeTransactionRunner({ User, Student });

  await createStudentRecord({
    ...ENTRY,
    actorUser: ACTOR,
    models: { User, Student },
    auditService: audit,
    runInTransaction,
  });

  assert.strictEqual(audit.calls.length, 1);
  assert.strictEqual(audit.calls[0].action,       'STUDENT_CREATED');
  assert.strictEqual(audit.calls[0].actorId,      ACTOR.id);
  assert.strictEqual(audit.calls[0].after.group,  'UNASSIGNED');
});

// ── Transaction path — partial failure (rollback) ─────────────────────────────

test('transaction path: Student.create fail → fake rollback removes User, no orphan', async () => {
  const { User, Student } = freshCollections();
  const audit             = makeAuditSpy();

  // Override Student.create to throw inside the transaction
  const originalStudentCreate = Student.create.bind(Student);
  Student.create = async () => { throw new Error('Simulated Student tx failure'); };

  // Build the runner AFTER the patch so it snapshots the (still-empty) _docs
  const runInTransaction = createFakeTransactionRunner({ User, Student });

  await assert.rejects(
    () => createStudentRecord({
      ...ENTRY,
      actorUser: ACTOR,
      models: { User, Student },
      auditService: audit,
      runInTransaction,
    }),
    /Simulated Student tx failure/,
  );

  // Fake transaction runner must have restored both collections to empty
  assert.strictEqual(User._docs.length,    0, 'User must be rolled back');
  assert.strictEqual(Student._docs.length, 0, 'Student was never persisted');

  Student.create = originalStudentCreate;
});

test('transaction path: Student.create fail → no audit entry written', async () => {
  const { User, Student } = freshCollections();
  const audit             = makeAuditSpy();

  const originalStudentCreate = Student.create.bind(Student);
  Student.create = async () => { throw new Error('tx Student fail'); };

  const runInTransaction = createFakeTransactionRunner({ User, Student });

  await assert.rejects(
    () => createStudentRecord({
      ...ENTRY,
      actorUser: ACTOR,
      models: { User, Student },
      auditService: audit,
      runInTransaction,
    }),
  );

  assert.strictEqual(audit.calls.length, 0, 'No audit entry on transaction rollback');

  Student.create = originalStudentCreate;
});

// ── Rerun idempotency (multiple calls) ────────────────────────────────────────

test('standalone: two sequential calls for different students each create their own docs', async () => {
  const { User, Student } = freshCollections();
  const audit = makeAuditSpy();

  const entry2 = { studentCode: '250100006', fullName: 'نهى محمد زين العابدين احمد' };

  await createStudentRecord({
    ...ENTRY,
    actorUser: ACTOR,
    models: { User, Student },
    auditService: audit,
    runInTransaction: null,
  });
  await createStudentRecord({
    ...entry2,
    actorUser: ACTOR,
    models: { User, Student },
    auditService: audit,
    runInTransaction: null,
  });

  assert.strictEqual(User._docs.length,    2);
  assert.strictEqual(Student._docs.length, 2);
  assert.strictEqual(audit.calls.length,   2);

  const codes = User._docs.map(u => u.username);
  assert.ok(codes.includes(ENTRY.studentCode));
  assert.ok(codes.includes(entry2.studentCode));
});

test('standalone: whitespace in studentCode is trimmed', async () => {
  const { User, Student } = freshCollections();
  const audit = makeAuditSpy();

  await createStudentRecord({
    studentCode: '  250100003  ',
    fullName:    '  Test Name  ',
    actorUser: ACTOR,
    models: { User, Student },
    auditService: audit,
    runInTransaction: null,
  });

  assert.strictEqual(User._docs[0].username,         '250100003');
  assert.strictEqual(Student._docs[0].studentCode,   '250100003');
  assert.strictEqual(Student._docs[0].fullName,      'Test Name');
});
