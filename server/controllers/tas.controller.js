const { createStaffController } = require('./staffController.factory');
const taService = require('../services/TAService');

module.exports = createStaffController(taService);
