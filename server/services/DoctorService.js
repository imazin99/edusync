const { createStaffService } = require('./StaffService');
const { ROLES } = require('../utils/constants');

function createDoctorService({ models, auditService } = {}) {
  return createStaffService({ models, auditService, role: ROLES.DOCTOR, ProfileModelName: 'Doctor' });
}

const defaultDoctorService = createDoctorService();

module.exports = { createDoctorService, ...defaultDoctorService };
