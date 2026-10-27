const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { isValidObjectId } = require('../utils/validateObjectId');
const requestService = require('../services/RequestService');
const authService = require('../services/AuthService');
const notificationService = require('../services/NotificationService');
const settingsService = require('../services/SettingsService');
const auditService = require('../services/AuditService');
const dashboardService = require('../services/AdminDashboardService');
const scheduleController = require('./schedule.controller');

const listRequests = asyncHandler(async (req, res) => {
  const { type, status } = req.query;
  const requests = await requestService.list({ type, status });
  res.status(200).json({ success: true, requests });
});

const reviewRequest = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    throw AppError.badRequest('id is not a valid id', 'INVALID_REQUEST_ID');
  }
  const { status } = req.body || {};
  const request = await requestService.review({ actorUser: req.user, requestId: req.params.id, status });
  res.status(200).json({ success: true, request });
});

const resetUserPassword = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.userId)) {
    throw AppError.badRequest('userId is not a valid id', 'INVALID_USER_ID');
  }
  const { newPassword } = req.body || {};
  await authService.adminResetPassword({
    actorUser: req.user,
    targetUserId: req.params.userId,
    newPassword,
  });
  res.status(200).json({ success: true, message: 'Password reset.' });
});

const broadcast = asyncHandler(async (req, res) => {
  const { audience, title, message } = req.body || {};
  const notification = await notificationService.broadcast({
    actorUser: req.user,
    audience,
    title,
    message,
  });
  res.status(201).json({ success: true, notification });
});
const permanentScheduleChange = scheduleController.applyPermanentChange;

const getSettings = asyncHandler(async (req, res) => {
  const settings = await settingsService.get();
  res.status(200).json({ success: true, settings });
});

const updateSettings = asyncHandler(async (req, res) => {
  const settings = await settingsService.update({ actorUser: req.user, patch: req.body || {} });
  res.status(200).json({ success: true, settings });
});

const listAuditLogs = asyncHandler(async (req, res) => {
  const { actorId, action, entityType, entityId } = req.query;
  const auditLogs = await auditService.list({ actorId, action, entityType, entityId });
  res.status(200).json({ success: true, auditLogs });
});

const getDashboard = asyncHandler(async (req, res) => {
  const dashboard = await dashboardService.getDashboard();
  res.status(200).json({ success: true, dashboard });
});

module.exports = {
  listRequests,
  reviewRequest,
  resetUserPassword,
  permanentScheduleChange,
  broadcast,
  getSettings,
  updateSettings,
  listAuditLogs,
  getDashboard,
};
