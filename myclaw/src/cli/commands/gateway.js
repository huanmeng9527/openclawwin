/**
 * `myclaw gateway` — Start/stop the Gateway HTTP API server
 */

import { Config } from '../../config/index.js';
import { Gateway } from '../../gateway/index.js';
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

export async function gatewayStartCommand(opts) {
  const cfg = loadConfig();
  const gateway = new Gateway(cfg.all());

  logger.banner('MyClaw Gateway');
  logger.info(`Host: ${cfg.get('gateway.host')}`);
  logger.info(`Port: opts.port || cfg.get('gateway.port')`);
  logger.info(`Model: ${cfg.get('provider.type')}:${cfg.get('provider.model')}`);

  await gateway.start();

  const port = opts.port || cfg.get('gateway.port');
  logger.success(`Gateway running at http://${cfg.get('gateway.host')}:${port}`);
  logger.info('API endpoints:');
  logger.info('  POST /api/agent       — send message');
  logger.info('  GET  /api/sessions    — list sessions');
  logger.info('  GET  /api/status      — server status');
  logger.info('  GET  /api/health      — health check');
  logger.info('  GET  /api/approvals   - admin token required');
  logger.info('  GET  /api/audit       - admin token required');
  logger.info('  GET  /api/memory/proposals - admin token required');
  console.log('');

  process.on('SIGINT', () => { gateway.stop(); process.exit(0); });
  process.on('SIGTERM', () => { gateway.stop(); process.exit(0); });
}
