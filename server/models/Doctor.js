const mongoose = require('mongoose');
const doctorSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: [true, 'fullName is required'],
      trim: true,
      minlength: 2,
      maxlength: 150,
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
doctorSchema.index({ isActive: 1 });
doctorSchema.index({ fullName: 1 });

module.exports = mongoose.model('Doctor', doctorSchema);
