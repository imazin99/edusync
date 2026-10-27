const mongoose = require('mongoose');
const notificationRecipientSchema = new mongoose.Schema(
  {
    notificationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Notification',
      required: [true, 'notificationId is required'],
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'userId is required'],
    },
    readAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

notificationRecipientSchema.index({ notificationId: 1, userId: 1 }, { unique: true });
notificationRecipientSchema.index({ userId: 1, readAt: 1 });
notificationRecipientSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('NotificationRecipient', notificationRecipientSchema);
