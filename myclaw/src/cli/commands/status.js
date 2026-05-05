/**
 * `myclaw status` — Quick status overview
 */

import { Config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

export function statusCommand() {
  logger.banner('MyClaw Status');

  if (!Config.exists()) {
    logger.warn('Not initialized. Run `myclaw init` first.');
    return;
  }

  const cfg = new Config();
  cfg.load();

  const providerType = cfg.get('provider.type');
  const model = cfg.get('provider.model');
  const channels = Object.keys(cfg.get('channels') || {});

  const rows = [
    ['Config',       cfg.path],
    ['Name',         cfg.get('agent.name')],
    ['Provider',     `${providerType} (${model})`],
    ['Base URL',     cfg.get('provider.baseUrl') || '(default)'],
    ['Workspace',    cfg.get('agent.workspace')],
    ['Gateway',      `${cfg.get('gateway.host')}:${cfg.get('gateway.port')}`],
    ['Channels',     channels.length > 0 ? channels.join(', ') : '(none)'],
    ['Tools',        (cfg.get('tools.enabled') || []).join(', ')],
    ['Timeout',      `${cfg.get('agent.timeoutSeconds')}s`],
  ];

  for (const [label, value] of rows) {
    console.log(`  \x1b[36m${label.padEnd(14)}\x1b[0m ${value}`);
  }
  console.log('');
}
