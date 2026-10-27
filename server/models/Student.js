const mongoose = require('mongoose');
const { STUDENT_GROUP_VALUES } = require('../utils/constants');

const studentSchema = new mongoose.Schema(
  {
    studentCode: {
      type: String,
      required: [true, 'studentCode is required'],
      unique: true,
      trim: true,
      minlength: 1,
      maxlength: 50,
    },
    fullName: {
      type: String,
      required: [true, 'fullName is required'],
      trim: true,
      minlength: 2,
      maxlength: 150,
    },
    group: {
      type: String,
      required: [true, 'group is required'],
      enum: STUDENT_GROUP_VALUES,
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
  },
  { timestamps: true }
);

studentSchema.index({ group: 1 });
studentSchema.index({ isActive: 1 });
studentSchema.index({ fullName: 1 });

module.exports = mongoose.model('Student', studentSchema);
