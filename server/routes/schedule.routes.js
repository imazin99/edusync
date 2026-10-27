const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { checkMaintenanceMode } = require('../middleware/maintenance');
const { ROLES } = require('../utils/constants');
const controller = require('../controllers/schedule.controller');

const router = express.Router();
router.use(requireAuth, checkMaintenanceMode);

router.get('/', controller.getRange);
router.get('/today', controller.getToday);
router.get('/changes', controller.getChanges);
router.get('/templates', controller.listTemplates);
router.post('/templates', requireRole(ROLES.ADMIN), controller.createTemplate);
router.get('/sessions', controller.getSessions);
router.get('/:sessionId', controller.getSession);
router.post(
  '/:sessionId/change',
  requireRole(ROLES.DOCTOR, ROLES.TA, ROLES.LEADER, ROLES.ADMIN),
  controller.applyOneTimeChange
);

module.exports = router;
