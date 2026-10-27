const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { isValidObjectId } = require('../utils/validateObjectId');
const notificationService = require('../services/NotificationService');

const list = asyncHandler(async (req, res) => {
  const { unreadOnly } = req.query;
  const notifications = await notificationService.listForUser({
    userId: req.user.id,
    unreadOnly: unreadOnly === 'true',
  });
  res.status(200).json({ success: true, notifications });
});

const markRead = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    throw AppError.badRequest('id is not a valid id', 'INVALID_NOTIFICATION_ID');
  }
  await notificationService.markRead({ userId: req.user.id, recipientId: req.params.id });
  res.status(200).json({ success: true, message: 'Marked as read.' });
});

const markAllRead = asyncHandler(async (req, res) => {
  const result = await notificationService.markAllRead({ userId: req.user.id });
  res.status(200).json({ success: true, ...result });
});

module.exports = { list, markRead, markAllRead };
