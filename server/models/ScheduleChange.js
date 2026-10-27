const mongoose = require('mongoose');
const { ROLE_VALUES, CHANGE_TYPE_VALUES } = require('../utils/constants');
const scheduleChangeSchema = new mongoose.Schema(
  {
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ScheduleSession',
      required: [true, 'sessionId is required'],
    },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'changedBy is required'],
    },
    changedByRole: {
      type: String,
      required: [true, 'changedByRole is required'],
      enum: ROLE_VALUES,
    },
    changeTypes: {
      type: [{ type: String, enum: CHANGE_TYPE_VALUES }],
      required: true,
      validate: {
        validator: (arr) => Array.isArray(arr) && arr.length > 0,
        message: 'changeTypes must contain at least one change type',
      },
    },
    before: {
      type: mongoose.Schema.Types.Mixed,
      required: [true, 'before snapshot is required'],
    },
    after: {
      type: mongoose.Schema.Types.Mixed,
      required: [true, 'after snapshot is required'],
    },
    reason: {
      type: String,
      default: null,
      maxlength: 500,
    },
    isPermanent: {
      type: Boolean,
      required: true,
      default: false,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

scheduleChangeSchema.index({ sessionId: 1, createdAt: 1 });
scheduleChangeSchema.index({ changedBy: 1 });
scheduleChangeSchema.index({ createdAt: -1 });
scheduleChangeSchema.index({ isPermanent: 1 });

module.exports = mongoose.model('ScheduleChange', scheduleChangeSchema);
