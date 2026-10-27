/**
 * server/tests/envValidation.test.js
 *
 * Regression tests for the pre-deployment hardening pass (Phase 3:
 * database safety / production configuration).
 *
 * CONFIRMED ISSUE: config/env.js's validateEnv() already threw correctly
 * when required production config (MONGODB_URI, SESSION_SECRET) was
 * missing or insecure — that logic itself was already correct and is
 * re-confirmed below. The actual bug was in server/app.js's bootstrap:
 * `start()` (an async function) begins by calling validateEnv()
 * synchronously; when it threw, nothing caught the resulting rejected
 * promise except the generic `process.on('unhandledRejection', ...)`
 * handler, which only logs — it never calls process.exit(). The process
 * therefore never crashed and never served anything either: a silently
 * hung process with exit code 0 pending, which looks identical to
 * "started fine" to a process manager, container orchestrator, or health
 * check watching only the exit code. Fixed by wrapping the top-level
 * `start()` call in `server/app.js` with `.catch(err => { ...;
 * process.exit(1); })`.
 *
 * This file covers both halves:
 *   1. validateEnv() itself still throws/doesn't-throw in exactly the
 *      right cases (unchanged behavior, re-confirmed as a baseline).
 *   2. A static-source regression guard on server/app.js's bootstrap,
 *      since actually exercising process.exit() from inside the test
 *      runner would kill the whole test process — reading the source to
 *      confirm the `.catch(...)` + `process.exit(1)` wiring is present
 *      is the safe way to guard against this regressing, matching the
 *      static-source-guard convention already used elsewhere in this
 *      suite (see scheduleWeekNavigation.test.js, clientPageLinks.test.js).
 */

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

function freshEnvModule() {
  delete require.cache[require.resolve('../config/env')];
  // eslint-disable-next-line global-require
  return require('../config/env');
}

function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('validateEnv(): a no-op outside production, even with no config set at all', () => {
  withEnv(
    { NODE_ENV: 'development', MONGODB_URI: '', SESSION_SECRET: '' },
    () => {
      const { validateEnv } = freshEnvModule();
      assert.doesNotThrow(() => validateEnv());
    }
  );
});

test('validateEnv(): throws in production when MONGODB_URI is missing', () => {
  withEnv(
    { NODE_ENV: 'production', MONGODB_URI: '', SESSION_SECRET: 'a-sufficiently-long-random-secret' },
    () => {
      const { validateEnv } = freshEnvModule();
      assert.throws(() => validateEnv(), /MONGODB_URI/);
    }
  );
});

test('validateEnv(): throws in production when SESSION_SECRET is missing', () => {
  withEnv(
    { NODE_ENV: 'production', MONGODB_URI: 'mongodb://example.test/db', SESSION_SECRET: '' },
    () => {
      const { validateEnv } = freshEnvModule();
      assert.throws(() => validateEnv(), /SESSION_SECRET/);
    }
  );
});

test('validateEnv(): throws in production when SESSION_SECRET is still the insecure development default', () => {
  withEnv(
    {
      NODE_ENV: 'production',
      MONGODB_URI: 'mongodb://example.test/db',
      SESSION_SECRET: 'dev-only-insecure-secret-change-me',
    },
    () => {
      const { validateEnv } = freshEnvModule();
      assert.throws(() => validateEnv(), /strong value/);
    }
  );
});

test('validateEnv(): does not throw in production when MONGODB_URI and a real SESSION_SECRET are both set', () => {
  withEnv(
    {
      NODE_ENV: 'production',
      MONGODB_URI: 'mongodb://example.test/db',
      SESSION_SECRET: 'a-sufficiently-long-random-secret',
    },
    () => {
      const { validateEnv } = freshEnvModule();
      assert.doesNotThrow(() => validateEnv());
    }
  );
});

test('REGRESSION (static-source guard): server/app.js exits the process on a fatal startup error instead of hanging silently', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const bootstrapSection = source.slice(source.indexOf('if (require.main === module)'));
  assert.match(
    bootstrapSection,
    /start\(\)\s*\.catch\(/,
    'the top-level start() call must have a .catch(...) handler'
  );
  assert.match(
    bootstrapSection,
    /process\.exit\(1\)/,
    'the .catch(...) handler must call process.exit(1) on a fatal startup error'
  );
});
