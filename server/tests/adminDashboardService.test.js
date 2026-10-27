const test = require('node:test');
const assert = require('node:assert');

const { createAdminDashboardService } = require('../services/AdminDashboardService');

function countMatching(rows, filter = {}) {
  return rows.filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v)).length;
}

function makeCollection(rows) {
  return {
    async countDocuments(filter = {}) {
      return countMatching(rows, filter);
    },
    find(filter = {}) {
      const matched = rows.filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v));
      const sorted = [...matched].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const query = {
        _limit: null,
        sort() {
          return this;
        },
        limit(n) {
          this._limit = n;
          return this;
        },
        select() {
          return this;
        },
        then(resolve, reject) {
          const result = this._limit != null ? sorted.slice(0, this._limit) : sorted;
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

function buildFixture({ students = [], subjects = [], doctors = [], tas = [], tasks = [], requests = [], scheduleChanges = [], auditLogs = [] } = {}) {
  const models = {
    Student: makeCollection(students),
    Subject: makeCollection(subjects),
    Doctor: makeCollection(doctors),
    TA: makeCollection(tas),
    Task: makeCollection(tasks),
    Request: makeCollection(requests),
    ScheduleChange: makeCollection(scheduleChanges),
    AuditLog: makeCollection(auditLogs),
  };

  const taskService = {
    async list() {
      return [...tasks]
        .filter((t) => t.deletedAt === null || t.deletedAt === undefined)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    },
  };
  const requestService = {
    async list() {
      return [...requests].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    },
  };

  return { models, taskService, requestService };
}

function date(daysAgo) {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
}

test('getDashboard() on an empty system returns all-zero counts and empty feeds', async () => {
  const fx = buildFixture({});
  const service = createAdminDashboardService(fx);
  const dashboard = await service.getDashboard();

  assert.deepStrictEqual(dashboard.counts, {
    students: 0,
    subjects: 0,
    doctors: 0,
    tas: 0,
    activeTasks: 0,
    pendingRequests: 0,
  });
  assert.deepStrictEqual(dashboard.recent.scheduleChanges, []);
  assert.deepStrictEqual(dashboard.recent.tasks, []);
  assert.deepStrictEqual(dashboard.recent.requests, []);
  assert.deepStrictEqual(dashboard.recent.activity, []);
});

test('counts: students/subjects/doctors/tas are totals, including inactive records', async () => {
  const fx = buildFixture({
    students: [{ _id: 's1', isActive: true }, { _id: 's2', isActive: false }],
    subjects: [{ _id: 'sub1', isActive: true }],
    doctors: [{ _id: 'd1', isActive: true }, { _id: 'd2', isActive: false }],
    tas: [{ _id: 't1', isActive: false }],
  });
  const service = createAdminDashboardService(fx);
  const dashboard = await service.getDashboard();

  assert.strictEqual(dashboard.counts.students, 2, 'must include the inactive student');
  assert.strictEqual(dashboard.counts.subjects, 1);
  assert.strictEqual(dashboard.counts.doctors, 2, 'must include the inactive doctor');
  assert.strictEqual(dashboard.counts.tas, 1, 'must include the inactive TA');
});

test('counts: activeTasks excludes soft-deleted tasks', async () => {
  const fx = buildFixture({
    tasks: [
      { _id: 'task1', deletedAt: null, status: 'ACTIVE', createdAt: date(1), title: 'A', subjectId: 'sub1' },
      { _id: 'task2', deletedAt: null, status: 'OVERDUE', createdAt: date(2), title: 'B', subjectId: 'sub1' },
      { _id: 'task3', deletedAt: new Date(), status: 'ACTIVE', createdAt: date(3), title: 'C', subjectId: 'sub1' },
    ],
  });
  const service = createAdminDashboardService(fx);
  const dashboard = await service.getDashboard();

  assert.strictEqual(dashboard.counts.activeTasks, 2, 'soft-deleted task must not count as active');
});

test('counts: activeTasks includes DUE_SOON and OVERDUE, not only the literal ACTIVE status', async () => {
  const fx = buildFixture({
    tasks: [
      { _id: 'task1', deletedAt: null, status: 'ACTIVE', createdAt: date(1), title: 'A', subjectId: 'sub1' },
      { _id: 'task2', deletedAt: null, status: 'DUE_SOON', createdAt: date(2), title: 'B', subjectId: 'sub1' },
      { _id: 'task3', deletedAt: null, status: 'OVERDUE', createdAt: date(3), title: 'C', subjectId: 'sub1' },
    ],
  });
  const service = createAdminDashboardService(fx);
  const dashboard = await service.getDashboard();
  assert.strictEqual(dashboard.counts.activeTasks, 3);
});

test('counts: pendingRequests counts only PENDING, not APPROVED/REJECTED', async () => {
  const fx = buildFixture({
    requests: [
      { _id: 'r1', status: 'PENDING', type: 'GROUP_CHANGE', userId: 'u1', createdAt: date(1) },
      { _id: 'r2', status: 'APPROVED', type: 'GROUP_CHANGE', userId: 'u2', createdAt: date(2) },
      { _id: 'r3', status: 'REJECTED', type: 'PASSWORD_RESET', userId: 'u3', createdAt: date(3) },
      { _id: 'r4', status: 'PENDING', type: 'PASSWORD_RESET', userId: 'u4', createdAt: date(4) },
    ],
  });
  const service = createAdminDashboardService(fx);
  const dashboard = await service.getDashboard();
  assert.strictEqual(dashboard.counts.pendingRequests, 2);
});

test('recent.scheduleChanges is sorted newest first and capped', async () => {
  const scheduleChanges = Array.from({ length: 15 }, (_, i) => ({
    _id: `sc_${i}`,
    sessionId: 'sess1',
    changeTypes: ['TIME_CHANGED'],
    isPermanent: false,
    changedBy: 'u1',
    changedByRole: 'ADMIN',
    createdAt: date(i),
  }));
  const fx = buildFixture({ scheduleChanges });
  const service = createAdminDashboardService(fx);
  const dashboard = await service.getDashboard();

  assert.strictEqual(dashboard.recent.scheduleChanges.length, 10, 'must be capped');
  assert.strictEqual(dashboard.recent.scheduleChanges[0]._id, 'sc_0', 'newest first');
  assert.strictEqual(dashboard.recent.scheduleChanges[9]._id, 'sc_9');
});

test('recent.tasks excludes soft-deleted tasks and is sorted newest first', async () => {
  const fx = buildFixture({
    tasks: [
      { _id: 'task1', deletedAt: null, status: 'ACTIVE', createdAt: date(5), title: 'Old', subjectId: 'sub1' },
      { _id: 'task2', deletedAt: new Date(), status: 'ACTIVE', createdAt: date(1), title: 'Deleted-but-newest', subjectId: 'sub1' },
      { _id: 'task3', deletedAt: null, status: 'DUE_SOON', createdAt: date(2), title: 'Newer', subjectId: 'sub1' },
    ],
  });
  const service = createAdminDashboardService(fx);
  const dashboard = await service.getDashboard();

  assert.deepStrictEqual(dashboard.recent.tasks.map((t) => t._id), ['task3', 'task1']);
  assert.strictEqual(dashboard.recent.tasks[0].title, 'Newer');
});

test('recent.requests includes all statuses (not only pending), newest first', async () => {
  const fx = buildFixture({
    requests: [
      { _id: 'r1', status: 'PENDING', type: 'GROUP_CHANGE', userId: 'u1', createdAt: date(3) },
      { _id: 'r2', status: 'APPROVED', type: 'GROUP_CHANGE', userId: 'u2', createdAt: date(1) },
      { _id: 'r3', status: 'REJECTED', type: 'PASSWORD_RESET', userId: 'u3', createdAt: date(2) },
    ],
  });
  const service = createAdminDashboardService(fx);
  const dashboard = await service.getDashboard();

  assert.deepStrictEqual(dashboard.recent.requests.map((r) => r._id), ['r2', 'r3', 'r1']);
});

test('recent.activity reflects the audit log, newest first, capped', async () => {
  const auditLogs = Array.from({ length: 12 }, (_, i) => ({
    _id: `al_${i}`,
    actorId: 'u1',
    actorRole: 'ADMIN',
    action: 'SETTINGS_UPDATED',
    entityType: 'SystemSettings',
    entityId: 'e1',
    createdAt: date(i),
  }));
  const fx = buildFixture({ auditLogs });
  const service = createAdminDashboardService(fx);
  const dashboard = await service.getDashboard();

  assert.strictEqual(dashboard.recent.activity.length, 10);
  assert.strictEqual(dashboard.recent.activity[0]._id, 'al_0');
});

test('recent.tasks items do not include attachments/submissionLinks internals', async () => {
  const fx = buildFixture({
    tasks: [
      {
        _id: 'task1',
        deletedAt: null,
        status: 'ACTIVE',
        createdAt: date(1),
        title: 'A',
        subjectId: 'sub1',
        deadline: date(-2),
        attachments: [{ storageKey: 'secret-path', filename: 'x.pdf' }],
      },
    ],
  });
  const service = createAdminDashboardService(fx);
  const dashboard = await service.getDashboard();
  const item = dashboard.recent.tasks[0];
  assert.deepStrictEqual(Object.keys(item).sort(), ['_id', 'createdAt', 'deadline', 'status', 'subjectId', 'title'].sort());
});

test('recent.activity does not expose before/after snapshots (drill-down data stays on the audit-log endpoint)', async () => {
  const fx = buildFixture({
    auditLogs: [
      {
        _id: 'al_1',
        actorId: 'u1',
        actorRole: 'ADMIN',
        action: 'PASSWORD_RESET_BY_ADMIN',
        entityType: 'User',
        entityId: 'u2',
        before: { passwordHash: 'should-never-appear' },
        after: { passwordHash: 'should-never-appear-either' },
        createdAt: date(1),
      },
    ],
  });
  const service = createAdminDashboardService(fx);
  const dashboard = await service.getDashboard();
  const item = dashboard.recent.activity[0];
  assert.ok(!('before' in item) && !('after' in item), 'before/after must not be on the dashboard feed');
  assert.ok(!/passwordHash|secret/i.test(JSON.stringify(dashboard.recent.activity)));
});

test('recent.scheduleChanges does not expose before/after state snapshots', async () => {
  const fx = buildFixture({
    scheduleChanges: [
      {
        _id: 'sc_1',
        sessionId: 'sess1',
        changeTypes: ['ROOM_CHANGED'],
        isPermanent: false,
        changedBy: 'u1',
        changedByRole: 'ADMIN',
        before: { roomId: 'secretRoomDetail' },
        after: { roomId: 'anotherRoomDetail' },
        createdAt: date(1),
      },
    ],
  });
  const service = createAdminDashboardService(fx);
  const dashboard = await service.getDashboard();
  const item = dashboard.recent.scheduleChanges[0];
  assert.ok(!('before' in item) && !('after' in item));
});
