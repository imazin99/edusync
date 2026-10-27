const AppError = require('../utils/AppError');
const { ROLES, LEADER_SLOT_VALUES } = require('../utils/constants');
const { hashPassword } = require('../utils/password');
function createLeaderService({ models, auditService } = {}) {
  const resolvedModels = models || require('../models');
  const { User, Student, Leader } = resolvedModels;
  const audit = auditService || require('./AuditService');

  async function list({ isActive } = {}) {
    const filter = {};
    if (typeof isActive === 'boolean') filter.isActive = isActive;
    return Leader.find(filter);
  }

  async function getById(id) {
    const leader = await Leader.findById(id);
    if (!leader) throw AppError.notFound('Leader not found');
    return leader;
  }

  async function create({ actorUser, slot, linkedStudentId, username, password }) {
    if (!slot || !LEADER_SLOT_VALUES.includes(slot)) {
      throw AppError.badRequest('slot must be MALE or FEMALE');
    }
    if (!linkedStudentId || !username || !password) {
      throw AppError.badRequest('linkedStudentId, username and password are required');
    }

    const student = await Student.findById(linkedStudentId);
    if (!student) throw AppError.badRequest('linkedStudentId does not reference an existing Student');

    const activeInSlot = await Leader.findOne({ slot, isActive: true });
    if (activeInSlot) {
      throw AppError.conflict(
        `There is already an active ${slot} Leader. Deactivate them first before assigning a replacement.`,
        'LEADER_SLOT_TAKEN'
      );
    }

    const existingUser = await User.findOne({ username: username.trim() });
    if (existingUser) throw AppError.conflict('A user with this username already exists');

    const user = await User.create({
      username: username.trim(),
      passwordHash: await hashPassword(password),
      role: ROLES.LEADER,
      isActive: true,
    });

    let leader;
    try {
      leader = await Leader.create({
        slot,
        isActive: true,
        userId: user._id,
        linkedStudentId: student._id,
      });
    } catch (err) {
      if (err && err.code === 11000) {
        throw AppError.conflict(
          `There is already an active ${slot} Leader. Deactivate them first before assigning a replacement.`,
          'LEADER_SLOT_TAKEN'
        );
      }
      throw err;
    }

    await audit.recordAudit({
      actorId: actorUser.id,
      actorRole: actorUser.role,
      action: 'LEADER_CREATED',
      entityType: 'Leader',
      entityId: leader._id,
      after: { slot: leader.slot, linkedStudentId: leader.linkedStudentId },
    });

    return leader;
  }

  async function setActive({ actorUser, id, isActive }) {
    const leader = await Leader.findById(id);
    if (!leader) throw AppError.notFound('Leader not found');

    const before = { isActive: leader.isActive };
    leader.isActive = !!isActive;
    await leader.save();

    await audit.recordAudit({
      actorId: actorUser.id,
      actorRole: actorUser.role,
      action: isActive ? 'LEADER_ACTIVATED' : 'LEADER_DEACTIVATED',
      entityType: 'Leader',
      entityId: leader._id,
      before,
      after: { isActive: leader.isActive },
    });

    return leader;
  }

  return { list, getById, create, setActive };
}

const defaultLeaderService = createLeaderService();

module.exports = { createLeaderService, ...defaultLeaderService };
