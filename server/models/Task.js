const mongoose = require('mongoose');
const { ROLE_VALUES, TASK_STATUS_VALUES, TASK_STATUS } = require('../utils/constants');

const MAX_ATTACHMENTS = 10;
const MAX_SUBMISSION_LINKS = 10;
const attachmentSchema = new mongoose.Schema(
  {
    filename: { type: String, required: true, trim: true },
    mimeType: { type: String, required: true, trim: true },
    size: { type: Number, required: true, min: 0 },
    url: { type: String, required: true, trim: true },
    storageKey: { type: String, required: true, trim: true },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const submissionLinkSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true, default: '' },
    url: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const taskSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'title is required'],
      trim: true,
      maxlength: 200,
    },
    description: {
      type: String,
      default: '',
      maxlength: 5000,
    },
    subjectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subject',
      required: [true, 'subjectId is required'],
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'createdBy is required'],
    },
    creatorRole: {
      type: String,
      required: [true, 'creatorRole is required'],
      enum: ROLE_VALUES,
    },
    deadline: {
      type: Date,
      default: null, // optional — no deadline means it stays ACTIVE indefinitely
    },
    status: {
      type: String,
      enum: TASK_STATUS_VALUES,
      default: TASK_STATUS.ACTIVE,
    },
    attachments: {
      type: [attachmentSchema],
      default: [],
      validate: {
        validator: (arr) => arr.length <= MAX_ATTACHMENTS,
        message: `A task may have at most ${MAX_ATTACHMENTS} attachments`,
      },
    },
    submissionLinks: {
      type: [submissionLinkSchema],
      default: [],
      validate: {
        validator: (arr) => arr.length <= MAX_SUBMISSION_LINKS,
        message: `A task may have at most ${MAX_SUBMISSION_LINKS} submission links`,
      },
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

taskSchema.index({ subjectId: 1, deletedAt: 1 });
taskSchema.index({ status: 1, deletedAt: 1 });
taskSchema.index({ deadline: 1 });
taskSchema.index({ createdBy: 1 });
taskSchema.index({ deletedAt: 1 });

module.exports = mongoose.model('Task', taskSchema);
module.exports.MAX_ATTACHMENTS = MAX_ATTACHMENTS;
