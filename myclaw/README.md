# MyClaw — AI Agent Framework

A minimal Claude Code-inspired AI agent architecture. Production-grade module boundaries, clean public API.

## Quick Start

```bash
npm install
node bin/myclaw.js init
node bin/myclaw.js config set provider.apiKey YOUR_KEY
node bin/myclaw.js chat "Hello!"
```

## Four-Layer Memory

MyClaw now has a minimal OpenClaw-style memory skeleton connected to `QueryEngine`.

- `L1 Working`: in-process current-turn/task context.
- `L2 Session`: persistent per-session transcript events.
- `L3 Semantic`: long-term facts/preferences/project notes with Markdown as canonical source.
- `L4 Procedural`: skills, tool recipes, playbooks, and policy hints with Markdown as canonical source.
- `PromptAssembler` calls `MemoryRouter.retrieveForPrompt()` and injects a bounded `[Memory Context]` section.
- L2 session compaction can summarize older transcript events while keeping the summary in L2 only.
- Stable fact candidates can be stored as review-only L3 proposals; they are never auto-written to L3.
- Procedural memory is guidance only; tool execution still goes through `ToolPolicy`, `PermissionRules`, and `canUseTool()`.

See `docs/memory_architecture.md`, `docs/compaction.md`, and `docs/memory_proposals.md` for data flow, policy rules, storage layout, L2 summaries, proposals, and limitations.

## Workspace Sandbox

Local file and command tools are constrained to `config.agent.workspace` by default:

- relative paths resolve from the workspace
- absolute paths must still point inside the workspace
- `../` traversal and symlink escapes are rejected
- `exec` runs with `cwd = agent.workspace` unless a safe workspace-relative `cwd` is provided

Set `tools.allowExternalPaths: true` only for trusted local use. It allows external paths, but it does not bypass `ToolPolicy`, `PermissionRules`, or memory policy. See `docs/security.md` for details.

### Memory Runtime Smoke Test

Run the full test suite and the fake-provider memory smoke test without calling a real model API:

```bash
npm install
npm test
npm run check:syntax
npm run smoke:memory
node bin/myclaw.js --help
node bin/myclaw.js init
```

`npm run smoke:memory` verifies:

- a fake provider can run through `QueryEngine` without external API calls
- the second turn retrieves the first turn from L2 into `[Memory Context]`
- L3/L4 are skipped when `memory.read` is absent
- `memory.write` and `memory.procedural.write` gates reject unauthorized writes
- destructive `exec` is denied without an explicit approved request
- procedural memory never grants tool execution permission

### Isolated Test Home

Set `MYCLAW_HOME` to run CLI, sessions, and memory storage in an isolated directory:

```bash
export MYCLAW_HOME="$(mktemp -d)"
node bin/myclaw.js init
npm run smoke:memory
```

When `MYCLAW_HOME` is set and `agent.workspace` has not been explicitly configured, `myclaw init` creates the default workspace at `$MYCLAW_HOME/workspace`. Existing configs with an explicit `agent.workspace` keep that value for backward compatibility.

Tools configured as `ask`, and destructive tools such as `exec`, are denied safely unless an explicit approval decision allows them.

MyClaw includes a minimal headless `ApprovalBroker` lifecycle for tests and future CLI integration. It creates pending requests by default and never auto-approves unless explicitly configured with `approval.mode = "auto_for_tests"`. See `docs/approval.md`.

Security decisions are also written to a JSONL audit log at `$MYCLAW_HOME/audit/audit.log`. Approval requests are persisted at `$MYCLAW_HOME/approvals/approvals.json`. See `docs/audit.md`, `docs/approval.md`, and `docs/cli.md`.

Local JSON/Markdown persistence uses atomic writes and corrupt JSON backup where supported. Audit logs rotate by size; see `docs/storage.md`.

Gateway management APIs for approvals, audit, memory proposals, and read-only SSE events require `gateway.adminToken` or `MYCLAW_ADMIN_TOKEN`; see `docs/gateway_api.md` and `docs/events.md`. The minimal channel bridge skeleton adds generic `InternalMessage`, `ChannelRouter`, test bridges, a disabled-by-default HTTP webhook, persistent channel session mapping, and channel guardrails; see `docs/channels.md` and `docs/channel_security.md`. The minimal daemon skeleton can run the Gateway as a foreground local control process; see `docs/daemon.md`.

## Commands

| Command | Description |
|---------|-------------|
| `myclaw init [--force]` | Initialize config + workspace |
| `myclaw config show\|get\|set\|validate` | Manage configuration |
| `myclaw status` | Status overview |
| `myclaw doctor` | Health check & diagnostics |
| `myclaw chat [message]` | Chat (streaming, session-aware) |
| `myclaw chat --session <id>` | Continue session |
| `myclaw sessions list\|new\|show\|history\|delete\|prune` | Session management |
| `myclaw approvals list\|show\|approve\|deny` | Headless approval decisions |
| `myclaw audit tail\|query` | Read JSONL audit events |
| `myclaw memory proposals list\|show\|approve\|reject\|write` | Review L3 semantic memory proposals |
| `myclaw serve` | WeChat callback server |
| `myclaw gateway` | Gateway HTTP API server |
| `myclaw daemon start\|stop\|status\|restart` | Foreground daemon skeleton for Gateway control API |

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                      ENTRY LAYER                         │
│  bin/myclaw.js ──> CLI commands ──> REPL / headless      │
└────────────────────────┬─────────────────────────────────┘
                         ▼
