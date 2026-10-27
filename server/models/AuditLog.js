const mongoose = require('mongoose');
const { ROLE_VALUES } = require('../utils/constants');

const auditLogSchema = new mongoose.Schema(
  {
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'actorId is required'],
    },
    actorRole: {
      type: String,
      required: [true, 'actorRole is required'],
      enum: ROLE_VALUES,
    },
    action: {
      type: String,
      required: [true, 'action is required'],
      trim: true,
      maxlength: 100,
    },
    entityType: {
      type: String,
      required: [true, 'entityType is required'],
      trim: true,
      maxlength: 100,
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      required: [true, 'entityId is required'],
    },
    before: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    after: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditLogSchema.index({ actorId: 1 });
auditLogSchema.index({ entityType: 1, entityId: 1 });
auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ action: 1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
