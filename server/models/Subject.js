const mongoose = require('mongoose');
const subjectSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'name is required'],
      trim: true,
      maxlength: 150,
    },
    code: {
      type: String,
      required: [true, 'code is required'],
      unique: true,
      trim: true,
      uppercase: true,
      maxlength: 30,
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
    hasSections: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);
subjectSchema.index({ doctorId: 1 });
subjectSchema.index({ taId: 1 });
subjectSchema.index({ isActive: 1 });

module.exports = mongoose.model('Subject', subjectSchema);