┌──────────────────────────────────────────────────────────┐
│                    QUERY ENGINE                          │
│  query(prompt) ──> AsyncGenerator<SDKMessage>            │
│    ├── fetchSystemPromptParts()  ← prompt assembly       │
│    ├── processUserInput()        ← /commands             │
│    ├── query()                   ← agent loop            │
│    │     ├── autoCompact()       ← context compression   │
│    │     ├── canUseTool()        ← permission check      │
│    │     ├── StreamingToolExecutor ← parallel/serial     │
│    │     └── recordTranscript()  ← persistence           │
│    └── yield SDKMessage          ← event stream          │
└────────────────────────┬─────────────────────────────────┘
           ┌─────────────┼─────────────┐
           ▼             ▼             ▼
┌────────────────┐ ┌──────────┐ ┌────────────────┐
│   TOOL SYSTEM  │ │ SERVICES │ │     STATE      │
│                │ │          │ │                │
│ ToolInterface  │ │ Provider │ │ SessionManager │
│ ├ validateInput│ │ ├ OpenAI  │ │ ├ create/load  │
│ ├ checkPerms   │ │ ├ MiniMax │ │ ├ export/import│
│ ├ call()       │ │ ├ Xiaomi  │ │ └ prune/search │
│ ├ isReadOnly   │ │ └ Ollama  │ │                │
│ ├ isDestructive│ │          │ │ SkillLoader    │
│ └ concurrency  │ │ Channels │ │ PluginManager  │
│                │ │ ├ WeChat  │ │ Compaction     │
│ StreamingTool- │ │ └ (more)  │ │                │
│ Executor       │ │          │ │                │
│ (parallel/     │ │ Gateway  │ │                │
│  serial)       │ │ HTTP API │ │                │
└────────────────┘ └──────────┘ └────────────────┘
```

## Tools (8 built-in)

| Tool | ReadOnly | Concurrent | Destructive | Description |
|------|----------|------------|-------------|-------------|
| read | ✅ | ✅ | ❌ | Read file / list directory |
| write | ❌ | ✅ | ❌ | Write file |
| edit | ❌ | ❌ | ❌ | String-replace editing |
| exec | ❌ | ❌ | ✅ | Execute shell command |
| list_files | ✅ | ✅ | ❌ | List files with sizes |
| grep | ✅ | ✅ | ❌ | Search file contents |
| glob | ✅ | ✅ | ❌ | Find files by pattern |
| web_fetch | ✅ | ✅ | ❌ | Fetch URL content |

## Providers

| Type | Base URL | Models |
|------|----------|--------|
| `openai` | api.openai.com/v1 | gpt-4o, gpt-4o-mini |
| `minimax` | api.minimaxi.com | MiniMax-Text-01 |
| `xiaomi` | api.xiaomimimo.com/v1 | mimo-v2-pro, mimo-v2-flash |
| `ollama` | localhost:11434/v1 | llama3, etc. |

## Permission System (3 layers)

```
Layer 1: Policy    — config: tools.policies = { exec: "ask" }
Layer 2: Rules     — pattern: { tool: "exec", pattern: "rm -rf*", action: "deny" }
Layer 3: Plugins   — tool_before hook can veto
```

## Gateway HTTP API

```bash
myclaw gateway              # start on port 3456
curl http://localhost:3456/api/health
curl -X POST http://localhost:3456/api/agent -d '{"message":"hello"}'
curl http://localhost:3456/api/sessions
curl http://localhost:3456/api/status
```

## Project Structure

```
myclaw/
├── bin/myclaw.js
├── src/
│   ├── engine/          ← QueryEngine + AgentLoop (compat)
│   ├── cli/commands/    ← CLI commands
│   ├── config/          ← Config management
│   ├── provider/        ← OpenAI, MiniMax, Xiaomi + retry/errors
│   ├── gateway/         ← HTTP API server
│   ├── session/         ← Session persistence + export/import
│   ├── skills/          ← Skill discovery
│   ├── plugins/         ← Plugin hooks (6 lifecycle events)
│   ├── compaction/      ← Context compression
│   ├── streaming/       ← SSE stream parser
│   ├── channels/        ← WeCom (WeChat) adapter
│   ├── tools/
│   │   ├── interface.js    ← ToolInterface (lifecycle)
│   │   ├── registry.js     ← ToolRegistry
│   │   ├── policy.js       ← Tool policy
│   │   ├── permissions.js  ← Permission engine
│   │   ├── executor.js     ← StreamingToolExecutor
│   │   ├── builtin.js      ← read/write/exec/list_files
│   │   ├── edit.js         ← string-replace editing
│   │   ├── grep.js         ← content search
│   │   ├── glob.js         ← file pattern search
│   │   └── web_fetch.js    ← URL fetcher
│   └── utils/
└── README.md
```
