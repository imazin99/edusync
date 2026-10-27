const AppError = require('../utils/AppError');
const { ROLES } = require('../utils/constants');
const { isValidObjectId } = require('../utils/validateObjectId');

function createReadScopeService({ models, taskService, scheduleService } = {}) {
  const resolvedModels = models || require('../models');
  const { Subject, Doctor, TA, Task, ScheduleSession } = resolvedModels;
  const tasks = taskService || require('./TaskService');
  const schedule = scheduleService || require('./ScheduleService');
  async function allowedSubjectIds(actorUser) {
    if (!actorUser) return [];
    if (
      actorUser.role === ROLES.STUDENT ||
      actorUser.role === ROLES.LEADER ||
      actorUser.role === ROLES.ADMIN
    ) {
      return null;
    }
    if (actorUser.role === ROLES.DOCTOR) {
      const doctor = await Doctor.findOne({ userId: actorUser.id });
      if (!doctor) return [];
      const subjects = await Subject.find({ doctorId: doctor._id });
      return subjects.map((s) => String(s._id));
    }
    if (actorUser.role === ROLES.TA) {
      const ta = await TA.findOne({ userId: actorUser.id });
      if (!ta) return [];
      const subjects = await Subject.find({ taId: ta._id });
      return subjects.map((s) => String(s._id));
    }
    return [];
  }

  function isProvided(value) {
    return value !== undefined && value !== null && value !== '';
  }
  async function listTasksForActor({ actorUser, subjectId, status, createdBy } = {}) {
    const allowed = await allowedSubjectIds(actorUser);
    if (allowed === null) {
      return tasks.list({ subjectId, status, createdBy });
    }
    if (isProvided(subjectId) && !allowed.includes(String(subjectId))) {
      return [];
    }
    const filter = {
      deletedAt: null,
      subjectId: isProvided(subjectId) ? subjectId : { $in: allowed },
    };
    if (status) filter.status = status;
    if (createdBy) filter.createdBy = createdBy;
    return Task.find(filter).sort({ createdAt: -1 });
  }
  async function assertTaskReadable({ actorUser, taskId } = {}) {
    const allowed = await allowedSubjectIds(actorUser);
    if (allowed === null) {
      return tasks.getById(taskId);
    }
    if (!isValidObjectId(taskId)) {
      throw AppError.badRequest('taskId is not a valid id', 'INVALID_TASK_ID');
    }
    const task = await tasks.getById(taskId);
    if (!allowed.includes(String(task.subjectId))) {
      throw AppError.notFound('Task not found');
    }
    return task;
  }
  async function assertAttachmentReadable({ actorUser, taskId } = {}) {
    const allowed = await allowedSubjectIds(actorUser);
    if (allowed === null) return;
    if (!isValidObjectId(taskId)) {
      throw AppError.badRequest('taskId is not a valid id', 'INVALID_TASK_ID');
    }
    const task = await tasks.getById(taskId);
    if (!allowed.includes(String(task.subjectId))) {
      throw AppError.notFound('Task not found');
    }
  }
  async function getChangeHistoryForActor({ actorUser, sessionId, subjectId } = {}) {
    const allowed = await allowedSubjectIds(actorUser);
    if (allowed === null) {
      return schedule.getChangeHistory({ sessionId, subjectId });
    }

    if (isProvided(subjectId) && !allowed.includes(String(subjectId))) {
      return [];
    }

    if (isProvided(sessionId)) {
      if (!isValidObjectId(sessionId)) {
        throw AppError.badRequest('sessionId is not a valid id', 'INVALID_SESSION_ID');
      }
      const session = await ScheduleSession.findById(sessionId);
      if (!session || !allowed.includes(String(session.subjectId))) {
        return [];
      }
      return schedule.getChangeHistory({ sessionId });
    }

    if (isProvided(subjectId)) {
      return schedule.getChangeHistory({ subjectId });
    }
    const perSubject = await Promise.all(
      allowed.map((id) => schedule.getChangeHistory({ subjectId: id }))
    );
    return perSubject
      .flat()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  return {
    allowedSubjectIds,
    listTasksForActor,
    assertTaskReadable,
    assertAttachmentReadable,
    getChangeHistoryForActor,
  };
}

const defaultReadScopeService = createReadScopeService();

module.exports = { createReadScopeService, ...defaultReadScopeService };
