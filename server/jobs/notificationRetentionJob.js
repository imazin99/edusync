function createNotificationRetentionJob({ models, runInTransaction } = {}) {
  const resolvedModels = models || require('../models');
  const { Notification, NotificationRecipient, SystemSettings } = resolvedModels;
  const runTx = runInTransaction || require('../utils/transaction').runInTransaction;
  async function run({ now = new Date() } = {}) {
    const settings = await SystemSettings.getSingleton();
    const retentionDays = settings.notificationRetentionDays;
    if (typeof retentionDays !== 'number' || !Number.isFinite(retentionDays) || retentionDays < 1) {
      throw new Error(`Invalid notificationRetentionDays in SystemSettings: ${retentionDays}`);
    }

    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

    const expired = await Notification.find({ createdAt: { $lte: cutoff } });

    const summary = { checked: expired.length, deleted: 0, failed: 0 };

    for (const notification of expired) {
      try {
        const removed = await runTx(async (dbSession) => {
          await NotificationRecipient.deleteMany(
            { notificationId: notification._id },
            { session: dbSession }
          );
          const result = await Notification.deleteOne(
            { _id: notification._id },
            { session: dbSession }
          );
          return result.deletedCount === 1;
        });

        if (removed) summary.deleted += 1;
      } catch (err) {
        summary.failed += 1;
        console.error(
          `[notificationRetentionJob] failed deleting notification ${notification._id}:`,
          err.message
        );
      }
    }

    return summary;
  }

  return { run };
}

const defaultNotificationRetentionJob = createNotificationRetentionJob();

module.exports = { createNotificationRetentionJob, ...defaultNotificationRetentionJob };

if (require.main === module) {
  const { connectDatabase, disconnectDatabase } = require('../config/database');

  (async () => {
    try {
      await connectDatabase();
      const summary = await defaultNotificationRetentionJob.run();
      console.log('[notificationRetentionJob] run summary:', summary);
      process.exitCode = 0;
    } catch (err) {
      console.error('[notificationRetentionJob] run failed:', err);
      process.exitCode = 1;
    } finally {
      await disconnectDatabase();
    }
  })();
}
