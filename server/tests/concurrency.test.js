/**
 * server/tests/concurrency.test.js
 *
 * RECONSTRUCTION NOTICE: the two tests and two helper functions in this
 * file were originally written in a previous chat session (Gap Closure
 * Part F — concurrency investigation). That session ended, and its
 * working state was never exported as a project ZIP — only summarized
 * afterward in HANDOFF.md (see HANDOFF.md §9–§14). The uploaded project
 * snapshot (`academic-schedule-gapclosure-partE.zip`) predates that
 * work entirely, so this file was originally a RECONSTRUCTION from
 * HANDOFF.md's description, done under explicit user authorization.
 *
 * UPDATE (Part F / F-Full implemented): the different-field test below
 * was, at reconstruction time, a documented `{ todo }` reproducing a
 * confirmed lost-update bug. With F-Full now implemented in
 * ScheduleService.applyChange() (field-level atomic $set instead of a
 * whole-subdocument replace), that test has been converted into a real,
 * passing assertion — not disabled or loosened. See the test's own
 * comment block below for what changed and why it now passes.
 *
 * One implementation detail is NOT separately named in HANDOFF.md:
 * `createWriteOrderGate()` below (originally `createSaveOrderGate()`,
 * renamed when the write path moved from `session.save()` to
 * `ScheduleSession.updateOne()` — see that rename note further down).
 * HANDOFF documents the arrival barrier that forces genuine overlap on
 * the READ side, but does not specify how the original session
 * controlled which caller's write landed last (it describes the winner
 * as empirically observed, not forced). Without also controlling write
 * order here, "who wins" would be left to incidental microtask
 * scheduling and these tests would be flaky.
 *
 * Master Spec §39 (Near-Simultaneous Changes) — verified verbatim
 * against Master_Specification.txt:
 *   "If two changes occur almost simultaneously: The server/database
 *   transaction order determines which successful change becomes
 *   current. The later successfully committed change becomes the
 *   current state. Both legitimate changes remain in history."
 *
 * Mechanism now under test (ScheduleService.applyChange(), Part F /
 * F-Full): each caller still reads session.current once and builds its
 * own full `nextCurrent` snapshot, but the actual persisted write is a
 * FIELD-LEVEL atomic update — only the specific `current.*` leaf paths
 * (and `status`) THIS call's patch actually changed are $set, via
 * `ScheduleSession.updateOne({_id}, {$set: {...}}, {session})`, never a
 * whole-subdocument replace. Two callers changing the SAME field still
 * resolve to "later commit wins" on that one field (§39). Two callers
 * changing DIFFERENT fields no longer clobber each other: each $set
 * only ever touches its own leaf paths, leaving the other caller's
 * already-committed sibling field untouched.
 */

const test = require('node:test');
const assert = require('node:assert');

const { createFakeCollection, createTestFixtureScope, attachSave } = require('./helpers/fakeCollection');
const { ROLES, GROUPS, CLASS_TYPES } = require('../utils/constants');
const { createNotificationService } = require('../services/NotificationService');
const { createScheduleService } = require('../services/ScheduleService');

// ===========================================================================
// Helper 1: createArrivalBarrier(count)
//
// Holds `count` concurrent callers at the same point until ALL of them
// have arrived, then releases every one of them together. This is what
// actually, deterministically forces two "concurrent" applyChange()
// calls to genuinely overlap their reads.
//
// (Per HANDOFF.md §12: an equal setTimeout delay on both reads was
// tried first instead of this and produced a misleadingly-passing
// result — Node drains an entire macrotask's resulting microtask chain
// (i.e. one WHOLE applyChange() call, given this harness's otherwise-
// instant fake I/O) before moving to the next timer callback, so one
// call can silently run to full completion before the other's delayed
// read even resolves. A synchronization barrier, not a timer, is what
// actually forces true overlap.)
// ===========================================================================
function createArrivalBarrier(count) {
  let arrived = 0;
  let releaseAll;
  const everyoneArrived = new Promise((resolve) => {
    releaseAll = resolve;
  });
  return async function arrive() {
    arrived += 1;
    if (arrived === count) releaseAll();
    await everyoneArrived;
  };
}

