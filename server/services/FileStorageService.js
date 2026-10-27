const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const AppError = require('../utils/AppError');
function createLocalFileStorage({ baseDir } = {}) {
  const resolvedBaseDir = path.resolve(baseDir || path.join(__dirname, '../../uploads/tasks'));

  async function ensureBaseDir() {
    await fs.mkdir(resolvedBaseDir, { recursive: true });
  }

  function resolvePathFor(storageKey) {
    const safeKey = path.basename(String(storageKey || ''));
    const destination = path.join(resolvedBaseDir, safeKey);
    if (!safeKey || path.dirname(destination) !== resolvedBaseDir) {
      throw AppError.notFound('Attachment not found');
    }
    return destination;
  }

  /** @param {{ buffer: Buffer, extension: string }} */
  async function save({ buffer, extension }) {
    await ensureBaseDir();
    const safeExtension = /^\.[a-z0-9]{1,10}$/i.test(extension || '') ? extension : '';
    const storageKey = `${crypto.randomUUID()}${safeExtension}`;
    const destination = path.join(resolvedBaseDir, storageKey);
    if (path.dirname(destination) !== resolvedBaseDir) {
      throw AppError.badRequest('Invalid storage path', 'INVALID_STORAGE_PATH');
    }
    await fs.writeFile(destination, buffer);
    return { storageKey, size: buffer.length };
  }

  async function remove({ storageKey }) {
    let destination;
    try {
      destination = resolvePathFor(storageKey);
    } catch (err) {
      return; 
    }
    try {
      await fs.unlink(destination);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err; 
    }
  }

  async function exists(storageKey) {
    try {
      await fs.access(resolvePathFor(storageKey));
      return true;
    } catch (err) {
      return false;
    }
  }

  return { save, remove, resolvePathFor, exists, baseDir: resolvedBaseDir };
}

const defaultFileStorage = createLocalFileStorage();

module.exports = { createLocalFileStorage, ...defaultFileStorage };
