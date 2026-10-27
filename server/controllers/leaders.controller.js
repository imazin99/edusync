const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { isValidObjectId } = require('../utils/validateObjectId');
const leaderService = require('../services/LeaderService');

const list = asyncHandler(async (req, res) => {
  const { isActive } = req.query;
  const leaders = await leaderService.list({
    isActive: isActive === undefined ? undefined : isActive === 'true',
  });
  res.status(200).json({ success: true, leaders });
});

const getOne = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    throw AppError.badRequest('id is not a valid id', 'INVALID_LEADER_ID');
  }
  const leader = await leaderService.getById(req.params.id);
  res.status(200).json({ success: true, leader });
});

const create = asyncHandler(async (req, res) => {
  const { slot, linkedStudentId, username, password } = req.body || {};
  const leader = await leaderService.create({
    actorUser: req.user,
    slot,
    linkedStudentId,
    username,
    password,
  });
  res.status(201).json({ success: true, leader });
});

const setActive = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    throw AppError.badRequest('id is not a valid id', 'INVALID_LEADER_ID');
  }
  const { isActive } = req.body || {};
  const leader = await leaderService.setActive({ actorUser: req.user, id: req.params.id, isActive });
  res.status(200).json({ success: true, leader });
});

module.exports = { list, getOne, create, setActive };
