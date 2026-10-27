const asyncHandler = require('../utils/asyncHandler');
const requestService = require('../services/RequestService');
const createGroupChange = asyncHandler(async (req, res) => {
  const { requestedGroup } = req.body || {};
  const request = await requestService.createGroupChangeRequest({
    actorUser: req.user,
    requestedGroup,
  });
  res.status(201).json({ success: true, request });
});

module.exports = { createGroupChange };
