/**
 * Phase 2 tests: schema-level validation and index declarations.
 *
 * These deliberately do NOT require a live MongoDB connection — they use
 * Mongoose's validateSync() (which runs schema validators in-memory) and
 * schema.indexes() (which inspects declared indexes without touching the
 * database) so the suite can run anywhere, exactly like Phase 1's tests.
 * Once MongoDB is actually connected (Phase 3+), these same validators
 * and indexes govern real writes.
 */

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

const {
  User,
  Student,
  Doctor,
  TA,
  Leader,
  Subject,
  Room,
  ScheduleTemplate,
  ScheduleSession,
  ScheduleChange,
  Task,
  TaskCompletion,
  Notification,
  NotificationRecipient,
  Request,
  AuditLog,
  SystemSettings,
} = require('../models');

const oid = () => new mongoose.Types.ObjectId();

function hasIndexOn(model, fieldNames) {
  const indexes = model.schema.indexes(); // [ [fieldsObj, optionsObj], ... ]
  return indexes.some(([fields]) => {
    const keys = Object.keys(fields);
    return fieldNames.every((f) => keys.includes(f)) && keys.length === fieldNames.length;
  });
}

function uniqueIndexOn(model, fieldNames) {
  const indexes = model.schema.indexes();
  return indexes.some(([fields, options]) => {
    const keys = Object.keys(fields);
    return (
      fieldNames.every((f) => keys.includes(f)) &&
      keys.length === fieldNames.length &&
      options &&
      options.unique === true
    );
  });
}

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

test('User requires username and a valid role', () => {
  const err = new User({}).validateSync();
  assert.ok(err.errors.username);
  assert.ok(err.errors.role);
});

test('User rejects an invalid role', () => {
  const err = new User({ username: 'mazen', role: 'SUPERADMIN' }).validateSync();
  assert.ok(err.errors.role);
});

test('User accepts a minimal valid document (student, no password)', () => {
  const err = new User({ username: '2201234', role: 'STUDENT' }).validateSync();
  assert.strictEqual(err, undefined);
});

test('User has a unique index on username', () => {
  assert.ok(uniqueIndexOn(User, ['username']));
});

// ---------------------------------------------------------------------------
// Student
// ---------------------------------------------------------------------------

test('Student requires studentCode, fullName, group, userId', () => {
  const err = new Student({}).validateSync();
  assert.ok(err.errors.studentCode);
  assert.ok(err.errors.fullName);
  assert.ok(err.errors.group);
  assert.ok(err.errors.userId);
});

test('Student rejects group ALL (a student must be G1 or G2, never ALL)', () => {
  const err = new Student({
    studentCode: '2201234',
    fullName: 'Test Student',
    group: 'ALL',
    userId: oid(),
  }).validateSync();
  assert.ok(err.errors.group);
});

test('Student accepts a valid document', () => {
  const err = new Student({
    studentCode: '2201234',
    fullName: 'Test Student',
    group: 'G1',
    userId: oid(),
  }).validateSync();
  assert.strictEqual(err, undefined);
});

test('Student has unique indexes on studentCode and userId', () => {
  assert.ok(uniqueIndexOn(Student, ['studentCode']));
  assert.ok(uniqueIndexOn(Student, ['userId']));
});

// ---------------------------------------------------------------------------
// Doctor / TA
// ---------------------------------------------------------------------------

test('Doctor requires fullName and userId, and has a unique userId index', () => {
  const err = new Doctor({}).validateSync();
  assert.ok(err.errors.fullName);
  assert.ok(err.errors.userId);
  assert.ok(uniqueIndexOn(Doctor, ['userId']));
});

test('TA requires fullName and userId, and has a unique userId index', () => {
  const err = new TA({}).validateSync();
  assert.ok(err.errors.fullName);
  assert.ok(err.errors.userId);
  assert.ok(uniqueIndexOn(TA, ['userId']));
});

