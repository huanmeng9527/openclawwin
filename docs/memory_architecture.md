# OpenClaw 四层记忆架构

本项目实现的是 OpenClaw 风格记忆系统的参考骨架，不是完整 OpenClaw 本体。设计目标是让记忆层边界清晰、可测试、可替换，并能接入现有 `Gateway`、`PolicyEngine`、`ToolRegistry`、`Skills`、`Plugins`、`Hooks` 骨架。

## 四层记忆

| 层级 | 名称 | 生命周期 | 当前实现 |
| --- | --- | --- | --- |
| L1 | Working Memory / Context Memory | 进程内，可 TTL，默认不持久化 | `WorkingMemoryLayer` + `InMemoryMemoryStore` |
| L2 | Session Memory / Episodic Memory | SQLite 持久化 | `SessionMemoryLayer` + SQLite FTS/BM25 |
| L3 | Long-term Semantic Memory | Markdown 真源，SQLite 派生索引 | `SemanticMemoryLayer` + `MarkdownMemoryStore` + SQLite FTS |
| L4 | Procedural / Skill / Policy Memory | Markdown 真源，SQLite 派生索引 | `ProceduralMemoryLayer` + Skill/Tool/Policy metadata filters |

## 数据模型

统一记录模型是 `MemoryRecord`，包含：

- `id`、`layer`、`namespace`、`scope`
- `session_id`、`agent_id`、`user_id`
- `key`、`title`、`content`
- `tags`、`metadata`
- `source`、`confidence`
- `created_at`、`updated_at`、`expires_at`
- `visibility`、`risk_level`

检索返回 `MemorySearchResult`，包含 `record`、`layer`、`score`、`source`、`reason`。

## 数据流

写入：

1. 调用 `MemoryRouter.write(record, requested_layer, context)`。
2. `MemoryPolicyGate` 检查当前层所需权限。
3. L1 写入内存；L2 写入 SQLite；L3/L4 先写 Markdown block，再同步 SQLite FTS。
4. L3/L4 可通过 `MemoryRouter.reindex()` 从 Markdown 重新构建索引。

检索：

1. 调用 `MemoryRouter.retrieve(query, context, layers, limit, budget_tokens)`。
2. 默认按 L1 → L2 → L3 → L4 查询。
3. 每条结果携带层级、分数、来源和原因。
4. `CharacterBudget` 用字符长度近似 token budget，保留排序更靠前的结果。

Prompt 注入：

1. `PromptAssembler` 优先使用 `MemoryRouter.retrieve_for_prompt()`。
2. 查询上下文来自当前 `SessionRecord` 和当前输入，包括 `session_id`、`agent_id`、`user_id`、`lane_id` 和权限集合。
3. Prompt 中生成 `[Memory Context]`，按 L1/L2/L3/L4 分组展示结果。
4. L1/L2 默认可用于当前 prompt；L3/L4 只有在 context 带 `memory.read` 时才会注入。
5. 如果没有 `MemoryRouter`，`PromptAssembler` 会 fallback 到旧的 `WorkspaceMemory.recall()`，保持兼容。

## 权限

权限常量定义在 `openclaw_memory.policy`：

- `memory.read`
- `memory.write`
- `memory.procedural.write`
- `memory.delete`
- `memory.reindex`

默认规则：

- L1 写入默认允许。
- L2 写入默认允许。
- L3 写入需要 `memory.write`。
- L4 写入需要 `memory.procedural.write`、`policy.change` 或 `skill.write`。
- 删除需要 `memory.delete`。
- L3/L4 reindex 需要 `memory.reindex`。

`Gateway` 会把现有 `PolicyEngine` 注入 `MemoryPolicyGate`。工具调用仍先经过 `PolicyEngine.enforce_tool_call()`，然后记忆写入再经过 memory policy gate。

## Markdown 与 SQLite

L3/L4 的 canonical source of truth 是 Markdown：

```text
memory/
  semantic/
    facts.md
    preferences.md
    project_notes.md
    decisions.md
    known_issues.md
  procedural/
    skills.md
    tool_recipes.md
    policies.md
    runbooks.md
```

Markdown block 使用稳定 id：

```markdown
<!-- memory:record-id
{"id":"record-id","layer":"semantic",...}
-->
记忆正文
<!-- /memory:record-id -->
```

SQLite 只作为 FTS/BM25 索引和查询缓存。索引损坏时，可以从 Markdown 重新 `reindex`。

## 工具接口

`register_memory_router_tools()` 注册：

- `memory.search`
- `memory.write`
- `memory.delete`
- `memory.reindex`
- `memory.summarize_session`

旧的 `memory_search` / `memory_get` 仍保留，避免破坏已有调用。

工具检索和 prompt 注入是两条不同路径：

- `memory.search` 是显式工具调用，必须先经过 `PolicyEngine.enforce_tool_call()`。
- Prompt memory injection 是系统组装上下文，必须经过 `MemoryPolicyGate` 的读权限判断。
- L4 procedural memory 只能提供 skill、tool、policy、runbook 提示，不能授权工具执行。
- 真实工具调用仍必须经过 `PolicyEngine`、工具 allow/deny、审批和沙箱计划。

## 当前限制

- 没有真实 embedding/vector index。
- 没有真实 hybrid vector + BM25 scoring。
- 没有长期 daemon 或文件监听增量索引。
- Prompt 注入已接入四层记忆，但还没有真实模型级 relevance reranker。
- 没有真实 session summarizer 模型，只提供确定性摘要拼接。
- 没有 per-agent ACL 数据库，只通过 `PolicyEngine` / `ToolPolicy` 和 context permissions 做最小权限判断。

## 后续扩展点

- `EmbeddingIndex` 替换当前 `NoOpEmbeddingIndex`。
- Hybrid retrieval：向量分数 + BM25 分数加权。
- Session summarizer：接入模型生成会话摘要，再写回 L2/L3。
- Memory compaction：压缩旧 session event，保留摘要和高价值 facts。
- Per-agent ACL：按 agent、user、namespace、visibility 细化读写权限。
- File watcher：Markdown 改动后 debounce 增量 reindex。
