/**
 * `myclaw serve` — Start WeChat callback server
 */

import { Config } from '../../config/index.js';
import { QueryEngine } from '../../engine/index.js';
import { WeChatServer } from '../../channels/wechat/server.js';
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

export async function serveCommand(opts) {
  const cfg = loadConfig();
  const engine = new QueryEngine(cfg.all());
  await engine.init();

  const wechatConfig = cfg.get('channels.wechat');
  if (!wechatConfig) {
    logger.error('WeChat channel not configured.');
    logger.info('Add to myclaw.json: channels.wechat.webhookUrl and/or corpId/agentId/secret');
    process.exit(1);
  }

  const port = opts.port || wechatConfig.callbackPort || 8080;

  logger.banner('WeChat Server');
  logger.info(`Port: ${port}`);
  logger.info(`Agent: ${cfg.get('agent.name')}`);
  logger.info(`Model: ${cfg.get('provider.type')}:${cfg.get('provider.model')}`);

  // Wrap engine as AgentLoop-compatible for WeChatServer
  const agentCompat = {
    run: (msg, session, opts) => engine.run(msg, session, opts),
  };

  const server = new WeChatServer(cfg.all(), agentCompat);
  server.start();

  process.on('SIGINT', () => { server.stop(); process.exit(0); });
  process.on('SIGTERM', () => { server.stop(); process.exit(0); });
}
