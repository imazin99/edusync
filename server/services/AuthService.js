const { ROLES, REQUEST_TYPES } = require('../utils/constants');
const AppError = require('../utils/AppError');
const { hashPassword, comparePassword } = require('../utils/password');

const MIN_PASSWORD_LENGTH = 8;
function createAuthService({ models, auditService } = {}) {
  const resolvedModels = models || require('../models');
  const { User, Student, Doctor, TA, Leader, Request, SystemSettings } = resolvedModels;
  const audit = auditService || require('./AuditService');

  function invalidCredentialsError() {
    return AppError.unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
  }
  async function loadProfileForUser(user) {
    switch (user.role) {
      case ROLES.STUDENT: {
        const profile = await Student.findOne({ userId: user._id });
        return { kind: 'student', profile };
      }
      case ROLES.DOCTOR: {
        const profile = await Doctor.findOne({ userId: user._id });
        return { kind: 'doctor', profile };
      }
      case ROLES.TA: {
        const profile = await TA.findOne({ userId: user._id });
        return { kind: 'ta', profile };
      }
      case ROLES.LEADER: {
        const profile = await Leader.findOne({ userId: user._id });
        return { kind: 'leader', profile };
      }
      case ROLES.ADMIN:
      default:
        return { kind: 'admin', profile: null };
    }
  }
  function isProfileActive(role, profile) {
    if (role === ROLES.ADMIN) return true;
    if (!profile) return false;
    return profile.isActive !== false;
  }

  async function getSystemSettings() {
    return SystemSettings.getSingleton();
  }
  async function login({ identifier, password }) {
    if (!identifier || typeof identifier !== 'string') {
      throw AppError.badRequest('identifier is required');
    }

    const user = await User.findOne({ username: identifier.trim() }).select('+passwordHash');
    if (!user) throw invalidCredentialsError();
    if (!user.isActive) {
      throw AppError.forbidden('This account has been disabled', 'ACCOUNT_DISABLED');
    }

    const { profile } = await loadProfileForUser(user);
    if (!isProfileActive(user.role, profile)) {
      throw AppError.forbidden('This account has been disabled', 'ACCOUNT_DISABLED');
    }

    const settings = await getSystemSettings();
    if (settings.maintenanceMode && user.role !== ROLES.ADMIN) {
      throw AppError.serviceUnavailable(
        settings.maintenanceMessage || 'The system is under maintenance. Please try again later.'
      );
    }

    if (user.passwordHash) {
      if (!password) throw invalidCredentialsError();
      const matches = await comparePassword(password, user.passwordHash);
      if (!matches) throw invalidCredentialsError();
    } else if (user.role !== ROLES.STUDENT) {
      throw invalidCredentialsError();
    }

    user.lastLoginAt = new Date();
    await user.save();

    await audit.recordAudit({
      actorId: user._id,
      actorRole: user.role,
      action: 'LOGIN_SUCCESS',
      entityType: 'User',
      entityId: user._id,
    });

    return user;
  }

  async function createPassword({ userId, password }) {
    const user = await User.findById(userId).select('+passwordHash');
    if (!user) throw AppError.notFound('User not found');
    if (user.role !== ROLES.STUDENT) {
      throw AppError.forbidden(
        'Only students can create or remove a login password',
        'NOT_A_STUDENT'
      );
    }
    if (user.passwordHash) {
      throw AppError.conflict('A password is already set for this account', 'PASSWORD_ALREADY_SET');
    }
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      throw AppError.badRequest(
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
        'WEAK_PASSWORD'
      );
    }

    user.passwordHash = await hashPassword(password);
    await user.save();

    await audit.recordAudit({
      actorId: user._id,
      actorRole: user.role,
      action: 'PASSWORD_CREATED',
      entityType: 'User',
      entityId: user._id,
    });

    return user;
  }

  async function removePassword({ userId }) {
    const user = await User.findById(userId).select('+passwordHash');
    if (!user) throw AppError.notFound('User not found');
    if (user.role !== ROLES.STUDENT) {
      throw AppError.forbidden(
        'Only students can create or remove a login password',
        'NOT_A_STUDENT'
      );
    }
    if (!user.passwordHash) {
      throw AppError.conflict('No password is currently set for this account', 'PASSWORD_NOT_SET');
    }

    user.passwordHash = null;
    await user.save();

    await audit.recordAudit({
      actorId: user._id,
      actorRole: user.role,
      action: 'PASSWORD_REMOVED',
      entityType: 'User',
      entityId: user._id,
    });

    return user;
  }

  async function requestPasswordReset({ identifier }) {
    if (!identifier || typeof identifier !== 'string') {
      throw AppError.badRequest('identifier is required');
    }

    const user = await User.findOne({ username: identifier.trim() });
    if (user) {
      await Request.create({ type: REQUEST_TYPES.PASSWORD_RESET, userId: user._id, data: {} });
      await audit.recordAudit({
        actorId: user._id,
        actorRole: user.role,
        action: 'PASSWORD_RESET_REQUESTED',
        entityType: 'User',
        entityId: user._id,
      });
    }

    return { requested: true };
  }

  async function adminResetPassword({ actorUser, targetUserId, newPassword }) {
    if (!actorUser || actorUser.role !== ROLES.ADMIN) {
      throw AppError.forbidden('Only Admin can reset a password', 'ADMIN_ONLY');
    }
    const user = await User.findById(targetUserId);
    if (!user) throw AppError.notFound('User not found');
    if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
      throw AppError.badRequest(
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
        'WEAK_PASSWORD'
      );
    }

    user.passwordHash = await hashPassword(newPassword);
    await user.save();

    await audit.recordAudit({
      actorId: actorUser.id || actorUser._id,
      actorRole: actorUser.role,
      action: 'PASSWORD_RESET_BY_ADMIN',
      entityType: 'User',
      entityId: user._id,
    });

    return user;
  }

  return {
    loadProfileForUser,
    isProfileActive,
    getSystemSettings,
    login,
    createPassword,
    removePassword,
    requestPasswordReset,
    adminResetPassword,
  };
}

const defaultAuthService = createAuthService();

module.exports = { createAuthService, ...defaultAuthService };
