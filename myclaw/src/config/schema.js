/**
 * Config schema & defaults
 * 
 * Defines the structure of myclaw.json with sensible defaults.
 * Every field has a default — a fresh install works out of the box.
 */

export const CONFIG_VERSION = 1;

export const DEFAULTS = {
  // ── Meta ──
  version: CONFIG_VERSION,

  // ── Gateway ──
  gateway: {
    port: 3456,
    host: '127.0.0.1',
    logLevel: 'info',        // debug | info | warn | error
    adminToken: '',           // or env: MYCLAW_ADMIN_TOKEN
  },

  daemon: {
    pidFile: '',              // empty = $MYCLAW_HOME/run/myclaw.pid
    logFile: '',              // empty = $MYCLAW_HOME/logs/daemon.log
  },

  // ── Agent ──
  agent: {
    workspace: '~/.myclaw/workspace',
    name: 'myclaw',
    systemPrompt: '',
    timeoutSeconds: 300,
    maxHistoryTurns: 50,
  },

  // ── Model Provider ──
  provider: {
    type: 'openai',           // openai | minimax | xiaomi | ollama | custom
    apiKey: '',               // or env: MYCLAW_API_KEY / MINIMAX_API_KEY / MIMO_API_KEY
    baseUrl: '',              // auto-resolved per provider type
    model: 'gpt-4o-mini',
    temperature: 0.7,
    maxTokens: 4096,
    // Provider-specific options
    minimaxCompat: true,      // MiniMax: use OpenAI-compatible mode
  },

  // ── Channels ──
  channels: {
    enabled: [],
    defaultAgentId: 'myclaw',
    defaultUserId: 'channel-user',
    webhook: {
      enabled: false,
      token: '',              // or env: MYCLAW_CHANNEL_TOKEN
    },
    allowlist: [],
    denylist: [],
    maxMessageLength: 8000,
    rateLimit: {
      enabled: true,
      windowMs: 60000,
      maxMessages: 20,
    },
    sessionRegistry: {
      enabled: true,
    },
    // WeChat (企业微信 WeCom)
    // wechat: {
    //   webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx',
    //   corpId: '',
    //   agentId: '',
    //   secret: '',
    //   token: '',
    //   encodingAESKey: '',
    //   mentionedList: [],
    // },
    // Telegram
    // telegram: { botToken: '', allowedUsers: [] },
    // Discord
    // discord: { botToken: '', guildIds: [] },
  },

  // ── Skills ──
  skills: {
    enabled: [],           // empty = all skills enabled
    extraPaths: [],        // additional skill directories
  },

  // ── Tools ──
  tools: {
    enabled: ['read', 'write', 'exec', 'edit', 'list_files', 'grep', 'glob', 'web_fetch'],
    allowExternalPaths: false,
    exec: {
      timeout: 30,
      allowedCommands: [],
      deniedCommands: ['rm -rf /'],
    },
  },

  // ── Memory ─────────────────────────────────────────────────────────────
  memory: {
    root: '',                    // empty = ~/.myclaw/memory
    promptBudgetChars: 4000,
    promptPermissions: [],       // e.g. ["memory.read"] to inject L3/L4
    runtimePermissions: [],
    toolPermissions: [],
    compaction: {
      enabled: true,
      maxEventsBeforeCompact: 30,
      maxCharsBeforeCompact: 20000,
      maxSummaryChars: 4000,
      keepRecentEvents: 8,
    },
    proposals: {
      enabled: true,
      autoCreateFromCompaction: false,
      minConfidence: 0.7,
      maxCandidatesPerSummary: 5,
    },
  },

  approval: {
    mode: 'manual',              // manual | deny | auto_for_tests
  },

  storage: {
    atomicWrites: {
      enabled: true,
    },
  },

  audit: {
    rotation: {
      enabled: true,
      maxSizeBytes: 10 * 1024 * 1024,
      maxFiles: 5,
    },
  },

  events: {
    maxRecentEvents: 200,
  },
};

/**
 * Schema for config validation.
 * Each field: { type, required, default, enum?, validate? }
 */