// ---------------------------------------------------------------------------
// Leader
// ---------------------------------------------------------------------------

test('Leader requires slot, userId, linkedStudentId', () => {
  const err = new Leader({}).validateSync();
  assert.ok(err.errors.slot);
  assert.ok(err.errors.userId);
  assert.ok(err.errors.linkedStudentId);
});

test('Leader rejects an invalid slot', () => {
  const err = new Leader({
    slot: 'NONBINARY_SLOT_THAT_DOES_NOT_EXIST',
    userId: oid(),
    linkedStudentId: oid(),
  }).validateSync();
  assert.ok(err.errors.slot);
});

test('Leader has a partial unique index enforcing one active leader per slot', () => {
  const indexes = Leader.schema.indexes();
  const found = indexes.find(([fields, options]) => {
    return (
      Object.keys(fields).length === 1 &&
      fields.slot === 1 &&
      options &&
      options.unique === true &&
      options.partialFilterExpression &&
      options.partialFilterExpression.isActive === true
    );
  });
  assert.ok(found, 'expected a partial unique index on { slot } filtered to isActive: true');
});

// ---------------------------------------------------------------------------
// Room / Subject
// ---------------------------------------------------------------------------

test('Room requires building, floor, roomNumber and has a unique compound index', () => {
  const err = new Room({}).validateSync();
  assert.ok(err.errors.building);
  assert.ok(err.errors.floor);
  assert.ok(err.errors.roomNumber);
  assert.ok(uniqueIndexOn(Room, ['building', 'floor', 'roomNumber']));
});

test('Subject requires name, code, doctorId; taId is optional', () => {
  const err = new Subject({}).validateSync();
  assert.ok(err.errors.name);
  assert.ok(err.errors.code);
  assert.ok(err.errors.doctorId);

  const okErr = new Subject({
    name: 'Object-Oriented Programming',
    code: 'oop101',
    doctorId: oid(),
  }).validateSync();
  assert.strictEqual(okErr, undefined);
});

test('Subject uppercases its code and has a unique index on code', () => {
  const subject = new Subject({ name: 'OOP', code: 'oop101', doctorId: oid() });
  assert.strictEqual(subject.code, 'OOP101');
  assert.ok(uniqueIndexOn(Subject, ['code']));
});

// ---------------------------------------------------------------------------
// ScheduleTemplate
// ---------------------------------------------------------------------------

function validTemplateData(overrides = {}) {
  return {
    subjectId: oid(),
    type: 'LECTURE',
    group: 'ALL',
    dayOfWeek: 'SATURDAY',
    startTime: '10:00',
    endTime: '12:00',
    roomId: oid(),
    doctorId: oid(),
    effectiveFrom: new Date('2026-09-01'),
    ...overrides,
  };
}

test('ScheduleTemplate accepts a valid LECTURE/ALL document', () => {
  const err = new ScheduleTemplate(validTemplateData()).validateSync();
  assert.strictEqual(err, undefined);
});

test('ScheduleTemplate rejects LECTURE with a group other than ALL', () => {
  const err = new ScheduleTemplate(validTemplateData({ group: 'G1' })).validateSync();
  assert.ok(err.errors.group);
});

test('ScheduleTemplate accepts SECTION with group ALL (whole-cohort section, no G1/G2 division)', () => {
  // Confirmed current-semester business rule (2026-10): a semester with no
  // G1/G2 split can still have SECTION/lab entries, attended by every
  // student, so SECTION must accept ALL alongside G1/G2. LECTURE's
  // ALL-only requirement is unaffected (see the next two tests).
  const err = new ScheduleTemplate(
    validTemplateData({ type: 'SECTION', group: 'ALL' })
  ).validateSync();
  assert.strictEqual(err, undefined);
});

test('ScheduleTemplate accepts SECTION with group G1 or G2', () => {
  const err = new ScheduleTemplate(
    validTemplateData({ type: 'SECTION', group: 'G1' })
  ).validateSync();
  assert.strictEqual(err, undefined);
});

