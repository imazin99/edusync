const { createStaffService } = require('./StaffService');
const { ROLES } = require('../utils/constants');

function createTAService({ models, auditService } = {}) {
  return createStaffService({ models, auditService, role: ROLES.TA, ProfileModelName: 'TA' });
}

const defaultTAService = createTAService();

module.exports = { createTAService, ...defaultTAService };
