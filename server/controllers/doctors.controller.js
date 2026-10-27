const { createStaffController } = require('./staffController.factory');
const doctorService = require('../services/DoctorService');

module.exports = createStaffController(doctorService);