export const SCHEMA = {
  version:                { type: 'number', required: true },

  'gateway.port':         { type: 'number', required: false, validate: v => v > 0 && v < 65536 },
  'gateway.host':         { type: 'string', required: false },
  'gateway.logLevel':     { type: 'string', required: false, enum: ['debug', 'info', 'warn', 'error'] },
  'gateway.adminToken':    { type: 'string', required: false },

  'daemon.pidFile':        { type: 'string', required: false },
  'daemon.logFile':        { type: 'string', required: false },

  'agent.workspace':      { type: 'string', required: true },
  'agent.name':           { type: 'string', required: false },
  'agent.systemPrompt':   { type: 'string', required: false },
  'agent.timeoutSeconds': { type: 'number', required: false, validate: v => v > 0 },
  'agent.maxHistoryTurns':{ type: 'number', required: false, validate: v => v > 0 },

  'provider.type':        { type: 'string', required: true, enum: ['openai', 'minimax', 'xiaomi', 'ollama', 'custom'] },
  'provider.apiKey':      { type: 'string', required: false },
  'provider.baseUrl':     { type: 'string', required: false },
  'provider.model':       { type: 'string', required: true },
  'provider.temperature': { type: 'number', required: false, validate: v => v >= 0 && v <= 2 },
  'provider.maxTokens':   { type: 'number', required: false, validate: v => v > 0 },

  'tools.enabled':        { type: 'object', required: false },  // string[]
  'tools.allowExternalPaths': { type: 'boolean', required: false },

  'channels.enabled':             { type: 'object', required: false },  // string[]
  'channels.defaultAgentId':      { type: 'string', required: false },
  'channels.defaultUserId':       { type: 'string', required: false },
  'channels.webhook.enabled':     { type: 'boolean', required: false },
  'channels.webhook.token':       { type: 'string', required: false },
  'channels.allowlist':           { type: 'object', required: false },
  'channels.denylist':            { type: 'object', required: false },
  'channels.maxMessageLength':    { type: 'number', required: false, validate: v => v > 0 },
  'channels.rateLimit.enabled':   { type: 'boolean', required: false },
  'channels.rateLimit.windowMs':  { type: 'number', required: false, validate: v => v > 0 },
  'channels.rateLimit.maxMessages': { type: 'number', required: false, validate: v => v > 0 },
  'channels.sessionRegistry.enabled': { type: 'boolean', required: false },

  'memory.root':                 { type: 'string', required: false },
  'memory.promptBudgetChars':    { type: 'number', required: false, validate: v => v > 0 },
  'memory.promptPermissions':    { type: 'object', required: false },  // string[]
  'memory.runtimePermissions':   { type: 'object', required: false },  // string[]
  'memory.toolPermissions':      { type: 'object', required: false },  // string[]
  'memory.compaction.enabled':   { type: 'boolean', required: false },
  'memory.compaction.maxEventsBeforeCompact': { type: 'number', required: false, validate: v => v > 0 },
  'memory.compaction.maxCharsBeforeCompact':  { type: 'number', required: false, validate: v => v > 0 },
  'memory.compaction.maxSummaryChars':        { type: 'number', required: false, validate: v => v > 0 },
  'memory.compaction.keepRecentEvents':       { type: 'number', required: false, validate: v => v >= 0 },
  'memory.proposals.enabled':                 { type: 'boolean', required: false },
  'memory.proposals.autoCreateFromCompaction':{ type: 'boolean', required: false },
  'memory.proposals.minConfidence':           { type: 'number', required: false, validate: v => v >= 0 && v <= 1 },
  'memory.proposals.maxCandidatesPerSummary': { type: 'number', required: false, validate: v => v > 0 },

  'approval.mode':        { type: 'string', required: false, enum: ['manual', 'deny', 'auto_for_tests'] },

  'storage.atomicWrites.enabled': { type: 'boolean', required: false },

  'audit.rotation.enabled':       { type: 'boolean', required: false },
  'audit.rotation.maxSizeBytes':  { type: 'number', required: false, validate: v => v > 0 },
  'audit.rotation.maxFiles':      { type: 'number', required: false, validate: v => v > 0 },

  'events.maxRecentEvents':       { type: 'number', required: false, validate: v => v > 0 },
};
