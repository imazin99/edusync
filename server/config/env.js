const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const REQUIRED_IN_PRODUCTION = ['MONGODB_URI', 'SESSION_SECRET'];

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3000,
  mongodbUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/academic_schedule',
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me',
  sessionMaxAgeMs: parseInt(process.env.SESSION_MAX_AGE_MS, 10) || 12 * 60 * 60 * 1000,
  uploadLimit: process.env.UPLOAD_LIMIT || '10mb',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:3000',
};

env.isProduction = env.nodeEnv === 'production';
env.isDevelopment = env.nodeEnv === 'development';
env.isTest = env.nodeEnv === 'test';

function validateEnv() {
  if (!env.isProduction) return;

  const missing = REQUIRED_IN_PRODUCTION.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables in production: ${missing.join(', ')}`
    );
  }

  if (env.sessionSecret === 'dev-only-insecure-secret-change-me') {
    throw new Error('SESSION_SECRET must be set to a strong value in production.');
  }
}

module.exports = { env, validateEnv };
