const AppError = require('../utils/AppError');
const { REQUEST_TYPES, REQUEST_STATUS, GROUP_CHANGE_TARGET_VALUES } = require('../utils/constants');

function createRequestService({ models, auditService, runInTransaction } = {}) {
  const resolvedModels = models || require('../models');
  const { Request, Student, User } = resolvedModels;
  const audit = auditService || require('./AuditService');
  const runTx = runInTransaction || require('../utils/transaction').runInTransaction;

  async function createGroupChangeRequest({ actorUser, requestedGroup }) {
    if (!GROUP_CHANGE_TARGET_VALUES.includes(requestedGroup)) {
      throw AppError.badRequest('requestedGroup must be G1 or G2');
    }
    const student = await Student.findOne({ userId: actorUser.id });
    if (!student) throw AppError.forbidden('Only students can request a group change');

    const request = await Request.create({
      type: REQUEST_TYPES.GROUP_CHANGE,
      userId: actorUser.id,
      data: { requestedGroup },
      status: REQUEST_STATUS.PENDING,
    });

    await audit.recordAudit({
      actorId: actorUser.id,
      actorRole: actorUser.role,
      action: 'GROUP_CHANGE_REQUESTED',
      entityType: 'Request',
      entityId: request._id,
      after: { requestedGroup },
    });

    return request;
  }

  async function list({ type, status } = {}) {
    const filter = {};
    if (type) filter.type = type;
    if (status) filter.status = status;
    return Request.find(filter).sort({ createdAt: -1 });
  }

  async function review({ actorUser, requestId, status }) {
    if (![REQUEST_STATUS.APPROVED, REQUEST_STATUS.REJECTED].includes(status)) {
      throw AppError.badRequest('status must be APPROVED or REJECTED');
    }
    const request = await Request.findById(requestId);
    if (!request) throw AppError.notFound('Request not found');
    if (request.status !== REQUEST_STATUS.PENDING) {
      throw AppError.conflict('This request has already been reviewed');
    }
    let student = null;
    if (status === REQUEST_STATUS.APPROVED && request.type === REQUEST_TYPES.GROUP_CHANGE) {
      student = await Student.findOne({ userId: request.userId });
    }

    await runTx(async (dbSession) => {
      request.status = status;
      request.reviewedBy = actorUser.id;
      request.reviewedAt = new Date();
      await request.save({ session: dbSession });

      if (student) {
        student.group = request.data.requestedGroup;
        await student.save({ session: dbSession });
      }
    });

    await audit.recordAudit({
      actorId: actorUser.id,
      actorRole: actorUser.role,
      action: `REQUEST_${status}`,
      entityType: 'Request',
      entityId: request._id,
      after: { status },
    });

    return request;
  }

  return { createGroupChangeRequest, list, review };
}

const defaultRequestService = createRequestService();

module.exports = { createRequestService, ...defaultRequestService };
