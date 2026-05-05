#!/usr/bin/env node

/**
 * MyClaw CLI
 */

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { initCommand } from '../src/cli/commands/init.js';
import { configShowCommand, configGetCommand, configSetCommand, configPathCommand, configValidateCommand } from '../src/cli/commands/config.js';
import { statusCommand } from '../src/cli/commands/status.js';
import { doctorCommand } from '../src/cli/commands/doctor.js';
import { chatCommand } from '../src/cli/commands/chat.js';
import { serveCommand } from '../src/cli/commands/serve.js';
import { gatewayStartCommand } from '../src/cli/commands/gateway.js';
import { daemonRestartCommand, daemonStartCommand, daemonStatusCommand, daemonStopCommand } from '../src/cli/commands/daemon.js';
import { sessionsListCommand, sessionsNewCommand, sessionsShowCommand, sessionsDeleteCommand, sessionsPruneCommand, sessionsHistoryCommand } from '../src/cli/commands/sessions.js';
import { approvalsApproveCommand, approvalsDenyCommand, approvalsListCommand, approvalsShowCommand } from '../src/cli/commands/approvals.js';
import { auditQueryCommand, auditTailCommand } from '../src/cli/commands/audit.js';
import {
  memoryProposalsApproveCommand,
  memoryProposalsListCommand,
  memoryProposalsRejectCommand,
  memoryProposalsShowCommand,
  memoryProposalsWriteCommand,
} from '../src/cli/commands/memory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));

const program = new Command();

program.name('myclaw').description('MyClaw — AI Agent Framework').version(pkg.version, '-v, --version');

// init
program.command('init').description('Initialize config + workspace').option('-f, --force', 'Overwrite').action(initCommand);

// config
const cfg = program.command('config').description('Configuration');
cfg.command('show').description('Show full config').action(configShowCommand);
cfg.command('get <key>').description('Get value').action(configGetCommand);
cfg.command('set <key> <value>').description('Set value').action(configSetCommand);
cfg.command('path').description('Config file path').action(configPathCommand);
cfg.command('validate').description('Validate config').action(configValidateCommand);

// status / doctor
program.command('status').description('Status overview').action(statusCommand);
program.command('doctor').description('Health check').action(doctorCommand);

// chat
program.command('chat [message]').description('Chat with agent')
  .option('-s, --session <id>', 'Continue session')
  .option('-n, --new', 'New session')
  .option('-q, --quiet', 'Minimal output')
  .option('--no-stream', 'Disable streaming')
  .action(chatCommand);

// sessions
const sess = program.command('sessions').description('Session management');
sess.command('list').description('List sessions').action(sessionsListCommand);
sess.command('new [name]').description('Create session').action(sessionsNewCommand);
sess.command('show <id>').description('Session details').action(sessionsShowCommand);
sess.command('delete <id>').description('Delete session').action(sessionsDeleteCommand);
sess.command('prune [keep]').description('Prune old sessions').action(sessionsPruneCommand);
sess.command('history <id>').description('Message history').action(sessionsHistoryCommand);

// approvals
const approvals = program.command('approvals').description('Approval request management');
approvals.command('list').description('List approval requests')
  .option('--all', 'Show all statuses')
  .option('--status <status>', 'Filter by status: pending|approved|denied|expired')
  .action(approvalsListCommand);
approvals.command('show <id>').description('Show approval request details').action(approvalsShowCommand);
approvals.command('approve <id>').description('Approve an approval request')
  .option('--reason <reason>', 'Decision reason')
  .action(approvalsApproveCommand);
approvals.command('deny <id>').description('Deny an approval request')
  .option('--reason <reason>', 'Decision reason')
  .action(approvalsDenyCommand);

// audit
const audit = program.command('audit').description('Audit log queries');
audit.command('tail').description('Show recent audit events')
  .option('--lines <lines>', 'Number of recent events', '20')
  .action(auditTailCommand);
audit.command('query').description('Query audit events')
  .option('--event-type <eventType>', 'Filter by event type')
  .option('--decision <decision>', 'Filter by decision')
  .option('--tool <toolName>', 'Filter by tool name')
  .option('--session <sessionId>', 'Filter by session id')
  .option('--user <userId>', 'Filter by user id')
  .option('--agent <agentId>', 'Filter by agent id')
  .option('--approval <approvalId>', 'Filter by approval id')
  .option('--since <iso>', 'Only events since timestamp')
  .option('--until <iso>', 'Only events until timestamp')
  .option('--limit <limit>', 'Maximum events', '100')
  .action(auditQueryCommand);

// memory
const memory = program.command('memory').description('Memory management');
const memoryProposals = memory.command('proposals').description('L3 semantic memory proposals');
memoryProposals.command('list').description('List memory proposals')
  .option('--all', 'Show all statuses')
  .option('--status <status>', 'Filter by status: pending|approved|rejected|written')
  .action(memoryProposalsListCommand);
memoryProposals.command('show <id>').description('Show memory proposal details').action(memoryProposalsShowCommand);
memoryProposals.command('approve <id>').description('Approve a memory proposal')
  .option('--reason <reason>', 'Decision reason')
  .action(memoryProposalsApproveCommand);
memoryProposals.command('reject <id>').description('Reject a memory proposal')
  .option('--reason <reason>', 'Decision reason')
  .action(memoryProposalsRejectCommand);
memoryProposals.command('write <id>').description('Write an approved proposal to L3 semantic memory')
  .action(memoryProposalsWriteCommand);

// serve (WeChat)
program.command('serve').description('Start WeChat callback server')
  .option('-p, --port <port>', 'Listen port', '8080')
  .action(serveCommand);

// gateway
program.command('gateway').description('Start Gateway HTTP API')
  .option('-p, --port <port>', 'Listen port')
  .action(gatewayStartCommand);

// daemon
const daemon = program.command('daemon').description('Local daemon control process');
daemon.command('start').description('Start daemon and Gateway API')
  .option('--foreground', 'Run in foreground')
  .action(daemonStartCommand);
daemon.command('stop').description('Stop daemon or clean stale pid').action(daemonStopCommand);
daemon.command('status').description('Show daemon status').action(daemonStatusCommand);
daemon.command('restart').description('Restart daemon in foreground')
  .option('--foreground', 'Run in foreground')
  .action(daemonRestartCommand);

program.parse();
