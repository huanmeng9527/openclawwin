import { Gateway } from '../gateway/index.js';
import {
  cleanupStalePid,
  defaultLogPath,
  defaultPidPath,
  getMyClawHome,
  isPidRunning,
  readPidFile,
  removePidFile,
  writePidFile,
} from './pidfile.js';

export class DaemonManager {
  constructor(config = {}, options = {}) {
    this.config = config;
    this.gateway = options.gateway || null;
    this.gatewayDeps = options.gatewayDeps || {};
    this.pidFile = options.pidFile || defaultPidPath(config);
    this.logFile = options.logFile || defaultLogPath(config);
    this.startedAt = null;
  }

  async start(options = {}) {
    const stale = cleanupStalePid(this.pidFile);
    if (!stale.stale && stale.record && isPidRunning(stale.record.pid)) {
      throw new Error(`Daemon already running with pid ${stale.record.pid}`);
    }

    this._assertSafeGatewayConfig();
    this.gateway = options.gateway || this.gateway || new Gateway(this.config, options.gatewayDeps || this.gatewayDeps);

    try {
      await this.gateway.start();
      this.startedAt = new Date().toISOString();
      writePidFile(this.pidFile, {
        pid: process.pid,
        startedAt: this.startedAt,
        gateway: this._gatewayAddress(),
        myclawHome: getMyClawHome(this.config),
        logFile: this.logFile,
      }, { config: this.config });
      return this.status();
    } catch (err) {
      await this._stopGateway();
      removePidFile(this.pidFile);
      throw err;
    }
  }

  async stop(options = {}) {
    const record = readPidFile(this.pidFile);
    if (!record) {
      return {
        running: false,
        stopped: false,
        stale: false,
        reason: 'not_running',
        pidFile: this.pidFile,
      };
    }

    if (!isPidRunning(record.pid)) {
      removePidFile(this.pidFile);
      return {
        running: false,
        stopped: false,
        stale: true,
        removed: true,
        pid: record.pid,
        pidFile: this.pidFile,
      };
    }

    if (record.pid === process.pid) {
      await this._stopGateway();
      removePidFile(this.pidFile);
      return {
        running: false,
        stopped: true,
        stale: false,
        pid: record.pid,
        pidFile: this.pidFile,
      };
    }

    if (options.signal !== false) {
      process.kill(record.pid, options.signalName || 'SIGTERM');
      return {
        running: true,
        stopped: false,
        signaled: true,
        signal: options.signalName || 'SIGTERM',
        pid: record.pid,
        pidFile: this.pidFile,
      };
    }

    return {
      running: true,
      stopped: false,
      signaled: false,
      pid: record.pid,
      pidFile: this.pidFile,
    };
  }

  async restart(options = {}) {
    const stopped = await this.stop({ signal: false });
    if (stopped.running && !stopped.stale) {
      throw new Error(`Cannot restart while daemon pid ${stopped.pid} is still running`);
    }
    const started = await this.start(options);
    return { stopped, started };
  }

  status(options = {}) {
    let record = readPidFile(this.pidFile);
    let stale = false;
    if (record && !isPidRunning(record.pid)) {
      stale = true;
      if (options.cleanupStale) {
        removePidFile(this.pidFile);
        record = null;
      }
    }

    const gateway = record?.gateway || this._configuredGatewayAddress();
    return {
      running: !!(record && !stale),
      stale,
      pid: record?.pid || null,
      startedAt: record?.startedAt || null,
      gatewayHost: gateway.host || this.config.gateway?.host || '127.0.0.1',
      gatewayPort: gateway.port ?? this.config.gateway?.port ?? 3456,
      myclawHome: record?.myclawHome || getMyClawHome(this.config),
      pidFile: this.pidFile,
      logFile: record?.logFile || this.logFile,
    };
  }

  isRunning() {
    return this.status().running;
  }

  async gracefulShutdown() {
    return this.stop({ signal: false });
  }

  _assertSafeGatewayConfig() {
    const host = this.config.gateway?.host || '127.0.0.1';
    const token = this.config.gateway?.adminToken || process.env.MYCLAW_ADMIN_TOKEN || '';
    if (isPublicHost(host) && !token) {
      throw new Error('Refusing to start daemon on a public host without gateway.adminToken or MYCLAW_ADMIN_TOKEN');
    }
  }

  _gatewayAddress() {
    const address = this.gateway?._server?.address?.();
    const configured = this._configuredGatewayAddress();
    if (address && typeof address === 'object') {
      return {
        host: configured.host,
        port: address.port,
      };
    }
    return configured;
  }

  _configuredGatewayAddress() {
    return {
      host: this.config.gateway?.host || '127.0.0.1',
      port: this.config.gateway?.port ?? 3456,
    };
  }

  async _stopGateway() {
    if (!this.gateway) return;
    await this.gateway.stop?.();
    this.gateway = null;
  }
}

export function isPublicHost(host) {
  return ['0.0.0.0', '::', '[::]'].includes(host);
}
