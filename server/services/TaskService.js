const AppError = require('../utils/AppError');
const { ROLES, TASK_STATUS } = require('../utils/constants');
const { sanitizeFilename, getValidatedExtension, isPlausibleBase64, parseByteSize } = require('../utils/attachmentValidation');

function createTaskService({ models, auditService, notificationService, fileStorage, uploadLimit, runInTransaction } = {}) {
  const resolvedModels = models || require('../models');
  const { Task, TaskCompletion, Subject, Doctor, TA, Student } = resolvedModels;
  const audit = auditService || require('./AuditService');
  const notifications = notificationService || require('./NotificationService');
  const storage = fileStorage || require('./FileStorageService');
  const runTx = runInTransaction || require('../utils/transaction').runInTransaction;
  const maxAttachmentBytes = parseByteSize(uploadLimit || require('../config/env').env.uploadLimit);
  const maxAttachments = Task.MAX_ATTACHMENTS || 10;

  async function loadSubjectAndAssertManage(actorUser, subject) {
    if (actorUser.role === ROLES.ADMIN || actorUser.role === ROLES.LEADER) return;
    if (actorUser.role === ROLES.DOCTOR) {
      const doctor = await Doctor.findOne({ userId: actorUser.id });
      if (doctor && subject.doctorId.toString() === doctor._id.toString()) return;
    }
    if (actorUser.role === ROLES.TA) {
      const ta = await TA.findOne({ userId: actorUser.id });
      if (ta && subject.taId && subject.taId.toString() === ta._id.toString()) return;
    }
    throw AppError.forbidden('You do not have permission to manage tasks for this subject');
  }

  async function create({ actorUser, title, description, subjectId, deadline, submissionLinks }) {
    if (!title || !subjectId) throw AppError.badRequest('title and subjectId are required');
    const subject = await Subject.findById(subjectId);
    if (!subject) throw AppError.badRequest('subjectId does not reference an existing Subject');

    await loadSubjectAndAssertManage(actorUser, subject);

    const recipientUserIds = await notifications.computeTaskRecipients({ subject });

    const task = await runTx(async (dbSession) => {
      const [createdTask] = await Task.create(
        [
          {
            title: title.trim(),
            description: description || '',
            subjectId,
            createdBy: actorUser.id,
            creatorRole: actorUser.role,
            deadline: deadline ? new Date(deadline) : null,
            submissionLinks: submissionLinks || [],
            attachments: [],
            status: TASK_STATUS.ACTIVE,
          },
        ],
        { session: dbSession }
      );

      await notifications.dispatch({
        type: 'NEW_TASK',
        category: 'TASK',
        title: `New task: ${createdTask.title}`,
        message: `A new task was posted for ${subject.name}.`,
        createdBy: actorUser.id,
        relatedType: 'TASK',
        relatedId: createdTask._id,
        recipientUserIds,
        actorUserId: actorUser.id,
        actorRole: actorUser.role,
        dbSession,
      });

      return createdTask;
    });
    await audit.recordAudit({
      actorId: actorUser.id,
      actorRole: actorUser.role,
      action: 'TASK_CREATED',
      entityType: 'Task',
      entityId: task._id,
      after: { title: task.title, subjectId, deadline: task.deadline },
    });

    return task;
  }

  async function update({ actorUser, taskId, title, description, deadline, submissionLinks, attachments }) {
    const task = await Task.findById(taskId);
    if (!task || task.deletedAt) throw AppError.notFound('Task not found');
    const subject = await Subject.findById(task.subjectId);
    if (!subject) throw AppError.notFound('Subject not found for this task');

    await loadSubjectAndAssertManage(actorUser, subject);
    const oldDeadline = task.deadline;
    const nextDeadline = deadline !== undefined ? (deadline ? new Date(deadline) : null) : oldDeadline;
    const deadlineChanged = deadline !== undefined && String(oldDeadline || '') !== String(nextDeadline || '');
    const recipientUserIds = await notifications.computeTaskRecipients({ subject });

    await runTx(async (dbSession) => {
      if (title !== undefined) task.title = title.trim();
      if (description !== undefined) task.description = description;
      if (deadline !== undefined) task.deadline = nextDeadline;
      if (submissionLinks !== undefined) task.submissionLinks = submissionLinks;
      if (attachments !== undefined) task.attachments = attachments;
      await task.save({ session: dbSession });

      await notifications.dispatch({
        type: deadlineChanged ? 'DEADLINE_CHANGED' : 'TASK_UPDATED',
        category: 'TASK',
        title: `Task updated: ${task.title}`,
        message: deadlineChanged
          ? `Deadline changed${oldDeadline ? ` from ${oldDeadline.toISOString()}` : ''} to ${
              task.deadline ? task.deadline.toISOString() : 'no deadline'
            }.`
          : 'This task was updated.',
        createdBy: actorUser.id,
        relatedType: 'TASK',
        relatedId: task._id,
        recipientUserIds,
        actorUserId: actorUser.id,
        actorRole: actorUser.role,
        dbSession,
      });
    });

    await audit.recordAudit({
      actorId: actorUser.id,
      actorRole: actorUser.role,
      action: 'TASK_UPDATED',
      entityType: 'Task',
      entityId: task._id,
      before: { deadline: oldDeadline },
      after: { deadline: task.deadline },
    });

    return task;
  }

  async function remove({ actorUser, taskId }) {
    const task = await Task.findById(taskId);
    if (!task || task.deletedAt) throw AppError.notFound('Task not found');
    const subject = await Subject.findById(task.subjectId);
    if (!subject) throw AppError.notFound('Subject not found for this task');

    await loadSubjectAndAssertManage(actorUser, subject);

    const recipientUserIds = await notifications.computeTaskRecipients({ subject });

    await runTx(async (dbSession) => {
      task.deletedAt = new Date();
      await task.save({ session: dbSession });

      await notifications.dispatch({
        type: 'TASK_DELETED',
        category: 'TASK',
        title: `Task deleted: ${task.title}`,
        message: `This task was removed.`,
        createdBy: actorUser.id,
        relatedType: 'TASK',
        relatedId: task._id,
        recipientUserIds,
        actorUserId: actorUser.id,
        actorRole: actorUser.role,
        dbSession,
      });
    });

    await audit.recordAudit({
      actorId: actorUser.id,
      actorRole: actorUser.role,
      action: 'TASK_DELETED',
      entityType: 'Task',
      entityId: task._id,
    });

    return task;
  }

  async function list({ subjectId, status, createdBy } = {}) {
    const filter = { deletedAt: null };
    if (subjectId) filter.subjectId = subjectId;
    if (status) filter.status = status;
    if (createdBy) filter.createdBy = createdBy;
    return Task.find(filter).sort({ createdAt: -1 });
  }

  async function getById(taskId) {
    const task = await Task.findById(taskId);
    if (!task || task.deletedAt) throw AppError.notFound('Task not found');
    return task;
  }

  async function markDone({ actorUser, taskId }) {
    const student = await Student.findOne({ userId: actorUser.id });
    if (!student) throw AppError.forbidden('Only students can mark tasks as done');
    const task = await getById(taskId);

    const existing = await TaskCompletion.findOne({ taskId: task._id, studentId: student._id });
    if (existing) return existing;

    return TaskCompletion.create({ taskId: task._id, studentId: student._id });
  }

  async function unmarkDone({ actorUser, taskId }) {
    const student = await Student.findOne({ userId: actorUser.id });
    if (!student) throw AppError.forbidden('Only students can un-mark tasks as done');
    await TaskCompletion.deleteOne({ taskId, studentId: student._id });
    return { removed: true };
  }

  async function addAttachment({ actorUser, taskId, filename, mimeType, dataBase64 }) {
    if (!filename || !mimeType || !dataBase64) {
      throw AppError.badRequest('filename, mimeType, and dataBase64 are required');
    }
    if (!isPlausibleBase64(dataBase64)) {
      throw AppError.badRequest('dataBase64 is not valid base64 data', 'INVALID_FILE_DATA');
    }

    const task = await Task.findById(taskId);
    if (!task || task.deletedAt) throw AppError.notFound('Task not found');
    const subject = await Subject.findById(task.subjectId);
    if (!subject) throw AppError.notFound('Subject not found for this task');
    await loadSubjectAndAssertManage(actorUser, subject);
    if (!task.attachments) task.attachments = [];

    if (task.attachments.length >= maxAttachments) {
      throw AppError.badRequest(
        `A task may have at most ${maxAttachments} attachments`,
        'TOO_MANY_ATTACHMENTS'
      );
    }

    const safeFilename = sanitizeFilename(filename);
    const extension = getValidatedExtension(safeFilename, mimeType); 

    const buffer = Buffer.from(dataBase64, 'base64');
    if (buffer.length === 0) throw AppError.badRequest('Uploaded file is empty', 'EMPTY_FILE');
    if (buffer.length > maxAttachmentBytes) {
      throw AppError.badRequest(
        `File exceeds the maximum allowed attachment size (${Math.floor(maxAttachmentBytes / (1024 * 1024))}MB)`,
        'FILE_TOO_LARGE'
      );
    }

    const recipientUserIds = await notifications.computeTaskRecipients({ subject });
    const { storageKey } = await storage.save({ buffer, extension });

    try {
      await runTx(async (dbSession) => {
        task.attachments = [
          ...task.attachments,
          {
            filename: safeFilename,
            mimeType,
            size: buffer.length,
            url: `/api/tasks/${task._id}/attachments/${storageKey}`,
            storageKey,
            uploadedAt: new Date(),
          },
        ];
        await task.save({ session: dbSession });

        await notifications.dispatch({
          type: 'TASK_UPDATED',
          category: 'TASK',
          title: `Task updated: ${task.title}`,
          message: `A new attachment was added: ${safeFilename}.`,
          createdBy: actorUser.id,
          relatedType: 'TASK',
          relatedId: task._id,
          recipientUserIds,
          actorUserId: actorUser.id,
          actorRole: actorUser.role,
          dbSession,
        });
      });
    } catch (err) {
      await storage.remove({ storageKey }).catch((cleanupErr) => {
        console.error(`[TaskService] failed to roll back orphaned attachment file ${storageKey}:`, cleanupErr.message);
      });
      throw err;
    }

    await audit.recordAudit({
      actorId: actorUser.id,
      actorRole: actorUser.role,
      action: 'TASK_ATTACHMENT_ADDED',
      entityType: 'Task',
      entityId: task._id,
      after: { filename: safeFilename, mimeType, size: buffer.length },
    });

    return task;
  }

  async function removeAttachment({ actorUser, taskId, storageKey }) {
    const task = await Task.findById(taskId);
    if (!task || task.deletedAt) throw AppError.notFound('Task not found');
    const subject = await Subject.findById(task.subjectId);
    if (!subject) throw AppError.notFound('Subject not found for this task');

    await loadSubjectAndAssertManage(actorUser, subject);

    if (!task.attachments) task.attachments = [];
    const existing = task.attachments.find((a) => a.storageKey === storageKey);
    if (!existing) throw AppError.notFound('Attachment not found');

    const recipientUserIds = await notifications.computeTaskRecipients({ subject });

    await runTx(async (dbSession) => {
      task.attachments = task.attachments.filter((a) => a.storageKey !== storageKey);
      await task.save({ session: dbSession });

      await notifications.dispatch({
        type: 'TASK_UPDATED',
        category: 'TASK',
        title: `Task updated: ${task.title}`,
        message: `An attachment was removed: ${existing.filename}.`,
        createdBy: actorUser.id,
        relatedType: 'TASK',
        relatedId: task._id,
        recipientUserIds,
        actorUserId: actorUser.id,
        actorRole: actorUser.role,
        dbSession,
      });
    });
    await storage.remove({ storageKey: existing.storageKey }).catch((err) => {
      console.error(`[TaskService] failed to delete attachment file ${existing.storageKey}:`, err.message);
    });

    await audit.recordAudit({
      actorId: actorUser.id,
      actorRole: actorUser.role,
      action: 'TASK_ATTACHMENT_REMOVED',
      entityType: 'Task',
      entityId: task._id,
      before: { filename: existing.filename },
    });

    return task;
  }
  
  async function getAttachmentForDownload({ taskId, storageKey }) {
    const task = await getById(taskId);
    const attachment = (task.attachments || []).find((a) => a.storageKey === storageKey);
    if (!attachment) throw AppError.notFound('Attachment not found');
    const absolutePath = storage.resolvePathFor(storageKey);
    if (!(await storage.exists(storageKey))) throw AppError.notFound('Attachment not found');
    return { absolutePath, filename: attachment.filename, mimeType: attachment.mimeType };
  }

  return {
    create,
    update,
    remove,
    list,
    getById,
    markDone,
    unmarkDone,
    addAttachment,
    removeAttachment,
    getAttachmentForDownload,
  };
}

const defaultTaskService = createTaskService();

module.exports = { createTaskService, ...defaultTaskService };
