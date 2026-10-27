const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { isValidObjectId } = require('../utils/validateObjectId');
const roomService = require('../services/RoomService');

const list = asyncHandler(async (req, res) => {
  const { isActive } = req.query;
  const rooms = await roomService.list({
    isActive: isActive === undefined ? undefined : isActive === 'true',
  });
  res.status(200).json({ success: true, rooms });
});

const getOne = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    throw AppError.badRequest('id is not a valid id', 'INVALID_ROOM_ID');
  }
  const room = await roomService.getById(req.params.id);
  res.status(200).json({ success: true, room });
});

const create = asyncHandler(async (req, res) => {
  const { building, floor, roomNumber } = req.body || {};
  const room = await roomService.create({ actorUser: req.user, building, floor, roomNumber });
  res.status(201).json({ success: true, room });
});

const update = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    throw AppError.badRequest('id is not a valid id', 'INVALID_ROOM_ID');
  }
  const { isActive } = req.body || {};
  const room = await roomService.update({ actorUser: req.user, id: req.params.id, isActive });
  res.status(200).json({ success: true, room });
});

module.exports = { list, getOne, create, update };
