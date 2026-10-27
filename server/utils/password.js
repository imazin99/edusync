const bcrypt = require('bcryptjs');
const SALT_ROUNDS = 10;

async function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, SALT_ROUNDS);
}

async function comparePassword(plainPassword, hash) {
  if (!hash) return false;
  return bcrypt.compare(plainPassword, hash);
}

module.exports = { hashPassword, comparePassword, SALT_ROUNDS };
