const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { checkMaintenanceMode } = require('../middleware/maintenance');
const { ROLES } = require('../utils/constants');
const controller = require('../controllers/rooms.controller');

const router = express.Router();
router.use(requireAuth, checkMaintenanceMode);

router.get('/', controller.list);
router.get('/:id', controller.getOne);
router.post('/', requireRole(ROLES.ADMIN), controller.create);
router.patch('/:id', requireRole(ROLES.ADMIN), controller.update);

module.exports = router;