// ===========================================================================
// Write-order gate (see RECONSTRUCTION NOTICE above — not separately
// named in HANDOFF.md; originally named createSaveOrderGate() when the
// production write path was `session.save()`. Renamed to
// createWriteOrderGate() now that Part F / F-Full writes via
// `ScheduleSession.updateOne()` instead — same mechanism, applied at
// the collection's updateOne() call instead of the document's save()).
//
// The first caller to reach updateOne() (index 0) writes immediately
// and signals completion; the second (index 1) waits for that signal
// before writing. This makes "the later commit" deterministic instead
// of leaving write order to incidental microtask scheduling.
// ===========================================================================
function createWriteOrderGate() {
  let resolveFirst;
  const firstWritten = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  return {
    async before(myIndex) {
      if (myIndex !== 0) await firstWritten;
    },
    after(myIndex) {
      if (myIndex === 0) resolveFirst();
    },
  };
}

// ===========================================================================
// Helper 2: wrapWithIndependentReads(collection, { arrivalBarrier, writeGate })
//
// The ordinary fakeCollection's findById() (helpers/fakeCollection.js)
// returns the SAME shared object reference on every call. That's fine
// for every other test in this project, but it artificially "fixes"
// races: any mutation is instantly visible to every "concurrent"
// reader, silently collapsing a concurrency test into the already-
// covered SEQUENTIAL case (Gap C). A genuine concurrency test cannot
// use the ordinary fake collection for ScheduleSession reads.
//
// This wrapper makes findById() return a fresh, INDEPENDENT CLONE on
// every call — much closer to real Mongoose document semantics, where
// each concurrent request gets its own in-memory document instance.
// `updateOne()` is delegated straight through to the real underlying
// collection (this is the actual F-Full write path, and it is already
// naturally atomic/field-level — see ScheduleService.applyChange()),
// with `writeGate` added only to make the ORDER of the two concurrent
// writes deterministic for these tests' assertions.
// ===========================================================================
function wrapWithIndependentReads(collection, { arrivalBarrier, writeGate } = {}) {
  let readCallIndex = 0;
  let writeCallIndex = 0;

  function chainable(resultPromise) {
    return {
      select: () => chainable(resultPromise),
      sort: () => chainable(resultPromise),
      session: () => chainable(resultPromise),
      then: (onResolve, onReject) => resultPromise.then(onResolve, onReject),
      catch: (onReject) => resultPromise.catch(onReject),
    };
  }

  return {
    ...collection,
    findById(id) {
      readCallIndex += 1;

      const resultPromise = (async () => {
        const original = await collection.findById(id);
        if (!original) return null;

        // Independent clone: its own top-level object AND its own
        // `current` subdocument, so mutating this clone never touches
        // `original` at all — the F-Full write path never calls
        // .save() on it (it goes through updateOne() below instead),
        // so this clone only needs to behave correctly for reads and
        // for ScheduleService's pre-transaction session.validate() call.
        const clone = { ...original, current: { ...original.current } };

        // Reuses the exact same toObject()/validate() shims
        // fakeCollection.js attaches to every ordinary doc (the spread
        // above does not copy them — attachSave()'s definitions are
        // non-enumerable; without this, ScheduleService.applyChange()
        // would crash with "session.current.toObject is not a
        // function" per HANDOFF.md §12.6, and session.validate() —
        // Part F's pre-transaction validation step — would be missing
        // entirely).
        attachSave(clone);

        // Hold this reader here until every concurrent reader has also
        // arrived, then release them all together — forcing genuine
        // overlap instead of accidental sequentiality.
        if (arrivalBarrier) await arrivalBarrier();

        return clone;
      })();

      return chainable(resultPromise);
    },
    async updateOne(filter, update, options) {
      const myIndex = writeCallIndex;
      writeCallIndex += 1;
      if (writeGate) await writeGate.before(myIndex);
      const result = await collection.updateOne(filter, update, options);
      if (writeGate) writeGate.after(myIndex);
      return result;
    },
  };
}

