/**
 * `myclaw sessions` — Session management commands
 * 
 * Subcommands:
 *   myclaw sessions list              — list all sessions
 *   myclaw sessions new [name]        — create a new session
 *   myclaw sessions show <id>         — show session details
 *   myclaw sessions delete <id>       — delete a session
 *   myclaw sessions prune [keep]      — delete old sessions (keep N most recent)
 *   myclaw sessions history <id>      — show message history
 */

import { SessionManager } from '../../session/index.js';
import { logger } from '../../utils/logger.js';

const mgr = new SessionManager();

export function sessionsListCommand() {
  const sessions = mgr.list();

  if (sessions.length === 0) {
    logger.info('No sessions found.');
    logger.info('Start one with: myclaw chat "hello"');
    return;
  }

  logger.banner(`Sessions (${sessions.length})`);

  for (const s of sessions) {
    const name = s.name || '(unnamed)';
    const preview = s.preview.length > 60 ? s.preview.slice(0, 60) + '...' : s.preview;
    console.log(
      `  \x1b[36m${s.id}\x1b[0m  ` +
      `${s.messages.toString().padStart(4)} msgs  ` +
      `\x1b[90m${s.updated.slice(0, 16)}\x1b[0m  ` +
      `${name !== '(unnamed)' ? `\x1b[33m${name}\x1b[0m  ` : ''}` +
      `${preview}`
    );
  }
  console.log('');
}

export function sessionsNewCommand(name) {
  const session = mgr.create(name || '');
  logger.success(`Session created: ${session.id}`);
  if (name) logger.info(`Name: ${name}`);
}

export function sessionsShowCommand(id) {
  try {
    const session = mgr.load(id);
    const summary = session.summary;

    logger.banner(`Session ${id}`);
    const rows = [
      ['ID', summary.id],
      ['Name', summary.name || '(unnamed)'],
      ['Created', summary.created],
      ['Updated', summary.updated],
      ['Messages', `${summary.messages} total (${summary.userMessages} user, ${summary.toolCalls} tool)`],
      ['Preview', summary.preview],
    ];

    for (const [label, value] of rows) {
      console.log(`  \x1b[36m${label.padEnd(10)}\x1b[0m ${value}`);
    }
    console.log('');
  } catch (err) {
    logger.error(err.message);
    process.exit(1);
  }
}

export function sessionsDeleteCommand(id) {
  if (mgr.delete(id)) {
    logger.success(`Deleted session: ${id}`);
  } else {
    logger.error(`Session not found: ${id}`);
    process.exit(1);
  }
}

export function sessionsPruneCommand(keep) {
  const n = parseInt(keep, 10) || 10;
  const deleted = mgr.prune(n);
  if (deleted > 0) {
    logger.success(`Pruned ${deleted} session(s), kept ${n} most recent`);
  } else {
    logger.info(`Nothing to prune (${mgr.list().length} sessions, keeping ${n})`);
  }
}

export function sessionsHistoryCommand(id) {
  try {
    const session = mgr.load(id);

    logger.banner(`Session ${id} — History`);

    for (const msg of session.messages) {
      const time = msg.timestamp ? `\x1b[90m${msg.timestamp.slice(11, 19)}\x1b[0m ` : '';
      const role = msg.role === 'user'
        ? '\x1b[32mYou\x1b[0m'
        : msg.role === 'assistant'
          ? '\x1b[36mAgent\x1b[0m'
          : msg.role === 'tool'
            ? '\x1b[33mTool\x1b[0m'
            : msg.role;

      const content = msg.content || '';
      const preview = content.length > 200 ? content.slice(0, 200) + '...' : content;

      console.log(`${time}${role}: ${preview}`);
    }
    console.log('');
  } catch (err) {
    logger.error(err.message);
    process.exit(1);
  }
}
