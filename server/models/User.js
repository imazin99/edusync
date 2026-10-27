const mongoose = require('mongoose');
const { ROLE_VALUES } = require('../utils/constants');
const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: [true, 'username is required'],
      unique: true,
      trim: true,
      minlength: 2,
      maxlength: 100,
    },
    passwordHash: {
      type: String,
      required: false, 
      default: null,
      select: false, 
    },
    role: {
      type: String,
      required: [true, 'role is required'],
      enum: ROLE_VALUES,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);
userSchema.index({ role: 1 });
userSchema.index({ role: 1, isActive: 1 });

module.exports = mongoose.model('User', userSchema);
