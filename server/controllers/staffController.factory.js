const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { isValidObjectId } = require('../utils/validateObjectId');

function createStaffController(service) {
  const list = asyncHandler(async (req, res) => {
    const { search, isActive } = req.query;
    const items = await service.list({
      search,
      isActive: isActive === undefined ? undefined : isActive === 'true',
    });
    res.status(200).json({ success: true, items });
  });

  const getOne = asyncHandler(async (req, res) => {
    if (!isValidObjectId(req.params.id)) {
      throw AppError.badRequest('id is not a valid id', 'INVALID_STAFF_ID');
    }
    const item = await service.getById(req.params.id);
    res.status(200).json({ success: true, item });
  });

  const create = asyncHandler(async (req, res) => {
    const { username, fullName, password } = req.body || {};
    const item = await service.create({ actorUser: req.user, username, fullName, password });
    res.status(201).json({ success: true, item });
  });

  const update = asyncHandler(async (req, res) => {
    if (!isValidObjectId(req.params.id)) {
      throw AppError.badRequest('id is not a valid id', 'INVALID_STAFF_ID');
    }
    const { fullName, isActive } = req.body || {};
    const item = await service.update({ actorUser: req.user, id: req.params.id, fullName, isActive });
    res.status(200).json({ success: true, item });
  });

  return { list, getOne, create, update };
}

module.exports = { createStaffController };
