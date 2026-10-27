const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { checkMaintenanceMode } = require('../middleware/maintenance');
const { ROLES } = require('../utils/constants');
const controller = require('../controllers/requests.controller');

const router = express.Router();
router.use(requireAuth, requireRole(ROLES.STUDENT), checkMaintenanceMode);

router.post('/group-change', controller.createGroupChange);

module.exports = router;
