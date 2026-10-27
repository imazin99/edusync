const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { isValidObjectId } = require('../utils/validateObjectId');
const studentService = require('../services/StudentService');

const list = asyncHandler(async (req, res) => {
  const { search, group, isActive } = req.query;
  const students = await studentService.list({
    search,
    group,
    isActive: isActive === undefined ? undefined : isActive === 'true',
  });
  res.status(200).json({ success: true, students });
});

const getOne = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    throw AppError.badRequest('id is not a valid id', 'INVALID_STUDENT_ID');
  }
  const student = await studentService.getById(req.params.id);
  res.status(200).json({ success: true, student });
});

const create = asyncHandler(async (req, res) => {
  const { studentCode, fullName, group, password } = req.body || {};
  const student = await studentService.create({
    actorUser: req.user,
    studentCode,
    fullName,
    group,
    password,
  });
  res.status(201).json({ success: true, student });
});

const update = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    throw AppError.badRequest('id is not a valid id', 'INVALID_STUDENT_ID');
  }
  const { studentCode, fullName, group, isActive } = req.body || {};
  const student = await studentService.update({
    actorUser: req.user,
    id: req.params.id,
    studentCode,
    fullName,
    group,
    isActive,
  });
  res.status(200).json({ success: true, student });
});

module.exports = { list, getOne, create, update };
