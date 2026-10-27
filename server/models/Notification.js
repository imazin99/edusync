const mongoose = require('mongoose');
const {
  NOTIFICATION_CATEGORY_VALUES,
  NOTIFICATION_RELATED_TYPE_VALUES,
} = require('../utils/constants');
const notificationSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: [true, 'type is required'],
      trim: true,
      maxlength: 50,
    },
    category: {
      type: String,
      required: [true, 'category is required'],
      enum: NOTIFICATION_CATEGORY_VALUES,
    },
    title: {
      type: String,
      required: [true, 'title is required'],
      trim: true,
      maxlength: 200,
    },
    message: {
      type: String,
      required: [true, 'message is required'],
      trim: true,
      maxlength: 1000,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null, 
    },
    relatedType: {
      type: String,
      required: [true, 'relatedType is required'],
      enum: NOTIFICATION_RELATED_TYPE_VALUES,
    },
    relatedId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

notificationSchema.index({ category: 1, createdAt: -1 });
notificationSchema.index({ relatedType: 1, relatedId: 1 });
notificationSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
