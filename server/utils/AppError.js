class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message, code = 'VALIDATION_ERROR') {
    return new AppError(message, 422, code);
  }

  static unauthorized(message = 'Authentication required', code = 'UNAUTHORIZED') {
    return new AppError(message, 401, code);
  }

  static forbidden(message = 'You do not have permission to do this', code = 'FORBIDDEN') {
    return new AppError(message, 403, code);
  }

  static notFound(message = 'Resource not found', code = 'NOT_FOUND') {
    return new AppError(message, 404, code);
  }

  static conflict(message = 'Conflicting request', code = 'CONFLICT') {
    return new AppError(message, 409, code);
  }

  static tooManyRequests(message = 'Too many requests', code = 'RATE_LIMITED') {
    return new AppError(message, 429, code);
  }

  static serviceUnavailable(message = 'Service unavailable', code = 'MAINTENANCE') {
    return new AppError(message, 503, code);
  }
}

module.exports = AppError;
