const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;

function isValidObjectId(id) {
  return typeof id === 'string' && OBJECT_ID_REGEX.test(id);
}

module.exports = { isValidObjectId };
