const mongoose = require('mongoose');
const taSchema = new mongoose.Schema(
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

taSchema.index({ isActive: 1 });
taSchema.index({ fullName: 1 });

module.exports = mongoose.model('TA', taSchema);
