const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { checkMaintenanceMode } = require('../middleware/maintenance');
const { ROLES } = require('../utils/constants');
const controller = require('../controllers/admin.controller');

const router = express.Router();
router.use(requireAuth, requireRole(ROLES.ADMIN), checkMaintenanceMode);

router.get('/requests', controller.listRequests);
router.patch('/requests/:id', controller.reviewRequest);
router.post('/users/:userId/reset-password', controller.resetUserPassword);
router.post('/schedule/permanent-change', controller.permanentScheduleChange);
router.post('/notifications/broadcast', controller.broadcast);
router.get('/settings', controller.getSettings);
router.patch('/settings', controller.updateSettings);
router.get('/audit-logs', controller.listAuditLogs);
router.get('/dashboard', controller.getDashboard);

module.exports = router;
