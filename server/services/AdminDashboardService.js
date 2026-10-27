const { REQUEST_STATUS } = require('../utils/constants');
const RECENT_LIMIT = 10;

function createAdminDashboardService({ models, taskService, requestService } = {}) {
  const resolvedModels = models || require('../models');
  const { Student, Doctor, TA, Subject, Task, Request, ScheduleChange, AuditLog } = resolvedModels;
  const tasks = taskService || require('./TaskService');
  const requests = requestService || require('./RequestService');

  async function getDashboard() {
    const [
      studentsCount,
      subjectsCount,
      doctorsCount,
      tasCount,
      activeTasksCount,
      pendingRequestsCount,
      recentScheduleChanges,
      recentTasks,
      recentRequests,
      recentActivity,
    ] = await Promise.all([
      Student.countDocuments({}),
      Subject.countDocuments({}),
      Doctor.countDocuments({}),
      TA.countDocuments({}),
      Task.countDocuments({ deletedAt: null }),
      Request.countDocuments({ status: REQUEST_STATUS.PENDING }),
      ScheduleChange.find({})
        .sort({ createdAt: -1 })
        .limit(RECENT_LIMIT)
        .select('_id sessionId changeTypes isPermanent changedBy changedByRole createdAt'),
      tasks.list({}).then((all) => all.slice(0, RECENT_LIMIT)),
      requests.list({}).then((all) => all.slice(0, RECENT_LIMIT)),
      AuditLog.find({})
        .sort({ createdAt: -1 })
        .limit(RECENT_LIMIT)
        .select('_id actorId actorRole action entityType entityId createdAt'),
    ]);

    return {
      counts: {
        students: studentsCount,
        subjects: subjectsCount,
        doctors: doctorsCount,
        tas: tasCount,
        activeTasks: activeTasksCount,
        pendingRequests: pendingRequestsCount,
      },
      recent: {
        scheduleChanges: recentScheduleChanges.map((c) => ({
          _id: c._id,
          sessionId: c.sessionId,
          changeTypes: c.changeTypes,
          isPermanent: c.isPermanent,
          changedBy: c.changedBy,
          changedByRole: c.changedByRole,
          createdAt: c.createdAt,
        })),
        tasks: recentTasks.map((t) => ({
          _id: t._id,
          title: t.title,
          subjectId: t.subjectId,
          status: t.status,
          deadline: t.deadline,
          createdAt: t.createdAt,
        })),
        requests: recentRequests.map((r) => ({
          _id: r._id,
          type: r.type,
          status: r.status,
          userId: r.userId,
          createdAt: r.createdAt,
        })),
        activity: recentActivity.map((a) => ({
          _id: a._id,
          actorId: a.actorId,
          actorRole: a.actorRole,
          action: a.action,
          entityType: a.entityType,
          entityId: a.entityId,
          createdAt: a.createdAt,
        })),
      },
    };
  }

  return { getDashboard };
}

const defaultAdminDashboardService = createAdminDashboardService();

module.exports = { createAdminDashboardService, ...defaultAdminDashboardService };
