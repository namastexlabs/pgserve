/**
 * Native Logger - Zero Dependencies
 *
 * Provides colorful, human-readable logging with pino-compatible API.
 * All modules should use createLogger() for consistent output.
 */

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  info: '\x1b[32m',    // green
  warn: '\x1b[33m',    // yellow
  error: '\x1b[31m',   // red
  debug: '\x1b[36m',   // cyan
};

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function formatTime() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
}

function formatData(data) {
  if (!data || Object.keys(data).length === 0) return '';
  // Clone to avoid mutating original
  const formatted = { ...data };
  // Format error objects specially
  if (formatted.err) {
    formatted.err = formatted.err.message || String(formatted.err);
  }
  return ` ${JSON.stringify(formatted)}`;
}

/**
 * Create a configured logger with pretty output
 * @param {Object} options - Logger options
 * @param {string} options.level - Log level (default: 'info')
 * @param {string} options.component - Component name for log context
 * @param {Object} options.context - Additional context to merge into all logs
 * @returns {Object} Logger with info, debug, warn, error, child methods
 */
export function createLogger(options = {}) {
  const minLevel = LEVELS[options.level || process.env.LOG_LEVEL || 'info'] || LEVELS.info;
  const context = options.context || {};

  // Add component to context if specified
  if (options.component && !context.component) {
    context.component = options.component;
  }

  const log = (level, levelName, data, msg) => {
    if (level < minLevel) return;

    // Handle (msg) or (data, msg) calling conventions
    if (typeof data === 'string') {
      msg = data;
      data = {};
    }

    const merged = { ...context, ...data };
    const timestamp = formatTime();
    const color = COLORS[levelName];
    const label = levelName.toUpperCase().padEnd(5);

    const output = `${COLORS.dim}${timestamp}${COLORS.reset} ${color}${label}${COLORS.reset}${formatData(merged)} ${msg || ''}`;

    if (levelName === 'error') {
      console.error(output);
    } else {
      console.log(output);
    }
  };

  return {
    debug: (data, msg) => log(LEVELS.debug, 'debug', data, msg),
    info: (data, msg) => log(LEVELS.info, 'info', data, msg),
    warn: (data, msg) => log(LEVELS.warn, 'warn', data, msg),
    error: (data, msg) => log(LEVELS.error, 'error', data, msg),
    child: (childContext) => createLogger({
      ...options,
      context: { ...context, ...childContext }
    }),
  };
}