test('ScheduleTemplate rejects endTime <= startTime', () => {
  const err = new ScheduleTemplate(
    validTemplateData({ startTime: '12:00', endTime: '10:00' })
  ).validateSync();
  assert.ok(err.errors.endTime);
});

test('ScheduleTemplate rejects malformed time strings', () => {
  const err = new ScheduleTemplate(validTemplateData({ startTime: '25:99' })).validateSync();
  assert.ok(err.errors.startTime);
});

test('ScheduleTemplate rejects an invalid dayOfWeek (e.g. FRIDAY, outside the academic week)', () => {
  const err = new ScheduleTemplate(validTemplateData({ dayOfWeek: 'FRIDAY' })).validateSync();
  assert.ok(err.errors.dayOfWeek);
});

test('ScheduleTemplate rejects effectiveTo before effectiveFrom', () => {
  const err = new ScheduleTemplate(
    validTemplateData({
      effectiveFrom: new Date('2026-09-01'),
      effectiveTo: new Date('2026-08-01'),
    })
  ).validateSync();
  assert.ok(err.errors.effectiveTo);
});

test('ScheduleTemplate has expected indexes', () => {
  assert.ok(hasIndexOn(ScheduleTemplate, ['subjectId', 'dayOfWeek']));
  assert.ok(hasIndexOn(ScheduleTemplate, ['subjectId', 'isActive']));
});

// ---------------------------------------------------------------------------
// ScheduleSession
// ---------------------------------------------------------------------------

function validScheduleState(overrides = {}) {
  return {
    startTime: '10:00',
    endTime: '12:00',
    roomId: oid(),
    doctorId: oid(),
    ...overrides,
  };
}

function validSessionData(overrides = {}) {
  return {
    templateId: oid(),
    subjectId: oid(),
    date: new Date('2026-10-03'),
    type: 'LECTURE',
    group: 'ALL',
    original: validScheduleState(),
    current: validScheduleState(),
    ...overrides,
  };
}

test('ScheduleSession accepts a valid document', () => {
  const err = new ScheduleSession(validSessionData()).validateSync();
  assert.strictEqual(err, undefined);
});

test('ScheduleSession requires original and current', () => {
  const err = new ScheduleSession(
    validSessionData({ original: undefined, current: undefined })
  ).validateSync();
  assert.ok(err.errors.original);
  assert.ok(err.errors.current);
});

test('ScheduleSession rejects current.endTime <= current.startTime', () => {
  const err = new ScheduleSession(
    validSessionData({ current: validScheduleState({ startTime: '14:00', endTime: '12:00' }) })
  ).validateSync();
  assert.ok(err.errors['current.endTime']);
});

test('ScheduleSession defaults status to ACTIVE', () => {
  const session = new ScheduleSession(validSessionData());
  assert.strictEqual(session.status, 'ACTIVE');
});

test('ScheduleSession rejects an invalid status', () => {
  const err = new ScheduleSession(validSessionData({ status: 'ON_FIRE' })).validateSync();
  assert.ok(err.errors.status);
});

// -- group/type validation (groupMatchesType; mirrors ScheduleTemplate's ----
// identical validator, since materializeSessionForDate() copies
// template.group straight onto the new session) --------------------------

test('ScheduleSession rejects LECTURE with a group other than ALL', () => {
  const err = new ScheduleSession(validSessionData({ group: 'G1' })).validateSync();
  assert.ok(err.errors.group);
});

test('ScheduleSession accepts SECTION with group ALL (whole-cohort section, no G1/G2 division)', () => {
  const err = new ScheduleSession(
    validSessionData({ type: 'SECTION', group: 'ALL' })
  ).validateSync();
  assert.strictEqual(err, undefined);
});

