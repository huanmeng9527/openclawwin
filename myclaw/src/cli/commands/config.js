/**
 * `myclaw config` — View and modify configuration
 * 
 * Subcommands:
 *   myclaw config show              — dump full config
 *   myclaw config get <key>         — get a single value
 *   myclaw config set <key> <value> — set a single value
 *   myclaw config path              — print config file path
 *   myclaw config validate          — run validation
 */

import { Config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

function loadConfig() {
  if (!Config.exists()) {
    logger.error('Config not found. Run `myclaw init` first.');
    process.exit(1);
  }
  const cfg = new Config();
  cfg.load();
  return cfg;
}

/** Pretty-print an object with flattened keys */
function printFlat(obj, prefix = '') {
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      printFlat(value, fullKey);
    } else {
      const display = typeof value === 'string' && value.includes('Key')
        ? '***' // mask potential secrets
        : JSON.stringify(value);
      console.log(`  \x1b[36m${fullKey}\x1b[0m = ${display}`);
    }
  }
}

/** Coerce string value to appropriate type */
function coerceValue(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  if (/^\d+\.\d+$/.test(value)) return parseFloat(value);
  // Try JSON parse for arrays/objects
  if (value.startsWith('[') || value.startsWith('{')) {
    try { return JSON.parse(value); } catch { /* fall through */ }
  }
  return value;
}

export function configShowCommand() {
  const cfg = loadConfig();
  const data = cfg.all();

  logger.banner('MyClaw Configuration');
  console.log(`  Config: \x1b[90m${cfg.path}\x1b[0m\n`);
  printFlat(data);
  console.log('');
}

export function configGetCommand(key) {
  const cfg = loadConfig();
  const value = cfg.get(key);

  if (value === undefined) {
    logger.warn(`Key "${key}" not found or not set`);
    process.exit(1);
  }

  if (typeof value === 'object') {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(value);
  }
}

export function configSetCommand(key, value) {
  const cfg = loadConfig();
  const coerced = coerceValue(value);

  cfg.set(key, coerced);

  const errors = cfg.validate();
  if (errors.length > 0) {
    logger.warn('Validation warnings:');
    errors.forEach(e => logger.warn(`  • ${e}`));
  }

  cfg.save();
  logger.success(`${key} = ${JSON.stringify(coerced)}`);
}

export function configPathCommand() {
  console.log(Config.getConfigPath());
}

export function configValidateCommand() {
  const cfg = loadConfig();
  const errors = cfg.validate();

  if (errors.length === 0) {
    logger.success('Config is valid ✓');
  } else {
    logger.error(`Config has ${errors.length} error(s):`);
    errors.forEach(e => logger.error(`  ✗ ${e}`));
    process.exit(1);
  }
}
