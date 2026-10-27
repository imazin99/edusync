const AppError = require('../utils/AppError');
function createRoomService({ models, auditService } = {}) {
  const resolvedModels = models || require('../models');
  const { Room } = resolvedModels;
  const audit = auditService || require('./AuditService');

  async function list({ isActive } = {}) {
    const filter = {};
    if (typeof isActive === 'boolean') filter.isActive = isActive;
    return Room.find(filter).sort({ building: 1, floor: 1, roomNumber: 1 });
  }

  async function getById(id) {
    const room = await Room.findById(id);
    if (!room) throw AppError.notFound('Room not found');
    return room;
  }

  async function create({ actorUser, building, floor, roomNumber }) {
    if (!building || floor === undefined || floor === null || floor === '' || !roomNumber) {
      throw AppError.badRequest('building, floor and roomNumber are required');
    }
    const floorStr = String(floor).trim();
    if (!floorStr) {
      throw AppError.badRequest('building, floor and roomNumber are required');
    }

    const existing = await Room.findOne({
      building: building.trim(),
      floor: floorStr,
      roomNumber: roomNumber.trim(),
    });
    if (existing) throw AppError.conflict('This room already exists');

    const room = await Room.create({
      building: building.trim(),
      floor: floorStr,
      roomNumber: roomNumber.trim(),
      isActive: true,
    });

    await audit.recordAudit({
      actorId: actorUser.id,
      actorRole: actorUser.role,
      action: 'ROOM_CREATED',
      entityType: 'Room',
      entityId: room._id,
      after: { building: room.building, floor: room.floor, roomNumber: room.roomNumber },
    });

    return room;
  }

  async function update({ actorUser, id, isActive }) {
    const room = await Room.findById(id);
    if (!room) throw AppError.notFound('Room not found');

    const before = { isActive: room.isActive };
    if (isActive !== undefined) room.isActive = !!isActive;
    await room.save();

    await audit.recordAudit({
      actorId: actorUser.id,
      actorRole: actorUser.role,
      action: 'ROOM_UPDATED',
      entityType: 'Room',
      entityId: room._id,
      before,
      after: { isActive: room.isActive },
    });

    return room;
  }

  return { list, getById, create, update };
}

const defaultRoomService = createRoomService();

module.exports = { createRoomService, ...defaultRoomService };