test('ScheduleSession accepts SECTION with group G1 or G2', () => {
  const err = new ScheduleSession(
    validSessionData({ type: 'SECTION', group: 'G1' })
  ).validateSync();
  assert.strictEqual(err, undefined);
});

test('ScheduleSession has a unique compound index on templateId + date', () => {
  assert.ok(uniqueIndexOn(ScheduleSession, ['templateId', 'date']));
});

// -- Phase 2 fix: current.date (day-change support) -------------------------

test('ScheduleSession.current accepts an optional date override, defaulting to null', () => {
  const session = new ScheduleSession(validSessionData());
  // Not set explicitly -> defaults to null, meaning "same as top-level date".
  assert.strictEqual(session.current.date, null);

  const err = new ScheduleSession(validSessionData()).validateSync();
  assert.strictEqual(err, undefined);
});

test('ScheduleSession.current.date can be set to a different calendar date (DAY_CHANGED case)', () => {
  const originalDate = new Date('2026-10-03'); // Saturday
  const newDate = new Date('2026-10-04'); // Sunday — the class moved a day
  const session = new ScheduleSession(
    validSessionData({
      date: originalDate,
      current: validScheduleState({ date: newDate }),
    })
  );

  const err = session.validateSync();
  assert.strictEqual(err, undefined);
  // Original identity date is untouched...
  assert.strictEqual(session.date.getTime(), originalDate.getTime());
  // ...while current.date holds the new actual date.
  assert.strictEqual(session.current.date.getTime(), newDate.getTime());
});

test('ScheduleSession.original does NOT expose a date override field (only current does)', () => {
  assert.strictEqual(ScheduleSession.schema.path('original.date'), undefined);
  assert.ok(ScheduleSession.schema.path('current.date'));
});

// -- Phase 2 fix: {date, group} index for future conflict detection ---------

test('ScheduleSession has an index on date + group (for group conflict detection)', () => {
  assert.ok(hasIndexOn(ScheduleSession, ['date', 'group']));
});

// ---------------------------------------------------------------------------
// ScheduleChange
// ---------------------------------------------------------------------------

function validChangeData(overrides = {}) {
  return {
    sessionId: oid(),
    changedBy: oid(),
    changedByRole: 'DOCTOR',
    changeTypes: ['ROOM_CHANGED'],
    before: { roomId: 'A' },
    after: { roomId: 'B' },
    isPermanent: false,
    ...overrides,
  };
}

test('ScheduleChange accepts a valid document', () => {
  const err = new ScheduleChange(validChangeData()).validateSync();
  assert.strictEqual(err, undefined);
});

test('ScheduleChange requires at least one changeType', () => {
  const err = new ScheduleChange(validChangeData({ changeTypes: [] })).validateSync();
  assert.ok(err.errors.changeTypes);
});

test('ScheduleChange supports multiple combined change types on one record', () => {
  const err = new ScheduleChange(
    validChangeData({ changeTypes: ['DAY_CHANGED', 'TIME_CHANGED', 'ROOM_CHANGED'] })
  ).validateSync();
  assert.strictEqual(err, undefined);
});

test('ScheduleChange rejects an invalid changeType value', () => {
  const err = new ScheduleChange(validChangeData({ changeTypes: ['TELEPORTED'] })).validateSync();
  assert.ok(err.errors['changeTypes.0']);
});

test('ScheduleChange schema does not track updatedAt (immutable history record)', () => {
  assert.strictEqual(ScheduleChange.schema.paths.updatedAt, undefined);
  assert.ok(ScheduleChange.schema.paths.createdAt);
});

// ---------------------------------------------------------------------------
// Task / TaskCompletion
// ---------------------------------------------------------------------------

function validTaskData(overrides = {}) {
  return {
    title: 'OOP Assignment 1',
    subjectId: oid(),
    createdBy: oid(),
    creatorRole: 'DOCTOR',
    ...overrides,
  };
}

