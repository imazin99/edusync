/**
 * Phase 1 smoke tests.
 *
 * These verify the app boots and responds correctly WITHOUT requiring a
 * live MongoDB connection, so they can run in any environment. Full
 * business-logic tests (auth, schedule, tasks, notifications) are added
 * in their respective phases per the spec's testing strategy.
 */

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { createApp } = require('../app');

test('GET /api/health responds with a well-formed payload', async () => {
  const app = createApp();
  const res = await request(app).get('/api/health');

  assert.ok([200, 503].includes(res.status), 'health should return 200 or 503');
  assert.strictEqual(typeof res.body.status, 'string');
  assert.strictEqual(typeof res.body.database, 'string');
  assert.ok(['connected', 'connecting', 'disconnected', 'disconnecting'].includes(res.body.database));
});

test('Unknown API route returns consistent 404 error shape', async () => {
  const app = createApp();
  const res = await request(app).get('/api/does-not-exist');

  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.success, false);
  assert.strictEqual(res.body.code, 'ROUTE_NOT_FOUND');
  assert.strictEqual(typeof res.body.message, 'string');
});

test('Security headers are present (helmet)', async () => {
  const app = createApp();
  const res = await request(app).get('/api/health');

  assert.ok(res.headers['x-content-type-options']);
});
