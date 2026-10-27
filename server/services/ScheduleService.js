const AppError = require('../utils/AppError');
const {
  ROLES,
  CLASS_TYPES,
  GROUPS,
  SESSION_STATUS,
  CHANGE_TYPES,
  DAY_OF_WEEK_VALUES,
} = require('../utils/constants');

const JS_DAY_TO_NAME = [
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
];

const DUPLICATE_CHANGE_WINDOW_MS = 10 * 1000;

function dateOnly(d) {
  const copy = new Date(d);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

function addDays(d, n) {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + n);
  return copy;
}

function normalizeForCompare(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeForCompare);
  if (typeof value === 'object') {
    if (typeof value.toISOString === 'function') return value.toISOString();
    if (typeof value.toString === 'function' && value.constructor && value.constructor.name === 'ObjectId') {
      return value.toString();
    }
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = normalizeForCompare(value[key]);
    return out;
  }
  return value;
}

function deepEqualSnapshot(a, b) {
  return JSON.stringify(normalizeForCompare(a)) === JSON.stringify(normalizeForCompare(b));
}
function createScheduleService({ models, auditService, notificationService, runInTransaction } = {}) {
  const resolvedModels = models || require('../models');
  const { ScheduleTemplate, ScheduleSession, ScheduleChange, Subject, Doctor, TA } = resolvedModels;
  const audit = auditService || require('./AuditService');
  const notifications = notificationService || require('./NotificationService');
  const runTx = runInTransaction || require('../utils/transaction').runInTransaction;

  async function createTemplate({
    actorUser,
    subjectId,
    type,
    group,
    dayOfWeek,
    startTime,
    endTime,
    roomId,
    doctorId,
    taId,
    effectiveFrom,
  }) {
    const subject = await Subject.findById(subjectId);
    if (!subject) throw AppError.badRequest('subjectId does not reference an existing Subject');

    if (type === CLASS_TYPES.SECTION) {
      if (!subject.hasSections) {
        throw AppError.badRequest('This subject does not have sections enabled', 'SECTIONS_NOT_ENABLED');
      }
      const hasLecture = await ScheduleTemplate.exists({
        subjectId,
        type: CLASS_TYPES.LECTURE,
        isActive: true,
      });
      if (!hasLecture) {
        throw AppError.badRequest(
          'A Section cannot be created before this Subject has an active Lecture',
          'LECTURE_REQUIRED'
        );
      }
    }

    const template = await ScheduleTemplate.create({
      subjectId,
      type,
      group,
      dayOfWeek,
      startTime,
      endTime,
      roomId,
      doctorId,
      taId: taId || null,
      effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : new Date(),
      isActive: true,
    });

    await audit.recordAudit({
      actorId: actorUser.id,
      actorRole: actorUser.role,
      action: 'SCHEDULE_TEMPLATE_CREATED',
      entityType: 'ScheduleTemplate',
      entityId: template._id,
      after: { subjectId, type, group, dayOfWeek, startTime, endTime },
    });

    return template;
  }

  async function listTemplates({ subjectId, isActive } = {}) {
    const filter = {};
    if (subjectId) filter.subjectId = subjectId;
    if (typeof isActive === 'boolean') filter.isActive = isActive;
    return ScheduleTemplate.find(filter);
  }

  async function materializeSessionForDate(template, date) {
    const existing = await ScheduleSession.findOne({ templateId: template._id, date });
    if (existing) return existing;

    const state = {
      startTime: template.startTime,
      endTime: template.endTime,
      roomId: template.roomId,
      doctorId: template.doctorId,
      taId: template.taId || null,
    };

    try {
      return await ScheduleSession.create({
        templateId: template._id,
        subjectId: template.subjectId,
        date,
        type: template.type,
        group: template.group,
        original: state,
        current: { ...state, date: null },
        status: SESSION_STATUS.ACTIVE,
      });
    } catch (err) {
      if (err && err.code === 11000) {
        return ScheduleSession.findOne({ templateId: template._id, date });
      }
      throw err;
    }
  }

  async function getSessionsForRange({ startDate, endDate, subjectId } = {}) {
    const start = dateOnly(startDate);
    const end = dateOnly(endDate);

    const templateFilter = {};
    if (subjectId) templateFilter.subjectId = subjectId;
    const templates = await ScheduleTemplate.find(templateFilter);

    const created = [];
    for (const template of templates) {
      for (let day = new Date(start); day <= end; day = addDays(day, 1)) {
        const dow = JS_DAY_TO_NAME[day.getUTCDay()];
        if (dow !== template.dayOfWeek) continue;
        if (day < dateOnly(template.effectiveFrom)) continue;
        if (template.effectiveTo && day >= dateOnly(template.effectiveTo)) continue;
        created.push(await materializeSessionForDate(template, day));
      }
    }

    return ScheduleSession.find({
      _id: { $in: created.map((s) => s._id) },
    }).sort({ date: 1, 'current.startTime': 1 });
  }

  async function getToday() {
    const today = dateOnly(new Date());
    return getSessionsForRange({ startDate: today, endDate: today });
  }

  async function getSessionById(id) {
    const session = await ScheduleSession.findById(id);
    if (!session) throw AppError.notFound('Schedule session not found');
    return session;
  }

  async function getChangeHistory({ sessionId, subjectId } = {}) {
    if (sessionId) return ScheduleChange.find({ sessionId }).sort({ createdAt: 1 });
    if (subjectId) {
      const sessions = await ScheduleSession.find({ subjectId }).select('_id');
      return ScheduleChange.find({ sessionId: { $in: sessions.map((s) => s._id) } }).sort({
        createdAt: -1,
      });
    }
    throw AppError.badRequest('sessionId or subjectId is required');
  }

  async function assertCanEditSession(actorUser, subject) {
    if (actorUser.role === ROLES.ADMIN || actorUser.role === ROLES.LEADER) return;
    if (actorUser.role === ROLES.DOCTOR) {
      const doctor = await Doctor.findOne({ userId: actorUser.id });
      if (!doctor || subject.doctorId.toString() !== doctor._id.toString()) {
        throw AppError.forbidden('You can only edit schedule for your own subject');
      }
      return;
    }
    if (actorUser.role === ROLES.TA) {
      const ta = await TA.findOne({ userId: actorUser.id });
      if (!ta || !subject.taId || subject.taId.toString() !== ta._id.toString()) {
        throw AppError.forbidden('You can only edit schedule for your own subject');
      }
      return;
    }
    throw AppError.forbidden('You do not have permission to edit the schedule');
  }

  async function findConflicts(session, effectiveDate, current) {
    const warnings = [];
    const candidates = await ScheduleSession.find({
      _id: { $ne: session._id },
      status: { $ne: SESSION_STATUS.CANCELLED },
      $or: [{ date: effectiveDate }, { 'current.date': effectiveDate }],
    });

    const others = candidates.filter((other) => {
      const otherEffectiveDate = other.current.date ? dateOnly(other.current.date) : dateOnly(other.date);
      return otherEffectiveDate.getTime() === dateOnly(effectiveDate).getTime();
    });

    const overlaps = (a, b) => a.startTime < b.endTime && b.startTime < a.endTime;

    for (const other of others) {
      const otherState = other.current;
      if (!overlaps(current, otherState)) continue;
      if (current.roomId && otherState.roomId && current.roomId.toString() === otherState.roomId.toString()) {
        warnings.push({ type: 'ROOM_CONFLICT', withSessionId: other._id });
      }
      if (
        current.doctorId &&
        otherState.doctorId &&
        current.doctorId.toString() === otherState.doctorId.toString()
      ) {
        warnings.push({ type: 'DOCTOR_CONFLICT', withSessionId: other._id });
      }
      if (session.group !== GROUPS.ALL && other.group === session.group) {
        warnings.push({ type: 'GROUP_CONFLICT', withSessionId: other._id });
      }
    }
    return warnings;
  }

  async function findRecentDuplicateChange({ sessionId, changedBy, afterSnapshot }) {
    const recent = await ScheduleChange.find({ sessionId, changedBy });
    const cutoff = Date.now() - DUPLICATE_CHANGE_WINDOW_MS;
    const match = recent
      .filter((c) => new Date(c.createdAt).getTime() >= cutoff)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .find((c) => deepEqualSnapshot(c.after, afterSnapshot));
    return match || null;
  }

  async function applyChange({ actorUser, sessionId, patch = {}, reason, isPermanent, effectiveFrom }) {
    const session = await ScheduleSession.findById(sessionId);
    if (!session) throw AppError.notFound('Schedule session not found');
    const subject = await Subject.findById(session.subjectId);
    if (!subject) throw AppError.notFound('Subject not found for this session');

    await assertCanEditSession(actorUser, subject);

    const actuallyPermanent = actorUser.role === ROLES.ADMIN && !!isPermanent;
    if (isPermanent && actorUser.role !== ROLES.ADMIN) {
      throw AppError.forbidden('Only Admin can make a permanent schedule change');
    }
    if (actuallyPermanent && !effectiveFrom) {
      throw AppError.badRequest('effectiveFrom is required for a permanent change');
    }

    const before = { ...session.current.toObject(), status: session.status };
    const changeTypes = [];
    const nextCurrent = { ...session.current.toObject() };
    const currentFieldsChanged = new Set();
    let newDayOfWeek;

    if (patch.startTime !== undefined && patch.startTime !== session.current.startTime) {
      nextCurrent.startTime = patch.startTime;
      currentFieldsChanged.add('startTime');
      changeTypes.push(CHANGE_TYPES.TIME_CHANGED);
    }
    if (patch.endTime !== undefined && patch.endTime !== session.current.endTime) {
      nextCurrent.endTime = patch.endTime;
      currentFieldsChanged.add('endTime');
      if (!changeTypes.includes(CHANGE_TYPES.TIME_CHANGED)) changeTypes.push(CHANGE_TYPES.TIME_CHANGED);
    }
    if (
      patch.roomId !== undefined &&
      String(patch.roomId) !== String(session.current.roomId || '')
    ) {
      nextCurrent.roomId = patch.roomId;
      currentFieldsChanged.add('roomId');
      changeTypes.push(CHANGE_TYPES.ROOM_CHANGED);
    }
    if (
      patch.doctorId !== undefined &&
      String(patch.doctorId) !== String(session.current.doctorId || '')
    ) {
      nextCurrent.doctorId = patch.doctorId;
      currentFieldsChanged.add('doctorId');
      changeTypes.push(CHANGE_TYPES.DOCTOR_CHANGED);
    }
    if (patch.taId !== undefined && String(patch.taId || '') !== String(session.current.taId || '')) {
      nextCurrent.taId = patch.taId || null;
      currentFieldsChanged.add('taId');
      changeTypes.push(CHANGE_TYPES.TA_CHANGED);
    }

    if (patch.date !== undefined) {
      if (actuallyPermanent) {
        throw AppError.badRequest(
          'For a permanent change, use dayOfWeek to change the recurring pattern, not date (which only moves a single occurrence)',
          'USE_DAY_OF_WEEK_FOR_PERMANENT'
        );
      }
      const requestedDate = dateOnly(patch.date);
      const currentEffectiveDate = session.current.date ? dateOnly(session.current.date) : dateOnly(session.date);
      if (requestedDate.getTime() !== currentEffectiveDate.getTime()) {
        nextCurrent.date = requestedDate;
        currentFieldsChanged.add('date');
        changeTypes.push(CHANGE_TYPES.DAY_CHANGED);
      }
    }

    if (patch.dayOfWeek !== undefined) {
      if (!actuallyPermanent) {
        throw AppError.badRequest(
          'Changing the recurring day of week requires a permanent (Admin) change',
          'DAY_OF_WEEK_REQUIRES_PERMANENT'
        );
      }
      if (!DAY_OF_WEEK_VALUES.includes(patch.dayOfWeek)) {
        throw AppError.badRequest('dayOfWeek must be one of the academic week days');
      }
      newDayOfWeek = patch.dayOfWeek;
      changeTypes.push(CHANGE_TYPES.DAY_CHANGED);
    }

    let nextStatus = session.status;
    let statusChanged = false;
    if (patch.status !== undefined && patch.status !== session.status) {
      nextStatus = patch.status;
      statusChanged = true;
      if (patch.status === SESSION_STATUS.CANCELLED) changeTypes.push(CHANGE_TYPES.CANCELLED);
      else if (patch.status === SESSION_STATUS.ONLINE) changeTypes.push(CHANGE_TYPES.ONLINE);
      else if (patch.status === SESSION_STATUS.ACTIVE) changeTypes.push(CHANGE_TYPES.RESTORED);
    }

    if (changeTypes.length === 0) {
      return { session, change: null, warnings: [], noop: true, duplicate: false };
    }

    const afterSnapshot = { ...nextCurrent, status: nextStatus };
    if (newDayOfWeek) afterSnapshot.dayOfWeek = newDayOfWeek;
    const duplicate = await findRecentDuplicateChange({
      sessionId: session._id,
      changedBy: actorUser.id,
      afterSnapshot,
    });
    if (duplicate) {
      return { session, change: duplicate, warnings: [], noop: true, duplicate: true };
    }

    const effectiveDate = nextCurrent.date || session.date;
    const warnings = await findConflicts(session, effectiveDate, nextCurrent);
    const recipientUserIds = await notifications.computeScheduleChangeRecipients({ session, subject });
    const notificationTitle = `${subject.name} schedule changed`;
    const notificationMessage = `${changeTypes.join(', ')}${actuallyPermanent ? ' (permanent)' : ''}`;
    const originalCurrentRef = session.current;
    const originalStatusValue = session.status;
    session.current = nextCurrent;
    session.status = nextStatus;
    try {
      await session.validate();
    } finally {
      session.current = originalCurrentRef;
      session.status = originalStatusValue;
    }
    const change = await runTx(async (dbSession) => {
      session.current = nextCurrent;
      session.status = nextStatus;

      const currentSet = {};
      for (const field of currentFieldsChanged) {
        currentSet[`current.${field}`] = nextCurrent[field];
      }
      const sessionSet = { ...currentSet };
      if (statusChanged) sessionSet.status = nextStatus;
      if (Object.keys(sessionSet).length > 0) {
        await ScheduleSession.updateOne({ _id: session._id }, { $set: sessionSet }, { session: dbSession });
      }

      if (actuallyPermanent) {
        const oldTemplate = await ScheduleTemplate.findById(session.templateId).session(dbSession);
        if (oldTemplate) {
          oldTemplate.effectiveTo = new Date(effectiveFrom);
          oldTemplate.isActive = false;
          await oldTemplate.save({ session: dbSession });

          await ScheduleTemplate.create(
            [
              {
                subjectId: oldTemplate.subjectId,
                type: oldTemplate.type,
                group: oldTemplate.group,
                dayOfWeek: newDayOfWeek || oldTemplate.dayOfWeek,
                startTime: nextCurrent.startTime,
                endTime: nextCurrent.endTime,
                roomId: nextCurrent.roomId,
                doctorId: nextCurrent.doctorId,
                taId: nextCurrent.taId || null,
                effectiveFrom: new Date(effectiveFrom),
                isActive: true,
              },
            ],
            { session: dbSession }
          );
        }
      }

      const [createdChange] = await ScheduleChange.create(
        [
          {
            sessionId: session._id,
            changedBy: actorUser.id,
            changedByRole: actorUser.role,
            changeTypes,
            before,
            after: afterSnapshot,
            reason: reason || null,
            isPermanent: actuallyPermanent,
          },
        ],
        { session: dbSession }
      );

      await notifications.dispatch({
        type: changeTypes[0],
        category: 'SCHEDULE',
        title: notificationTitle,
        message: notificationMessage,
        createdBy: actorUser.id,
        relatedType: 'SCHEDULE_SESSION',
        relatedId: session._id,
        recipientUserIds,
        actorUserId: actorUser.id,
        actorRole: actorUser.role,
        dbSession,
      });

      return createdChange;
    });
    await audit.recordAudit({
      actorId: actorUser.id,
      actorRole: actorUser.role,
      action: 'SCHEDULE_CHANGED',
      entityType: 'ScheduleSession',
      entityId: session._id,
      before,
      after: afterSnapshot,
    });

    return { session, change, warnings, noop: false, duplicate: false };
  }

  return {
    createTemplate,
    listTemplates,
    getSessionsForRange,
    getToday,
    getSessionById,
    getChangeHistory,
    applyChange,
    assertCanEditSession,
  };
}

const defaultScheduleService = createScheduleService();

module.exports = { createScheduleService, ...defaultScheduleService };
