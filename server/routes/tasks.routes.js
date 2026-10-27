const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { checkMaintenanceMode } = require('../middleware/maintenance');
const { ROLES } = require('../utils/constants');
const controller = require('../controllers/tasks.controller');

const router = express.Router();
router.use(requireAuth, checkMaintenanceMode);

const canManage = requireRole(ROLES.DOCTOR, ROLES.TA, ROLES.LEADER, ROLES.ADMIN);

router.get('/', controller.list);
router.get('/:id', controller.getOne);
router.post('/', canManage, controller.create);
router.patch('/:id', canManage, controller.update);
router.delete('/:id', canManage, controller.remove);
router.post('/:id/complete', requireRole(ROLES.STUDENT), controller.complete);
router.delete('/:id/complete', requireRole(ROLES.STUDENT), controller.uncomplete);
router.post('/:id/attachments', canManage, controller.addAttachment);
router.delete('/:id/attachments/:storageKey', canManage, controller.removeAttachment);
router.get('/:id/attachments/:storageKey', controller.downloadAttachment);

module.exports = router;
