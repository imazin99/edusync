const mongoose = require('mongoose');
const taskCompletionSchema = new mongoose.Schema(
  {
    taskId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Task',
      required: [true, 'taskId is required'],
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Student',
      required: [true, 'studentId is required'],
    },
    completedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: false }
);

taskCompletionSchema.index({ taskId: 1, studentId: 1 }, { unique: true });
taskCompletionSchema.index({ studentId: 1 });

module.exports = mongoose.model('TaskCompletion', taskCompletionSchema);
