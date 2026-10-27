const path = require('path');
const AppError = require('./AppError');
const ALLOWED_ATTACHMENT_TYPES = [
  { mimeType: 'application/pdf', extensions: ['.pdf'] },
  { mimeType: 'application/msword', extensions: ['.doc'] },
  {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extensions: ['.docx'],
  },
  { mimeType: 'application/vnd.ms-powerpoint', extensions: ['.ppt'] },
  {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extensions: ['.pptx'],
  },
  { mimeType: 'image/png', extensions: ['.png'] },
  { mimeType: 'image/jpeg', extensions: ['.jpg', '.jpeg'] },
  { mimeType: 'image/gif', extensions: ['.gif'] },
  { mimeType: 'image/webp', extensions: ['.webp'] },
  { mimeType: 'application/zip', extensions: ['.zip'] },
  { mimeType: 'application/x-zip-compressed', extensions: ['.zip'] },
];

const CONTROL_CHARS_REGEX = /[\x00-\x1f\x7f]/g;
const BASE64_REGEX = /^[A-Za-z0-9+/]*={0,2}$/;

function sanitizeFilename(rawFilename) {
  const base = path.basename(String(rawFilename || '').trim());
  const stripped = base.replace(CONTROL_CHARS_REGEX, '').trim();
  const safe = stripped || 'file';
  return safe.length > 255 ? safe.slice(0, 255) : safe;
}

function getValidatedExtension(filename, mimeType) {
  const ext = path.extname(filename).toLowerCase();
  const entry = ALLOWED_ATTACHMENT_TYPES.find(
    (t) => t.mimeType === mimeType && t.extensions.includes(ext)
  );
  if (!entry) {
    throw AppError.badRequest(
      `Unsupported attachment type (mimeType=${mimeType || '(none)'}, extension=${ext || '(none)'})`,
      'UNSUPPORTED_FILE_TYPE'
    );
  }
  return ext;
}

function isPlausibleBase64(str) {
  return typeof str === 'string' && str.length > 0 && BASE64_REGEX.test(str);
}

function parseByteSize(sizeStr, fallbackBytes = 10 * 1024 * 1024) {
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(String(sizeStr).trim());
  if (!match) return fallbackBytes;
  const value = parseFloat(match[1]);
  const unit = (match[2] || 'b').toLowerCase();
  const multipliers = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 * 1024 * 1024 };
  return Math.floor(value * multipliers[unit]);
}

module.exports = {
  ALLOWED_ATTACHMENT_TYPES,
  sanitizeFilename,
  getValidatedExtension,
  isPlausibleBase64,
  parseByteSize,
};
