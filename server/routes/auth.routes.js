const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { checkMaintenanceMode } = require('../middleware/maintenance');
const { authLimiter } = require('../middleware/rateLimiters');
const { ROLES } = require('../utils/constants');
const controller = require('../controllers/auth.controller');

const router = express.Router();

router.post('/login', authLimiter, controller.login);
router.post('/logout', controller.logout);
router.get('/me', requireAuth, checkMaintenanceMode, controller.me);
router.post('/forgot-password', authLimiter, controller.forgotPassword);
router.post(
  '/password',
  requireAuth,
  requireRole(ROLES.STUDENT),
  checkMaintenanceMode,
  controller.createPassword
);
router.delete(
  '/password',
  requireAuth,
  requireRole(ROLES.STUDENT),
  checkMaintenanceMode,
  controller.removePassword
);

module.exports = router;
