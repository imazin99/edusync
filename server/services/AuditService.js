const AppError = require('../utils/AppError');
const { isValidObjectId } = require('../utils/validateObjectId');

function createAuditService({ models } = {}) {
  const resolvedModels = models || require('../models');
  const { AuditLog } = resolvedModels;

  async function recordAudit({
    actorId,
    actorRole,
    action,
    entityType,
    entityId,
    before = null,
    after = null,
  }) {
    try {
      await AuditLog.create({ actorId, actorRole, action, entityType, entityId, before, after });
    } catch (err) {
      console.error('[audit] failed to record audit log entry:', err.message);
    }
  }
  async function list({ actorId, action, entityType, entityId } = {}) {
    const filter = {};

    if (actorId) {
      if (!isValidObjectId(actorId)) {
        throw AppError.badRequest('actorId is not a valid id', 'INVALID_ACTOR_ID');
      }
      filter.actorId = actorId;
    }
    if (action) filter.action = action;
    if (entityType) filter.entityType = entityType;
    if (entityId) {
      if (!isValidObjectId(entityId)) {
        throw AppError.badRequest('entityId is not a valid id', 'INVALID_ENTITY_ID');
      }
      filter.entityId = entityId;
    }

    return AuditLog.find(filter).sort({ createdAt: -1 });
  }

  return { recordAudit, list };
}

const defaultAuditService = createAuditService();

module.exports = { createAuditService, ...defaultAuditService };
