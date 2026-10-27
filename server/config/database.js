const mongoose = require('mongoose');
const { env } = require('./env');

mongoose.set('strictQuery', true);

let hasConnectedOnce = false;

async function connectDatabase() {
  mongoose.connection.on('connected', () => {
    hasConnectedOnce = true;
    console.log(`[database] Connected to MongoDB (${maskUri(env.mongodbUri)})`);
  });

  mongoose.connection.on('error', (err) => {
    console.error('[database] MongoDB connection error:', err.message);
  });

  mongoose.connection.on('disconnected', () => {
    if (hasConnectedOnce) {
      console.warn('[database] MongoDB disconnected');
    }
  });

  try {
    await mongoose.connect(env.mongodbUri, {
      serverSelectionTimeoutMS: 8000,
    });
  } catch (err) {
    console.error('[database] Initial MongoDB connection failed:', err.message);
    throw err;
  }
}

function getConnectionState() {

  const state = mongoose.connection.readyState;
  const map = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
  };
  return map[state] || 'unknown';
}

async function disconnectDatabase() {
  await mongoose.disconnect();
}

function maskUri(uri) {
  return uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@');
}

module.exports = {
  connectDatabase,
  disconnectDatabase,
  getConnectionState,
};
