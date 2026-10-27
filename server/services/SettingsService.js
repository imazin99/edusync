const AppError = require('../utils/AppError');
const ALLOWED_FIELDS = Object.freeze([
  'maintenanceMode',
  'maintenanceMessage',
  'currentAcademicTerm',
  'notificationRetentionDays',
  'weekOffDay',
]);

function createSettingsService({ models, auditService } = {}) {
  const resolvedModels = models || require('../models');
  const { SystemSettings } = resolvedModels;
  const audit = auditService || require('./AuditService');

  async function get() {
    return SystemSettings.getSingleton();
  }

  async function update({ actorUser, patch } = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw AppError.badRequest('A settings patch object is required', 'VALIDATION_ERROR');
    }

    const suppliedKeys = Object.keys(patch);
    if (suppliedKeys.length === 0) {
      throw AppError.badRequest('At least one setting must be supplied', 'VALIDATION_ERROR');
    }

    const unknownKeys = suppliedKeys.filter((key) => !ALLOWED_FIELDS.includes(key));
    if (unknownKeys.length > 0) {
      throw AppError.badRequest(
        `Unknown or unapproved setting field(s): ${unknownKeys.join(', ')}`,
        'VALIDATION_ERROR'
      );
    }

    if (
      Object.prototype.hasOwnProperty.call(patch, 'notificationRetentionDays') &&
      typeof patch.notificationRetentionDays !== 'number'
    ) {
      throw AppError.badRequest(
        'notificationRetentionDays must be a number',
        'VALIDATION_ERROR'
      );
    }

    const before = await SystemSettings.getSingleton();

    let updated;
    try {
      updated = await SystemSettings.findOneAndUpdate(
        { key: SystemSettings.SINGLETON_KEY },
        { $set: patch },
        { new: true, runValidators: true, context: 'query' }
      );
    } catch (err) {
      if (err && (err.name === 'ValidationError' || err.name === 'CastError')) {
        throw AppError.badRequest(err.message, 'VALIDATION_ERROR');
      }
      throw err;
    }

    const changedBefore = {};
    const changedAfter = {};
    for (const key of suppliedKeys) {
      changedBefore[key] = before[key];
      changedAfter[key] = updated[key];
    }

    await audit.recordAudit({
      actorId: actorUser.id,
      actorRole: actorUser.role,
      action: 'SETTINGS_UPDATED',
      entityType: 'SystemSettings',
      entityId: updated._id,
      before: changedBefore,
      after: changedAfter,
    });

    return updated;
  }

  return { get, update, ALLOWED_FIELDS };
}

const defaultSettingsService = createSettingsService();

module.exports = { createSettingsService, ...defaultSettingsService };
