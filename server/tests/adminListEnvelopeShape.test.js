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

function assertSingleKeyEnvelope(body, dataKey) {
  assert.deepStrictEqual(Object.keys(body).sort(), [dataKey, 'success'].sort());
  assert.strictEqual(body.success, true);
  assert.ok(Array.isArray(body[dataKey]), `${dataKey} must be an array`);
}

test('GET /api/rooms — single-key { success, rooms } envelope (client/js/pages/admin-rooms.js loadList() contract)', async () => {
  const roomService = require('../services/RoomService');
  const original = roomService.list;
  roomService.list = async () => [{ _id: 'room_1', building: 'A', floor: '1', roomNumber: '101', isActive: true }];
  try {
    setUser('ADMIN');
    const res = await request(mount('/api/rooms', require('../routes/rooms.routes'))).get('/api/rooms');
    assert.strictEqual(res.status, 200);
    assertSingleKeyEnvelope(res.body, 'rooms');
  } finally {
    roomService.list = original;
  }
});

test('GET /api/subjects — single-key { success, subjects } envelope (client/js/pages/admin-subjects.js loadList() contract)', async () => {
  const subjectService = require('../services/SubjectService');
  const original = subjectService.list;
  subjectService.list = async () => [{ _id: 'subject_1', name: 'Anatomy', code: 'ANAT101', doctorId: 'doctor_1', taId: null, hasSections: false, isActive: true }];
  try {
    setUser('ADMIN');
    const res = await request(mount('/api/subjects', require('../routes/subjects.routes'))).get('/api/subjects');
    assert.strictEqual(res.status, 200);
    assertSingleKeyEnvelope(res.body, 'subjects');
  } finally {
    subjectService.list = original;
  }
});

test('GET /api/doctors — single-key { success, items } envelope (client/js/pages/admin-subjects.js Doctor-picker contract)', async () => {
  const doctorService = require('../services/DoctorService');
  const original = doctorService.list;
  doctorService.list = async () => [{ _id: 'doctor_1', fullName: 'Dr. Dev Doctor', isActive: true }];
  try {
    setUser('ADMIN');
    const res = await request(mount('/api/doctors', require('../routes/doctors.routes'))).get('/api/doctors');
    assert.strictEqual(res.status, 200);
    assertSingleKeyEnvelope(res.body, 'items');
  } finally {
    doctorService.list = original;
  }
});

test('GET /api/tas — single-key { success, items } envelope (client/js/pages/admin-subjects.js TA-picker contract)', async () => {
  const taService = require('../services/TAService');
  const original = taService.list;
  taService.list = async () => [{ _id: 'ta_1', fullName: 'Dev TA', isActive: true }];
  try {
    setUser('ADMIN');
    const res = await request(mount('/api/tas', require('../routes/tas.routes'))).get('/api/tas');
    assert.strictEqual(res.status, 200);
    assertSingleKeyEnvelope(res.body, 'items');
  } finally {
    taService.list = original;
  }
});

test('GET /api/leaders — single-key { success, leaders } envelope (client/js/pages/admin-leaders.js loadList() contract)', async () => {
  const leaderService = require('../services/LeaderService');
  const original = leaderService.list;
  leaderService.list = async () => [{ _id: 'leader_1', slot: 'MALE', isActive: true, userId: 'user_1' }];
  try {
    setUser('ADMIN');
    const res = await request(mount('/api/leaders', require('../routes/leaders.routes'))).get('/api/leaders');
    assert.strictEqual(res.status, 200);
    assertSingleKeyEnvelope(res.body, 'leaders');
    assert.strictEqual(res.body.leaders[0].userId, 'user_1');
  } finally {
    leaderService.list = original;
  }
});

test('GET /api/admin/requests — single-key { success, requests } envelope (client/js/pages/admin-requests.js loadList() contract)', async () => {
  const requestService = require('../services/RequestService');
  const original = requestService.list;
  requestService.list = async () => [{ _id: 'request_1', type: 'PASSWORD_RESET', status: 'PENDING', userId: 'user_1', createdAt: new Date() }];
  try {
    setUser('ADMIN');
    const res = await request(mount('/api/admin', require('../routes/admin.routes'))).get('/api/admin/requests');
    assert.strictEqual(res.status, 200);
    assertSingleKeyEnvelope(res.body, 'requests');
  } finally {
    requestService.list = original;
  }
});

test('GET /api/admin/audit-logs — single-key { success, auditLogs } envelope (client/js/pages/admin-audit-logs.js loadList() contract)', async () => {
  const auditService = require('../services/AuditService');
  const original = auditService.list;
  auditService.list = async () => [{ _id: 'al_1', actorId: 'u_admin', actorRole: 'ADMIN', action: 'ROOM_CREATED', entityType: 'Room', entityId: 'e1', createdAt: new Date() }];
  try {
    setUser('ADMIN');
    const res = await request(mount('/api/admin', require('../routes/admin.routes'))).get('/api/admin/audit-logs');
    assert.strictEqual(res.status, 200);
    assertSingleKeyEnvelope(res.body, 'auditLogs');
  } finally {
    auditService.list = original;
  }
});
