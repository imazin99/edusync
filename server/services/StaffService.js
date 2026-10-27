const AppError = require('../utils/AppError');
const { hashPassword } = require('../utils/password');

function createStaffService({ models, auditService, role, ProfileModelName } = {}) {
  const resolvedModels = models || require('../models');
  const { User } = resolvedModels;
  const ProfileModel = resolvedModels[ProfileModelName];
  const audit = auditService || require('./AuditService');

  async function list({ search, isActive } = {}) {
    const filter = {};
    if (typeof isActive === 'boolean') filter.isActive = isActive;
    if (search) filter.fullName = new RegExp(search.trim(), 'i');
    return ProfileModel.find(filter).sort({ fullName: 1 });
  }

  async function getById(id) {
    const profile = await ProfileModel.findById(id);
    if (!profile) throw AppError.notFound(`${role} not found`);
    return profile;
  }

  async function create({ actorUser, username, fullName, password }) {
    if (!username || !fullName || !password) {
      throw AppError.badRequest('username, fullName and password are required');
    }
    const existing = await User.findOne({ username: username.trim() });
    if (existing) throw AppError.conflict('A user with this username already exists');

    const user = await User.create({
      username: username.trim(),
      passwordHash: await hashPassword(password),
      role,
      isActive: true,
    });
    const profile = await ProfileModel.create({
      fullName: fullName.trim(),
      isActive: true,
      userId: user._id,
    });

    await audit.recordAudit({
      actorId: actorUser.id,
      actorRole: actorUser.role,
      action: `${role}_CREATED`,
      entityType: role,
      entityId: profile._id,
      after: { fullName: profile.fullName },
    });

    return profile;
  }

  async function update({ actorUser, id, fullName, isActive }) {
    const profile = await ProfileModel.findById(id);
    if (!profile) throw AppError.notFound(`${role} not found`);

    const before = { fullName: profile.fullName, isActive: profile.isActive };
    if (fullName !== undefined) profile.fullName = fullName.trim();
    if (isActive !== undefined) profile.isActive = !!isActive;
    await profile.save();

    await audit.recordAudit({
      actorId: actorUser.id,
      actorRole: actorUser.role,
      action: `${role}_UPDATED`,
      entityType: role,
      entityId: profile._id,
      before,
      after: { fullName: profile.fullName, isActive: profile.isActive },
    });

    return profile;
  }

  return { list, getById, create, update };
}

module.exports = { createStaffService };
