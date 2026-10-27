const AppError = require('../utils/AppError');
const { ROLES } = require('../utils/constants');
const asyncHandler = require('../utils/asyncHandler');
function createMaintenanceMiddleware({ models } = {}) {
  const resolvedModels = models || require('../models');
  const { SystemSettings } = resolvedModels;

  const checkMaintenanceMode = asyncHandler(async (req, res, next) => {
    const settings = await SystemSettings.getSingleton();
    const isAdmin = req.user && req.user.role === ROLES.ADMIN;

    if (settings.maintenanceMode && !isAdmin) {
      throw AppError.serviceUnavailable(
        settings.maintenanceMessage || 'The system is under maintenance. Please try again later.'
      );
    }

    next();
  });

  return { checkMaintenanceMode };
}

const defaultMaintenanceMiddleware = createMaintenanceMiddleware();

module.exports = { createMaintenanceMiddleware, ...defaultMaintenanceMiddleware };
