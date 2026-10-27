const mongoose = require('mongoose');
const {
  CLASS_TYPE_VALUES,
  CLASS_TYPES,
  GROUP_VALUES,
  GROUPS,
  DAY_OF_WEEK_VALUES,
  TIME_OF_DAY_REGEX,
} = require('../utils/constants');
const scheduleTemplateSchema = new mongoose.Schema(
  {
    subjectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subject',
      required: [true, 'subjectId is required'],
    },
    type: {
      type: String,
      required: [true, 'type is required'],
      enum: CLASS_TYPE_VALUES,
    },
    group: {
      type: String,
      required: [true, 'group is required'],
      enum: GROUP_VALUES,
      validate: {
        validator: function groupMatchesType(value) {
          if (this.type === CLASS_TYPES.LECTURE) return value === GROUPS.ALL;
          return true;
        },
        message: 'LECTURE must use group ALL',
      },
    },
    dayOfWeek: {
      type: String,
      required: [true, 'dayOfWeek is required'],
      enum: DAY_OF_WEEK_VALUES,
    },
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
      required: [true, 'roomId is required'],
    },
    doctorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Doctor',
      required: [true, 'doctorId is required'],
    },
    taId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TA',
      default: null,
    },
    effectiveFrom: {
      type: Date,
      required: [true, 'effectiveFrom is required'],
    },
    effectiveTo: {
      type: Date,
      default: null,
      validate: {
        validator: function effectiveToAfterFrom(value) {
          if (!value) return true;
          return value >= this.effectiveFrom;
        },
        message: 'effectiveTo must be on or after effectiveFrom',
      },
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

scheduleTemplateSchema.index({ subjectId: 1, dayOfWeek: 1 });
scheduleTemplateSchema.index({ subjectId: 1, isActive: 1 });
scheduleTemplateSchema.index({ roomId: 1 });
scheduleTemplateSchema.index({ doctorId: 1 });
scheduleTemplateSchema.index({ taId: 1 });
scheduleTemplateSchema.index({ isActive: 1, effectiveFrom: 1, effectiveTo: 1 });

module.exports = mongoose.model('ScheduleTemplate', scheduleTemplateSchema);
