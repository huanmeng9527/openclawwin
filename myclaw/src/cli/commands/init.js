/**
 * `myclaw init` — Initialize a fresh myclaw environment
 * 
 * Creates config file + workspace directory with bootstrap files.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

const WORKSPACE_FILES = {
  'AGENTS.md': `# AGENTS.md\n\nYour agent instructions go here.\n`,
  'SOUL.md': `# SOUL.md\n\nDefine your agent's persona and tone.\n`,
  'MEMORY.md': `# MEMORY.md\n\nLong-term memory for your agent.\n`,
  'USER.md': `# USER.md\n\nAbout you — the human behind the keyboard.\n`,
};

export function initCommand(opts) {
  const configDir = Config.getConfigDir();
  const configPath = Config.getConfigPath();
  const force = opts.force || false;

  logger.banner('Initializing MyClaw');

  // 1. Check if already initialized
  if (Config.exists(configPath) && !force) {
    logger.warn(`Config already exists at ${configPath}`);
    logger.info('Use --force to reinitialize (overwrites config)');
    return;
  }

  // 2. Create config
  const cfg = Config.init(configPath);
  logger.success(`Config created: ${configPath}`);

  // 3. Create workspace
  const workspace = cfg.get('agent.workspace');
  const expandedWorkspace = workspace.replace('~', process.env.HOME || process.env.USERPROFILE);

  if (!fs.existsSync(expandedWorkspace)) {
    fs.mkdirSync(expandedWorkspace, { recursive: true });
    logger.success(`Workspace created: ${expandedWorkspace}`);
  } else {
    logger.info(`Workspace already exists: ${expandedWorkspace}`);
  }

  // 4. Create bootstrap files
  for (const [filename, content] of Object.entries(WORKSPACE_FILES)) {
    const filePath = path.join(expandedWorkspace, filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content, 'utf-8');
      logger.success(`  Created ${filename}`);
    } else {
      logger.debug(`  Skipped ${filename} (exists)`);
    }
  }

  // 5. Summary
  console.log('');
  logger.info('Next steps:');
  console.log(`  1. Set your API key:    ${COLORS_CMD}myclaw config set provider.apiKey YOUR_KEY${COLORS_RESET}`);
  console.log(`  2. Choose a model:      ${COLORS_CMD}myclaw config set provider.model gpt-4o-mini${COLORS_RESET}`);
  console.log(`  3. Check health:        ${COLORS_CMD}myclaw doctor${COLORS_RESET}`);
  console.log(`  4. Start the gateway:   ${COLORS_CMD}myclaw gateway start${COLORS_RESET}`);
  console.log('');
}

const COLORS_CMD = '\x1b[36m';
const COLORS_RESET = '\x1b[0m';
