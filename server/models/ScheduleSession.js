const mongoose = require('mongoose');
const {
  CLASS_TYPE_VALUES,
  CLASS_TYPES,
  GROUP_VALUES,
  GROUPS,
  SESSION_STATUS_VALUES,
  SESSION_STATUS,
} = require('../utils/constants');
const { buildScheduleStateSchema } = require('./schemas/scheduleState.schema');
const scheduleSessionSchema = new mongoose.Schema(
  {
    templateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ScheduleTemplate',
      required: [true, 'templateId is required'],
    },
    subjectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subject',
      required: [true, 'subjectId is required'],
    },
    date: {
      type: Date,
      required: [true, 'date is required'],
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
    original: {
      type: buildScheduleStateSchema(),
      required: [true, 'original schedule state is required'],
    },
    current: {
      type: buildScheduleStateSchema({ includeDate: true }),
      required: [true, 'current schedule state is required'],
    },
    status: {
      type: String,
      required: true,
      enum: SESSION_STATUS_VALUES,
      default: SESSION_STATUS.ACTIVE,
    },
  },
  { timestamps: true }
);

scheduleSessionSchema.index({ templateId: 1, date: 1 }, { unique: true });
scheduleSessionSchema.index({ subjectId: 1, date: 1 });
scheduleSessionSchema.index({ date: 1, status: 1 });
scheduleSessionSchema.index({ date: 1, group: 1 });
scheduleSessionSchema.index({ 'current.roomId': 1, date: 1 });
scheduleSessionSchema.index({ 'current.doctorId': 1, date: 1 });

module.exports = mongoose.model('ScheduleSession', scheduleSessionSchema);
