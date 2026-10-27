const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');

const { env, validateEnv } = require('./config/env');
const { connectDatabase, disconnectDatabase } = require('./config/database');
const { buildSessionMiddleware } = require('./config/session');
const healthRoutes = require('./routes/health.routes');
const authRoutes = require('./routes/auth.routes');
const studentsRoutes = require('./routes/students.routes');
const doctorsRoutes = require('./routes/doctors.routes');
const tasRoutes = require('./routes/tas.routes');
const leadersRoutes = require('./routes/leaders.routes');
const subjectsRoutes = require('./routes/subjects.routes');
const roomsRoutes = require('./routes/rooms.routes');
const scheduleRoutes = require('./routes/schedule.routes');
const tasksRoutes = require('./routes/tasks.routes');
const notificationsRoutes = require('./routes/notifications.routes');
const requestsRoutes = require('./routes/requests.routes');
const adminRoutes = require('./routes/admin.routes');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

require('./models');

function createApp() {
  const app = express();

  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigin.split(',').map((o) => o.trim()),
      credentials: true,
    })
  );
  app.use(morgan(env.isProduction ? 'combined' : 'dev'));
  app.use(express.json({ limit: env.uploadLimit }));
  app.use(express.urlencoded({ extended: true, limit: env.uploadLimit }));
  app.use(cookieParser());
  app.use(buildSessionMiddleware());

  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api', apiLimiter);

  app.use(
    express.static(path.join(__dirname, '../client'), {
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );

  app.use('/api/health', healthRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/students', studentsRoutes);
  app.use('/api/doctors', doctorsRoutes);
  app.use('/api/tas', tasRoutes);
  app.use('/api/leaders', leadersRoutes);
  app.use('/api/subjects', subjectsRoutes);
  app.use('/api/rooms', roomsRoutes);
  app.use('/api/schedule', scheduleRoutes);
  app.use('/api/tasks', tasksRoutes);
  app.use('/api/notifications', notificationsRoutes);
  app.use('/api/requests', requestsRoutes);
  app.use('/api/admin', adminRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

async function start() {
  validateEnv();

  const app = createApp();

  try {
    await connectDatabase();
  } catch (err) {
    console.error(
      '[startup] Could not connect to MongoDB on startup. ' +
        'The server will still start so /api/health can report the outage, ' +
        'but most functionality will not work until the database is reachable.'
    );
  }

app.get('/', (req, res) => {
  res.send('EduSync API is running successfully on Vercel!');
});

  const server = app.listen(env.port, () => {
    console.log(`[server] Listening on port ${env.port} (${env.nodeEnv})`);
  });

  const shutdown = async (signal) => {
    console.log(`[server] Received ${signal}, shutting down gracefully...`);
    server.close(async () => {
      await disconnectDatabase();
      console.log('[server] Shutdown complete.');
      process.exit(0);
    });

    setTimeout(() => {
      console.error('[server] Forced shutdown after timeout.');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    console.error('[process] Unhandled promise rejection:', reason);
  });

  process.on('uncaughtException', (err) => {
    console.error('[process] Uncaught exception:', err);
    process.exit(1);
  });

  return server;
}

if (require.main === module) {
  start().catch((err) => {
    console.error('[startup] Fatal startup error:', err.message);
    process.exit(1);
  });
}

module.exports = { createApp, start };