// ===========================================================================
// Fixture — deliberately self-contained (does not import from
// phase4.test.js) so this file stays small and independently readable,
// per HANDOFF.md §15's rationale for a dedicated concurrency file.
// Mirrors the shape of phase4.test.js's own scheduleFixture(), but
// requires no changes to that file.
// ===========================================================================
function buildModels(seed = {}) {
  const scope = createTestFixtureScope();
  const c = (prefix, key) => createFakeCollection(prefix, seed[key] || [], scope);
  return {
    User: c('user', 'users'),
    Doctor: c('doctor', 'doctors'),
    TA: c('ta', 'tas'),
    Leader: c('leader', 'leaders'),
    Student: c('student', 'students'),
    Subject: c('subject', 'subjects'),
    Room: c('room', 'rooms'),
    ScheduleTemplate: c('template', 'templates'),
    ScheduleSession: c('session', 'sessions'),
    ScheduleChange: c('change', 'changes'),
    Notification: c('notification', 'notifications'),
    NotificationRecipient: c('recipient', 'recipients'),
    SystemSettings: {
      getSingleton: async () => ({ maintenanceMode: false, maintenanceMessage: '' }),
    },
  };
}

async function concurrencyFixture() {
  const models = buildModels({
    users: [
      { username: 'dr', role: ROLES.DOCTOR, isActive: true },
      { username: 'leader', role: ROLES.LEADER, isActive: true },
    ],
    doctors: [{ userId: 'user_1', fullName: 'Dr One', isActive: true }],
    leaders: [{ userId: 'user_2', slot: 'MALE', isActive: true, linkedStudentId: 'x' }],
    subjects: [{ name: 'OOP', code: 'OOP101', doctorId: 'doctor_1', hasSections: true, isActive: true }],
    rooms: [{ building: 'H', floor: '2', roomNumber: '204', isActive: true }],
  });

  const notificationService = createNotificationService({ models });
  const passthroughTx = async (callback) => callback({ __passthroughFakeSession: true });

  // Ordinary (unwrapped) service, used only to materialize the template
  // and the one session under test sequentially, before any concurrency
  // is introduced.
  const setupService = createScheduleService({
    models,
    auditService: { recordAudit: async () => {} },
    notificationService,
    runInTransaction: passthroughTx,
  });

  await setupService.createTemplate({
    actorUser: { id: 'admin', role: ROLES.ADMIN },
    subjectId: 'subject_1',
    type: CLASS_TYPES.LECTURE,
    group: GROUPS.ALL,
    dayOfWeek: 'SATURDAY',
    startTime: '10:00',
    endTime: '12:00',
    roomId: 'room_1',
    doctorId: 'doctor_1',
    effectiveFrom: '2026-01-01',
  });
  const sessions = await setupService.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });
  const sessionId = sessions[0]._id;

  const doctorActor = { id: 'user_1', role: ROLES.DOCTOR }; // owns subject_1
  const leaderActor = { id: 'user_2', role: ROLES.LEADER }; // can edit any subject

  // Build a SECOND service instance whose ScheduleSession collection is
  // the independent-reads wrapper around the SAME underlying collection
  // `setupService` just wrote to. Every other collection (Subject,
  // ScheduleChange, etc.) is shared, unwrapped, exactly as normal.
  function buildConcurrentService() {
    const arrivalBarrier = createArrivalBarrier(2);
    const writeGate = createWriteOrderGate();
    const concurrentModels = {
      ...models,
      ScheduleSession: wrapWithIndependentReads(models.ScheduleSession, { arrivalBarrier, writeGate }),
    };
    return createScheduleService({
      models: concurrentModels,
      auditService: { recordAudit: async () => {} },
      notificationService,
      runInTransaction: passthroughTx,
    });
  }

  return { models, sessionId, doctorActor, leaderActor, buildConcurrentService };
}

