const { TASK_STATUS, NOTIFICATION_RELATED_TYPES, NOTIFICATION_CATEGORIES } = require('../utils/constants');
function createTaskDeadlineJob({ models, notificationService, runInTransaction } = {}) {
  const resolvedModels = models || require('../models');
  const { Task, Subject } = resolvedModels;
  const notifications = notificationService || require('../services/NotificationService');
  const runTx = runInTransaction || require('../utils/transaction').runInTransaction;

  async function run({ now = new Date() } = {}) {
    const candidates = await Task.find({
      deadline: { $ne: null, $lte: now },
      status: { $ne: TASK_STATUS.OVERDUE },
      deletedAt: null,
    });

    const summary = { checked: candidates.length, markedOverdue: 0, alreadyHandled: 0, failed: 0 };

    for (const task of candidates) {
      try {
        const claimed = await runTx(async (dbSession) => {
          const claim = await Task.updateOne(
            { _id: task._id, status: { $ne: TASK_STATUS.OVERDUE }, deletedAt: null },
            { $set: { status: TASK_STATUS.OVERDUE } },
            { session: dbSession }
          );
          if (claim.modifiedCount !== 1) return false;

          const subject = await Subject.findById(task.subjectId);
          if (!subject) {
            throw new Error(`Task ${task._id} references a missing Subject ${task.subjectId}`);
          }

          const recipientUserIds = await notifications.computeTaskRecipients({ subject });
          await notifications.dispatch({
            type: 'DEADLINE_PASSED',
            category: NOTIFICATION_CATEGORIES.TASK,
            title: `Task deadline passed: ${task.title}`,
            message: `The deadline for "${task.title}" has passed.`,
            createdBy: null, 
            relatedType: NOTIFICATION_RELATED_TYPES.TASK,
            relatedId: task._id,
            recipientUserIds,
            dbSession,
          });

          return true;
        });

        if (claimed) summary.markedOverdue += 1;
        else summary.alreadyHandled += 1;
      } catch (err) {
        summary.failed += 1;
        console.error(`[taskDeadlineJob] failed processing task ${task._id}:`, err.message);
      }
    }

    return summary;
  }

  return { run };
}

const defaultTaskDeadlineJob = createTaskDeadlineJob();

module.exports = { createTaskDeadlineJob, ...defaultTaskDeadlineJob };
if (require.main === module) {
  const { connectDatabase, disconnectDatabase } = require('../config/database');

  (async () => {
    try {
      await connectDatabase();
      const summary = await defaultTaskDeadlineJob.run();
      console.log('[taskDeadlineJob] run summary:', summary);
      process.exitCode = 0;
    } catch (err) {
      console.error('[taskDeadlineJob] run failed:', err);
      process.exitCode = 1;
    } finally {
      await disconnectDatabase();
    }
  })();
}
