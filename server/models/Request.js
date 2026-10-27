const mongoose = require('mongoose');
const { REQUEST_TYPE_VALUES, REQUEST_STATUS_VALUES, REQUEST_STATUS } = require('../utils/constants');
const requestSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: [true, 'type is required'],
      enum: REQUEST_TYPE_VALUES,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'userId is required'],
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    status: {
      type: String,
      enum: REQUEST_STATUS_VALUES,
      default: REQUEST_STATUS.PENDING,
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

requestSchema.index({ userId: 1 });
requestSchema.index({ status: 1 });
requestSchema.index({ type: 1, status: 1 });
requestSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Request', requestSchema);
