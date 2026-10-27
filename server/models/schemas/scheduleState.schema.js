const mongoose = require('mongoose');
const { TIME_OF_DAY_REGEX } = require('../../utils/constants');
function buildScheduleStateSchema({
  requireRoom = true,
  requireDoctor = true,
  includeDate = false,
} = {}) {
  const fields = {
    startTime: {
      type: String,
      required: [true, 'startTime is required'],
      match: [TIME_OF_DAY_REGEX, 'startTime must be in HH:mm 24-hour format'],
    },
    endTime: {
      type: String,
      required: [true, 'endTime is required'],
      match: [TIME_OF_DAY_REGEX, 'endTime must be in HH:mm 24-hour format'],
      validate: {
        validator: function endAfterStart(value) {
          if (!this.startTime || !value) return true;
          return value > this.startTime;
        },
        message: 'endTime must be later than startTime',
      },
    },
    roomId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Room',
      required: requireRoom,
      default: null,
    },
    doctorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Doctor',
      required: requireDoctor,
      default: null,
    },
    taId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TA',
      default: null,
    },
  };

  if (includeDate) {
    fields.date = {
      type: Date,
      default: null, 
    };
  }

  return new mongoose.Schema(fields, { _id: false });
}

module.exports = { buildScheduleStateSchema };
