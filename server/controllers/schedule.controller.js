const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { isValidObjectId } = require('../utils/validateObjectId');
const scheduleService = require('../services/ScheduleService');
const readScope = require('../services/ReadScopeService');

const listTemplates = asyncHandler(async (req, res) => {
  const { subjectId, isActive } = req.query;
  const templates = await scheduleService.listTemplates({
    subjectId,
    isActive: isActive === undefined ? undefined : isActive === 'true',
  });
  res.status(200).json({ success: true, templates });
});

const createTemplate = asyncHandler(async (req, res) => {
  const { subjectId, type, group, dayOfWeek, startTime, endTime, roomId, doctorId, taId, effectiveFrom } =
    req.body || {};
  const template = await scheduleService.createTemplate({
    actorUser: req.user,
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
  });
  res.status(201).json({ success: true, template });
});

const getRange = asyncHandler(async (req, res) => {
  const { startDate, endDate, subjectId } = req.query;
  if (!startDate || !endDate) {
    throw AppError.badRequest('startDate and endDate query params are required');
  }
  const sessions = await scheduleService.getSessionsForRange({ startDate, endDate, subjectId });
  res.status(200).json({ success: true, sessions });
});
const getSessions = asyncHandler(async (req, res) => {
  const { date, startDate, endDate, subjectId } = req.query;
  const rangeStart = date || startDate;
  const rangeEnd = date || endDate;
  if (!rangeStart || !rangeEnd) {
    throw AppError.badRequest('date, or both startDate and endDate, query params are required');
  }
  const sessions = await scheduleService.getSessionsForRange({
    startDate: rangeStart,
    endDate: rangeEnd,
    subjectId,
  });
  res.status(200).json({ success: true, sessions });
});

const getToday = asyncHandler(async (req, res) => {
  const sessions = await scheduleService.getToday();
  res.status(200).json({ success: true, sessions });
});

const getSession = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.sessionId)) {
    throw AppError.badRequest('sessionId is not a valid id', 'INVALID_SESSION_ID');
  }
  const session = await scheduleService.getSessionById(req.params.sessionId);
  res.status(200).json({ success: true, session });
});

const getChanges = asyncHandler(async (req, res) => {
  const { sessionId, subjectId } = req.query;
  const changes = await readScope.getChangeHistoryForActor({
    actorUser: req.user,
    sessionId,
    subjectId,
  });
  res.status(200).json({ success: true, changes });
});

const applyOneTimeChange = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.sessionId)) {
    throw AppError.badRequest('sessionId is not a valid id', 'INVALID_SESSION_ID');
  }
  const { current, reason, status } = req.body || {};

  const patch = { ...(current || {}) };
  if (status !== undefined) patch.status = status;
  const result = await scheduleService.applyChange({
    actorUser: req.user,
    sessionId: req.params.sessionId,
    patch,
    reason,
    isPermanent: false,
  });
  res.status(200).json({ success: true, ...result });
});

const applyPermanentChange = asyncHandler(async (req, res) => {
  const { sessionId, current, dayOfWeek, reason, effectiveFrom } = req.body || {};
  if (!sessionId) throw AppError.badRequest('sessionId is required');
  if (!isValidObjectId(sessionId)) {
    throw AppError.badRequest('sessionId is not a valid id', 'INVALID_SESSION_ID');
  }
  const result = await scheduleService.applyChange({
    actorUser: req.user,
    sessionId,
    patch: { ...(current || {}), ...(dayOfWeek !== undefined ? { dayOfWeek } : {}) },
    reason,
    isPermanent: true,
    effectiveFrom,
  });
  res.status(200).json({ success: true, ...result });
});

module.exports = {
  listTemplates,
  createTemplate,
  getRange,
  getSessions,
  getToday,
  getSession,
  getChanges,
  applyOneTimeChange,
  applyPermanentChange,
};
