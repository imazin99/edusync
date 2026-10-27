const mongoose = require('mongoose');
const roomSchema = new mongoose.Schema(
  {
    building: {
      type: String,
      required: [true, 'building is required'],
      trim: true,
      maxlength: 50,
    },
    floor: {
      type: String,
      required: [true, 'floor is required'],
      trim: true,
      maxlength: 50,
    },
    roomNumber: {
      type: String,
      required: [true, 'roomNumber is required'],
      trim: true,
      maxlength: 50,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);
roomSchema.index({ building: 1, floor: 1, roomNumber: 1 }, { unique: true });
roomSchema.index({ isActive: 1 });

module.exports = mongoose.model('Room', roomSchema);
