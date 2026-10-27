const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { checkMaintenanceMode } = require('../middleware/maintenance');
const controller = require('../controllers/notifications.controller');

const router = express.Router();
router.use(requireAuth, checkMaintenanceMode);

router.get('/', controller.list);
router.patch('/:id/read', controller.markRead);
router.patch('/read-all', controller.markAllRead);

module.exports = router;
