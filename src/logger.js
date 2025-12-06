/**
 * Shared Logger Configuration
 *
 * Provides colorful, human-readable logging via pino-pretty.
 * All modules should use createLogger() for consistent output.
 */

import pino from 'pino';

/**
 * Create a configured pino logger with pretty output
 * @param {Object} options - Logger options
 * @param {string} options.level - Log level (default: 'info')
 * @param {string} options.component - Component name for log context
 * @returns {pino.Logger} Configured pino logger
 */
export function createLogger(options = {}) {
  const level = options.level || process.env.LOG_LEVEL || 'info';

  const logger = pino({
    level,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        ignore: 'pid,hostname',           // Remove noise
        translateTime: 'HH:MM:ss',        // Short timestamp
        singleLine: false,                // Multi-line for readable objects
      }
    }
  });

  // Return child logger with component if specified
  if (options.component) {
    return logger.child({ component: options.component });
  }

  return logger;
}
