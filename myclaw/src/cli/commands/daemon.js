import { Config } from '../../config/index.js';
import { DaemonManager } from '../../daemon/index.js';
import { logger } from '../../utils/logger.js';

export async function daemonStartCommand(options = {}) {
  const config = loadConfigData({ requireConfig: true });
  const manager = new DaemonManager(config);

  logger.banner('MyClaw Daemon');
  if (!options.foreground) {
    logger.info('Background service mode is not implemented yet; running in foreground.');
  }

  const status = await manager.start();
  printStatus(status);
  logger.success(`Gateway running at http://${status.gatewayHost}:${status.gatewayPort}`);
  logger.info('Press Ctrl+C to stop the foreground daemon.');

  installShutdownHandlers(manager);
}

export async function daemonStopCommand() {
  const manager = new DaemonManager(loadConfigData());
  const result = await manager.stop();
  console.log(JSON.stringify(result, null, 2));
}

export function daemonStatusCommand() {
  const manager = new DaemonManager(loadConfigData());
  printStatus(manager.status());
}

export async function daemonRestartCommand(options = {}) {
  const config = loadConfigData({ requireConfig: true });
  const manager = new DaemonManager(config);
  const result = await manager.restart();
  printStatus(result.started);
  if (!options.foreground) {
    logger.info('Background service mode is not implemented yet; running in foreground.');
  }
  logger.success(`Gateway running at http://${result.started.gatewayHost}:${result.started.gatewayPort}`);
  logger.info('Press Ctrl+C to stop the foreground daemon.');
  installShutdownHandlers(manager);
}

function loadConfigData(options = {}) {
  if (!Config.exists()) {
    if (options.requireConfig) {
      logger.error('Config not found. Run `myclaw init` first.');
      process.exit(1);
    }
    return {};
  }
  const cfg = new Config();
  return cfg.load().all();
}

function printStatus(status) {
  console.log(JSON.stringify({
    running: status.running,
    stale: status.stale,
    pid: status.pid,
    gatewayHost: status.gatewayHost,
    gatewayPort: status.gatewayPort,
    myclawHome: status.myclawHome,
    pidFile: status.pidFile,
    logFile: status.logFile,
    startedAt: status.startedAt,
  }, null, 2));
}

function installShutdownHandlers(manager) {
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await manager.gracefulShutdown();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
