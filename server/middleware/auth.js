const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
function createAuthMiddleware({ models, authService } = {}) {
  const resolvedModels = models || require('../models');
  const { User } = resolvedModels;
  const auth = authService || require('../services/AuthService');
  const requireAuth = asyncHandler(async (req, res, next) => {
    if (!req.session || !req.session.userId) {
      throw AppError.unauthorized('Authentication required');
    }

    const user = await User.findById(req.session.userId);
    if (!user || !user.isActive) {
      req.session.destroy(() => {});
      throw AppError.unauthorized('Session is no longer valid', 'SESSION_INVALID');
    }

    const { profile } = await auth.loadProfileForUser(user);
    if (!auth.isProfileActive(user.role, profile)) {
      req.session.destroy(() => {});
      throw AppError.unauthorized('Session is no longer valid', 'SESSION_INVALID');
    }

    req.user = { id: user._id.toString(), username: user.username, role: user.role };
    req.userDoc = user;
    next();
  });

  function requireRole(...roles) {
    return function roleCheck(req, res, next) {
      if (!req.user) {
        return next(AppError.unauthorized('Authentication required'));
      }
      if (!roles.includes(req.user.role)) {
        return next(AppError.forbidden('You do not have permission to do this'));
      }
      next();
    };
  }

  function requirePermission(predicate) {
    return asyncHandler(async (req, res, next) => {
      if (!req.user) {
        throw AppError.unauthorized('Authentication required');
      }
      const allowed = await predicate(req);
      if (!allowed) {
        throw AppError.forbidden('You do not have permission to do this');
      }
      next();
    });
  }

  return { requireAuth, requireRole, requirePermission };
}

const defaultAuthMiddleware = createAuthMiddleware();

module.exports = { createAuthMiddleware, ...defaultAuthMiddleware };
