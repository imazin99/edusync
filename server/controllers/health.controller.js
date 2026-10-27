const { getConnectionState } = require('../config/database');
const { env } = require('../config/env');
function getHealth(req, res) {
  const dbState = getConnectionState();
  const isHealthy = dbState === 'connected';

  res.status(isHealthy ? 200 : 503).json({
    success: isHealthy,
    status: isHealthy ? 'ok' : 'degraded',
    environment: env.nodeEnv,
    database: dbState,
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
  });
}

module.exports = { getHealth };
