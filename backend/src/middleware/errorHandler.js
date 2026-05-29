import { ZodError } from 'zod';
import { logger } from '../utils/logger.js';

export function notFound(_req, res) {
  res.status(404).json({ message: 'Not found' });
}

export function errorHandler(error, req, res, _next) {
  const isValidationError = error instanceof ZodError;
  const statusCode = isValidationError ? 400 : error.statusCode || 500;
  const message = isValidationError
    ? error.issues.map((issue) => issue.message).join(' ')
    : statusCode < 500
      ? error.message
      : 'Unable to process request.';

  logger.error('request_failed', {
    requestId: req.id,
    method: req.method,
    path: req.originalUrl,
    statusCode,
    error: {
      name: error.name,
      message: error.message,
      stack: process.env.NODE_ENV === 'production' ? undefined : error.stack,
    },
  });

  res.status(statusCode).json({
    message,
    requestId: req.id,
  });
}
