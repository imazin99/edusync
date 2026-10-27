const AppError = require('../utils/AppError');
const { ROLES, STUDENT_GROUP_VALUES } = require('../utils/constants');
const { hashPassword } = require('../utils/password');

function createStudentService({ models, auditService } = {}) {
  const resolvedModels = models || require('../models');
  const { User, Student } = resolvedModels;
  const audit = auditService || require('./AuditService');

  async function list({ search, group, isActive } = {}) {
    const filter = {};
    if (group) filter.group = group;
    if (typeof isActive === 'boolean') filter.isActive = isActive;
    if (search) {
      const re = new RegExp(search.trim(), 'i');
      filter.$or = [{ studentCode: re }, { fullName: re }];
    }
    return Student.find(filter).sort({ fullName: 1 });
  }

  async function getById(id) {
    const student = await Student.findById(id);
    if (!student) throw AppError.notFound('Student not found');
    return student;
  }

  async function create({ actorUser, studentCode, fullName, group, password }) {
    if (!studentCode || !fullName || !group) {
      throw AppError.badRequest('studentCode, fullName and group are required');
    }
    if (!STUDENT_GROUP_VALUES.includes(group)) {
      throw AppError.badRequest('group must be G1 or G2');
    }

    const existing = await User.findOne({ username: studentCode.trim() });
    if (existing) throw AppError.conflict('A user with this Student Code already exists');

    const passwordHash = password ? await hashPassword(password) : null;
    const user = await User.create({
      username: studentCode.trim(),
      passwordHash,
      role: ROLES.STUDENT,
      isActive: true,
    });
    const student = await Student.create({
      studentCode: studentCode.trim(),
      fullName: fullName.trim(),
      group,
      isActive: true,
      userId: user._id,
    });

    await audit.recordAudit({
      actorId: actorUser.id,
      actorRole: actorUser.role,
      action: 'STUDENT_CREATED',
      entityType: 'Student',
      entityId: student._id,
      after: { studentCode: student.studentCode, fullName: student.fullName, group: student.group },
    });

    return student;
  }

  async function update({ actorUser, id, fullName, group, isActive, studentCode }) {
    const student = await Student.findById(id);
    if (!student) throw AppError.notFound('Student not found');

    const before = {
      studentCode: student.studentCode,
      fullName: student.fullName,
      group: student.group,
      isActive: student.isActive,
    };

    if (group !== undefined) {
      if (!STUDENT_GROUP_VALUES.includes(group)) {
        throw AppError.badRequest('group must be G1 or G2');
      }
      student.group = group;
    }
    if (fullName !== undefined) student.fullName = fullName.trim();
    if (isActive !== undefined) student.isActive = !!isActive;

    if (studentCode !== undefined && studentCode.trim() !== student.studentCode) {
      const trimmed = studentCode.trim();
      const clash = await User.findOne({ username: trimmed });
      if (clash) throw AppError.conflict('A user with this Student Code already exists');
      const user = await User.findById(student.userId);
      if (user) {
        user.username = trimmed;
        await user.save();
      }
      student.studentCode = trimmed;
    }

    await student.save();

    await audit.recordAudit({
      actorId: actorUser.id,
      actorRole: actorUser.role,
      action: 'STUDENT_UPDATED',
      entityType: 'Student',
      entityId: student._id,
      before,
      after: {
        studentCode: student.studentCode,
        fullName: student.fullName,
        group: student.group,
        isActive: student.isActive,
      },
    });

    return student;
  }

  return { list, getById, create, update };
}

const defaultStudentService = createStudentService();

module.exports = { createStudentService, ...defaultStudentService };
