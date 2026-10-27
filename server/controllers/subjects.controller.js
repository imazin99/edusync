const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { isValidObjectId } = require('../utils/validateObjectId');
const subjectService = require('../services/SubjectService');

const list = asyncHandler(async (req, res) => {
  const { isActive } = req.query;
  const subjects = await subjectService.list({
    isActive: isActive === undefined ? undefined : isActive === 'true',
  });
  res.status(200).json({ success: true, subjects });
});

const getOne = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    throw AppError.badRequest('id is not a valid id', 'INVALID_SUBJECT_ID');
  }
  const subject = await subjectService.getById(req.params.id);
  res.status(200).json({ success: true, subject });
});

const create = asyncHandler(async (req, res) => {
  const { name, code, doctorId, taId, hasSections } = req.body || {};
  const subject = await subjectService.create({
    actorUser: req.user,
    name,
    code,
    doctorId,
    taId,
    hasSections,
  });
  res.status(201).json({ success: true, subject });
});

const update = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    throw AppError.badRequest('id is not a valid id', 'INVALID_SUBJECT_ID');
  }
  const { name, doctorId, taId, hasSections, isActive } = req.body || {};
  const subject = await subjectService.update({
    actorUser: req.user,
    id: req.params.id,
    name,
    doctorId,
    taId,
    hasSections,
    isActive,
  });
  res.status(200).json({ success: true, subject });
});

module.exports = { list, getOne, create, update };
