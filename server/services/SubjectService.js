const AppError = require('../utils/AppError');

function createSubjectService({ models, auditService } = {}) {
  const resolvedModels = models || require('../models');
  const { Subject, Doctor, TA } = resolvedModels;
  const audit = auditService || require('./AuditService');

  async function list({ isActive } = {}) {
    const filter = {};
    if (typeof isActive === 'boolean') filter.isActive = isActive;
    return Subject.find(filter).sort({ name: 1 });
  }

  async function getById(id) {
    const subject = await Subject.findById(id);
    if (!subject) throw AppError.notFound('Subject not found');
    return subject;
  }

  async function validateDoctorAndTA(doctorId, taId) {
    if (doctorId) {
      const doctor = await Doctor.findById(doctorId);
      if (!doctor) throw AppError.badRequest('doctorId does not reference an existing Doctor');
    }
    if (taId) {
      const ta = await TA.findById(taId);
      if (!ta) throw AppError.badRequest('taId does not reference an existing TA');
    }
  }

  async function create({ actorUser, name, code, doctorId, taId, hasSections }) {
    if (!name || !code || !doctorId) {
      throw AppError.badRequest('name, code and doctorId are required');
    }
    await validateDoctorAndTA(doctorId, taId);

    const existing = await Subject.findOne({ code: code.trim().toUpperCase() });
    if (existing) throw AppError.conflict('A subject with this code already exists');

    const subject = await Subject.create({
      name: name.trim(),
      code: code.trim(),
      doctorId,
      taId: taId || null,
      hasSections: !!hasSections,
      isActive: true,
    });

    await audit.recordAudit({
      actorId: actorUser.id,
      actorRole: actorUser.role,
      action: 'SUBJECT_CREATED',
      entityType: 'Subject',
      entityId: subject._id,
      after: { name: subject.name, code: subject.code, doctorId, taId: taId || null },
    });

    return subject;
  }

  async function update({ actorUser, id, name, doctorId, taId, hasSections, isActive }) {
    const subject = await Subject.findById(id);
    if (!subject) throw AppError.notFound('Subject not found');

    await validateDoctorAndTA(doctorId, taId);

    const before = {
      name: subject.name,
      doctorId: subject.doctorId,
      taId: subject.taId,
      hasSections: subject.hasSections,
      isActive: subject.isActive,
    };

    if (name !== undefined) subject.name = name.trim();
    if (doctorId !== undefined) subject.doctorId = doctorId;
    if (taId !== undefined) subject.taId = taId || null;
    if (hasSections !== undefined) subject.hasSections = !!hasSections;
    if (isActive !== undefined) subject.isActive = !!isActive;
    await subject.save();

    await audit.recordAudit({
      actorId: actorUser.id,
      actorRole: actorUser.role,
      action: 'SUBJECT_UPDATED',
      entityType: 'Subject',
      entityId: subject._id,
      before,
      after: {
        name: subject.name,
        doctorId: subject.doctorId,
        taId: subject.taId,
        hasSections: subject.hasSections,
        isActive: subject.isActive,
      },
    });

    return subject;
  }

  return { list, getById, create, update };
}

const defaultSubjectService = createSubjectService();

module.exports = { createSubjectService, ...defaultSubjectService };
