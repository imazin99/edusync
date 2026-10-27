const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { checkMaintenanceMode } = require('../middleware/maintenance');
const { ROLES } = require('../utils/constants');
const controller = require('../controllers/students.controller');

const router = express.Router();
router.use(requireAuth, requireRole(ROLES.ADMIN), checkMaintenanceMode);

router.get('/', controller.list);
router.get('/:id', controller.getOne);
router.post('/', controller.create);
router.patch('/:id', controller.update);

module.exports = router;