test('Task accepts a valid minimal document (no deadline required)', () => {
  const err = new Task(validTaskData()).validateSync();
  assert.strictEqual(err, undefined);
});

test('Task status enum excludes COMPLETED (completion is per-student, not per-task)', () => {
  assert.ok(!Task.schema.path('status').enumValues.includes('COMPLETED'));
});

test('Task rejects more than the maximum number of attachments', () => {
  const attachments = Array.from({ length: 11 }, (_, i) => ({
    filename: `file${i}.pdf`,
    mimeType: 'application/pdf',
    size: 1000,
    url: `https://example.com/file${i}.pdf`,
  }));
  const err = new Task(validTaskData({ attachments })).validateSync();
  assert.ok(err.errors.attachments);
});

test('TaskCompletion requires taskId and studentId, and has a unique compound index', () => {
  const err = new TaskCompletion({}).validateSync();
  assert.ok(err.errors.taskId);
  assert.ok(err.errors.studentId);
  assert.ok(uniqueIndexOn(TaskCompletion, ['taskId', 'studentId']));
});

// ---------------------------------------------------------------------------
// Notification / NotificationRecipient
// ---------------------------------------------------------------------------

test('Notification requires type, category, title, message, relatedType', () => {
  const err = new Notification({}).validateSync();
  assert.ok(err.errors.type);
  assert.ok(err.errors.category);
  assert.ok(err.errors.title);
  assert.ok(err.errors.message);
  assert.ok(err.errors.relatedType);
});

test('Notification createdBy defaults to null (system-generated)', () => {
  const notification = new Notification({
    type: 'DEADLINE_PASSED',
    category: 'TASK',
    title: 'Deadline passed',
    message: 'The deadline for X has passed.',
    relatedType: 'TASK',
  });
  assert.strictEqual(notification.createdBy, null);
});

test('NotificationRecipient has a unique compound index on notificationId + userId', () => {
  assert.ok(uniqueIndexOn(NotificationRecipient, ['notificationId', 'userId']));
});

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

test('Request requires type and userId, defaults status to PENDING', () => {
  const err = new Request({}).validateSync();
  assert.ok(err.errors.type);
  assert.ok(err.errors.userId);

  const request = new Request({ type: 'GROUP_CHANGE', userId: oid() });
  assert.strictEqual(request.status, 'PENDING');
});

test('Request rejects an invalid type', () => {
  const err = new Request({ type: 'CHANGE_MY_NAME', userId: oid() }).validateSync();
  assert.ok(err.errors.type);
});

// ---------------------------------------------------------------------------
// AuditLog
// ---------------------------------------------------------------------------

test('AuditLog requires actorId, actorRole, action, entityType, entityId', () => {
  const err = new AuditLog({}).validateSync();
  assert.ok(err.errors.actorId);
  assert.ok(err.errors.actorRole);
  assert.ok(err.errors.action);
  assert.ok(err.errors.entityType);
  assert.ok(err.errors.entityId);
});

test('AuditLog schema does not track updatedAt (immutable history record)', () => {
  assert.strictEqual(AuditLog.schema.paths.updatedAt, undefined);
  assert.ok(AuditLog.schema.paths.createdAt);
});

// ---------------------------------------------------------------------------
// SystemSettings
// ---------------------------------------------------------------------------

test('SystemSettings defaults to sensible values and a fixed singleton key', () => {
  const settings = new SystemSettings({});
  assert.strictEqual(settings.key, 'singleton');
  assert.strictEqual(settings.maintenanceMode, false);
  assert.strictEqual(settings.notificationRetentionDays, 180);
  assert.strictEqual(settings.weekOffDay, null);
});

test('SystemSettings has a unique index on key', () => {
  assert.ok(uniqueIndexOn(SystemSettings, ['key']));
});

test('SystemSettings.getSingleton is exposed as a model static', () => {
  assert.strictEqual(typeof SystemSettings.getSingleton, 'function');
});
