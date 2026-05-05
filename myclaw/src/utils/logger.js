/**
 * Simple logger with color output and level filtering
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 99 };

const COLORS = {
  debug: '\x1b[90m',   // gray
  info:  '\x1b[36m',   // cyan
  warn:  '\x1b[33m',   // yellow
  error: '\x1b[31m',   // red
  reset: '\x1b[0m',
  bold:  '\x1b[1m',
};

let _level = 'info';

export const logger = {
  setLevel(level) {
    _level = level;
  },

  getLevel() {
    return _level;
  },

  debug(...args) {
    if (LEVELS[_level] <= LEVELS.debug) {
      console.log(`${COLORS.debug}[debug]${COLORS.reset}`, ...args);
    }
  },

  info(...args) {
    if (LEVELS[_level] <= LEVELS.info) {
      console.log(`${COLORS.info}[info]${COLORS.reset} `, ...args);
    }
  },

  warn(...args) {
    if (LEVELS[_level] <= LEVELS.warn) {
      console.warn(`${COLORS.warn}[warn]${COLORS.reset} `, ...args);
    }
  },

  error(...args) {
    if (LEVELS[_level] <= LEVELS.error) {
      console.error(`${COLORS.error}[error]${COLORS.reset}`, ...args);
    }
  },

  success(...args) {
    console.log(`\x1b[32m✔\x1b[0m`, ...args);
  },

  banner(text) {
    console.log(`\n${COLORS.bold}${COLORS.info}═══ ${text} ═══${COLORS.reset}\n`);
  },
};