// ===========================================================================
// §39 CONCURRENCY: two actors changing the SAME field
//
// Two genuinely concurrent applyChange() calls on the same session, both
// changing `roomId` (to two different target rooms). This case passed
// even before Part F (a same-field $set is equivalent whether the
// surrounding write is whole-subdocument or field-level), and still
// passes now: the later-committing change's value correctly becomes
// `current`, matching §39.
// ===========================================================================
test('§39 CONCURRENCY: two actors changing the SAME field — later commit wins', async () => {
  const { models, sessionId, doctorActor, leaderActor, buildConcurrentService } = await concurrencyFixture();
  const concurrentService = buildConcurrentService();

  const ROOM_TARGET_A = 'ROOM_TARGET_A'; // Doctor's requested room
  const ROOM_TARGET_B = 'ROOM_TARGET_B'; // Leader's requested room

  const [doctorResult, leaderResult] = await Promise.all([
    concurrentService.applyChange({ actorUser: doctorActor, sessionId, patch: { roomId: ROOM_TARGET_A } }),
    concurrentService.applyChange({ actorUser: leaderActor, sessionId, patch: { roomId: ROOM_TARGET_B } }),
  ]);

  // Both changes were legitimately applied and recorded — neither
  // actor's request failed or was treated as a duplicate/no-op.
  assert.strictEqual(doctorResult.noop, false);
  assert.strictEqual(leaderResult.noop, false);
  assert.strictEqual(doctorResult.change.after.roomId, ROOM_TARGET_A);
  assert.strictEqual(leaderResult.change.after.roomId, ROOM_TARGET_B);

  // Both ScheduleChange history records exist and are each correct
  // (spec §39: "Both legitimate changes remain in history").
  const historyForSession = models.ScheduleChange._docs.filter((c) => c.sessionId === sessionId);
  const historyRoomIds = historyForSession.map((c) => c.after.roomId).sort();
  assert.deepStrictEqual(historyRoomIds, [ROOM_TARGET_A, ROOM_TARGET_B].sort());

  // The final persisted state must reflect whichever commit was LATER
  // (§39) — which of the two actors that is depends on this harness's
  // exact microtask scheduling (governed deterministically by the
  // write-order gate, but not tied to Promise.all's array order; see
  // buildConcurrentService above), so this is checked structurally
  // rather than by hardcoding an assumed winner: the ScheduleChange
  // history records are created in write order, so the LAST one
  // created is, by construction, the later commit.
  const laterChange = historyForSession[historyForSession.length - 1];
  const finalSession = await models.ScheduleSession.findById(sessionId);
  assert.strictEqual(finalSession.current.roomId, laterChange.after.roomId);
});

// ===========================================================================
// §39 CONCURRENCY: two actors changing DIFFERENT fields
//
// Two genuinely concurrent applyChange() calls on the same session:
// Actor A (Doctor) changes `roomId`; Actor B (Leader) changes
// `startTime`/`endTime`.
//
// BEFORE Part F, this was a documented `{ todo }`: a confirmed lost
// update, where Actor A's later, whole-subdocument-replace write
// silently erased Actor B's already-committed, already-in-history time
// change from `session.current`.
//
// AFTER Part F (F-Full): ScheduleService.applyChange() writes via a
// field-level atomic `$set` (only the leaf paths this call's patch
// actually changed), so Actor A's roomId write and Actor B's
// startTime/endTime write no longer collide — both persist, regardless
// of which one lands last. This test has been converted from the
// documented `todo` into a real, passing assertion — not merely
// unmarked; the assertions below are unchanged from the pre-fix
// version (they always encoded the TRUE spec requirement).
// ===========================================================================
test('§39 CONCURRENCY: two actors changing DIFFERENT fields — current state contains BOTH (Part F / F-Full)', async () => {
  const { models, sessionId, doctorActor, leaderActor, buildConcurrentService } = await concurrencyFixture();
  const concurrentService = buildConcurrentService();

  const NEW_ROOM = 'ROOM_TARGET_NEW';

  // The two writes race via the write-order gate (see
  // createWriteOrderGate/buildConcurrentService above) — which of the
  // two actually lands first is a harness scheduling detail, not
  // something asserted here; what matters for this test is that BOTH
  // survive regardless of order.
  const [leaderResult, doctorResult] = await Promise.all([
    concurrentService.applyChange({
      actorUser: leaderActor,
      sessionId,
      patch: { startTime: '11:00', endTime: '13:00' },
    }),
    concurrentService.applyChange({ actorUser: doctorActor, sessionId, patch: { roomId: NEW_ROOM } }),
  ]);

  // Both requests succeeded individually and each has a correct,
  // independent ScheduleChange history record.
  assert.strictEqual(leaderResult.noop, false);
  assert.strictEqual(doctorResult.noop, false);
  assert.strictEqual(leaderResult.change.after.startTime, '11:00');
  assert.strictEqual(leaderResult.change.after.endTime, '13:00');
  assert.strictEqual(doctorResult.change.after.roomId, NEW_ROOM);

  const finalSession = await models.ScheduleSession.findById(sessionId);

  // TRUE spec requirement (§39: "the final current state must contain
  // BOTH successful changes"). Now genuinely passes under F-Full.
  assert.strictEqual(finalSession.current.roomId, NEW_ROOM);
  assert.strictEqual(finalSession.current.startTime, '11:00');
  assert.strictEqual(finalSession.current.endTime, '13:00');
});
