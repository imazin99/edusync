const { env } = require('../config/env');

function notFoundHandler(req, res, next) {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
    code: 'ROUTE_NOT_FOUND',
  });
}

function errorHandler(err, req, res, next) {
  const isOperational = err.isOperational === true;
  const statusCode = isOperational ? err.statusCode : 500;
  const code = isOperational ? err.code : 'INTERNAL_ERROR';
  const message = isOperational ? err.message : 'An unexpected error occurred';

  if (!isOperational) {
    console.error('[unhandled error]', err);
  } else if (statusCode >= 500) {
    console.error('[operational error]', err.message);
  }

  const body = { success: false, message, code };

  if (env.isDevelopment && !isOperational) {
    body.debug = { stack: err.stack };
  }

  res.status(statusCode).json(body);
}

module.exports = { notFoundHandler, errorHandler };
