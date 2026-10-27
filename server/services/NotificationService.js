const AppError = require('../utils/AppError');
const { ROLES, GROUPS } = require('../utils/constants');

function createNotificationService({ models } = {}) {
  const resolvedModels = models || require('../models');
  const { Notification, NotificationRecipient, User, Student, Leader, Doctor, TA } = resolvedModels;

  async function activeAdminUserIds() {
    const admins = await User.find({ role: ROLES.ADMIN, isActive: true });
    return admins.map((u) => u._id);
  }

  async function activeLeaderUserIds() {
    const leaders = await Leader.find({ isActive: true });
    return leaders.map((l) => l.userId);
  }

  async function activeStudentUserIds({ group } = {}) {
    const filter = { isActive: true };
    if (group && group !== GROUPS.ALL) filter.group = group;
    const students = await Student.find(filter);
    return students.map((s) => s.userId);
  }

  async function subjectStaffUserIds(subject) {
    const ids = [];
    if (subject.doctorId) {
      const doctor = await Doctor.findById(subject.doctorId);
      if (doctor) ids.push(doctor.userId);
    }
    if (subject.taId) {
      const ta = await TA.findById(subject.taId);
      if (ta) ids.push(ta.userId);
    }
    return ids;
  }

  async function computeScheduleChangeRecipients({ session, subject }) {
    const [students, staff, leaders, admins] = await Promise.all([
      activeStudentUserIds({ group: session.group }),
      subjectStaffUserIds(subject),
      activeLeaderUserIds(),
      activeAdminUserIds(),
    ]);
    return [...students, ...staff, ...leaders, ...admins];
  }

  async function computeTaskRecipients({ subject }) {
    const [students, staff, leaders, admins] = await Promise.all([
      activeStudentUserIds(),
      subjectStaffUserIds(subject),
      activeLeaderUserIds(),
      activeAdminUserIds(),
    ]);
    return [...students, ...staff, ...leaders, ...admins];
  }

  const BROADCAST_AUDIENCES = ['STUDENTS', 'DOCTORS', 'TAS', 'LEADERS', 'EVERYONE'];
  async function computeBroadcastRecipients({ audience }) {
    if (!BROADCAST_AUDIENCES.includes(audience)) {
      throw AppError.badRequest(`audience must be one of ${BROADCAST_AUDIENCES.join(', ')}`);
    }

    const wantStudents = audience === 'STUDENTS' || audience === 'EVERYONE';
    const wantDoctors = audience === 'DOCTORS' || audience === 'EVERYONE';
    const wantTAs = audience === 'TAS' || audience === 'EVERYONE';
    const wantLeaders = audience === 'LEADERS' || audience === 'EVERYONE';

    const [students, doctors, tas, leaders, admins] = await Promise.all([
      wantStudents ? activeStudentUserIds() : [],
      wantDoctors ? User.find({ role: ROLES.DOCTOR, isActive: true }) : [],
      wantTAs ? User.find({ role: ROLES.TA, isActive: true }) : [],
      wantLeaders ? activeLeaderUserIds() : [],
      activeAdminUserIds(), 
    ]);

    return [...students, ...doctors.map((u) => u._id), ...tas.map((u) => u._id), ...leaders, ...admins];
  }

  async function broadcast({ actorUser, audience, title, message }) {
    if (!title || !message) throw AppError.badRequest('title and message are required');
    const recipientUserIds = await computeBroadcastRecipients({ audience });
    return dispatch({
      type: 'BROADCAST',
      category: 'SCHEDULE',
      title,
      message,
      createdBy: actorUser.id,
      relatedType: 'BROADCAST',
      relatedId: null,
      recipientUserIds,
    });
  }
  async function dispatch({
    type,
    category,
    title,
    message,
    createdBy,
    relatedType,
    relatedId,
    recipientUserIds,
    actorUserId,
    actorRole,
    dbSession,
  }) {
  
    const createOptions = dbSession ? { session: dbSession, ordered: true } : undefined;

    const [notification] = await Notification.create(
      [
        {
          type,
          category,
          title,
          message,
          createdBy: createdBy || null,
          relatedType,
          relatedId: relatedId || null,
        },
      ],
      createOptions
    );

    const excludeActor = !!actorUserId && actorRole !== ROLES.ADMIN;

    const uniqueRecipients = [
      ...new Set(
        recipientUserIds
          .filter(Boolean)
          .map((id) => id.toString())
          .filter((id) => !excludeActor || id !== actorUserId.toString())
      ),
    ];

    if (uniqueRecipients.length > 0) {
      await NotificationRecipient.create(
        uniqueRecipients.map((userId) => ({ notificationId: notification._id, userId })),
        createOptions
      );
    }

    return notification;
  }

  async function listForUser({ userId, unreadOnly = false }) {
    const filter = { userId };
    if (unreadOnly) filter.readAt = null;
    const recipients = await NotificationRecipient.find(filter).sort({ createdAt: -1 });
    const notificationIds = recipients.map((r) => r.notificationId);
    const notifications = await Notification.find({ _id: { $in: notificationIds } });
    const byId = new Map(notifications.map((n) => [n._id.toString(), n]));

    return recipients.map((r) => ({
      recipientId: r._id,
      readAt: r.readAt,
      notification: byId.get(r.notificationId.toString()),
    }));
  }

  async function markRead({ userId, recipientId }) {
    const recipient = await NotificationRecipient.findById(recipientId);
    if (!recipient || recipient.userId.toString() !== userId.toString()) {
      throw AppError.notFound('Notification not found');
    }
    recipient.readAt = new Date();
    await recipient.save();
    return recipient;
  }

  async function markAllRead({ userId }) {
    const unread = await NotificationRecipient.find({ userId, readAt: null });
    await Promise.all(
      unread.map((r) => {
        r.readAt = new Date();
        return r.save();
      })
    );
    return { updated: unread.length };
  }

  return {
    computeScheduleChangeRecipients,
    computeTaskRecipients,
    computeBroadcastRecipients,
    broadcast,
    dispatch,
    listForUser,
    markRead,
    markAllRead,
  };
}

const defaultNotificationService = createNotificationService();

module.exports = { createNotificationService, ...defaultNotificationService };
