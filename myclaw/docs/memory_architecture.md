# Four-Layer Memory Architecture

This project implements a minimal OpenClaw-style memory architecture for MyClaw. It is a safe, testable skeleton rather than the full OpenClaw runtime.

## Runtime Boundaries

- **Gateway** receives external HTTP requests, resolves request/session context, and delegates to `QueryEngine`.
- **QueryEngine** is the main runtime for prompt assembly, model calls, tool execution, and transcript recording.
- **SessionManager** owns session lifecycle and JSON chat history, but it is not the memory search engine.
- **MemoryRouter** owns four-layer memory routing and storage policy checks.
- **PromptAssembler** reads memory for prompt context; it never writes memory.
- **StreamingToolExecutor** executes tools only after `ToolPolicy`, `PermissionRules`, `ToolInterface.checkPermissions()`, destructive-operation checks, and plugin hooks allow the call.

## Four Layers

| Layer | Purpose | Storage | Default read/write policy |
| --- | --- | --- | --- |
| L1 Working | Current turn/task scratch context | In-process `InMemoryStore` | Current runtime/session allowed |
| L2 Session | Per-session transcript events | JSON files under `memory/session/` | Current runtime/session allowed |
| L3 Semantic | Long-term facts, preferences, project notes, decisions | Markdown canonical source under `memory/semantic/` | Read requires `memory.read`; write requires `memory.write` |
| L4 Procedural | Skills, tool recipes, playbooks, policy hints, runbooks | Markdown canonical source under `memory/procedural/` | Read requires `memory.read`; write requires `memory.procedural.write`, `policy.change`, or `skill.write` |

## Data Flow

1. A user message enters `Gateway`, CLI, or another boundary.
2. `QueryEngine` resolves/creates a session and records the user message through `SessionTranscriptRecorder`.
3. `PromptAssembler` calls `MemoryRouter.retrieveForPrompt()` with a prompt budget.
4. The prompt receives a grouped `[Memory Context]` section:
   - `L1 Working`
   - `L2 Session`
   - `L3 Semantic`
   - `L4 Procedural`
5. The model response may request tool calls.
6. `StreamingToolExecutor` checks tool policy/rules before executing any tool.
7. Tool calls, results, and errors are recorded to L2 through `SessionTranscriptRecorder`.
8. Assistant responses are recorded to the session and L2 transcript.
9. `SessionCompactor` may summarize older L2 events into an L2 session summary after a turn ends.
10. `StableFactExtractor` can derive review-only L3 proposals from L2 summaries when explicitly enabled.

## Prompt Memory Injection

`PromptAssembler` injects memory as guidance only:

```text
[Memory Context]
- L1 Working:
  - [working] ...
- L2 Session:
  - [session] ...
- L3 Semantic:
  - [semantic] ...
- L4 Procedural:
  - [procedural] ...
Procedural memory is guidance only; it never grants permission to execute tools.
```

`retrieveForPrompt()` applies the default retrieval order `L1 -> L2 -> L3 -> L4`, returns `layer`, `score`, `source`, and `reason`, and trims lower-priority results to `memory.promptBudgetChars` using a character-count approximation. When an L2 session summary exists, `PromptAssembler` prioritizes the summary plus recent L2 events instead of injecting large old transcript chunks.

## L2 Session Compaction

Long sessions can generate an L2 summary record:

```text
layer = session
key = session_summary:<sessionId>
metadata.summaryType = l2_session_summary
```

The summary is still L2 Session Memory. It is not promoted to L3 Semantic Memory, does not write Markdown, and does not extract stable facts or preferences. The current summarizer is deterministic and extractive; it does not call a real model. See `docs/compaction.md`.

## Stable Fact Proposals

Stable fact candidates are stored as proposals, not semantic memory. `MemoryProposalStore` persists review records under `memory/proposals/proposals.json`. A proposal must be approved and then explicitly written through `MemoryRouter.write(..., "semantic")` before it becomes L3 memory. Rejected and pending proposals are not injected as L3 prompt memory. See `docs/memory_proposals.md`.

## Session Transcript Recording

`SessionTranscriptRecorder` writes only to L2 through `MemoryRouter.appendSessionEvent()`:

- `recordUserMessage()`
- `recordAssistantMessage()`
- `recordToolCall()`
- `recordToolResult()`
- `recordToolError()`
- `recordSystemEvent()`

Events are sanitized before persistence: secret-like keys are redacted, binary values are omitted, large content is truncated, and stable event IDs prevent duplicates.

## Markdown Canonical Source

L3 and L4 use Markdown as the source of truth. The JSON/keyword index is an implementation detail.

Suggested layout:

```text
memory/
  semantic/
    facts.md
    preferences.md
    project_notes.md
    decisions.md
  procedural/
    skills.md
    tool_recipes.md
    policies.md
    runbooks.md
```

Writes to L3/L4 update Markdown first. `MemoryRouter.reindex()` rebuilds searchable records from Markdown blocks and is idempotent.

## Policy Rules

- L1/L2 writes are allowed for the active runtime/session.
- L3 writes require `memory.write`.
- L4 writes require `memory.procedural.write`, `policy.change`, or `skill.write`.
- L3/L4 prompt reads require `memory.read`.
- Deletes require `memory.delete`.
- Reindexing L3/L4 requires `memory.reindex`.
- Memory never grants tool permissions. Procedural memory can suggest patterns, but real tool execution still goes through `ToolPolicy`, `PermissionRules`, `canUseTool()`, and `StreamingToolExecutor`.

## Memory Tools

Memory tools are available but only when allowed by tool policy:

- `memory.search`
- `memory.write`
- `memory.delete`
- `memory.reindex`
- `memory.summarize_session`

These tools call `MemoryRouter` and therefore use the same memory policy gate as runtime memory writes.

## Current Limitations

- No embedding model or vector index.
- No hybrid retrieval beyond simple keyword/BM25-like scoring.
- No daemon, WebSocket bridge, or device-node runtime.
- No real approval UI; approval-required tools are denied safely.
- No Docker/OS sandbox implementation.
- No production security guarantee.
- No automatic L2-to-L3 promotion.
- L2 compaction uses a deterministic summarizer, not a real model summarizer.
- Stable fact extraction is heuristic and creates proposals only.

## Extension Points

- Add an embedding index behind `MemoryRouter` without changing callers.
- Add hybrid lexical/vector retrieval.
- Add a model-backed session summarizer and human-reviewed memory promotion.
- Add a model-backed stable fact extractor and review UI.
- Add per-agent/user ACLs and namespace policies.
- Add approval UI integration for `ask` policy outcomes.
- Add richer L4 skill/plugin feedback loops while keeping tool authorization separate.
