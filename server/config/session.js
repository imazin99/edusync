const session = require('express-session');
const MongoStore = require('connect-mongo');
const { env } = require('./env');

const SESSION_COOKIE_NAME = 'academic_schedule_sid';
function buildSessionMiddleware() {
  const options = {
    name: SESSION_COOKIE_NAME,
    secret: env.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: env.isProduction,
      sameSite: 'lax',
      maxAge: env.sessionMaxAgeMs,
    },
  };

  if (!env.isTest) {
    options.store = MongoStore.create({
      mongoUrl: env.mongodbUri,
      collectionName: 'sessions',
      ttl: Math.floor(env.sessionMaxAgeMs / 1000),
    });
  }

  return session(options);
}

module.exports = { buildSessionMiddleware, SESSION_COOKIE_NAME };
