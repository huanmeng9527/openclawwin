# OpenClaw 参考架构

这个仓库根据《OpenClaw 架构深度解析》中文翻译与大纲实现了一个 Python 参考运行时。目标不是完整复刻所有第三方平台 SDK，而是把文档中的架构边界、数据流和安全约束落成可运行、可测试的代码。

## 总体架构

1. `Messaging Surfaces`：`ChannelBridge` 将 Telegram、WhatsApp、CLI、Webhook 等平台事件标准化为 `InternalMessage`。
2. `Gateway`：统一拥有连接、Session、Command Queue、Hooks、Plugins、Cron、Heartbeat、设备信任和 Node 注册。
3. `Agent Runtime`：动态组装 Prompt，加载工具元数据、Skill 元数据、工作区上下文、记忆召回，并执行模型和工具循环。
4. `LLM Providers`：通过 `ModelProvider` 接口接入真实模型；默认提供 `EchoModelProvider` 便于本地验证。

横切模块包括：

- `SessionManager`：生成 session key，维护 `sessions.json` 和 JSONL transcript。
- `LaneAwareCommandQueue`：按 session 串行、按全局和 sub-agent lane 控制并发。
- `ToolRegistry`：实现 Global deny → Per-agent deny → Global allow → Per-agent allow → Default 的工具策略。
- `PolicyEngine`：统一 Gateway 认证、设备信任、通道白名单、工具策略、执行审批、沙箱计划和消息发送策略。
- `SkillLoader`：按 workspace / managed / bundled 优先级发现 Skill，并只向 Prompt 注入元数据。
- `HookEngine` 与 `PluginManager`：提供事件驱动扩展和进程内插件扩展点。
- `SandboxManager`：根据 off / non-main / all 与 session / agent / shared 生成执行计划。
- `CronScheduler`、`HeartbeatSystem`、`NodeRegistry`、`DeviceTrustStore`：覆盖主动行为、物理设备和安全信任模型。

## 四层结构

1. `memory.md`：核心记忆，保存每次会话都应进入上下文的稳定事实和偏好。
2. `memory/YYYY-MM-DD.md`：每日记忆，只追加日志，并在 `## Retain` 小节里沉淀自包含事实。
3. `bank/`：结构化长期记忆，由反思任务生成，也可以人工编辑。
4. `.memory/index.sqlite`：派生检索索引，可从 Markdown 随时重建。

## 快速开始

```powershell
python -m openclaw_runtime init --workspace .\workspace
python -m openclaw_runtime send "hello openclaw" --workspace .\workspace --channel telegram --peer peter

python -m openclaw_memory init --workspace .\workspace
python -m openclaw_memory retain "Prefers concise replies on WhatsApp" --kind O --entity Peter --confidence 0.95 --workspace .\workspace
python -m openclaw_memory index --workspace .\workspace
python -m openclaw_memory recall "concise replies" --workspace .\workspace
python -m openclaw_memory reflect --since 7d --workspace .\workspace
```

`retain` 支持四种事实类型：

- `W`：world，客观世界事实。
- `B`：experience，智能体经历或执行过的事情。
- `O`：opinion，偏好、判断或主观信念，可带 `--confidence`。
- `S`：observation，观察或摘要。

## 嵌入 OpenClaw

运行时入口是 `openclaw_runtime.Gateway`：

```python
from openclaw_runtime import Gateway, GatewayConfig, InternalMessage

gateway = Gateway(GatewayConfig(workspace="./workspace"))
response = gateway.receive(
    InternalMessage(channel="telegram", peer_id="peter", text="hello")
)
print(response.run.output)
```

策略层入口是 `openclaw_runtime.PolicyEngine`，Gateway 默认会把现有 `ToolPolicy`、`DeviceTrustStore` 和 `SandboxManager` 注入进去：

```python
from openclaw_runtime import Gateway, GatewayConfig

gateway = Gateway(
    GatewayConfig(
        workspace="./workspace",
        allowed_channels=("telegram",),
        outbound_denied_channels=("public-web",),
        require_approval_for=("tool.call", "message.send"),
        auto_approve=False,
    )
)
```

库入口是 `openclaw_memory.WorkspaceMemory`：

```python
from openclaw_memory import WorkspaceMemory

memory = WorkspaceMemory("./workspace")
memory.init()
memory.retain("Fixed the Baileys WS crash.", kind="B", entities=["warelay"])
memory.rebuild_index()
results = memory.recall("Baileys crash", limit=5)
```

CLI 也兼容 `openclaw memory ...` 风格的参数剥离，方便后续接入主 CLI。
