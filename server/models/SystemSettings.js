const mongoose = require('mongoose');
const { DAY_OF_WEEK_VALUES } = require('../utils/constants');
const SINGLETON_KEY = 'singleton';

const systemSettingsSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      default: SINGLETON_KEY,
      immutable: true,
    },
    maintenanceMode: {
      type: Boolean,
      default: false,
    },
    maintenanceMessage: {
      type: String,
      default: '',
      maxlength: 500,
    },
    currentAcademicTerm: {
      type: String,
      default: '',
      maxlength: 100,
    },
    notificationRetentionDays: {
      type: Number,
      default: 180,
      min: 1,
    },
    weekOffDay: {
      type: String,
      enum: DAY_OF_WEEK_VALUES,
      default: null,
    },
    otherSettings: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

systemSettingsSchema.index({ key: 1 }, { unique: true });

systemSettingsSchema.statics.SINGLETON_KEY = SINGLETON_KEY;
systemSettingsSchema.statics.getSingleton = async function getSingleton() {
  return this.findOneAndUpdate(
    { key: SINGLETON_KEY },
    { $setOnInsert: { key: SINGLETON_KEY } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
};

module.exports = mongoose.model('SystemSettings', systemSettingsSchema);
