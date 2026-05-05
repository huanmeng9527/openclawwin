/**
 * `myclaw chat` — Chat with QueryEngine event stream
 */

import readline from 'node:readline';
import { Config } from '../../config/index.js';
import { QueryEngine } from '../../engine/index.js';
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

export async function chatCommand(message, opts) {
  const cfg = loadConfig();
  const engine = new QueryEngine(cfg.all());
  await engine.init();

  const apiKey = cfg.get('provider.apiKey') || process.env.MYCLAW_API_KEY;
  if (!apiKey && cfg.get('provider.type') !== 'ollama') {
    logger.error('No API key configured.');
    logger.info('Set via: myclaw config set provider.apiKey YOUR_KEY');
    process.exit(1);
  }

  let session;
  if (opts.session) {
    try { session = engine.sessions.load(opts.session); }
    catch { logger.error(`Session not found: ${opts.session}`); process.exit(1); }
  } else if (opts.new) {
    session = engine.sessions.create();
  }

  if (message) {
    await singleTurn(engine, message, session, opts);
  } else {
    await interactiveMode(engine, cfg, session);
  }
}

async function singleTurn(engine, message, session, opts) {
  if (!opts.quiet) logger.info(`You: ${message}\n`);

  try {
    let result;
    for await (const event of engine.query(message, session, { stream: !opts.noStream })) {
      switch (event.type) {
        case 'stream_start':
          process.stdout.write(`\n`);
          break;
        case 'stream_end':
          // text already printed by streaming
          break;
        case 'tool_result':
          if (!opts.quiet) {
            const icon = event.denied ? '🚫' : '🔧';
            logger.debug(`${icon} ${event.toolName}: ${event.result.slice(0, 100)}`);
          }
          break;
        case 'compaction':
          logger.debug(`📦 Compacted: -${event.removed} msgs, saved ~${event.tokensSaved} tokens`);
          break;
        case 'result':
          result = event;
          if (opts.noStream) {
            console.log(`\n${'─'.repeat(50)}`);
            console.log(event.text);
            console.log(`${'─'.repeat(50)}`);
          }
          console.log(`\n\x1b[90m[session: ${event.sessionId} | iter: ${event.iterations} | tokens: ${event.usage.total_tokens}${event.compacted ? ' | compacted' : ''}]\x1b[0m\n`);
          break;
        case 'error':
          logger.error(event.text);
          break;
      }
    }
  } catch (err) {
    logger.error(`Agent error: ${err.message}`);
    process.exit(1);
  }
}

async function interactiveMode(engine, cfg, session) {
  const agentName = cfg.get('agent.name') || 'myclaw';

  if (!session) {
    session = engine.sessions.latest();
    if (session) {
      logger.info(`Resuming session: ${session.id} (${session.messages.length} msgs)`);
    } else {
      session = engine.sessions.create();
    }
  }

  logger.banner(`${agentName} Chat`);
  logger.info(`Session: ${session.id}`);
  logger.info(`Model: ${cfg.get('provider.type')}:${cfg.get('provider.model')}`);
  logger.info(`Tools: ${engine.getToolNames().join(', ')}`);
  const skills = engine.skills.getEnabled();
  if (skills.length > 0) logger.info(`Skills: ${skills.map(s => s.name).join(', ')}`);
  logger.info('Commands: exit | new | sessions | history\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `\x1b[32mYou>\x1b[0m `,
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    switch (input.toLowerCase()) {
      case 'exit': case 'quit': case 'q':
        console.log('Bye!'); rl.close(); return;
      case 'new':
        session = engine.sessions.create();
        logger.success(`New session: ${session.id}\n`);
        rl.prompt(); return;
      case 'sessions':
        for (const s of engine.sessions.list()) {
          console.log(`  ${s.id}  ${s.messages} msgs  ${s.updated.slice(0, 16)}  ${s.name || ''}`);
        }
        console.log(''); rl.prompt(); return;
      case 'history':
        for (const msg of session.messages.slice(-10)) {
          const role = msg.role === 'user' ? 'You' : msg.role === 'assistant' ? agentName : 'Tool';
          console.log(`  ${role}: ${(msg.content || '').slice(0, 100)}`);
        }
        console.log(''); rl.prompt(); return;
    }

    try {
      let result;
      for await (const event of engine.query(input, session)) {
        switch (event.type) {
          case 'tool_result':
            const icon = event.denied ? '🚫' : '🔧';
            console.log(`  ${icon} ${event.toolName}`);
            break;
          case 'compaction':
            console.log(`  📦 Context compacted`);
            break;
          case 'result':
            result = event;
            console.log(`\n\x1b[36m${agentName}>\x1b[0m ${event.text}`);
            console.log(`\x1b[90m[${event.sessionId} | ${event.iterations} iter | ${event.usage.total_tokens} tok]\x1b[0m\n`);
            break;
          case 'error':
            logger.error(event.text);
            break;
        }
      }
      if (result?.sessionId) {
        try { session = engine.sessions.load(result.sessionId); } catch {}
      }
    } catch (err) {
      logger.error(`Error: ${err.message}\n`);
    }

    rl.prompt();
  });

  rl.on('close', () => process.exit(0));
}
