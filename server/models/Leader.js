const mongoose = require('mongoose');
const { LEADER_SLOT_VALUES } = require('../utils/constants');
const leaderSchema = new mongoose.Schema(
  {
    slot: {
      type: String,
      required: [true, 'slot is required'],
      enum: LEADER_SLOT_VALUES,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'userId is required'],
      unique: true,
    },
    linkedStudentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Student',
      required: [true, 'linkedStudentId is required'],
    },
  },
  { timestamps: true }
);
leaderSchema.index({ linkedStudentId: 1 });
leaderSchema.index(
  { slot: 1 },
  { unique: true, partialFilterExpression: { isActive: true } }
);

module.exports = mongoose.model('Leader', leaderSchema);
