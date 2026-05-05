/**
 * `myclaw doctor` — Health check & diagnostics
 */

import fs from 'node:fs';
import { Config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

const PROVIDER_ENV_KEYS = {
  openai: ['MYCLAW_API_KEY', 'OPENAI_API_KEY'],
  minimax: ['MINIMAX_API_KEY', 'MYCLAW_API_KEY'],
  xiaomi: ['MIMO_API_KEY', 'XIAOMI_API_KEY', 'MYCLAW_API_KEY'],
  ollama: [],
  custom: ['MYCLAW_API_KEY'],
};

function check(label, fn) {
  try {
    const result = fn();
    if (result === true) {
      logger.success(label);
      return true;
    } else {
      logger.error(`${label}: ${result}`);
      return false;
    }
  } catch (err) {
    logger.error(`${label}: ${err.message}`);
    return false;
  }
}

export function doctorCommand() {
  logger.banner('MyClaw Doctor');
  let pass = 0;
  let fail = 0;

  // 1. Config exists
  (check('Config file exists', () => {
    return Config.exists() || 'Not found — run `myclaw init`';
  })) ? pass++ : fail++;

  if (!Config.exists()) {
    logger.warn('Run `myclaw init` first.');
    return;
  }

  const cfg = new Config();
  cfg.load();

  // 2. Config valid
  (check('Config is valid', () => {
    const errors = cfg.validate();
    return errors.length === 0 || errors.join('; ');
  })) ? pass++ : fail++;

  // 3. Workspace
  const workspace = cfg.get('agent.workspace');
  const expanded = workspace.replace('~', process.env.HOME || process.env.USERPROFILE);
  (check(`Workspace (${expanded})`, () => {
    return fs.existsSync(expanded) || 'Not found';
  })) ? pass++ : fail++;

  // 4. Node.js
  (check('Node.js >= 18', () => {
    return parseInt(process.version.slice(1), 10) >= 18 || `Found ${process.version}`;
  })) ? pass++ : fail++;

  // 5. Provider API key
  const providerType = cfg.get('provider.type');
  const configKey = cfg.get('provider.apiKey');
  const envKeys = PROVIDER_ENV_KEYS[providerType] || ['MYCLAW_API_KEY'];
  const envKey = envKeys.find(k => process.env[k]);

  (check(`API key (${providerType})`, () => {
    return !!(configKey || envKey) || `Set provider.apiKey or env: ${envKeys.join('/')}`;
  })) ? pass++ : fail++;

  // 6. Provider base URL
  const baseUrl = cfg.get('provider.baseUrl');
  (check(`Provider base URL`, () => {
    return !!baseUrl || 'Not set (will use provider default)';
  })) ? pass++ : fail++; // warning only

  // 7. WeChat channel
  const wechatConfig = cfg.get('channels.wechat');
  if (wechatConfig) {
    (check('WeChat webhook URL', () => {
      return !!wechatConfig.webhookUrl || 'Not configured';
    })) ? pass++ : fail++;

    if (wechatConfig.corpId) {
      (check('WeChat callback config', () => {
        return !!(wechatConfig.corpId &&wechatConfig.agentId && wechatConfig.secret) || 'Incomplete: need corpId, agentId, secret';
      })) ? pass++ : fail++;
    }
  } else {
    logger.info('WeChat channel: not configured (optional)');
  }

  // Summary
  console.log('');
  if (fail === 0) {
    logger.success(`All checks passed (${pass}/${pass + fail})`);
  } else {
    logger.warn(`${pass} passed, ${fail} failed`);
  }
  console.log('');
}
