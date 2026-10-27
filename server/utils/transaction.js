const mongoose = require('mongoose');

async function runInTransaction(callback) {
  const dbSession = await mongoose.startSession();
  try {
    let result;
    await dbSession.withTransaction(async () => {
      result = await callback(dbSession);
    });
    return result;
  } finally {
    await dbSession.endSession();
  }
}

module.exports = { runInTransaction };
