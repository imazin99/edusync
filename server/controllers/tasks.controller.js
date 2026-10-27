const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { isValidObjectId } = require('../utils/validateObjectId');
const taskService = require('../services/TaskService');
const readScope = require('../services/ReadScopeService');

const list = asyncHandler(async (req, res) => {
  const { subjectId, status, createdBy } = req.query;
  const tasks = await readScope.listTasksForActor({
    actorUser: req.user,
    subjectId,
    status,
    createdBy,
  });
  res.status(200).json({ success: true, tasks });
});

const getOne = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    throw AppError.badRequest('taskId is not a valid id', 'INVALID_TASK_ID');
  }
  const task = await readScope.assertTaskReadable({
    actorUser: req.user,
    taskId: req.params.id,
  });
  res.status(200).json({ success: true, task });
});

const create = asyncHandler(async (req, res) => {
  const { title, description, subjectId, deadline, submissionLinks } = req.body || {};
  const task = await taskService.create({
    actorUser: req.user,
    title,
    description,
    subjectId,
    deadline,
    submissionLinks,
  });
  res.status(201).json({ success: true, task });
});

const update = asyncHandler(async (req, res) => {
  const { title, description, deadline, submissionLinks, attachments } = req.body || {};
  const task = await taskService.update({
    actorUser: req.user,
    taskId: req.params.id,
    title,
    description,
    deadline,
    submissionLinks,
    attachments,
  });
  res.status(200).json({ success: true, task });
});

const remove = asyncHandler(async (req, res) => {
  await taskService.remove({ actorUser: req.user, taskId: req.params.id });
  res.status(200).json({ success: true, message: 'Task deleted.' });
});

const complete = asyncHandler(async (req, res) => {
  await taskService.markDone({ actorUser: req.user, taskId: req.params.id });
  res.status(200).json({ success: true, message: 'Marked as done.' });
});

const uncomplete = asyncHandler(async (req, res) => {
  await taskService.unmarkDone({ actorUser: req.user, taskId: req.params.id });
  res.status(200).json({ success: true, message: 'Unmarked.' });
});

const addAttachment = asyncHandler(async (req, res) => {
  const { filename, mimeType, dataBase64 } = req.body || {};
  const task = await taskService.addAttachment({
    actorUser: req.user,
    taskId: req.params.id,
    filename,
    mimeType,
    dataBase64,
  });
  res.status(201).json({ success: true, task });
});

const removeAttachment = asyncHandler(async (req, res) => {
  const task = await taskService.removeAttachment({
    actorUser: req.user,
    taskId: req.params.id,
    storageKey: req.params.storageKey,
  });
  res.status(200).json({ success: true, task });
});

const downloadAttachment = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    throw AppError.badRequest('taskId is not a valid id', 'INVALID_TASK_ID');
  }
  await readScope.assertAttachmentReadable({ actorUser: req.user, taskId: req.params.id });
  const { absolutePath, filename } = await taskService.getAttachmentForDownload({
    taskId: req.params.id,
    storageKey: req.params.storageKey,
  });
  res.download(absolutePath, filename);
});

module.exports = {
  list,
  getOne,
  create,
  update,
  remove,
  complete,
  uncomplete,
  addAttachment,
  removeAttachment,
  downloadAttachment,
};
